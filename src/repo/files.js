import fs from "node:fs";
import path from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vibeguard-cache",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv"
]);

export function listRepoFiles(root = process.cwd(), options = {}) {
  const ignore = new Set([...(options.ignore || []), ...DEFAULT_IGNORES]);
  const limit = options.limit || 5000;
  const files = [];

  function walk(dir) {
    if (files.length >= limit) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (ignore.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  walk(root);
  return files.sort();
}

export function readTextIfExists(root, relativePath, maxBytes = 200_000) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return null;
  const stats = fs.statSync(absolute);
  if (stats.size > maxBytes) return null;
  return fs.readFileSync(absolute, "utf8");
}

export function ensureDirForFile(root, relativePath) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
}
