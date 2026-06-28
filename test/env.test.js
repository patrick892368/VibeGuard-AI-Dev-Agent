import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeEnv, parseDotEnv, parseGitConfig } from "../src/config/env.js";

test("parseDotEnv parses basic dotenv syntax", () => {
  const parsed = parseDotEnv(`
# comment
XAI_API_KEY=xai-secret
export VIBEGUARD_LLM_PROVIDER=grok
QUOTED="hello world"
`);

  assert.equal(parsed.XAI_API_KEY, "xai-secret");
  assert.equal(parsed.VIBEGUARD_LLM_PROVIDER, "grok");
  assert.equal(parsed.QUOTED, "hello world");
});

test("parseGitConfig parses proxy values without running git", () => {
  const parsed = parseGitConfig(`
[http]
  proxy = http://127.0.0.1:10809
[https]
  proxy = "http://127.0.0.1:10809"
`);

  assert.equal(parsed["http.proxy"], "http://127.0.0.1:10809");
  assert.equal(parsed["https.proxy"], "http://127.0.0.1:10809");
});

test("loadRuntimeEnv loads .env unless disabled and keeps process env precedence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-env-"));
  fs.writeFileSync(path.join(root, ".env"), "XAI_API_KEY=file-secret\nVIBEGUARD_MODEL=grok-4.3\n", "utf8");

  const loaded = loadRuntimeEnv(root, { XAI_API_KEY: "process-secret" });
  assert.equal(loaded.XAI_API_KEY, "process-secret");
  assert.equal(loaded.VIBEGUARD_MODEL, "grok-4.3");

  const disabled = loadRuntimeEnv(root, { VIBEGUARD_DISABLE_DOTENV: "1" });
  assert.equal(disabled.XAI_API_KEY, undefined);
});

test("loadRuntimeEnv falls back to git proxy config for provider requests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-env-proxy-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), `[http]
  proxy = http://127.0.0.1:10809
[https]
  proxy = http://127.0.0.1:10809
`, "utf8");

  const loaded = loadRuntimeEnv(root, {});
  assert.equal(loaded.HTTP_PROXY, "http://127.0.0.1:10809");
  assert.equal(loaded.HTTPS_PROXY, "http://127.0.0.1:10809");

  const explicit = loadRuntimeEnv(root, { HTTPS_PROXY: "http://proxy.example:8080" });
  assert.equal(explicit.HTTPS_PROXY, "http://proxy.example:8080");
});
