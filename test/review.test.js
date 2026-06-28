import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeReviewDiff, publishReviewComment, writeReviewComment } from "../src/agents/review.js";
import { PolicyEngine } from "../src/policy/engine.js";

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
  assert.ok(result.reviewComments.some((comment) =>
    comment.path === "src/db.js" &&
    comment.line === 2 &&
    comment.side === "RIGHT" &&
    /parameterized queries/.test(comment.body)
  ));
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

test("analyzeReviewDiff flags shell injection risks", () => {
  const diff = `diff --git a/src/tasks.js b/src/tasks.js
--- a/src/tasks.js
+++ b/src/tasks.js
@@ -1 +1,3 @@
 export function run(name) {}
+execSync("deploy " + name)
+spawn("sh", ["-c", command], { shell: true })
diff --git a/src/jobs.py b/src/jobs.py
--- a/src/jobs.py
+++ b/src/jobs.py
@@ -1 +1,2 @@
+subprocess.run(command, shell=True)
+os.system(command)
`;

  const result = analyzeReviewDiff(diff);
  const shellFindings = result.findings.filter((finding) => finding.message.includes("Shell injection risk"));

  assert.equal(shellFindings.length, 4);
  assert.ok(shellFindings.every((finding) => finding.severity === "high"));
  assert.ok(result.actionItems.some((item) => /policy-gated runner/.test(item.action)));
});

test("analyzeReviewDiff flags SSRF, TLS, weak hash, and insecure randomness risks", () => {
  const diff = `diff --git a/src/http.js b/src/http.js
--- a/src/http.js
+++ b/src/http.js
@@ -1 +1,6 @@
 export async function proxy(req) {}
+fetch(req.query.url)
+axios.get(req.body.callbackUrl)
+const token = Math.random().toString(36)
+createHash("md5").update(password).digest("hex")
+https.get(target, { rejectUnauthorized: false })
diff --git a/src/security.py b/src/security.py
--- a/src/security.py
+++ b/src/security.py
@@ -1 +1,4 @@
+requests.get(request.args["url"], verify=False)
+hashlib.sha1(password.encode()).hexdigest()
+session_token = random.random()
`;

  const result = analyzeReviewDiff(diff);

  assert.ok(result.findings.some((finding) => finding.message.includes("Potential SSRF") && finding.severity === "high"));
  assert.ok(result.findings.some((finding) => finding.message.includes("TLS certificate verification") && finding.severity === "high"));
  assert.ok(result.findings.some((finding) => finding.message.includes("Weak hash algorithm") && finding.severity === "medium"));
  assert.ok(result.findings.some((finding) => finding.message.includes("Insecure randomness") && finding.severity === "medium"));
  assert.ok(result.actionItems.some((item) => /allowlist/.test(item.action)));
  assert.ok(result.actionItems.some((item) => /certificate verification/.test(item.action)));
  assert.ok(result.actionItems.some((item) => /cryptographically secure random/.test(item.action)));
  assert.ok(result.reviewComments.some((comment) => comment.path === "src/http.js" && comment.line === 2 && /SSRF/.test(comment.body)));
});

test("analyzeReviewDiff flags Java process execution and SSRF risks", () => {
  const diff = `diff --git a/src/main/java/com/example/ProxyController.java b/src/main/java/com/example/ProxyController.java
--- a/src/main/java/com/example/ProxyController.java
+++ b/src/main/java/com/example/ProxyController.java
@@ -1 +1,5 @@
 public class ProxyController {}
+Runtime.getRuntime().exec("deploy " + request.getParameter("name"));
+new ProcessBuilder("sh", "-c", command).start();
+URI.create(request.getParameter("callbackUrl"));
+new ProcessBuilder("java", "-version").start();
`;

  const result = analyzeReviewDiff(diff);
  const shellFindings = result.findings.filter((finding) => finding.message.includes("Shell injection risk"));

  assert.equal(shellFindings.length, 2);
  assert.ok(shellFindings.every((finding) => finding.file.endsWith("ProxyController.java")));
  assert.ok(result.findings.some((finding) => finding.message.includes("Potential SSRF") && finding.line === 4));
  assert.ok(result.findings.some((finding) => finding.message.includes("Shell/process execution") && finding.line === 5));
  assert.ok(result.reviewComments.some((comment) => comment.path.endsWith("ProxyController.java") && /SSRF/.test(comment.body)));
});

test("analyzeReviewDiff flags bug-prone additions", () => {
  const diff = `diff --git a/src/cache.py b/src/cache.py
--- a/src/cache.py
+++ b/src/cache.py
@@ -1 +1,3 @@
+def collect(items=[]):
+    return items
+except: pass
diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1,3 @@
 export function run() {}
+if (ready = computeReady()) return ready
+try { run() } catch (error) {}
`;

  const result = analyzeReviewDiff(diff);
  const bugMessages = result.findings
    .filter((finding) => finding.category === "bug")
    .map((finding) => finding.message);

  assert.ok(bugMessages.some((message) => message.includes("Mutable default argument")));
  assert.ok(bugMessages.some((message) => message.includes("Assignment inside conditional")));
  assert.ok(bugMessages.some((message) => message.includes("Swallowed exception")));
  assert.ok(result.actionItems.some((item) => item.category === "bug" && /sentinel default/.test(item.action)));
  assert.ok(result.reviewComments.some((comment) => comment.category === "bug" && comment.path === "src/app.js"));
});

test("writeReviewComment writes markdown through policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-review-comment-"));
  const engine = new PolicyEngine({
    paths: { allow: ["reports/**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });
  const diff = `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`;

  const result = writeReviewComment(root, diff, "reports/review.md", engine);

  assert.equal(result.writtenComment.path, "reports/review.md");
  assert.equal(result.writtenComment.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, "reports", "review.md"), "utf8"), /VibeGuard Review/);
  assert.match(fs.readFileSync(path.join(root, "reports", "review.md"), "utf8"), /parameterized queries/);
});

test("publishReviewComment returns a policy-gated dry-run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-review-publish-"));
  const engine = new PolicyEngine({
    paths: { allow: ["reports/**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: ["gh pr comment"] }
  }, { root });
  const diff = `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`;

  const result = await publishReviewComment(root, diff, engine, { pr: "12" });

  assert.equal(result.status, "dry_run");
  assert.equal(result.commandPolicy.status, "require_confirmation");
  assert.equal(result.review.reviewComments.length, 1);
  assert.match(result.publish.command, /gh pr comment 12/);
});
