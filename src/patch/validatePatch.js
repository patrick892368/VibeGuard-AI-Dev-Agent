import { parsePatchFiles } from "./parsePatch.js";

export function validateUnifiedDiff(patchText) {
  if (!patchText || !patchText.trim()) {
    return {
      valid: false,
      reason: "Patch is empty",
      files: []
    };
  }

  const normalized = patchText.replace(/\r\n/g, "\n");
  const files = parsePatchFiles(normalized);
  if (files.length === 0) {
    return {
      valid: false,
      reason: "Patch does not contain any changed files",
      files: []
    };
  }

  if (!/^diff --git /m.test(normalized)) {
    return {
      valid: false,
      reason: "Patch is not a git-style unified diff",
      files
    };
  }

  if (!/^@@ .+ @@/m.test(normalized)) {
    return {
      valid: false,
      reason: "Patch does not contain a unified diff hunk",
      files
    };
  }

  return {
    valid: true,
    reason: "Patch is a git-style unified diff",
    files
  };
}
