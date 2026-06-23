import { parsePatchFiles } from "../patch/parsePatch.js";

function changedEntries(diffText) {
  const entries = [];
  let currentFile = "diff";
  for (const line of diffText.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(/\s+/);
      currentFile = (parts[3] || parts[2] || "diff").replace(/^b\//, "").replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim().split(/\s+/)[0];
      if (value !== "/dev/null") currentFile = value.replace(/^b\//, "").replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      entries.push({ file: currentFile, value: line.slice(1) });
    }
  }
  return entries;
}

export function analyzeReviewDiff(diffText, options = {}) {
  const files = parsePatchFiles(diffText);
  const additions = changedEntries(diffText);
  const findings = [];

  for (const file of files) {
    if (/\.env|secret|credential/i.test(file)) {
      findings.push({
        severity: "high",
        file,
        category: "security",
        message: "Sensitive-looking file changed. Verify this does not expose secrets."
      });
    }
    if (/migrations?|db\/migrate/i.test(file)) {
      findings.push({
        severity: "medium",
        file,
        category: "database",
        message: "Database migration changed. Confirm rollback and deployment order."
      });
    }
    if (/\.github\/workflows|Dockerfile|k8s|terraform/i.test(file)) {
      findings.push({
        severity: "medium",
        file,
        category: "deployment",
        message: "Deployment or CI configuration changed. Confirm blast radius before merging."
      });
    }
  }

  for (const addition of additions) {
    const value = addition.value;
    if (/\beval\s*\(|new Function\s*\(/.test(value)) {
      findings.push({
        severity: "high",
        file: addition.file,
        category: "security",
        message: "Dynamic code execution introduced. Avoid eval/new Function unless strictly sandboxed."
      });
    }
    if (/\bexec\s*\(|child_process|subprocess\./.test(value)) {
      findings.push({
        severity: "medium",
        file: addition.file,
        category: "security",
        message: "Shell/process execution introduced. Validate inputs and enforce command policy."
      });
    }
    if (/TODO|FIXME/.test(value)) {
      findings.push({
        severity: "low",
        file: addition.file,
        category: "maintainability",
        message: "TODO/FIXME added. Confirm it is intentional and tracked."
      });
    }
    if (/SELECT .* \+|WHERE .* \+|query\s*\(.*\+/.test(value)) {
      findings.push({
        severity: "high",
        file: addition.file,
        category: "security",
        message: "Possible SQL string concatenation introduced. Prefer parameterized queries."
      });
    }
  }

  const changedHasSource = files.some((file) => /\.(js|ts|py|java)$/.test(file) && !/(test|spec)/.test(file));
  const changedHasTest = files.some((file) => /(test|spec|tests\/|__tests__)/.test(file));
  if (changedHasSource && !changedHasTest) {
    findings.push({
      severity: "medium",
      file: "tests",
      category: "testing",
      message: "Source files changed without matching test changes."
    });
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file));

  return {
    files,
    summary: `${files.length} changed file(s), ${findings.length} finding(s).`,
    findings
  };
}
