import fs from "node:fs";
import path from "node:path";

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

export function parseGitConfig(text) {
  const values = {};
  let section = null;
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().split(/\s+/)[0];
      continue;
    }
    if (!section) continue;
    const valueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!valueMatch) continue;
    values[`${section}.${valueMatch[1]}`] = unquote(valueMatch[2]);
  }
  return values;
}

function gitConfigPath(root) {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return path.join(dotGit, "config");
    if (!stat.isFile()) return null;
    const pointer = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!pointer) return null;
    const gitDir = path.isAbsolute(pointer[1])
      ? pointer[1]
      : path.resolve(root, pointer[1]);
    return path.join(gitDir, "config");
  } catch {
    return null;
  }
}

export function gitConfigValue(root, key) {
  const configPath = gitConfigPath(root);
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    return parseGitConfig(fs.readFileSync(configPath, "utf8"))[key] || null;
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
