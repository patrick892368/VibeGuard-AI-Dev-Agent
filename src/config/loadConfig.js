import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "./defaultConfig.js";
import { parseYamlSubset } from "./yaml.js";

function asArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function mergeConfig(config) {
  return {
    ...defaultConfig,
    ...config,
    paths: {
      ...defaultConfig.paths,
      ...(config.paths || {}),
      allow: asArray(config.paths?.allow ?? defaultConfig.paths.allow),
      deny: asArray(config.paths?.deny ?? defaultConfig.paths.deny),
      require_confirmation: asArray(config.paths?.require_confirmation ?? defaultConfig.paths.require_confirmation)
    },
    commands: {
      ...defaultConfig.commands,
      ...(config.commands || {}),
      deny: asArray(config.commands?.deny ?? defaultConfig.commands.deny),
      require_confirmation: asArray(config.commands?.require_confirmation ?? defaultConfig.commands.require_confirmation)
    },
    agents: {
      ...defaultConfig.agents,
      ...(config.agents || {})
    }
  };
}

export function findConfigPath(cwd = process.cwd()) {
  const candidate = path.join(cwd, ".vibeguard.yaml");
  return fs.existsSync(candidate) ? candidate : null;
}

export function loadConfig(cwd = process.cwd()) {
  const configPath = findConfigPath(cwd);
  if (!configPath) {
    return { config: defaultConfig, configPath: null };
  }

  const text = fs.readFileSync(configPath, "utf8");
  const parsed = parseYamlSubset(text);
  return {
    config: mergeConfig(parsed),
    configPath
  };
}
