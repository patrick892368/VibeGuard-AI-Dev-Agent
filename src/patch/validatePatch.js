import { parsePatchFiles } from "./parsePatch.js";

function stripToDiff(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const fenced = normalized.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : normalized;
  const diffIndex = candidate.indexOf("diff --git ");
  return diffIndex >= 0 ? candidate.slice(diffIndex) : candidate;
}

function cleanHeaderPath(rawPath) {
  if (!rawPath) return null;
  const value = rawPath.trim().split(/\s+/)[0];
  if (value === "/dev/null") return null;
  return value.replace(/^a\//, "").replace(/^b\//, "");
}

function addGitHeaderIfMissing(text) {
  if (/^diff --git /m.test(text) || !/^@@ .+ @@/m.test(text)) return text;
  const oldPath = cleanHeaderPath(text.match(/^---\s+(.+)$/m)?.[1]);
  const newPath = cleanHeaderPath(text.match(/^\+\+\+\s+(.+)$/m)?.[1]);
  const target = newPath || oldPath;
  if (!target) return text;
  return `diff --git a/${oldPath || target} b/${newPath || target}\n${text}`;
}

function countHunkLines(lines) {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith(" ") || line.startsWith("-")) oldCount += 1;
    if (line.startsWith(" ") || line.startsWith("+")) newCount += 1;
  }
  return { oldCount, newCount };
}

export function normalizeUnifiedDiff(patchText) {
  if (!patchText || !patchText.trim()) return "";
  const lines = addGitHeaderIfMissing(stripToDiff(patchText)).split("\n");
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (!match) {
      output.push(line);
      continue;
    }

    const hunkLines = [];
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].startsWith("diff --git ") && !lines[cursor].startsWith("@@ ")) {
      hunkLines.push(lines[cursor]);
      cursor += 1;
    }

    const { oldCount, newCount } = countHunkLines(hunkLines);
    output.push(`@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}`);
    output.push(...hunkLines);
    index = cursor - 1;
  }

  return `${output.join("\n").trimEnd()}\n`;
}

export function validateUnifiedDiff(patchText) {
  if (!patchText || !patchText.trim()) {
    return {
      valid: false,
      reason: "Patch is empty",
      files: []
    };
  }

  const normalized = normalizeUnifiedDiff(patchText);
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
