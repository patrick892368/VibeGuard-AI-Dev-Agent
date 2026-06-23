import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDebugLog, parseJavaStack, parseNodeStack, parsePythonTraceback } from "../src/agents/debug.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-debug-"));
}

test("parsePythonTraceback extracts in-repository frames", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n    missing\n", "utf8");
  const log = `Traceback (most recent call last):
  File "${path.join(root, "src", "app.py")}", line 2, in run
    missing
NameError: name 'missing' is not defined`;

  const frames = parsePythonTraceback(log, root);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, "src/app.py");
  assert.equal(frames[0].line, 2);
});

test("parseNodeStack extracts in-repository frames", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "throw new Error('x')\n", "utf8");
  const log = `TypeError: Cannot read properties of undefined
    at run (${path.join(root, "src", "app.js")}:10:5)`;

  const frames = parseNodeStack(log, root);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, "src/app.js");
  assert.equal(frames[0].line, 10);
});

test("analyzeDebugLog returns summary, files, snippets, and hints", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n    missing\n", "utf8");
  const log = `Traceback (most recent call last):
  File "${path.join(root, "src", "app.py")}", line 2, in run
    missing
NameError: name 'missing' is not defined`;

  const result = analyzeDebugLog(log, { root });
  assert.equal(result.summary.type, "NameError");
  assert.deepEqual(result.likelyFiles, ["src/app.py"]);
  assert.equal(result.snippets.length, 1);
  assert.ok(result.hints.some((hint) => hint.includes("missing import") || hint.includes("scope")));
});

test("parseJavaStack maps Java stack frames to repository files", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "App.java"), "class App {}\n", "utf8");
  const log = `Exception in thread "main" java.lang.NullPointerException: boom
    at com.example.App.run(App.java:12)`;

  const frames = parseJavaStack(log, root, ["src/main/java/com/example/App.java"]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].file, "src/main/java/com/example/App.java");
  assert.equal(frames[0].line, 12);

  const result = analyzeDebugLog(log, { root });
  assert.equal(result.summary.type, "java.lang.NullPointerException");
  assert.deepEqual(result.likelyFiles, ["src/main/java/com/example/App.java"]);
});
