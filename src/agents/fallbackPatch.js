import fs from "node:fs";
import path from "node:path";
import { listRepoFiles } from "../repo/files.js";

function toPosix(filePath) {
  return filePath.replace(/\\/g, "/");
}

function templateNameFromFile(file) {
  const normalized = toPosix(file);
  const marker = "/templates/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  if (normalized.startsWith("templates/")) return normalized.slice("templates/".length);
  return null;
}

function firstToken(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)[0]
    .replace(/^['"]|['"]$/g, "");
}

function findReplacementTemplate(missingTemplate, files) {
  if (!missingTemplate) return null;
  const templateNames = files
    .map(templateNameFromFile)
    .filter(Boolean);

  if (templateNames.includes(missingTemplate)) return null;

  const missingBase = path.posix.basename(missingTemplate);
  const sameBasename = templateNames.filter((templateName) => path.posix.basename(templateName) === missingBase);
  if (sameBasename.length === 1) return sameBasename[0];

  const sameSuffix = templateNames.filter((templateName) => templateName.endsWith(`/${missingBase}`));
  if (sameSuffix.length === 1) return sameSuffix[0];

  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function findSourceFileContaining(root, debug, needle, files) {
  const candidates = unique([
    ...(debug.frames || []).map((frame) => frame.file),
    ...(debug.likelyFiles || []),
    ...files.filter((file) => file.endsWith(".py"))
  ]).filter((file) => file.endsWith(".py") && !/(^|\/)(test|tests)\//.test(file));

  for (const file of candidates) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, "utf8");
    if (text.includes(needle)) return { file, text };
  }
  return null;
}

function buildSingleLineReplacementPatch(file, beforeText, afterText, changedLineIndex, contextRadius = 3) {
  const oldLines = beforeText.replace(/\r\n/g, "\n").split("\n");
  const newLines = afterText.replace(/\r\n/g, "\n").split("\n");
  const startIndex = Math.max(0, changedLineIndex - contextRadius);
  const endIndex = Math.min(oldLines.length, changedLineIndex + contextRadius + 1);
  const hunk = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    if (index === changedLineIndex) {
      hunk.push(`-${oldLines[index]}`);
      hunk.push(`+${newLines[index]}`);
    } else {
      hunk.push(` ${oldLines[index]}`);
    }
  }

  const oldCount = endIndex - startIndex;
  const newCount = oldCount;
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startIndex + 1},${oldCount} +${startIndex + 1},${newCount} @@`,
    ...hunk,
    ""
  ].join("\n");
}

function replaceFirstLine(text, needle, replacement) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(needle)) continue;
    const updatedLine = lines[index].replace(needle, replacement);
    if (updatedLine === lines[index]) continue;
    const updated = [...lines];
    updated[index] = updatedLine;
    return {
      changedLineIndex: index,
      text: updated.join("\n")
    };
  }
  return null;
}

function generateDjangoTemplatePatch(debug, root) {
  if (!/TemplateDoesNotExist/.test(debug.summary?.type || "")) return null;

  const missingTemplate = firstToken(debug.summary?.message);
  const files = listRepoFiles(root);
  const replacementTemplate = findReplacementTemplate(missingTemplate, files);
  if (!replacementTemplate) return null;

  const source = findSourceFileContaining(root, debug, missingTemplate, files);
  if (!source) return null;

  const replaced = replaceFirstLine(source.text, missingTemplate, replacementTemplate);
  if (!replaced) return null;

  return {
    status: "recovered",
    strategy: "django_template_literal_replacement",
    reason: `Replaced missing Django template path ${missingTemplate} with existing template ${replacementTemplate}.`,
    patch: buildSingleLineReplacementPatch(source.file, source.text, replaced.text, replaced.changedLineIndex)
  };
}

export function generateFallbackPatch(debug, options = {}) {
  const root = options.root || process.cwd();
  return generateDjangoTemplatePatch(debug, root);
}

export const fallbackPatchInternals = {
  findReplacementTemplate,
  buildSingleLineReplacementPatch
};
