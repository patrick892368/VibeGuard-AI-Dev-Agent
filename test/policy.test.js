import test from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/policy/engine.js";

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

test("PolicyEngine requires confirmation for configured paths", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkPath(".github/workflows/ci.yml").status, "require_confirmation");
});

test("PolicyEngine denies paths outside allow list", () => {
  const engine = new PolicyEngine(config, { root: process.cwd() });
  assert.equal(engine.checkPath("scripts/deploy.sh").status, "deny");
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
