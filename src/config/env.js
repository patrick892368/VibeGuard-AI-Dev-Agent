import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

function gitConfigValue(root, key) {
  try {
    return execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function withGitProxyFallback(root, env) {
  const next = { ...env };
  const gitHttps = gitConfigValue(root, "https.proxy");
  const gitHttp = gitConfigValue(root, "http.proxy");
  const httpsProxy = gitHttps || gitHttp;
  const httpProxy = gitHttp || gitHttps;
  if (httpsProxy && !next.VIBEGUARD_HTTPS_PROXY && !next.HTTPS_PROXY && !next.https_proxy) {
    next.HTTPS_PROXY = httpsProxy;
  }
  if (httpProxy && !next.HTTP_PROXY && !next.http_proxy) {
    next.HTTP_PROXY = httpProxy;
  }
  return next;
}

export function loadRuntimeEnv(root = process.cwd(), baseEnv = process.env) {
  if (baseEnv.VIBEGUARD_DISABLE_DOTENV === "1") {
    return withGitProxyFallback(root, baseEnv);
  }

  const envPath = baseEnv.VIBEGUARD_ENV_FILE
    ? (path.isAbsolute(baseEnv.VIBEGUARD_ENV_FILE) ? baseEnv.VIBEGUARD_ENV_FILE : path.join(root, baseEnv.VIBEGUARD_ENV_FILE))
    : path.join(root, ".env");

  if (!fs.existsSync(envPath)) {
    return withGitProxyFallback(root, baseEnv);
  }

  const fileEnv = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  return withGitProxyFallback(root, {
    ...fileEnv,
    ...baseEnv
  });
}
