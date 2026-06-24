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
  assert.ok(result.findings.some((finding) => finding.category === "security" && finding.line === 2));
  assert.ok(result.findings.some((finding) => finding.category === "testing"));
  assert.ok(result.findings.some((finding) => /parameterized queries/.test(finding.recommendation)));
  assert.ok(result.actionItems.some((item) => item.file === "src/db.js" && /parameterized queries/.test(item.action)));
  assert.equal(result.summaryBySeverity.high, 1);
  assert.equal(result.summaryBySeverity.medium, 1);
  assert.match(result.markdown, /VibeGuard Review/);
  assert.match(result.markdown, /src\/db\.js:2/);
  assert.match(result.markdown, /Recommendation: Use parameterized queries/);
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

test("analyzeReviewDiff flags secret literals, html sinks, and sync filesystem calls", () => {
  const diff = `diff --git a/src/view.js b/src/view.js
--- a/src/view.js
+++ b/src/view.js
@@ -10,2 +10,5 @@
 export function render(el, html) {
+  const token = "abcdefghijklmnop"
+  el.innerHTML = html
+  fs.readFileSync("data.json", "utf8")
 }
`;

  const result = analyzeReviewDiff(diff);
  assert.ok(result.findings.some((finding) => finding.message.includes("Secret-looking literal") && finding.line === 11));
  assert.ok(result.findings.some((finding) => finding.message.includes("HTML injection") && finding.line === 12));
  assert.ok(result.findings.some((finding) => finding.category === "performance" && finding.line === 13));
  assert.ok(result.actionItems.some((item) => /HTML sink/.test(item.action)));
});
