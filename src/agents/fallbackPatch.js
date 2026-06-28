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

function policyAllows(result, options = {}) {
  return result.status === "allow" || (result.status === "require_confirmation" && options.confirmed);
}

function fallbackReadPolicy(file, options = {}) {
  if (!options.engine) return null;
  return options.engine.checkPath(file, "read_fallback_patch_source");
}

function candidateSourceFiles(debug, files) {
  const hinted = unique([
    ...(debug.frames || []).map((frame) => frame.file),
    ...(debug.likelyFiles || [])
  ]).filter((file) => file.endsWith(".py") && !/(^|\/)(test|tests)\//.test(file));
  const broad = files
    .filter((file) => file.endsWith(".py") && !/(^|\/)(test|tests)\//.test(file))
    .filter((file) => !hinted.includes(file));
  return [...hinted, ...broad];
}

function findSourceFileContaining(root, debug, needle, files, options = {}) {
  const candidates = candidateSourceFiles(debug, files);
  const skippedSourceFiles = [];

  for (const file of candidates) {
    const policy = fallbackReadPolicy(file, options);
    if (policy && !policyAllows(policy, options)) {
      skippedSourceFiles.push({ file, policy });
      continue;
    }
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, "utf8");
    if (text.includes(needle)) return { source: { file, text }, skippedSourceFiles };
  }
  return { source: null, skippedSourceFiles };
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

function generateDjangoTemplatePatch(debug, root, options = {}) {
  if (!/TemplateDoesNotExist/.test(debug.summary?.type || "")) return null;

  const missingTemplate = firstToken(debug.summary?.message);
  const files = listRepoFiles(root);
  const replacementTemplate = findReplacementTemplate(missingTemplate, files);
  if (!replacementTemplate) return null;

  const sourceResult = findSourceFileContaining(root, debug, missingTemplate, files, options);
  const source = sourceResult.source;
  if (!source) {
    return {
      status: "unavailable",
      reason: sourceResult.skippedSourceFiles.length > 0
        ? "No policy-allowed source file containing the missing template path was available for deterministic recovery."
        : "No source file containing the missing template path was available for deterministic recovery.",
      skippedSourceFiles: sourceResult.skippedSourceFiles
    };
  }

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
  return generateDjangoTemplatePatch(debug, root, options);
}

export const fallbackPatchInternals = {
  findReplacementTemplate,
  buildSingleLineReplacementPatch
};
