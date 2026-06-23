import fs from "node:fs";

function extractResponsesText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n");
}

export async function generateDebugPatch(context, env = process.env) {
  const provider = env.VIBEGUARD_LLM_PROVIDER;
  if (!provider) {
    return {
      status: "unavailable",
      reason: "Set VIBEGUARD_LLM_PROVIDER=openai-compatible, OPENAI_API_KEY, and VIBEGUARD_MODEL to enable AI patch generation."
    };
  }

  if (provider === "fixture") {
    const patch = env.VIBEGUARD_FIXTURE_PATCH_FILE
      ? fs.readFileSync(env.VIBEGUARD_FIXTURE_PATCH_FILE, "utf8")
      : env.VIBEGUARD_FIXTURE_PATCH || "";
    return {
      status: patch ? "ok" : "empty",
      patch
    };
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.VIBEGUARD_MODEL,
      input: [
        {
          role: "system",
          content: "You generate minimal unified diff patches for software bugs. Output only a unified diff. Do not modify sensitive files."
        },
        {
          role: "user",
          content: JSON.stringify(context, null, 2)
        }
      ]
    })
  });

  if (!response.ok) {
    return {
      status: "error",
      reason: `LLM request failed with HTTP ${response.status}`
    };
  }

  const data = await response.json();
  const patch = extractResponsesText(data).trim();
  return {
    status: patch ? "ok" : "empty",
    patch
  };
}
