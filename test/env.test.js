import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeEnv, parseDotEnv } from "../src/config/env.js";

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

test("loadRuntimeEnv loads .env unless disabled and keeps process env precedence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-env-"));
  fs.writeFileSync(path.join(root, ".env"), "XAI_API_KEY=file-secret\nVIBEGUARD_MODEL=grok-4.3\n", "utf8");

  const loaded = loadRuntimeEnv(root, { XAI_API_KEY: "process-secret" });
  assert.equal(loaded.XAI_API_KEY, "process-secret");
  assert.equal(loaded.VIBEGUARD_MODEL, "grok-4.3");

  const disabled = loadRuntimeEnv(root, { VIBEGUARD_DISABLE_DOTENV: "1" });
  assert.equal(disabled.XAI_API_KEY, undefined);
});
