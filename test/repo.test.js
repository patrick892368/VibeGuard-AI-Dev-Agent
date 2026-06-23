import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { scanRepository } from "../src/repo/scan.js";
import { analyzeTestTargets } from "../src/agents/testWriter.js";
import { analyzeRepository, buildOnboardingMarkdown } from "../src/agents/onboard.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-repo-"));
}

test("scanRepository detects JavaScript project metadata", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: { express: "^1.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "src", "index.js"), "export function run() {}\n", "utf8");
  fs.writeFileSync(path.join(root, "test", "index.test.js"), "import test from 'node:test';\n", "utf8");

  const scan = scanRepository(root);
  assert.ok(scan.languages.includes("JavaScript"));
  assert.ok(scan.frameworks.includes("Express"));
  assert.ok(scan.suggestedCommands.includes("npm test"));
  assert.ok(scan.entrypoints.includes("src/index.js"));
});

test("analyzeTestTargets finds source functions without likely tests", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");

  const result = analyzeTestTargets({ root });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceFile, "src/math.js");
  assert.deepEqual(result.candidates[0].functions, ["add"]);
});

test("analyzeTestTargets finds Java methods and suggested JUnit path", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "Calculator.java"), `package com.example;

public class Calculator {
  public int add(int a, int b) {
    return a + b;
  }
}
`, "utf8");

  const result = analyzeTestTargets({ root });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].suggestedTestFile, "src/test/java/com/example/CalculatorTest.java");
  assert.deepEqual(result.candidates[0].functions, ["add"]);
  assert.equal(result.candidates[0].metadata.className, "Calculator");
});

test("buildOnboardingMarkdown includes command and architecture sections", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  const result = analyzeRepository({ root });
  const markdown = buildOnboardingMarkdown(result.scan);

  assert.match(markdown, /Repository Onboarding/);
  assert.match(markdown, /Suggested Commands/);
  assert.match(markdown, /mermaid/);
});
