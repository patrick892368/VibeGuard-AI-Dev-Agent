import test from "node:test";
import assert from "node:assert/strict";
import { hookTemplate, listHooks } from "../src/integrations/hooks.js";
import { buildGhPrArgs, createPullRequestWithGh, parseGitHubRemote } from "../src/integrations/github.js";
import { buildPrSummary } from "../src/agents/pr.js";
import { generateDebugPatch } from "../src/llm/provider.js";

test("hook templates include pre-commit policy check", () => {
  assert.ok(listHooks().includes("pre-commit"));
  assert.match(hookTemplate("pre-commit"), /policy check/);
});

test("buildPrSummary returns GitHub-ready body", () => {
  const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  const result = buildPrSummary(diff);
  assert.match(result.body, /Changed Files/);
  assert.match(result.body, /src\/app.js/);
  assert.equal(result.review.files[0], "src/app.js");
});

test("generateDebugPatch is unavailable without provider env", async () => {
  const result = await generateDebugPatch({ summary: { type: "Error" } }, {});
  assert.equal(result.status, "unavailable");
});

test("generateDebugPatch fixture provider returns local patch text", async () => {
  const result = await generateDebugPatch({ summary: { type: "Error" } }, {
    VIBEGUARD_LLM_PROVIDER: "fixture",
    VIBEGUARD_FIXTURE_PATCH: "not a diff"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.patch, "not a diff");
});

test("generateDebugPatch uses Grok-compatible Responses API", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (endpoint, options) => {
    request = {
      endpoint,
      headers: options.headers,
      body: JSON.parse(options.body)
    };
    return {
      ok: true,
      async json() {
        return { output_text: "diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n" };
      }
    };
  };

  try {
    const result = await generateDebugPatch({ summary: { type: "ReferenceError" } }, {
      XAI_API_KEY: "xai-secret",
      VIBEGUARD_MODEL: "grok-test"
    });

    assert.equal(result.status, "ok");
    assert.equal(request.endpoint, "https://api.x.ai/v1/responses");
    assert.equal(request.headers.authorization, "Bearer xai-secret");
    assert.equal(request.body.model, "grok-test");
    assert.match(request.body.input[0].content, /unified diff/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseGitHubRemote supports https and ssh remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/patrick892368/VibeGuard-AI-Dev-Agent.git"), {
    owner: "patrick892368",
    repo: "VibeGuard-AI-Dev-Agent",
    url: "https://github.com/patrick892368/VibeGuard-AI-Dev-Agent"
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    url: "https://github.com/owner/repo"
  });
});

test("GitHub PR creation is dry-run by default", () => {
  assert.deepEqual(buildGhPrArgs({ title: "Fix bug", bodyFile: "pr.md", draft: true }), [
    "pr",
    "create",
    "--title",
    "Fix bug",
    "--body-file",
    "pr.md",
    "--draft"
  ]);
  const result = createPullRequestWithGh(process.cwd(), { title: "Fix bug" });
  assert.equal(result.status, "dry_run");
  assert.match(result.command, /gh pr create/);
});
