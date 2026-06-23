import { scanRepository } from "../repo/scan.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

function bulletList(values, fallback = "Not detected") {
  if (!values || values.length === 0) return `- ${fallback}`;
  return values.map((value) => `- ${value}`).join("\n");
}

export function buildOnboardingMarkdown(scan) {
  return `# Repository Onboarding

## Overview

- Files scanned: ${scan.fileCount}
- Languages: ${scan.languages.length ? scan.languages.join(", ") : "Not detected"}
- Frameworks: ${scan.frameworks.length ? scan.frameworks.join(", ") : "Not detected"}
- Package managers: ${scan.packageManagers.length ? scan.packageManagers.join(", ") : "Not detected"}

## Entrypoints

${bulletList(scan.entrypoints)}

## Test Files

${bulletList(scan.testFiles.slice(0, 20))}

## Suggested Commands

${bulletList(scan.suggestedCommands)}

## Architecture

\`\`\`mermaid
flowchart TD
  Repo["Repository"]
  Entry["Entrypoints"]
  Tests["Tests"]
  Docs["Generated Docs"]
  Repo --> Entry
  Repo --> Tests
  Repo --> Docs
\`\`\`

## First Tasks

- Run the suggested test command and confirm the baseline.
- Open the listed entrypoints and trace the first request or execution flow.
- Pick a source file that has no nearby test and add a focused unit test.
`;
}

export function buildArchitectureMarkdown(scan) {
  return `# Architecture

## Repository Shape

- Files scanned: ${scan.fileCount}
- Languages: ${scan.languages.length ? scan.languages.join(", ") : "Not detected"}
- Frameworks: ${scan.frameworks.length ? scan.frameworks.join(", ") : "Not detected"}

## Entrypoints

${bulletList(scan.entrypoints)}

## Test Surface

${bulletList(scan.testFiles.slice(0, 30))}

## High-Level Flow

\`\`\`mermaid
flowchart LR
  Dev["Developer"]
  CLI["VibeGuard CLI"]
  Policy["Policy Engine"]
  Agents["Agents"]
  Repo["Repository"]
  Tests["Tests"]

  Dev --> CLI
  CLI --> Policy
  Policy --> Agents
  Agents --> Repo
  Agents --> Tests
\`\`\`
`;
}

export function analyzeRepository(options = {}) {
  const root = options.root || process.cwd();
  const scan = scanRepository(root);
  return {
    scan,
    markdown: buildOnboardingMarkdown(scan),
    architecture: buildArchitectureMarkdown(scan)
  };
}

export function writeOnboardingDocs(root = process.cwd(), engine, options = {}) {
  if (!engine) throw new Error("writeOnboardingDocs requires a PolicyEngine");
  const result = analyzeRepository({ root });
  const written = [
    writeFileWithPolicy(root, "docs/ONBOARDING.md", result.markdown, engine, options),
    writeFileWithPolicy(root, "docs/ARCHITECTURE.md", result.architecture, engine, options)
  ];
  return { ...result, written };
}
