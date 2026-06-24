import fs from "node:fs";
import path from "node:path";
import { listRepoFiles, readTextIfExists } from "../repo/files.js";
import { scanRepository } from "../repo/scan.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";
import { commandDisplay, runArgvWithPolicy, runCommandWithPolicy } from "../runner/safeCommand.js";

function extractPythonFunctions(text) {
  return [...text.matchAll(/^\s*def\s+([a-zA-Z_]\w*)\s*\(/gm)].map((match) => match[1]);
}

function extractJavaScriptFunctions(text) {
  const names = [];
  for (const match of text.matchAll(/export\s+function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) names.push(match[1]);
  for (const match of text.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) names.push(match[1]);
  for (const match of text.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) names.push(match[1]);
  return [...new Set(names)];
}

function extractJavaMethods(text) {
  return [...text.matchAll(/(?:public|private|protected)\s+(?:static\s+)?[\w.<>\[\]]+\s+([a-zA-Z_]\w*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => !["if", "for", "while", "switch", "catch"].includes(name));
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

function extractPythonFunctionRanges(text) {
  const starts = [...text.matchAll(/^\s*def\s+([a-zA-Z_]\w*)\s*\(/gm)]
    .map((match) => ({ name: match[1], line: lineNumberAt(text, match.index) }));
  return rangeFromStarts(starts, text.split(/\r?\n/).length);
}

function extractJavaScriptFunctionRanges(text) {
  const starts = [];
  const patterns = [
    /export\s+function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      starts.push({ name: match[1], line: lineNumberAt(text, match.index) });
    }
  }
  const unique = [...new Map(starts.sort((a, b) => a.line - b.line).map((item) => [`${item.name}:${item.line}`, item])).values()];
  return rangeFromStarts(unique, text.split(/\r?\n/).length);
}

function extractJavaMethodRanges(text) {
  const starts = [...text.matchAll(/(?:public|private|protected)\s+(?:static\s+)?[\w.<>\[\]]+\s+([a-zA-Z_]\w*)\s*\(/g)]
    .map((match) => ({ name: match[1], line: lineNumberAt(text, match.index) }))
    .filter((item) => !["if", "for", "while", "switch", "catch"].includes(item.name));
  return rangeFromStarts(starts, text.split(/\r?\n/).length);
}

function uncoveredFunctions(functionRanges, coverage) {
  if (!coverage?.missingLines?.length) return [];
  return functionRanges
    .filter((range) => coverage.missingLines.some((line) => line >= range.startLine && line <= range.endLine))
    .map((range) => range.name);
}

function testTargetFunctions(candidate) {
  return candidate.uncoveredFunctions?.length ? candidate.uncoveredFunctions : candidate.functions;
}

function javaMetadata(text, sourceFile) {
  const packageName = text.match(/^\s*package\s+([\w.]+);/m)?.[1] || "";
  const className = text.match(/\bclass\s+([A-Z]\w*)/)?.[1] || path.basename(sourceFile, ".java");
  return { packageName, className };
}

function candidateTestPath(sourceFile) {
  const extension = path.extname(sourceFile);
  const base = sourceFile.slice(0, -extension.length);
  if (extension === ".py") return `tests/test_${path.basename(base)}.py`;
  if ([".js", ".mjs", ".cjs", ".ts"].includes(extension)) return `${base}.test${extension === ".ts" ? ".ts" : ".js"}`;
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

export function generateTestContent(candidate) {
  const sourceFile = candidate.sourceFile.replace(/\\/g, "/");
  const testFile = candidate.suggestedTestFile.replace(/\\/g, "/");
  const functions = testTargetFunctions(candidate);

  if (sourceFile.endsWith(".py")) {
    const relativeSource = relativeImport(testFile, sourceFile);
    const assertions = functions.map((name) => `    assert hasattr(module, "${name}")`).join("\n");
    return `import importlib.util
import pathlib


def load_module():
    source = pathlib.Path(__file__).resolve().parent / "${relativeSource}"
    source = source.resolve()
    spec = importlib.util.spec_from_file_location("target_module", source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_exports_expected_functions():
    module = load_module()
${assertions}
`;
  }

  if (sourceFile.endsWith(".java")) {
    const { packageName, className } = candidate.metadata || {};
    const packageLine = packageName ? `package ${packageName};\n\n` : "";
    return `${packageLine}import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNotNull;

class ${className}Test {
    @Test
    void classCanBeLoaded() {
        assertNotNull(${className}.class);
    }
}
`;
  }

  const importPath = relativeImport(testFile, sourceFile);
  const assertions = functions.map((name) => `  assert.equal(typeof mod.${name}, "function");`).join("\n");
  return `import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "${importPath}";

test("exports expected functions", () => {
${assertions}
});
`;
}

function defaultTestArgv(candidate, repo) {
  const testFile = candidate.suggestedTestFile;
  const sourceFile = candidate.sourceFile;
  const extension = path.extname(sourceFile);

  if (extension === ".py") return ["python", "-m", "pytest", testFile];
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

function runGeneratedTest(root, candidate, engine, repo, options = {}) {
  const common = {
    sourceFile: candidate.sourceFile,
    testFile: candidate.suggestedTestFile
  };
  try {
    if (options.testCommand) {
      return {
        ...common,
        ...runCommandWithPolicy(root, customTestCommand(options.testCommand, candidate), engine, {
          confirmed: options.confirmed,
          dryRun: options.dryRun
        })
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

    return {
      ...common,
      ...runArgvWithPolicy(root, argv, engine, {
        confirmed: options.confirmed,
        dryRun: options.dryRun
      })
    };
  } catch (error) {
    const argv = options.testCommand ? null : defaultTestArgv(candidate, repo);
    return {
      ...common,
      status: "blocked",
      command: options.testCommand ? customTestCommand(options.testCommand, candidate) : argv ? commandDisplay(argv) : undefined,
      error: error.message
    };
  }
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
      uncoveredFunctions: candidate.uncoveredFunctions
    }));
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
    const functions = isPython ? extractPythonFunctions(text) : isJava ? extractJavaMethods(text) : extractJavaScriptFunctions(text);
    const functionRanges = isPython ? extractPythonFunctionRanges(text) : isJava ? extractJavaMethodRanges(text) : extractJavaScriptFunctionRanges(text);
    if (functions.length === 0) continue;
    const testPath = candidateTestPath(file);
    const hasLikelyTest = testPath ? files.includes(testPath) : false;
    const fileCoverage = coverageByFile.get(file) || null;
    candidates.push({
      sourceFile: file,
      functions,
      functionRanges,
      uncoveredFunctions: uncoveredFunctions(functionRanges, fileCoverage),
      suggestedTestFile: testPath,
      hasLikelyTest,
      coverage: fileCoverage,
      metadata: isJava ? javaMetadata(text, file) : undefined
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
  const writable = analysis.candidates.filter((candidate) => candidate.suggestedTestFile && !candidate.hasLikelyTest).slice(0, limit);
  const written = writable.map((candidate) =>
    writeFileWithPolicy(root, candidate.suggestedTestFile, generateTestContent(candidate), engine, options)
  );
  const testRuns = options.runTests
    ? writable.map((candidate) => runGeneratedTest(root, candidate, engine, { suggestedCommands: analysis.frameworkHints }, options))
    : [];
  return {
    ...analysis,
    written,
    testRuns
  };
}
