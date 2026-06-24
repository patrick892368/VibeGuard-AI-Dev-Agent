import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/agents/doctor.js";

test("runDoctor reports readiness without exposing provider secrets", () => {
  const result = runDoctor({
    root: process.cwd(),
    env: {
      VIBEGUARD_LLM_PROVIDER: "grok",
      XAI_API_KEY: "secret-value",
      VIBEGUARD_MODEL: "grok-test",
      VIBEGUARD_HTTPS_PROXY: "http://127.0.0.1:10809"
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider.provider, "grok");
  assert.equal(result.provider.hasGrokKey, true);
  assert.equal(result.provider.model, "grok-test");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});
