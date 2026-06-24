import fs from "node:fs";
import path from "node:path";

function normalizeAuditEvent(event) {
  return {
    timestamp: new Date().toISOString(),
    agent: "vibeguard",
    ...event
  };
}

export function appendAuditEvent(root, engine, auditLog, event, options = {}) {
  if (!auditLog) return null;
  const policy = engine.checkPath(auditLog, "audit_log");
  if (policy.status === "deny" || (policy.status === "require_confirmation" && !options.confirmed)) {
    return {
      status: policy.status,
      path: auditLog,
      policy,
      event: normalizeAuditEvent({
        ...event,
        auditStatus: "not_written"
      })
    };
  }

  const absolute = path.isAbsolute(auditLog) ? auditLog : path.join(root, auditLog);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const normalized = normalizeAuditEvent({
    ...event,
    auditStatus: "written"
  });
  fs.appendFileSync(absolute, `${JSON.stringify(normalized)}\n`, "utf8");
  return {
    status: "written",
    path: auditLog,
    policy,
    event: normalized
  };
}

function increment(target, key) {
  const normalized = key || "unknown";
  target[normalized] = (target[normalized] || 0) + 1;
}

export function summarizeAuditEvents(text, options = {}) {
  const limit = Number(options.limit || 20);
  const events = [];
  const parseErrors = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({ line: index + 1, error: error.message });
    }
  }

  const operations = {};
  const policyStatuses = {};
  const outcomes = {};
  for (const event of events) {
    increment(operations, event.operation);
    increment(policyStatuses, event.policyStatus);
    increment(outcomes, event.outcome || event.status || event.auditStatus);
  }

  return {
    status: "completed",
    summary: {
      entries: events.length,
      parseErrors: parseErrors.length,
      operations,
      policyStatuses,
      outcomes,
      blockedEvents: events.filter((event) => event.outcome === "blocked" || event.policyStatus === "deny").length
    },
    recent: events.slice(-limit).reverse(),
    parseErrors
  };
}
