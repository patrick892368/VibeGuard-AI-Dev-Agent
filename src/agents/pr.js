import { analyzeReviewDiff } from "./review.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";
import { buildFixGitPlan, checkGitPlanPolicy, executeGitPlanAsync } from "../integrations/gitPlan.js";

function basename(file) {
  return String(file || "change").split("/").filter(Boolean).pop() || "change";
}

function labelForFile(file) {
  return basename(file).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]+/g, " ").trim() || "change";
}

function slug(value) {
  return String(value || "change")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";
}

function primarySourceFile(files) {
  return files.find((file) => /\.(js|ts|py|java|mjs|cjs)$/.test(file) && !/(^|\/)(test|tests|__tests__)\//.test(file) && !/\.(test|spec)\./.test(file)) ||
    files[0] ||
    "change";
}

function prIntent(review) {
  const categories = new Set(review.findings.map((finding) => finding.category));
  const files = review.files || [];
  const primary = primarySourceFile(files);
  const label = labelForFile(primary);
  if (categories.has("security")) {
    return {
      title: `Address security findings in ${label}`,
      branch: `codex/address-security-${slug(label)}`,
      commitMessage: `fix: address security findings in ${label}`
    };
  }
  if (categories.has("bug")) {
    return {
      title: `Fix ${label} behavior`,
      branch: `codex/fix-${slug(label)}`,
      commitMessage: `fix: update ${label} behavior`
    };
  }
  if (categories.has("testing")) {
    return {
      title: `Add coverage for ${label}`,
      branch: `codex/add-tests-${slug(label)}`,
      commitMessage: `test: add coverage for ${label}`
    };
  }
  if (files.every((file) => /\.(md|mdx|txt|rst)$/i.test(file))) {
    return {
      title: `Update ${label} docs`,
      branch: `codex/update-docs-${slug(label)}`,
      commitMessage: `docs: update ${label}`
    };
  }
  return {
    title: files.length > 1 ? `Update ${files.length} files` : `Update ${label}`,
    branch: `codex/update-${slug(label)}`,
    commitMessage: `chore: update ${label}`
  };
}

export function buildPrSummary(diffText) {
  const review = analyzeReviewDiff(diffText);
  const intent = prIntent(review);
  const files = review.files.map((file) => `- ${file}`).join("\n") || "- No files detected";
  const findings = review.findings
    .map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `- [${finding.severity}] ${finding.category}: ${location} - ${finding.message}\n  Recommendation: ${finding.recommendation}`;
    })
    .join("\n") || "- No findings";
  const actionItems = review.actionItems
    .map((item) => {
      const location = item.line ? `${item.file}:${item.line}` : item.file;
      return `- [${item.severity}] ${location}: ${item.action}`;
    })
    .join("\n") || "- No action items";

  return {
    title: intent.title,
    branch: intent.branch,
    commitMessage: intent.commitMessage,
    automation: {
      title: intent.title,
      branch: intent.branch,
      commitMessage: intent.commitMessage,
      changedFiles: review.files
    },
    body: `## Summary

This PR was prepared with VibeGuard.

## Changed Files

${files}

## Review Findings

${findings}

## Review Action Items

Findings by severity: high ${review.summaryBySeverity.high}, medium ${review.summaryBySeverity.medium}, low ${review.summaryBySeverity.low}.

${actionItems}

## Validation

- [ ] Unit tests passed
- [ ] Integration tests passed
- [ ] Policy check passed
`,
    review
  };
}

export function writePrSummaryBody(root, diffText, outputPath, engine, options = {}) {
  const summary = buildPrSummary(diffText);
  return {
    ...summary,
    writtenBody: writeFileWithPolicy(root, outputPath, summary.body, engine, options)
  };
}

export async function buildPrPlanWorkflow(root, diffText, engine, options = {}) {
  if (!engine) throw new Error("buildPrPlanWorkflow requires a PolicyEngine");
  const summary = buildPrSummary(diffText);
  const title = options.title || summary.title;
  const branch = options.branch || summary.branch;
  const commitMessage = options.commitMessage || summary.commitMessage;
  const bodyFile = options.bodyFile || options.writeBody || null;
  const writtenBody = options.writeBody
    ? writeFileWithPolicy(root, options.writeBody, summary.body, engine, {
      confirmed: Boolean(options.confirmed),
      auditLog: options.auditLog
    })
    : null;
  const gitPlan = buildFixGitPlan({
    changedFiles: summary.review.files,
    branch,
    commitMessage,
    title,
    bodyFile,
    body: bodyFile ? "" : summary.body,
    createBranch: options.createBranch !== false,
    commit: options.commit !== false,
    push: Boolean(options.push),
    prDryRun: options.prDryRun !== false
  });
  const gitPolicy = checkGitPlanPolicy(gitPlan, engine, {
    confirmed: Boolean(options.confirmed)
  });
  const gitExecution = options.executeGitPlan
    ? await executeGitPlanAsync(root, gitPlan, engine, {
      confirmed: Boolean(options.confirmed),
      auditLog: options.auditLog,
      env: options.env,
      fetch: options.fetch,
      useApi: Boolean(options.githubUseApi),
      dryRun: Boolean(options.dryRun)
    })
    : null;

  return {
    ...summary,
    title,
    branch,
    commitMessage,
    automation: {
      ...summary.automation,
      title,
      branch,
      commitMessage
    },
    writtenBody,
    gitPlan,
    gitPolicy,
    gitExecution
  };
}
