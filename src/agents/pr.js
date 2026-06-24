import { analyzeReviewDiff } from "./review.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

export function buildPrSummary(diffText) {
  const review = analyzeReviewDiff(diffText);
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
    title: "VibeGuard generated change",
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
