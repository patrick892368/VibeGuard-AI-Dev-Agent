import test from "node:test";
import assert from "node:assert/strict";
import { parseYamlSubset } from "../src/config/yaml.js";

test("parseYamlSubset parses nested objects and arrays", () => {
  const parsed = parseYamlSubset(`
version: 1
paths:
  allow:
    - "src/**"
    - "test/**"
  deny:
    - ".env"
agents:
  debug:
    enabled: true
    auto_patch: false
`);

  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.paths.allow, ["src/**", "test/**"]);
  assert.deepEqual(parsed.paths.deny, [".env"]);
  assert.equal(parsed.agents.debug.enabled, true);
  assert.equal(parsed.agents.debug.auto_patch, false);
});

test("parseYamlSubset ignores comments outside quotes", () => {
  const parsed = parseYamlSubset(`
commands:
  deny:
    - "curl * | sh" # dangerous pipe
`);

  assert.deepEqual(parsed.commands.deny, ["curl * | sh"]);
});

test("parseYamlSubset parses inline empty arrays", () => {
  const parsed = parseYamlSubset(`
paths:
  require_confirmation: []
commands:
  require_confirmation: []
`);

  assert.deepEqual(parsed.paths.require_confirmation, []);
  assert.deepEqual(parsed.commands.require_confirmation, []);
});
