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
  assert.ok(mcpInternals.tools.some((tool) => tool.name === "github_pr"));
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

test("MCP tools/call returns structured tool errors", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "check_policy",
      arguments: {}
    }
  }, tempRepo());

  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.status, "error");
  assert.match(response.result.structuredContent.error, /requires path, command, or patch/);
});

test("MCP tools/call validates required arguments", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "audit_report",
      arguments: {}
    }
  }, tempRepo());

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Missing required argument: output/);
});

test("MCP tools/call rejects unknown and mistyped arguments", async () => {
  const unknown = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "check_policy",
      arguments: { path: "src/index.js", extra: true }
    }
  }, tempRepo());
  const mistyped = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "write_tests",
      arguments: { limit: "2" }
    }
  }, tempRepo());

  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.structuredContent.error, /Unknown argument: extra/);
  assert.equal(mistyped.result.isError, true);
  assert.match(mistyped.result.structuredContent.error, /limit must be a number/);
});

test("MCP initialized notification does not produce a response", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, tempRepo());

  assert.equal(response, null);
});

test("MCP github_pr returns a dry-run PR command", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "github_pr",
      arguments: {
        title: "Fix bug",
        body: "body",
        draft: true
      }
    }
  }, tempRepo());

  assert.equal(response.result.structuredContent.status, "dry_run");
  assert.match(response.result.structuredContent.command, /gh pr create/);
  assert.match(response.result.structuredContent.command, /--draft/);
});
