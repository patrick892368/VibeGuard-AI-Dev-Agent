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
