import test from "node:test";
import assert from "node:assert/strict";
import { analyzeReviewDiff } from "../src/agents/review.js";

test("analyzeReviewDiff reports risky source changes without tests", () => {
  const diff = `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`;

  const result = analyzeReviewDiff(diff);
  assert.equal(result.files.length, 1);
  assert.ok(result.findings.some((finding) => finding.category === "security" && finding.file === "src/db.js"));
  assert.ok(result.findings.some((finding) => finding.category === "testing"));
});

test("analyzeReviewDiff flags sensitive and deployment files", () => {
  const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
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

  const result = analyzeReviewDiff(diff);
  assert.ok(result.findings.some((finding) => finding.category === "deployment"));
  assert.ok(result.findings.some((finding) => finding.category === "security"));
});
