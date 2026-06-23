import { analyzeReviewDiff } from "./review.js";

export function buildPrSummary(diffText) {
  const review = analyzeReviewDiff(diffText);
  const files = review.files.map((file) => `- ${file}`).join("\n") || "- No files detected";
  const findings = review.findings
    .map((finding) => `- [${finding.severity}] ${finding.category}: ${finding.file} - ${finding.message}`)
    .join("\n") || "- No findings";

  return {
    title: "VibeGuard generated change",
    body: `## Summary

This PR was prepared with VibeGuard.

## Changed Files

${files}

## Review Findings

${findings}

## Validation

- [ ] Unit tests passed
- [ ] Integration tests passed
- [ ] Policy check passed
`,
    review
  };
}
