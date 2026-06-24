import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const PATCH_SYSTEM_PROMPT = "You generate minimal unified diff patches for software bugs. Output only a git-style unified diff. Do not modify sensitive files.";

function extractResponsesText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n");
}

function summarizeErrorBody(text) {
  if (!text) return "";
  let value = text;
  try {
    const data = JSON.parse(text);
    value = data.error?.message || data.message || data.detail || JSON.stringify(data.error || data);
  } catch {
    value = text;
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

async function responseErrorReason(response) {
  let body = "";
  if (typeof response.text === "function") {
    try {
      body = await response.text();
    } catch {
      body = "";
    }
  }
  const summary = summarizeErrorBody(body);
  return `LLM request failed with HTTP ${response.status}${summary ? `: ${summary}` : ""}`;
}

function resolveProvider(env) {
  if (env.VIBEGUARD_LLM_PROVIDER) return env.VIBEGUARD_LLM_PROVIDER;
  if (env.XAI_API_KEY || env.GROK_API_KEY) return "grok";
  return null;
}

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super();
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const proxyRequest = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 80,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`
      }
    });

    proxyRequest.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetHost
      });
      callback(null, tlsSocket);
    });

    proxyRequest.once("error", callback);
    proxyRequest.end();
  }
}

function postJsonViaProxy(endpoint, headers, body, proxyUrl) {
  const url = new URL(endpoint);
  const agent = new HttpsProxyAgent(proxyUrl);

  return new Promise((resolve, reject) => {
    const request = https.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers,
      agent
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          async text() {
            return text;
          },
          async json() {
            return JSON.parse(text);
          }
        });
      });
    });

    request.once("error", reject);
    request.write(body);
    request.end();
  });
}

async function callResponsesApi({ endpoint, apiKey, model, context, proxyUrl }) {
  const body = JSON.stringify({
    model,
    input: [
      {
        role: "system",
        content: PATCH_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify(context, null, 2)
      }
    ]
  });
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    authorization: `Bearer ${apiKey}`
  };
  let response;
  try {
    response = proxyUrl
      ? await postJsonViaProxy(endpoint, headers, body, proxyUrl)
      : await fetch(endpoint, {
        method: "POST",
        headers,
        body
      });
  } catch (error) {
    return {
      status: "error",
      reason: `LLM request failed: ${error.message}`
    };
  }

  if (!response.ok) {
    return {
      status: "error",
      reason: await responseErrorReason(response)
    };
  }

  const data = await response.json();
  const patch = extractResponsesText(data).trim();
  return {
    status: patch ? "ok" : "empty",
    patch
  };
}

export async function generateDebugPatch(context, env = process.env) {
  const provider = resolveProvider(env);
  if (!provider) {
    return {
      status: "unavailable",
      reason: "Set VIBEGUARD_LLM_PROVIDER=openai-compatible with OPENAI_API_KEY, or set XAI_API_KEY/GROK_API_KEY for Grok patch generation."
    };
  }

  if (provider === "fixture") {
    if (env.VIBEGUARD_FIXTURE_PATCH_MAP) {
      const patchMap = JSON.parse(env.VIBEGUARD_FIXTURE_PATCH_MAP);
      const key = context.summary?.type || context.summary?.message || "default";
      const mapped = patchMap[key] || patchMap.default || "";
      return {
        status: mapped ? "ok" : "empty",
        patch: mapped
      };
    }

    const patch = env.VIBEGUARD_FIXTURE_PATCH_FILE
      ? fs.readFileSync(env.VIBEGUARD_FIXTURE_PATCH_FILE, "utf8")
      : env.VIBEGUARD_FIXTURE_PATCH || "";
    return {
      status: patch ? "ok" : "empty",
      patch
    };
  }

  if (provider === "grok" || provider === "xai") {
    const apiKey = env.XAI_API_KEY || env.GROK_API_KEY;
    const model = env.VIBEGUARD_MODEL || env.XAI_MODEL || env.GROK_MODEL || "grok-4.3";
    const endpoint = env.VIBEGUARD_GROK_BASE_URL || env.XAI_BASE_URL || "https://api.x.ai/v1/responses";
    if (!apiKey) {
      return {
        status: "unavailable",
        reason: "XAI_API_KEY or GROK_API_KEY is required for Grok patch generation."
      };
    }
    return callResponsesApi({
      endpoint,
      apiKey,
      model,
      context,
      proxyUrl: env.VIBEGUARD_HTTPS_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy
    });
  }

  if (provider !== "openai-compatible") {
    return {
      status: "unavailable",
      reason: `Unsupported LLM provider: ${provider}`
    };
  }

  if (!env.OPENAI_API_KEY || !env.VIBEGUARD_MODEL) {
    return {
      status: "unavailable",
      reason: "OPENAI_API_KEY and VIBEGUARD_MODEL are required for openai-compatible patch generation."
    };
  }

  const endpoint = env.VIBEGUARD_OPENAI_BASE_URL || "https://api.openai.com/v1/responses";
  return callResponsesApi({
    endpoint,
    apiKey: env.OPENAI_API_KEY,
    model: env.VIBEGUARD_MODEL,
    context,
    proxyUrl: env.VIBEGUARD_HTTPS_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy
  });
}
