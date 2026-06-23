function cleanPatchPath(rawPath) {
  if (!rawPath) return null;
  const value = rawPath.trim().split(/\s+/)[0];
  if (value === "/dev/null") return null;
  return value.replace(/^a\//, "").replace(/^b\//, "");
}

export function parsePatchFiles(patchText) {
  const files = new Set();
  for (const line of patchText.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      const target = cleanPatchPath(parts[3]) || cleanPatchPath(parts[2]);
      if (target) files.add(target);
    } else if (line.startsWith("+++ ")) {
      const target = cleanPatchPath(line.slice(4));
      if (target) files.add(target);
    } else if (line.startsWith("--- ")) {
      const target = cleanPatchPath(line.slice(4));
      if (target) files.add(target);
    }
  }
  return [...files].sort();
}
