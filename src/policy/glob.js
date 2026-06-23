import path from "node:path";

export function normalizeRepoPath(filePath, root = process.cwd()) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const relative = path.relative(root, absolute) || filePath;
  return relative.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegex(char) {
  return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchGlob(filePath, pattern) {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const cleanPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (globToRegExp(cleanPattern).test(normalized)) return true;

  if (!cleanPattern.includes("/")) {
    const basename = normalized.split("/").pop();
    return globToRegExp(cleanPattern).test(basename);
  }

  return false;
}

export function matchAnyGlob(filePath, patterns = []) {
  return patterns.some((pattern) => matchGlob(filePath, pattern));
}

export function matchCommand(command, pattern) {
  const normalizedCommand = command.trim().replace(/\s+/g, " ");
  const normalizedPattern = pattern.trim().replace(/\s+/g, " ");
  return globToRegExp(normalizedPattern).test(normalizedCommand) || normalizedCommand.includes(normalizedPattern);
}
