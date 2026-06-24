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

export function loadRuntimeEnv(root = process.cwd(), baseEnv = process.env) {
  if (baseEnv.VIBEGUARD_DISABLE_DOTENV === "1") {
    return { ...baseEnv };
  }

  const envPath = baseEnv.VIBEGUARD_ENV_FILE
    ? (path.isAbsolute(baseEnv.VIBEGUARD_ENV_FILE) ? baseEnv.VIBEGUARD_ENV_FILE : path.join(root, baseEnv.VIBEGUARD_ENV_FILE))
    : path.join(root, ".env");

  if (!fs.existsSync(envPath)) {
    return { ...baseEnv };
  }

  const fileEnv = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  return {
    ...fileEnv,
    ...baseEnv
  };
}
