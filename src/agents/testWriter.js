import path from "node:path";
import { listRepoFiles, readTextIfExists } from "../repo/files.js";
import { scanRepository } from "../repo/scan.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

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

export function generateTestContent(candidate) {
  const sourceFile = candidate.sourceFile.replace(/\\/g, "/");
  const testFile = candidate.suggestedTestFile.replace(/\\/g, "/");
  const functions = candidate.functions;

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

export function analyzeTestTargets(options = {}) {
  const root = options.root || process.cwd();
  const files = listRepoFiles(root);
  const repo = scanRepository(root);
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
    if (functions.length === 0) continue;
    const testPath = candidateTestPath(file);
    const hasLikelyTest = testPath ? files.includes(testPath) : false;
    candidates.push({
      sourceFile: file,
      functions,
      suggestedTestFile: testPath,
      hasLikelyTest,
      metadata: isJava ? javaMetadata(text, file) : undefined
    });
  }

  return {
    frameworkHints: repo.suggestedCommands,
    candidates: candidates.sort((a, b) => Number(a.hasLikelyTest) - Number(b.hasLikelyTest) || a.sourceFile.localeCompare(b.sourceFile))
  };
}

export function writeSuggestedTests(root, engine, options = {}) {
  const analysis = analyzeTestTargets({ root });
  const limit = Number(options.limit || 1);
  const writable = analysis.candidates.filter((candidate) => candidate.suggestedTestFile && !candidate.hasLikelyTest).slice(0, limit);
  const written = writable.map((candidate) =>
    writeFileWithPolicy(root, candidate.suggestedTestFile, generateTestContent(candidate), engine, options)
  );
  return {
    ...analysis,
    written
  };
}
