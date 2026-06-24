import test from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/policy/engine.js";
import { defaultConfig } from "../src/config/defaultConfig.js";

const config = {
  paths: {
    allow: ["src/**", "test/**", "README.md"],
    deny: [".env", ".git/**"],
    require_confirmation: [".github/workflows/**", "migrations/**", "package-lock.json"]
  },
  commands: {
    deny: ["rm -rf", "git reset --hard"],
    require_confirmation: ["npm install", "python manage.py migrate"]
  }
};

test("PolicyEngine allows configured source paths", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkPath("src/index.js").status, "allow");
});

test("PolicyEngine denies sensitive paths", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkPath(".env").status, "deny");
  assert.equal(engine.checkPath(".git/config").status, "deny");
});

test("default policy allows log artifacts but still denies .env", () => {
  const engine = new PolicyEngine(defaultConfig, { root: process.cwd() });
  assert.equal(engine.checkPath("error.log", "read").status, "allow");
  assert.equal(engine.checkPath("logs/error.log", "read").status, "allow");
  assert.equal(engine.checkPath(".env", "read").status, "deny");
});

test("PolicyEngine requires confirmation for configured paths", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkPath(".github/workflows/ci.yml").status, "require_confirmation");
});

test("PolicyEngine denies paths outside allow list", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkPath("scripts/deploy.sh").status, "deny");
});

test("PolicyEngine denies paths that escape the repository root", () => {
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root: process.cwd() });

  assert.equal(engine.checkPath("../outside.txt").status, "deny");
});

test("PolicyEngine checks command policy", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkCommand("npm test").status, "allow");
  assert.equal(engine.checkCommand("npm install").status, "require_confirmation");
  assert.equal(engine.checkCommand("git reset --hard").status, "deny");
});

test("PolicyEngine checks every file in a patch", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  const patch = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`;

  const result = engine.checkPatch(patch);
  assert.equal(result.status, "deny");
  assert.deepEqual(result.files, [".env", "src/app.js"]);
});

test("PolicyEngine denies patch files that escape the repository root", () => {
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root: process.cwd() });
  const patch = `diff --git a/../outside.txt b/../outside.txt
--- a/../outside.txt
+++ b/../outside.txt
@@ -1 +1 @@
-old
+new
`;

  const result = engine.checkPatch(patch);
  assert.equal(result.status, "deny");
  assert.deepEqual(result.files, ["../outside.txt"]);
});
