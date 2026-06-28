import fs from "node:fs";
import path from "node:path";
import { listRepoFiles, readTextIfExists } from "../repo/files.js";
import { scanRepository } from "../repo/scan.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";
import { commandDisplay, runArgvWithPolicy, runCommandWithPolicy } from "../runner/safeCommand.js";
import { buildFixGitPlan, checkGitPlanPolicy, executeGitPlan } from "../integrations/gitPlan.js";

function extractPythonFunctions(text) {
  return [...text.matchAll(/^\s*def\s+([a-zA-Z_]\w*)\s*\(/gm)].map((match) => match[1]);
}

function extractJavaScriptFunctions(text) {
  const names = [];
  for (const match of text.matchAll(/export\s+function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) names.push(match[1]);
  for (const match of text.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) names.push(match[1]);
  for (const match of text.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) names.push(match[1]);
  for (const match of text.matchAll(/(?:exports|module\.exports)\.([a-zA-Z_$][\w$]*)\s*=/g)) names.push(match[1]);
  for (const match of text.matchAll(/(?:exports|module\.exports)\[['"]([^'"]+)['"]\]\s*=/g)) names.push(match[1]);
  const objectExport = text.match(/module\.exports\s*=\s*{([\s\S]*?)}/m);
  if (objectExport) {
    for (const match of objectExport[1].matchAll(/([a-zA-Z_$][\w$]*)\s*(?::|,|$)/g)) names.push(match[1]);
  }
  return [...new Set(names)];
}

function extractJavaMethods(text) {
  return [...text.matchAll(/(?:public|private|protected)\s+(?:static\s+)?[\w.<>\[\]]+\s+([a-zA-Z_]\w*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => !["if", "for", "while", "switch", "catch"].includes(name));
}

function uniqueNames(names) {
  return [...new Set(names.filter(Boolean))];
}

function extractPythonClasses(text) {
  return uniqueNames([...text.matchAll(/^\s*class\s+([a-zA-Z_]\w*)\s*(?:\(|:)/gm)].map((match) => match[1]));
}

function extractJavaScriptClasses(text) {
  const names = [];
  const patterns = [
    /(?:export\s+default\s+|export\s+)?class\s+([a-zA-Z_$][\w$]*)\b/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*class\b/g,
    /(?:exports|module\.exports)\.([a-zA-Z_$][\w$]*)\s*=\s*class\b/g,
    /(?:exports|module\.exports)\[['"]([^'"]+)['"]\]\s*=\s*class\b/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.push(match[1]);
  }
  return uniqueNames(names);
}

function extractTypeScriptInterfaces(text) {
  return uniqueNames([...text.matchAll(/(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)\b/g)].map((match) => match[1]));
}

function extractJavaClasses(text) {
  return uniqueNames([...text.matchAll(/\b(?:class|record|enum)\s+([A-Z]\w*)\b/g)].map((match) => match[1]));
}

function extractJavaInterfaces(text) {
  return uniqueNames([...text.matchAll(/\binterface\s+([A-Z]\w*)\b/g)].map((match) => match[1]));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function rangeFromStarts(starts, totalLines) {
  return starts.map((item, index) => ({
    name: item.name,
    startLine: item.line,
    endLine: (starts[index + 1]?.line || totalLines + 1) - 1
  }));
}

function startsForPatterns(text, patterns) {
  const starts = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      starts.push({ name: match[1], line: lineNumberAt(text, match.index) });
    }
  }
  return [...new Map(starts.sort((a, b) => a.line - b.line).map((item) => [`${item.name}:${item.line}`, item])).values()];
}

function rangesFromPatterns(text, patterns, boundaryPatterns = patterns) {
  const totalLines = text.split(/\r?\n/).length;
  const ownStarts = startsForPatterns(text, patterns);
  const boundaryStarts = startsForPatterns(text, boundaryPatterns);
  return ownStarts.map((item) => {
    const next = boundaryStarts.find((candidate) => candidate.line > item.line);
    return {
      name: item.name,
      startLine: item.line,
      endLine: (next?.line || totalLines + 1) - 1
    };
  });
}

function extractPythonFunctionRanges(text) {
  const starts = [...text.matchAll(/^\s*def\s+([a-zA-Z_]\w*)\s*\(/gm)]
    .map((match) => ({ name: match[1], line: lineNumberAt(text, match.index) }));
  return rangeFromStarts(starts, text.split(/\r?\n/).length);
}

function extractPythonClassRanges(text) {
  return rangesFromPatterns(
    text,
    [/^\s*class\s+([a-zA-Z_]\w*)\s*(?:\(|:)/gm],
    [/^(?:class|def)\s+([a-zA-Z_]\w*)\s*(?:\(|:)/gm]
  );
}

function extractJavaScriptFunctionRanges(text) {
  const starts = [];
  const patterns = [
    /export\s+function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /(?:exports|module\.exports)\.([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      starts.push({ name: match[1], line: lineNumberAt(text, match.index) });
    }
  }
  const unique = [...new Map(starts.sort((a, b) => a.line - b.line).map((item) => [`${item.name}:${item.line}`, item])).values()];
  return rangeFromStarts(unique, text.split(/\r?\n/).length);
}

function extractJavaScriptClassRanges(text) {
  const patterns = [
    /(?:export\s+default\s+|export\s+)?class\s+([a-zA-Z_$][\w$]*)\b/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*class\b/g,
    /(?:exports|module\.exports)\.([a-zA-Z_$][\w$]*)\s*=\s*class\b/g,
    /(?:exports|module\.exports)\[['"]([^'"]+)['"]\]\s*=\s*class\b/g
  ];
  const boundaries = [
    ...patterns,
    /(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)\b/g,
    /(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g
  ];
  return rangesFromPatterns(text, patterns, boundaries);
}

function extractTypeScriptInterfaceRanges(text) {
  return rangesFromPatterns(
    text,
    [/(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)\b/g],
    [
      /(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)\b/g,
      /(?:export\s+default\s+|export\s+)?class\s+([a-zA-Z_$][\w$]*)\b/g,
      /(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
      /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g
    ]
  );
}

function extractJavaMethodRanges(text) {
  const starts = [...text.matchAll(/(?:public|private|protected)\s+(?:static\s+)?[\w.<>\[\]]+\s+([a-zA-Z_]\w*)\s*\(/g)]
    .map((match) => ({ name: match[1], line: lineNumberAt(text, match.index) }))
    .filter((item) => !["if", "for", "while", "switch", "catch"].includes(item.name));
  return rangeFromStarts(starts, text.split(/\r?\n/).length);
}

function extractJavaClassRanges(text) {
  return rangesFromPatterns(
    text,
    [/\b(?:class|record|enum)\s+([A-Z]\w*)\b/g],
    [/\b(?:class|record|enum|interface)\s+([A-Z]\w*)\b/g]
  );
}

function extractJavaInterfaceRanges(text) {
  return rangesFromPatterns(
    text,
    [/\binterface\s+([A-Z]\w*)\b/g],
    [/\b(?:class|record|enum|interface)\s+([A-Z]\w*)\b/g]
  );
}

function uncoveredNames(namedRanges, coverage) {
  if (!coverage?.missingLines?.length) return [];
  return namedRanges
    .filter((range) => coverage.missingLines.some((line) => line >= range.startLine && line <= range.endLine))
    .map((range) => range.name);
}

function uncoveredFunctions(functionRanges, coverage) {
  return uncoveredNames(functionRanges, coverage);
}

function testTargetFunctions(candidate) {
  return candidate.uncoveredFunctions?.length ? candidate.uncoveredFunctions : candidate.functions;
}

function testTargetClasses(candidate) {
  return candidate.uncoveredClasses?.length ? candidate.uncoveredClasses : candidate.classes || [];
}

function splitParams(params) {
  return params.split(",").map((param) => param.trim().replace(/=.*$/, "").trim()).filter(Boolean);
}

function jsLiteral(value) {
  return JSON.stringify(value);
}

function pythonLiteral(value) {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null) return "None";
  return JSON.stringify(value);
}

function literalValue(expression) {
  const normalized = expression.trim().replace(/;$/, "");
  if (/^["'][^"']*["']$/.test(normalized)) return normalized.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  if (normalized === "true" || normalized === "True") return true;
  if (normalized === "false" || normalized === "False") return false;
  if (normalized === "null" || normalized === "None") return null;
  return undefined;
}

function propertyAccess(expression, param) {
  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^${escaped}\\.([a-zA-Z_$][\\w$]*)$`),
    new RegExp(`^${escaped}\\[['"]([^'"]+)['"]\\]$`),
    new RegExp(`^${escaped}\\.get\\(['"]([^'"]+)['"]\\)$`)
  ];
  for (const pattern of patterns) {
    const match = expression.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function sampleValueForProperty(property) {
  return /(?:^id$|Id$|_id$)/.test(property) ? 123 : "Ada";
}

function objectSampleForExpression(param, expression) {
  const property = propertyAccess(expression.trim().replace(/;$/, ""), param);
  if (!property) return null;
  return { [property]: sampleValueForProperty(property) };
}

function expectedFromExpression(param, expression, sample) {
  const normalized = expression.trim().replace(/;$/, "");
  const literal = literalValue(normalized);
  if (literal !== undefined) return literal;
  if (normalized === param) return sample;
  const property = propertyAccess(normalized, param);
  if (property && sample && typeof sample === "object" && !Array.isArray(sample) && Object.prototype.hasOwnProperty.call(sample, property)) {
    return sample[property];
  }
  if (typeof sample === "string" && (normalized === `${param}.trim()` || normalized === `${param}.strip()`)) {
    return sample.trim();
  }
  if (typeof sample === "string" && (normalized === `${param}.trim().toLowerCase()` || normalized === `${param}.strip().lower()`)) {
    return sample.trim().toLowerCase();
  }
  if (typeof sample === "number" && normalized === `-${param}`) return -sample;
  if (Array.isArray(sample) && normalized === `${param}[0]`) return sample[0];
  return undefined;
}

function trueBranchArgs(param, condition) {
  const normalized = condition.trim();
  if ([`${param} == null`, `${param} === null`, `${param} is None`].includes(normalized)) return [null];
  if ([`${param} < 0`, `${param} <= 0`].includes(normalized)) return [-2];
  if ([`${param} == ""`, `${param} === ""`].includes(normalized)) return [""];
  if ([`${param}.length == 0`, `${param}.length === 0`, `len(${param}) == 0`].includes(normalized)) return [[]];
  return null;
}

function branchAssertions(name, params, condition, trueExpression, falseExpression) {
  if (params.length !== 1) return [];
  const [param] = params;
  const normalized = condition.trim();
  const cases = [];

  if ([`${param} == null`, `${param} === null`, `${param} is None`].includes(normalized)) {
    cases.push({ args: [null], expression: trueExpression });
    cases.push({ args: [objectSampleForExpression(param, falseExpression) || " Ada "], expression: falseExpression });
  } else if (normalized === `${param} < 0`) {
    cases.push({ args: [-2], expression: trueExpression });
    cases.push({ args: [3], expression: falseExpression });
  } else if (normalized === `${param} <= 0`) {
    cases.push({ args: [-2], expression: trueExpression });
    cases.push({ args: [0], expression: trueExpression });
    cases.push({ args: [3], expression: falseExpression });
  } else if ([`${param} == ""`, `${param} === ""`].includes(normalized)) {
    cases.push({ args: [""], expression: trueExpression });
    cases.push({ args: ["Ada"], expression: falseExpression });
  } else if ([`${param}.length == 0`, `${param}.length === 0`, `len(${param}) == 0`].includes(normalized)) {
    cases.push({ args: [[]], expression: trueExpression });
    cases.push({ args: [["Ada"]], expression: falseExpression });
  }

  return cases
    .map((item) => ({
      name,
      args: item.args,
      expected: expectedFromExpression(param, item.expression, item.args[0])
    }))
    .filter((item) => item.expected !== undefined);
}

function exceptionAssertions(name, params, condition, errorName) {
  if (params.length !== 1) return [];
  const [param] = params;
  const args = trueBranchArgs(param, condition);
  if (!args) return [];
  return [{
    name,
    args,
    throws: errorName.split(".").pop()
  }];
}

function simpleAssertion(name, params, expression) {
  const normalized = expression.trim().replace(/;$/, "");
  if (params.length === 0) {
    if (normalized === "true" || normalized === "True") return { name, args: [], expected: true };
    if (normalized === "false" || normalized === "False") return { name, args: [], expected: false };
    const stringLiteral = normalized.match(/^["']([^"']*)["']$/);
    if (stringLiteral) return { name, args: [], expected: stringLiteral[1] };
  }
  if (params.length === 1) {
    const [value] = params;
    if (normalized === `${value}.trim()` || normalized === `${value}.strip()`) {
      return { name, args: [" Ada "], expected: "Ada" };
    }
    if (normalized === `${value}.trim().toLowerCase()` || normalized === `${value}.strip().lower()`) {
      return { name, args: [" Ada "], expected: "ada" };
    }
    const objectSample = objectSampleForExpression(value, normalized);
    if (objectSample) {
      return { name, args: [objectSample], expected: expectedFromExpression(value, normalized, objectSample) };
    }
  }
  if (params.length === 2) {
    const [left, right] = params;
    if (normalized === `${left} + ${right}` || normalized === `${right} + ${left}`) {
      return { name, args: [2, 3], expected: 5 };
    }
  }
  return null;
}

function inferPythonAssertions(text) {
  const hints = [];
  const pattern = /^def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\):\s*\n\s+return\s+(.+)$/gm;
  for (const match of text.matchAll(pattern)) {
    const hint = simpleAssertion(match[1], splitParams(match[2]), match[3]);
    if (hint) hints.push(hint);
  }
  const branchPattern = /^def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\):\s*\n\s+if\s+(.+):\s*\n\s+return\s+(.+)\s*\n\s+return\s+(.+)$/gm;
  for (const match of text.matchAll(branchPattern)) {
    hints.push(...branchAssertions(match[1], splitParams(match[2]), match[3], match[4], match[5]));
  }
  const exceptionPattern = /^def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\):\s*\n\s+if\s+(.+):\s*\n\s+raise\s+([a-zA-Z_][\w.]*)\s*\([^)]*\)\s*\n\s+return\s+(.+)$/gm;
  for (const match of text.matchAll(exceptionPattern)) {
    hints.push(...exceptionAssertions(match[1], splitParams(match[2]), match[3], match[4]));
  }
  return hints;
}

function inferJavaScriptAssertions(text) {
  const hints = [];
  const patterns = [
    /(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*{\s*return\s+([^;{}]+);?\s*}/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>\s*([^;\n]+)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const hint = simpleAssertion(match[1], splitParams(match[2]), match[3]);
      if (hint) hints.push(hint);
    }
  }
  const branchPattern = /(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*{\s*if\s*\(([^)]*)\)\s*(?:{\s*)?return\s+([^;{}]+);?\s*(?:}\s*)?return\s+([^;{}]+);?\s*}/g;
  for (const match of text.matchAll(branchPattern)) {
    hints.push(...branchAssertions(match[1], splitParams(match[2]), match[3], match[4], match[5]));
  }
  const exceptionPattern = /(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*{\s*if\s*\(([^)]*)\)\s*(?:{\s*)?throw\s+new\s+([a-zA-Z_$][\w$]*)\s*\([^;{}]*\);?\s*(?:}\s*)?return\s+([^;{}]+);?\s*}/g;
  for (const match of text.matchAll(exceptionPattern)) {
    hints.push(...exceptionAssertions(match[1], splitParams(match[2]), match[3], match[4]));
  }
  return hints;
}

function javaMetadata(text, sourceFile) {
  const packageName = text.match(/^\s*package\s+([\w.]+);/m)?.[1] || "";
  const className = text.match(/\b(?:class|interface|record|enum)\s+([A-Z]\w*)/)?.[1] || path.basename(sourceFile, ".java");
  return { packageName, className };
}

function detectJavaScriptModuleSystem(text, sourceFile) {
  if (sourceFile.endsWith(".mjs")) return "esm";
  if (sourceFile.endsWith(".cjs")) return "commonjs";
  if (/\bexport\s+|\bimport\s+/.test(text)) return "esm";
  if (/module\.exports|exports\.|(?:exports|module\.exports)\[['"][^'"]+['"]\]/.test(text)) return "commonjs";
  return "unknown";
}

function detectDefaultExportedClasses(text) {
  return uniqueNames([...text.matchAll(/export\s+default\s+class\s+([a-zA-Z_$][\w$]*)\b/g)].map((match) => match[1]));
}

function detectDirectCommonJsClassExport(text, classes) {
  const inline = text.match(/module\.exports\s*=\s*class\s+([a-zA-Z_$][\w$]*)\b/);
  if (inline) return inline[1];
  const reference = text.match(/module\.exports\s*=\s*([a-zA-Z_$][\w$]*)\b/);
  return reference && classes.includes(reference[1]) ? reference[1] : null;
}

function javaScriptMetadata(text, sourceFile, classes) {
  return {
    moduleSystem: detectJavaScriptModuleSystem(text, sourceFile),
    assertionHints: inferJavaScriptAssertions(text),
    defaultExportedClasses: detectDefaultExportedClasses(text),
    directCommonJsClassExport: detectDirectCommonJsClassExport(text, classes)
  };
}

function candidateTestPath(sourceFile) {
  const extension = path.extname(sourceFile);
  const base = sourceFile.slice(0, -extension.length);
  if (extension === ".py") return `tests/test_${path.basename(base)}.py`;
  if (extension === ".mjs") return `${base}.test.mjs`;
  if (extension === ".cjs") return `${base}.test.cjs`;
  if ([".js", ".ts"].includes(extension)) return `${base}.test${extension === ".ts" ? ".ts" : ".js"}`;
  if (extension === ".java") {
    if (sourceFile.startsWith("src/main/java/")) {
      return `src/test/java/${sourceFile.slice("src/main/java/".length, -".java".length)}Test.java`;
    }
    return `${base}Test.java`;
  }
  return null;
}

function relativeImport(fromFile, toFile) {
  let relative = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function normalizeCoveragePath(root, filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (!path.isAbsolute(filePath)) return normalized.replace(/^\.\//, "");
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function parseCoverageJson(text, root) {
  const data = JSON.parse(text);
  if (!data.files || typeof data.files !== "object") {
    throw new Error("Coverage JSON does not contain a files object");
  }

  const files = Object.entries(data.files).map(([file, record]) => {
    const missingLines = Array.isArray(record.missing_lines) ? record.missing_lines.map(Number) : [];
    const summary = record.summary || {};
    const percentCovered = typeof summary.percent_covered === "number"
      ? summary.percent_covered
      : typeof summary.covered_lines === "number" && typeof summary.num_statements === "number" && summary.num_statements > 0
        ? (summary.covered_lines / summary.num_statements) * 100
        : null;

    return {
      file: normalizeCoveragePath(root, file),
      percentCovered,
      missingLines,
      missingLineCount: missingLines.length
    };
  });

  return {
    format: "coverage.py-json",
    files
  };
}

function parseLcov(text, root) {
  const files = [];
  let current = null;
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("SF:")) {
      current = {
        file: normalizeCoveragePath(root, line.slice(3)),
        lines: [],
        found: null,
        hit: null
      };
    } else if (line.startsWith("DA:") && current) {
      const [lineNumber, hitCount] = line.slice(3).split(",").map(Number);
      current.lines.push({ line: lineNumber, hits: hitCount });
    } else if (line.startsWith("LF:") && current) {
      current.found = Number(line.slice(3));
    } else if (line.startsWith("LH:") && current) {
      current.hit = Number(line.slice(3));
    } else if (line === "end_of_record" && current) {
      const found = current.found ?? current.lines.length;
      const hit = current.hit ?? current.lines.filter((item) => item.hits > 0).length;
      const missingLines = current.lines.filter((item) => item.hits === 0).map((item) => item.line);
      files.push({
        file: current.file,
        percentCovered: found > 0 ? (hit / found) * 100 : null,
        missingLines,
        missingLineCount: missingLines.length
      });
      current = null;
    }
  }

  return {
    format: "lcov",
    files
  };
}

function summarizeCoverage(files) {
  const coveredFiles = files.filter((file) => typeof file.percentCovered === "number");
  const averagePercentCovered = coveredFiles.length === 0
    ? null
    : coveredFiles.reduce((sum, file) => sum + file.percentCovered, 0) / coveredFiles.length;
  return {
    totalFiles: files.length,
    filesWithMissingLines: files.filter((file) => file.missingLineCount > 0).length,
    averagePercentCovered
  };
}

function sumMissingLines(report) {
  return (report?.files || []).reduce((sum, file) => sum + file.missingLineCount, 0);
}

function roundMetric(value) {
  return typeof value === "number" ? Math.round(value * 100) / 100 : null;
}

export function compareCoverageReports(before, after) {
  if (!before || !after) return null;
  const beforeByFile = new Map(before.files.map((file) => [file.file, file]));
  const afterByFile = new Map(after.files.map((file) => [file.file, file]));
  const files = [...new Set([...beforeByFile.keys(), ...afterByFile.keys()])].sort().map((file) => {
    const beforeFile = beforeByFile.get(file) || null;
    const afterFile = afterByFile.get(file) || null;
    const percentDelta = typeof beforeFile?.percentCovered === "number" && typeof afterFile?.percentCovered === "number"
      ? afterFile.percentCovered - beforeFile.percentCovered
      : null;
    const missingLineDelta = (afterFile?.missingLineCount ?? 0) - (beforeFile?.missingLineCount ?? 0);
    return {
      file,
      beforePercentCovered: beforeFile?.percentCovered ?? null,
      afterPercentCovered: afterFile?.percentCovered ?? null,
      percentDelta: roundMetric(percentDelta),
      beforeMissingLineCount: beforeFile?.missingLineCount ?? null,
      afterMissingLineCount: afterFile?.missingLineCount ?? null,
      missingLineDelta,
      status: percentDelta > 0 || missingLineDelta < 0
        ? "improved"
        : percentDelta < 0 || missingLineDelta > 0
          ? "regressed"
          : "unchanged"
    };
  });

  const averagePercentDelta = typeof before.summary.averagePercentCovered === "number" && typeof after.summary.averagePercentCovered === "number"
    ? after.summary.averagePercentCovered - before.summary.averagePercentCovered
    : null;
  const beforeMissingLines = sumMissingLines(before);
  const afterMissingLines = sumMissingLines(after);

  return {
    status: "compared",
    beforeFormat: before.format,
    afterFormat: after.format,
    summary: {
      beforeAveragePercentCovered: roundMetric(before.summary.averagePercentCovered),
      afterAveragePercentCovered: roundMetric(after.summary.averagePercentCovered),
      averagePercentDelta: roundMetric(averagePercentDelta),
      beforeMissingLines,
      afterMissingLines,
      missingLinesReduced: beforeMissingLines - afterMissingLines,
      filesImproved: files.filter((file) => file.status === "improved").length,
      filesRegressed: files.filter((file) => file.status === "regressed").length,
      filesUnchanged: files.filter((file) => file.status === "unchanged").length
    },
    files
  };
}

export function parseCoverageReport(text, options = {}) {
  const root = options.root || process.cwd();
  const trimmed = text.trim();
  const parsed = trimmed.startsWith("{")
    ? parseCoverageJson(trimmed, root)
    : parseLcov(trimmed, root);
  const files = parsed.files.sort((a, b) =>
    (a.percentCovered ?? 101) - (b.percentCovered ?? 101) ||
    b.missingLineCount - a.missingLineCount ||
    a.file.localeCompare(b.file)
  );

  return {
    status: "parsed",
    format: parsed.format,
    summary: summarizeCoverage(files),
    files
  };
}

function loadCoverageInput(options, root, fileKey, textKey) {
  if (options[textKey]) return parseCoverageReport(options[textKey], { root });
  if (!options[fileKey]) return null;
  const coverageFile = path.isAbsolute(options[fileKey]) ? options[fileKey] : path.join(root, options[fileKey]);
  return parseCoverageReport(fs.readFileSync(coverageFile, "utf8"), { root });
}

function loadCoverage(options, root) {
  return loadCoverageInput(options, root, "coverageFile", "coverageText");
}

function loadCoverageAfter(options, root) {
  return loadCoverageInput(options, root, "coverageAfterFile", "coverageAfterText");
}

function pythonBehaviorAssertion(hint) {
  const call = `module.${hint.name}(${hint.args.map(pythonLiteral).join(", ")})`;
  if (hint.throws) {
    return `        with self.assertRaises(${hint.throws}):
            ${call}`;
  }
  return `        self.assertEqual(${call}, ${pythonLiteral(hint.expected)})`;
}

function jsErrorConstructor(errorName) {
  const builtIns = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]);
  return builtIns.has(errorName) ? errorName : "Error";
}

function jsBehaviorAssertion(hint) {
  const call = `mod.${hint.name}(${hint.args.map(jsLiteral).join(", ")})`;
  if (hint.throws) return `  assert.throws(() => ${call}, ${jsErrorConstructor(hint.throws)});`;
  return `  assert.equal(${call}, ${jsLiteral(hint.expected)});`;
}

function jsClassAssertion(name, candidate) {
  if (candidate.metadata?.directCommonJsClassExport === name) {
    return "  assert.equal(typeof mod, \"function\");";
  }
  if (candidate.metadata?.defaultExportedClasses?.includes(name)) {
    return `  assert.equal(typeof (mod.${name} || mod.default), "function");`;
  }
  return `  assert.equal(typeof mod.${name}, "function");`;
}

export function generateTestContent(candidate, options = {}) {
  const sourceFile = candidate.sourceFile.replace(/\\/g, "/");
  const testFile = candidate.suggestedTestFile.replace(/\\/g, "/");
  const functions = testTargetFunctions(candidate);
  const classes = testTargetClasses(candidate);
  const assertionHints = (candidate.metadata?.assertionHints || []).filter((hint) => functions.includes(hint.name));

  if (sourceFile.endsWith(".py")) {
    const relativeSource = relativeImport(testFile, sourceFile);
    const sourcePathSetup = Boolean(options.pythonSourcePathSetup);
    const assertions = [
      ...functions.map((name) => `        self.assertTrue(hasattr(module, "${name}"))`),
      ...classes.map((name) => `        self.assertTrue(hasattr(module, "${name}"))`)
    ].join("\n") || "        self.assertIsNotNone(module)";
    const behaviorAssertions = assertionHints.map(pythonBehaviorAssertion).join("\n");
    return `import importlib.util
import pathlib
${sourcePathSetup ? "import sys\n" : ""}import unittest


def load_module():
    source = pathlib.Path(__file__).resolve().parent / "${relativeSource}"
    source = source.resolve()
${sourcePathSetup ? `    source_dir = str(source.parent)
    if source_dir not in sys.path:
        sys.path.insert(0, source_dir)
` : ""}    spec = importlib.util.spec_from_file_location("target_module", source)
    spec = importlib.util.spec_from_file_location("target_module", source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GeneratedBehaviorTest(unittest.TestCase):
    def test_exports_expected_symbols(self):
        module = load_module()
${assertions}
${behaviorAssertions ? `\n    def test_covers_simple_behavior(self):\n        module = load_module()\n${behaviorAssertions}\n` : ""}


if __name__ == "__main__":
    unittest.main()
`;
  }

  if (sourceFile.endsWith(".java")) {
    const { packageName, className } = candidate.metadata || {};
    const packageLine = packageName ? `package ${packageName};\n\n` : "";
    return `${packageLine}import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNotNull;

class ${className}Test {
    @Test
    void symbolCanBeLoaded() {
        assertNotNull(${className}.class);
    }
}
`;
  }

  const importPath = relativeImport(testFile, sourceFile);
  const assertions = [
    ...functions.map((name) => `  assert.equal(typeof mod.${name}, "function");`),
    ...classes.map((name) => jsClassAssertion(name, candidate))
  ].join("\n") || "  assert.ok(mod);";
  const behaviorAssertions = assertionHints.map(jsBehaviorAssertion).join("\n");
  if (candidate.metadata?.moduleSystem === "commonjs") {
    return `const test = require("node:test");
const assert = require("node:assert/strict");
const mod = require("${importPath}");

test("exports expected functions and classes", () => {
${assertions}
});
${behaviorAssertions ? `\ntest("covers simple behavior", () => {\n${behaviorAssertions}\n});\n` : ""}
`;
  }

  return `import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "${importPath}";

test("exports expected functions and classes", () => {
${assertions}
});
${behaviorAssertions ? `\ntest("covers simple behavior", () => {\n${behaviorAssertions}\n});\n` : ""}
`;
}

function defaultTestArgv(candidate, repo) {
  const testFile = candidate.suggestedTestFile;
  const sourceFile = candidate.sourceFile;
  const extension = path.extname(sourceFile);

  if (extension === ".py") return ["python", "-m", "unittest", testFile];
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ["node", "--test", testFile];
  if (extension === ".java") {
    if (repo.suggestedCommands.includes("mvn test")) return ["mvn", "test"];
    if (repo.suggestedCommands.includes("./gradlew test")) return ["./gradlew", "test"];
  }
  return null;
}

function customTestCommand(command, candidate) {
  return command
    .replaceAll("{testFile}", candidate.suggestedTestFile)
    .replaceAll("{sourceFile}", candidate.sourceFile);
}

function buildRepairPlan(category, result, evidence) {
  const command = result.command || null;
  const common = {
    status: "needs_repair",
    category,
    safeToAutoRetry: false,
    command,
    evidence,
    guardrails: [
      "Do not delete assertions, skip tests, or lower coverage thresholds to make generated tests pass.",
      "Any production-code fix must pass Policy-as-Code checks before it is applied."
    ]
  };
  const plans = {
    module_system_mismatch: {
      safeToAutoRetry: true,
      actions: [
        "Regenerate only the generated test file with the detected ESM/CommonJS module system.",
        "Check package.json type plus .mjs/.cjs/.js extensions before choosing import or require.",
        command ? `Rerun ${command} after regenerating the test file.` : "Rerun the smallest generated test command after regenerating the test file."
      ]
    },
    python_local_import_path: {
      safeToAutoRetry: true,
      actions: [
        "Regenerate only the generated Python test file with the source directory added to sys.path before loading the target module.",
        "Do not modify production code or install dependencies for this retry.",
        command ? `Rerun ${command} after regenerating the generated test file.` : "Rerun the generated Python unittest after regenerating the test file."
      ]
    },
    missing_module_or_bad_import: {
      actions: [
        "Verify the generated relative import path from the test file to the source file.",
        "Check whether the source module has import-time dependencies or package aliases that need test setup.",
        "Install missing test dependencies only after command policy and human confirmation allow it."
      ]
    },
    missing_test_runner: {
      actions: [
        "Pass a repository-specific --test-command that exists in this workspace.",
        "If installing a runner is required, run the package-manager command only after policy confirmation.",
        "Rerun the generated test through VibeGuard command policy."
      ]
    },
    assertion_failed: {
      actions: [
        "Inspect the generated assertion inputs and the source behavior side by side.",
        "If the assertion reflects intended behavior, fix the source bug through the debug/fix workflow.",
        "If the assertion is wrong, update the generated test to a stronger correct assertion instead of weakening coverage."
      ]
    },
    runtime_error: {
      actions: [
        "Inspect the stack trace and identify whether failure happens during import, setup, or function execution.",
        "Add required setup or mocks for IO, database, environment, and dependency-injection boundaries.",
        "If the runtime error is a source bug, route it through the debug/fix workflow with the failing command."
      ]
    },
    unknown_failure: {
      actions: [
        "Read stdout and stderr from the generated test run.",
        "Rerun the smallest failing command after correcting test setup or source behavior.",
        "Escalate to manual review if the failure needs IO, database, network, or framework-specific fixtures."
      ]
    }
  };

  return {
    ...common,
    ...(plans[category] || plans.unknown_failure)
  };
}

function analyzeTestFailure(result, candidate = null) {
  if (result.status !== "failed" && result.status !== "blocked") return null;
  const output = `${result.error || ""}\n${result.stderr || ""}\n${result.stdout || ""}`;
  const rules = [
    {
      pattern: /ModuleNotFoundError:\s+No module named ['"][^'"]+['"]/i,
      category: "python_local_import_path",
      nextAction: "Regenerate the generated Python test with the source directory on sys.path before loading the target module.",
      matches: () => candidate?.sourceFile?.endsWith(".py")
    },
    {
      pattern: /Cannot use import statement outside a module|Unexpected token 'export'|require is not defined in ES module scope/i,
      category: "module_system_mismatch",
      nextAction: "Regenerate the test with the correct ESM/CommonJS module system or adjust package.json type/module extension."
    },
    {
      pattern: /ERR_MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|No module named/i,
      category: "missing_module_or_bad_import",
      nextAction: "Check the generated import path, test location, and whether required test dependencies are installed."
    },
    {
      pattern: /pytest:.*not recognized|No module named pytest|pytest.*not found/i,
      category: "missing_test_runner",
      nextAction: "Install/enable the expected test runner or pass a custom --test-command that exists in this repository."
    },
    {
      pattern: /AssertionError|assertion/i,
      category: "assertion_failed",
      nextAction: "Inspect the assertion and source behavior; prefer strengthening the test or fixing the source bug instead of weakening assertions."
    },
    {
      pattern: /ReferenceError|TypeError|NameError|AttributeError|NullPointerException/i,
      category: "runtime_error",
      nextAction: "Inspect the stack trace and inputs used by the generated test; the source may have import-time side effects or missing setup."
    }
  ];
  const matched = rules.find((rule) => rule.pattern.test(output) && (!rule.matches || rule.matches(output, result, candidate)));
  const category = matched?.category || "unknown_failure";
  const lines = output.split(/\r?\n/);
  const evidence = (matched
    ? lines.find((line) => matched.pattern.test(line))
    : lines.find((line) => line.trim()))?.trim() || null;
  return {
    category,
    nextAction: matched?.nextAction || "Inspect stdout/stderr and rerun the smallest failing test command after correcting the generated test or setup.",
    evidence,
    repairPlan: buildRepairPlan(category, result, evidence)
  };
}

function runGeneratedTest(root, candidate, engine, repo, options = {}) {
  const common = {
    sourceFile: candidate.sourceFile,
    testFile: candidate.suggestedTestFile
  };
  try {
    if (options.testCommand) {
      const result = {
        ...common,
        ...runCommandWithPolicy(root, customTestCommand(options.testCommand, candidate), engine, {
          confirmed: options.confirmed,
          dryRun: options.dryRun
        })
      };
      return {
        ...result,
        failureAnalysis: analyzeTestFailure(result, candidate)
      };
    }

    const argv = defaultTestArgv(candidate, repo);
    if (!argv) {
      return {
        ...common,
        status: "skipped",
        reason: "No default test command is available for this candidate"
      };
    }

    const result = {
      ...common,
      ...runArgvWithPolicy(root, argv, engine, {
        confirmed: options.confirmed,
        dryRun: options.dryRun
      })
    };
    return {
      ...result,
      failureAnalysis: analyzeTestFailure(result, candidate)
    };
  } catch (error) {
    const argv = options.testCommand ? null : defaultTestArgv(candidate, repo);
    const result = {
      ...common,
      status: "blocked",
      command: options.testCommand ? customTestCommand(options.testCommand, candidate) : argv ? commandDisplay(argv) : undefined,
      error: error.message
    };
    return {
      ...result,
      failureAnalysis: analyzeTestFailure(result, candidate)
    };
  }
}

function moduleSystemRepairCandidate(candidate, failedRun) {
  const output = `${failedRun.error || ""}\n${failedRun.stderr || ""}\n${failedRun.stdout || ""}`;
  const moduleSystem = /require is not defined in ES module scope/i.test(output) ? "esm" : "commonjs";
  return {
    ...candidate,
    metadata: {
      ...(candidate.metadata || {}),
      moduleSystem
    }
  };
}

function repairGeneratedTest(root, candidate, failedRun, engine, repo, options = {}) {
  if (!failedRun || (failedRun.status !== "failed" && failedRun.status !== "blocked")) return null;
  const analysis = failedRun.failureAnalysis;
  const category = analysis?.category || "unknown_failure";
  const base = {
    sourceFile: candidate.sourceFile,
    testFile: candidate.suggestedTestFile,
    initialStatus: failedRun.status,
    category,
    evidence: analysis?.evidence || null
  };

  if (!analysis?.repairPlan?.safeToAutoRetry) {
    return {
      ...base,
      status: "skipped",
      reason: "repair_plan_not_safe"
    };
  }

  try {
    if (category === "python_local_import_path") {
      const written = writeFileWithPolicy(root, candidate.suggestedTestFile, generateTestContent(candidate, {
        pythonSourcePathSetup: true
      }), engine, options);
      const testRun = runGeneratedTest(root, candidate, engine, repo, options);
      return {
        ...base,
        status: testRun.status === "passed" ? "repaired" : "failed",
        strategy: "python_source_dir_sys_path",
        written,
        testRun
      };
    }

    if (category === "module_system_mismatch") {
      const repairedCandidate = moduleSystemRepairCandidate(candidate, failedRun);
      const written = writeFileWithPolicy(root, candidate.suggestedTestFile, generateTestContent(repairedCandidate), engine, options);
      const testRun = runGeneratedTest(root, repairedCandidate, engine, repo, options);
      return {
        ...base,
        status: testRun.status === "passed" ? "repaired" : "failed",
        strategy: `regenerate_${repairedCandidate.metadata.moduleSystem}_test`,
        written,
        testRun
      };
    }
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      reason: error.message
    };
  }

  return {
    ...base,
    status: "skipped",
    reason: "unsupported_repair_category"
  };
}

function mergeRepairedRuns(initialRuns, repairRuns) {
  return initialRuns.map((run, index) => {
    const repair = repairRuns[index];
    if (!repair?.testRun) return run;
    const { testRun, ...repairSummary } = repair;
    return {
      ...testRun,
      repaired: repair.status === "repaired",
      initialStatus: run.status,
      initialFailureAnalysis: run.failureAnalysis,
      repair: repairSummary
    };
  });
}

function coverageTargets(candidates) {
  return candidates
    .filter((candidate) => candidate.coverage?.missingLineCount > 0)
    .map((candidate) => ({
      sourceFile: candidate.sourceFile,
      suggestedTestFile: candidate.suggestedTestFile,
      missingLineCount: candidate.coverage.missingLineCount,
      missingLines: candidate.coverage.missingLines,
      percentCovered: candidate.coverage.percentCovered,
      uncoveredFunctions: candidate.uncoveredFunctions,
      uncoveredClasses: candidate.uncoveredClasses,
      uncoveredInterfaces: candidate.uncoveredInterfaces
    }));
}

function buildTestWriterPrBody(written, testRuns) {
  const files = written.map((item) => `- ${item.path}`).join("\n") || "- No generated tests";
  const validation = testRuns.length === 0
    ? "- [ ] Generated tests were not run"
    : testRuns.map((run) => `- [${run.status === "passed" ? "x" : " "}] ${run.command || run.testFile}: ${run.status}`).join("\n");

  return `## Summary

VibeGuard generated focused tests for uncovered or untested code.

## Generated Tests

${files}

## Validation

${validation}

## Policy

- [ ] Generated files passed Policy-as-Code checks
- [ ] Git/PR plan reviewed before execution
`;
}

function buildTestWriterGitPlan(written, testRuns, options = {}) {
  const changedFiles = written.map((item) => item.path);
  if (changedFiles.length === 0) return null;
  if (!options.createBranch && !options.commit && !options.push && !options.prDryRun && !options.createPr) return null;

  return buildFixGitPlan({
    changedFiles,
    branch: options.branch || "codex/add-generated-tests",
    commitMessage: options.commitMessage || "test: add generated coverage tests",
    title: options.prTitle || "Add generated tests",
    body: options.prBody || buildTestWriterPrBody(written, testRuns),
    bodyFile: options.prBodyFile,
    createBranch: Boolean(options.createBranch),
    commit: Boolean(options.commit),
    push: Boolean(options.push),
    prDryRun: Boolean(options.prDryRun || options.createPr)
  });
}

function buildTestWriterGitExecution(root, gitPlan, gitPolicy, testRuns, engine, options = {}) {
  if (!options.executeGitPlan || !gitPlan) return null;
  if (gitPolicy?.status !== "allow") {
    return {
      status: gitPolicy?.status || "blocked",
      stage: "git_plan_policy",
      policy: gitPolicy,
      results: []
    };
  }
  if (!options.runTests) {
    return {
      status: "blocked",
      stage: "test_validation",
      reason: "--execute-git-plan requires --run so generated tests are validated before Git state changes.",
      results: []
    };
  }
  const failingRuns = testRuns.filter((run) => run.status !== "passed");
  if (failingRuns.length > 0) {
    return {
      status: "failed",
      stage: "test_validation",
      reason: "Generated tests must pass before Git plan execution.",
      failingRuns,
      results: []
    };
  }
  return executeGitPlan(root, gitPlan, engine, {
    confirmed: Boolean(options.confirmed)
  });
}

function hasRuntimeTestTargets(candidate) {
  if (candidate.functions?.length > 0 || candidate.classes?.length > 0) return true;
  return candidate.sourceFile.endsWith(".java") && candidate.interfaces?.length > 0;
}

export function analyzeTestTargets(options = {}) {
  const root = options.root || process.cwd();
  const files = listRepoFiles(root);
  const repo = scanRepository(root);
  const coverage = loadCoverage(options, root);
  const coverageAfter = loadCoverageAfter(options, root);
  const coverageByFile = new Map((coverage?.files || []).map((item) => [item.file, item]));
  const sourceFiles = files.filter((file) =>
    !/(^|\/)(test|tests|__tests__)\//.test(file) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
    (file.endsWith(".py") || file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs") || file.endsWith(".ts") || file.endsWith(".java"))
  );

  const candidates = [];
  for (const file of sourceFiles) {
    const text = readTextIfExists(root, file);
    if (!text) continue;
    const isPython = file.endsWith(".py");
    const isJava = file.endsWith(".java");
    const isJavaScript = !isPython && !isJava;
    const functions = isPython ? extractPythonFunctions(text) : isJava ? extractJavaMethods(text) : extractJavaScriptFunctions(text);
    const functionRanges = isPython ? extractPythonFunctionRanges(text) : isJava ? extractJavaMethodRanges(text) : extractJavaScriptFunctionRanges(text);
    const classes = isPython ? extractPythonClasses(text) : isJava ? extractJavaClasses(text) : extractJavaScriptClasses(text);
    const classRanges = isPython ? extractPythonClassRanges(text) : isJava ? extractJavaClassRanges(text) : extractJavaScriptClassRanges(text);
    const interfaces = isJava ? extractJavaInterfaces(text) : file.endsWith(".ts") ? extractTypeScriptInterfaces(text) : [];
    const interfaceRanges = isJava ? extractJavaInterfaceRanges(text) : file.endsWith(".ts") ? extractTypeScriptInterfaceRanges(text) : [];
    if (functions.length === 0 && classes.length === 0 && interfaces.length === 0) continue;
    const testPath = candidateTestPath(file);
    const hasLikelyTest = testPath ? files.includes(testPath) : false;
    const fileCoverage = coverageByFile.get(file) || null;
    candidates.push({
      sourceFile: file,
      functions,
      functionRanges,
      uncoveredFunctions: uncoveredFunctions(functionRanges, fileCoverage),
      classes,
      classRanges,
      uncoveredClasses: uncoveredNames(classRanges, fileCoverage),
      interfaces,
      interfaceRanges,
      uncoveredInterfaces: uncoveredNames(interfaceRanges, fileCoverage),
      suggestedTestFile: testPath,
      hasLikelyTest,
      coverage: fileCoverage,
      metadata: isJava
        ? javaMetadata(text, file)
        : isJavaScript
          ? javaScriptMetadata(text, file, classes)
          : { assertionHints: inferPythonAssertions(text) }
    });
  }

  const sortedCandidates = candidates.sort((a, b) =>
    Number(Boolean(b.coverage?.missingLineCount)) - Number(Boolean(a.coverage?.missingLineCount)) ||
    (a.coverage?.percentCovered ?? 101) - (b.coverage?.percentCovered ?? 101) ||
    Number(a.hasLikelyTest) - Number(b.hasLikelyTest) ||
    a.sourceFile.localeCompare(b.sourceFile)
  );

  return {
    frameworkHints: repo.suggestedCommands,
    coverage,
    coverageAfter,
    coverageDelta: compareCoverageReports(coverage, coverageAfter),
    coverageTargets: coverageTargets(sortedCandidates),
    candidates: sortedCandidates
  };
}

export function writeSuggestedTests(root, engine, options = {}) {
  const analysis = analyzeTestTargets({
    root,
    coverageFile: options.coverageFile,
    coverageText: options.coverageText,
    coverageAfterFile: options.coverageAfterFile,
    coverageAfterText: options.coverageAfterText
  });
  const limit = Number(options.limit || 1);
  const writable = analysis.candidates
    .filter((candidate) => candidate.suggestedTestFile && !candidate.hasLikelyTest && hasRuntimeTestTargets(candidate))
    .slice(0, limit);
  const written = writable.map((candidate) =>
    writeFileWithPolicy(root, candidate.suggestedTestFile, generateTestContent(candidate), engine, options)
  );
  const repo = { suggestedCommands: analysis.frameworkHints };
  const initialTestRuns = options.runTests
    ? writable.map((candidate) => runGeneratedTest(root, candidate, engine, repo, options))
    : [];
  const repairRuns = options.runTests && options.repairFailures
    ? writable.map((candidate, index) => repairGeneratedTest(root, candidate, initialTestRuns[index], engine, repo, options))
    : [];
  const hasRepairRuns = repairRuns.some(Boolean);
  const testRuns = hasRepairRuns
    ? mergeRepairedRuns(initialTestRuns, repairRuns)
    : initialTestRuns;
  const gitPlan = buildTestWriterGitPlan(written, testRuns, options);
  const gitPolicy = gitPlan
    ? checkGitPlanPolicy(gitPlan, engine, { confirmed: Boolean(options.confirmed) })
    : null;
  const gitExecution = buildTestWriterGitExecution(root, gitPlan, gitPolicy, testRuns, engine, options);
  const result = {
    ...analysis,
    written,
    testRuns,
    gitPlan,
    gitPolicy,
    gitExecution
  };
  if (hasRepairRuns) {
    result.initialTestRuns = initialTestRuns;
    result.repairRuns = repairRuns;
  }
  return result;
}
