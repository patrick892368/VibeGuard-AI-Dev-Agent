import fs from "node:fs";
import path from "node:path";
import { appendAuditEvent } from "./audit.js";

export function assertPolicyAllowed(result, options = {}) {
  const target = result.path || result.command || (Array.isArray(result.files) ? result.files.join(", ") : "operation");
  if (result.status === "deny") {
    throw new Error(`${result.reason}: ${target}`);
  }
  if (result.status === "require_confirmation" && !options.confirmed) {
    throw new Error(`${result.reason}: ${target}`);
  }
}

function resolveInsideRoot(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return absoluteTarget;
}

export function writeFileWithPolicy(root, relativePath, content, engine, options = {}) {
  const result = engine.checkPath(relativePath, "write");
  const auditLog = appendAuditEvent(root, engine, options.auditLog, {
    operation: "write_file",
    target: relativePath,
    policyStatus: result.status,
    outcome: result.status === "allow" || (result.status === "require_confirmation" && options.confirmed) ? "allowed" : "blocked",
    reason: result.reason
  }, options);
  assertPolicyAllowed(result, options);
  const absolute = resolveInsideRoot(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
  return {
    path: relativePath,
    policy: result,
    auditLog
  };
}

export function appendFileWithPolicy(root, relativePath, content, engine, options = {}) {
  const result = engine.checkPath(relativePath, "append");
  const auditLog = appendAuditEvent(root, engine, options.auditLog, {
    operation: "append_file",
    target: relativePath,
    policyStatus: result.status,
    outcome: result.status === "allow" || (result.status === "require_confirmation" && options.confirmed) ? "allowed" : "blocked",
    reason: result.reason
  }, options);
  assertPolicyAllowed(result, options);
  const absolute = resolveInsideRoot(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, content, "utf8");
  return {
    path: relativePath,
    policy: result,
    auditLog
  };
}

export function readFileWithPolicy(root, relativePath, engine, options = {}) {
  const result = engine.checkPath(relativePath, "read");
  const auditLog = appendAuditEvent(root, engine, options.auditLog, {
    operation: "read_file",
    target: relativePath,
    policyStatus: result.status,
    outcome: result.status === "allow" || (result.status === "require_confirmation" && options.confirmed) ? "allowed" : "blocked",
    reason: result.reason
  }, options);
  assertPolicyAllowed(result, options);
  const absolute = resolveInsideRoot(root, relativePath);
  return {
    content: fs.readFileSync(absolute, "utf8"),
    path: relativePath,
    policy: result,
    auditLog
  };
}
