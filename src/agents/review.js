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

function recommendationFor(category, message) {
  if (message.includes("Secret-looking")) return "Remove the literal and load it from a secret manager or environment variable.";
  if (message.includes("Dynamic code execution")) return "Replace dynamic execution with explicit dispatch or a sandboxed interpreter with strict input validation.";
  if (message.includes("Shell/process execution")) return "Route commands through a policy-gated runner and validate every user-controlled argument.";
  if (message.includes("SQL string concatenation")) return "Use parameterized queries or the framework query builder for every dynamic value.";
  if (message.includes("HTML injection")) return "Render text safely or sanitize trusted markup before assigning it to an HTML sink.";
  if (message.includes("Unsafe deserialization")) return "Use safe loaders and reject untrusted serialized input.";
  if (message.includes("Synchronous filesystem")) return "Move blocking I/O out of request or hot paths, or use async APIs.";
  if (category === "testing") return "Add or update a focused test that covers the changed source behavior.";
  if (category === "database") return "Document rollback, migration order, and deployment coordination before merge.";
  if (category === "deployment") return "Confirm CI/deploy blast radius and require an explicit reviewer for infrastructure changes.";
  if (category === "security") return "Review the changed file for secret exposure and remove sensitive data from the diff.";
  if (category === "maintainability") return "Link the TODO/FIXME to a tracked issue or complete it before merge.";
  return "Inspect this finding and add a concrete fix or justification before merge.";
}

function finding(severity, file, category, message, addition = null) {
  return {
    severity,
    file,
    line: addition?.line ?? null,
    category,
    message,
    recommendation: recommendationFor(category, message)
  };
}

function summarizeBySeverity(findings) {
  return findings.reduce((summary, item) => {
    summary[item.severity] = (summary[item.severity] || 0) + 1;
    return summary;
  }, { high: 0, medium: 0, low: 0 });
}

function actionItems(findings) {
  return findings.map((item) => ({
    severity: item.severity,
    file: item.file,
    line: item.line,
    category: item.category,
    action: item.recommendation
  }));
}

function findingLocation(item) {
  return item.line ? `${item.file}:${item.line}` : item.file;
}

function buildReviewMarkdown(files, findings, summaryBySeverity) {
  const changedFiles = files.map((file) => `- \`${file}\``).join("\n") || "- No files detected";
  const findingLines = findings.map((item) =>
    `- **${item.severity.toUpperCase()} ${item.category}** at \`${findingLocation(item)}\`: ${item.message}\n  Recommendation: ${item.recommendation}`
  ).join("\n") || "- No findings.";

  return `## VibeGuard Review

Changed files: ${files.length}
Findings: ${findings.length} (high: ${summaryBySeverity.high}, medium: ${summaryBySeverity.medium}, low: ${summaryBySeverity.low})

### Changed Files

${changedFiles}

### Findings

${findingLines}
`;
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

  const summaryBySeverity = summarizeBySeverity(findings);
  return {
    files,
    summary: `${files.length} changed file(s), ${findings.length} finding(s).`,
    summaryBySeverity,
    actionItems: actionItems(findings),
    markdown: buildReviewMarkdown(files, findings, summaryBySeverity),
    findings
  };
}
