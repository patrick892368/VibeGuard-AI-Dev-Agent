import { parsePatchFiles } from "../patch/parsePatch.js";

function changedEntries(diffText) {
  const entries = [];
  let currentFile = "diff";
  let newLine = null;
  for (const line of diffText.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      currentFile = (parts[3] || parts[2] || "diff").replace(/^b\//, "").replace(/^a\//, "");
      newLine = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim().split(/\s+/)[0];
      if (value !== "/dev/null") currentFile = value.replace(/^b\//, "").replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      newLine = match ? Number(match[1]) : null;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      entries.push({ file: currentFile, line: newLine, value: line.slice(1) });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (newLine !== null && line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return entries;
}

function finding(severity, file, category, message, addition = null) {
  return {
    severity,
    file,
    line: addition?.line ?? null,
    category,
    message
  };
}

export function analyzeReviewDiff(diffText, options = {}) {
  const files = parsePatchFiles(diffText);
  const additions = changedEntries(diffText);
  const findings = [];

  for (const file of files) {
    if (/\.env|secret|credential/i.test(file)) {
      findings.push(finding("high", file, "security", "Sensitive-looking file changed. Verify this does not expose secrets."));
    }
    if (/migrations?|db\/migrate/i.test(file)) {
      findings.push(finding("medium", file, "database", "Database migration changed. Confirm rollback and deployment order."));
    }
    if (/\.github\/workflows|Dockerfile|k8s|terraform/i.test(file)) {
      findings.push(finding("medium", file, "deployment", "Deployment or CI configuration changed. Confirm blast radius before merging."));
    }
  }

  for (const addition of additions) {
    const value = addition.value;
    if (/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}/i.test(value)) {
      findings.push(finding("high", addition.file, "security", "Secret-looking literal introduced. Move credentials to a secret manager or environment variable.", addition));
    }
    if (/\beval\s*\(|new Function\s*\(/.test(value)) {
      findings.push(finding("high", addition.file, "security", "Dynamic code execution introduced. Avoid eval/new Function unless strictly sandboxed.", addition));
    }
    if (/\bexec\s*\(|child_process|subprocess\./.test(value)) {
      findings.push(finding("medium", addition.file, "security", "Shell/process execution introduced. Validate inputs and enforce command policy.", addition));
    }
    if (/TODO|FIXME/.test(value)) {
      findings.push(finding("low", addition.file, "maintainability", "TODO/FIXME added. Confirm it is intentional and tracked.", addition));
    }
    if (/SELECT .* \+|WHERE .* \+|query\s*\(.*\+/.test(value)) {
      findings.push(finding("high", addition.file, "security", "Possible SQL string concatenation introduced. Prefer parameterized queries.", addition));
    }
    if (/innerHTML\s*=|dangerouslySetInnerHTML/.test(value)) {
      findings.push(finding("high", addition.file, "security", "HTML injection sink introduced. Sanitize trusted markup or use safe text rendering.", addition));
    }
    if (/pickle\.loads?\(|yaml\.load\s*\(/.test(value)) {
      findings.push(finding("high", addition.file, "security", "Unsafe deserialization introduced. Use safe loaders or validate trusted input only.", addition));
    }
    if (/fs\.(readFileSync|writeFileSync)|readFileSync\(|writeFileSync\(/.test(value) && /\.(js|ts)$/.test(addition.file)) {
      findings.push(finding("medium", addition.file, "performance", "Synchronous filesystem I/O introduced. Confirm this is not on a request or hot path.", addition));
    }
  }

  const changedHasSource = files.some((file) => /\.(js|ts|py|java)$/.test(file) && !/(test|spec)/.test(file));
  const changedHasTest = files.some((file) => /(test|spec|tests\/|__tests__)/.test(file));
  if (changedHasSource && !changedHasTest) {
    findings.push(finding("medium", "tests", "testing", "Source files changed without matching test changes."));
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file));

  return {
    files,
    summary: `${files.length} changed file(s), ${findings.length} finding(s).`,
    findings
  };
}
