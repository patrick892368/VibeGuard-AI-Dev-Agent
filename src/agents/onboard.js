import { scanRepository } from "../repo/scan.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

function bulletList(values, fallback = "Not detected / 未检测到") {
  if (!values || values.length === 0) return `- ${fallback}`;
  return values.map((value) => `- ${value}`).join("\n");
}

export function buildOnboardingMarkdown(scan) {
  return `# Repository Onboarding / 仓库上手指南

## Overview / 概览

- Files scanned / 已扫描文件数: ${scan.fileCount}
- Languages / 语言: ${scan.languages.length ? scan.languages.join(", ") : "Not detected / 未检测到"}
- Frameworks / 框架: ${scan.frameworks.length ? scan.frameworks.join(", ") : "Not detected / 未检测到"}
- Package managers / 包管理器: ${scan.packageManagers.length ? scan.packageManagers.join(", ") : "Not detected / 未检测到"}

## Entrypoints / 入口文件

${bulletList(scan.entrypoints)}

## Test Files / 测试文件

${bulletList(scan.testFiles.slice(0, 20))}

## Suggested Commands / 建议命令

${bulletList(scan.suggestedCommands)}

## Architecture / 架构

\`\`\`mermaid
flowchart TD
  Repo["Repository / 仓库"]
  Entry["Entrypoints / 入口"]
  Tests["Tests / 测试"]
  Docs["Generated Docs / 生成文档"]
  Repo --> Entry
  Repo --> Tests
  Repo --> Docs
\`\`\`

## First Tasks / 新人任务

- Run the suggested test command and confirm the baseline. / 运行建议测试命令，确认当前基线。
- Open the listed entrypoints and trace the first request or execution flow. / 打开入口文件，追踪第一个请求或执行流程。
- Pick a source file that has no nearby test and add a focused unit test. / 选择一个缺少邻近测试的源码文件，添加聚焦单元测试。
`;
}

export function buildArchitectureMarkdown(scan) {
  return `# Architecture / 架构

## Repository Shape / 仓库形态

- Files scanned / 已扫描文件数: ${scan.fileCount}
- Languages / 语言: ${scan.languages.length ? scan.languages.join(", ") : "Not detected / 未检测到"}
- Frameworks / 框架: ${scan.frameworks.length ? scan.frameworks.join(", ") : "Not detected / 未检测到"}

## Entrypoints / 入口文件

${bulletList(scan.entrypoints)}

## Test Surface / 测试面

${bulletList(scan.testFiles.slice(0, 30))}

## High-Level Flow / 高层流程

\`\`\`mermaid
flowchart LR
  Dev["Developer / 开发者"]
  CLI["VibeGuard CLI"]
  Policy["Policy Engine / 策略引擎"]
  Agents["Agents / Agent"]
  Repo["Repository / 仓库"]
  Tests["Tests / 测试"]

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
