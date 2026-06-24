import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, mcpInternals } from "../src/mcp/server.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-mcp-"));
}

test("MCP tools expose input schemas", () => {
  for (const tool of mcpInternals.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description);
  }
});

test("MCP initialize returns server info and tool capabilities", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  }, tempRepo());

  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.serverInfo.name, "vibeguard-ai-dev-agent");
  assert.ok(response.result.capabilities.tools);
});

test("MCP tools/call returns text content and structured content", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "check_policy",
      arguments: { path: "src/index.js" }
    }
  }, tempRepo());

  assert.equal(response.result.content[0].type, "text");
  assert.equal(JSON.parse(response.result.content[0].text).status, "allow");
  assert.equal(response.result.structuredContent.status, "allow");
});

test("MCP initialized notification does not produce a response", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, tempRepo());

  assert.equal(response, null);
});
