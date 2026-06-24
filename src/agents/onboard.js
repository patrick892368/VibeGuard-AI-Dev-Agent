import { scanRepository } from "../repo/scan.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

function bulletList(values, fallback = "Not detected / 未检测到") {
  if (!values || values.length === 0) return `- ${fallback}`;
  return values.map((value) => `- ${value}`).join("\n");
}

function commandCheckList(checks) {
  if (!checks || checks.length === 0) return "- No suggested commands to verify / 没有可检查的建议命令";
  return checks.map((check) =>
    `- \`${check.command}\`: ${check.status}. ${check.reason} / ${check.reasonZh}`
  ).join("\n");
}

function isSourceFile(file) {
  return /\.(js|mjs|cjs|ts|tsx|py|java)$/.test(file) &&
    !/(^|\/)(test|tests|__tests__)\//.test(file) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
    !file.endsWith("_test.py") &&
    !file.startsWith("test_");
}

export function verifySuggestedCommands(scan) {
  return (scan.suggestedCommands || []).map((command) => {
    if (command === "npm test" || command === "npm run lint") {
      return {
        command,
        status: "available",
        reason: "package.json script was detected.",
        reasonZh: "已检测到 package.json script。"
      };
    }
    if (command.startsWith("python manage.py ")) {
      return {
        command,
        status: scan.files.includes("manage.py") ? "available" : "missing_entrypoint",
        reason: scan.files.includes("manage.py") ? "manage.py was detected." : "manage.py was not detected.",
        reasonZh: scan.files.includes("manage.py") ? "已检测到 manage.py。" : "未检测到 manage.py。"
      };
    }
    if (command === "python -m pytest") {
      return {
        command,
        status: "needs_dependency",
        reason: "Python tests were detected; verify pytest is installed before running.",
        reasonZh: "已检测到 Python 测试；运行前需要确认 pytest 已安装。"
      };
    }
    if (command === "mvn test") {
      return {
        command,
        status: scan.files.some((file) => file.endsWith("pom.xml")) ? "available" : "missing_config",
        reason: scan.files.some((file) => file.endsWith("pom.xml")) ? "pom.xml was detected." : "pom.xml was not detected.",
        reasonZh: scan.files.some((file) => file.endsWith("pom.xml")) ? "已检测到 pom.xml。" : "未检测到 pom.xml。"
      };
    }
    if (command === "./gradlew test") {
      const hasWrapper = scan.files.includes("gradlew") || scan.files.includes("gradlew.bat");
      return {
        command,
        status: hasWrapper ? "available" : "missing_wrapper",
        reason: hasWrapper ? "Gradle wrapper was detected." : "build.gradle was detected, but gradlew wrapper was not detected.",
        reasonZh: hasWrapper ? "已检测到 Gradle wrapper。" : "已检测到 build.gradle，但未检测到 gradlew wrapper。"
      };
    }
    return {
      command,
      status: "unknown",
      reason: "The command was inferred but VibeGuard does not have a verifier for it yet.",
      reasonZh: "该命令来自推断，但 VibeGuard 暂未提供对应检查器。"
    };
  });
}

export function recommendFirstTasks(scan) {
  const tasks = [];
  const firstCommand = scan.suggestedCommands[0];
  const firstEntrypoint = scan.entrypoints[0];
  const firstSource = scan.files.find(isSourceFile);

  if (firstCommand) {
    tasks.push({
      id: "baseline-command",
      title: "Baseline test command",
      titleZh: "基线测试命令",
      reason: "Run the safest known validation command before editing code.",
      reasonZh: "改代码前先运行最明确的验证命令。",
      command: firstCommand,
      files: []
    });
  }

  if (scan.frameworks.includes("Django")) {
    tasks.push({
      id: "trace-django-entrypoint",
      title: "Trace Django request flow",
      titleZh: "追踪 Django 请求链路",
      reason: "Start from URL routing and follow one view into its template or serializer.",
      reasonZh: "从 URL 路由开始，追踪一个 view 到 template 或 serializer。",
      command: scan.suggestedCommands.includes("python manage.py check") ? "python manage.py check" : null,
      files: scan.entrypoints.includes("manage.py") ? ["manage.py"] : scan.entrypoints.slice(0, 1)
    });
  } else if (scan.frameworks.includes("Spring Boot")) {
    tasks.push({
      id: "trace-spring-entrypoint",
      title: "Trace Spring Boot startup",
      titleZh: "追踪 Spring Boot 启动链路",
      reason: "Open the application class and follow one controller or service boundary.",
      reasonZh: "打开应用入口类，追踪一个 controller 或 service 边界。",
      command: scan.suggestedCommands.find((command) => command.includes("test")) || null,
      files: scan.entrypoints.slice(0, 2)
    });
  } else if (firstEntrypoint) {
    tasks.push({
      id: "trace-entrypoint",
      title: "Trace the first entrypoint",
      titleZh: "追踪第一个入口",
      reason: "Map the first execution path before taking a feature or bug task.",
      reasonZh: "接 feature 或 bug 前，先画清第一条执行路径。",
      command: null,
      files: [firstEntrypoint]
    });
  }

  if (scan.testFiles.length === 0 && firstSource) {
    tasks.push({
      id: "add-first-smoke-test",
      title: "Add the first smoke test",
      titleZh: "添加第一个冒烟测试",
      reason: "This repository has no detected tests, so a small export or startup test is low risk.",
      reasonZh: "当前未检测到测试文件，添加一个小的导出或启动测试风险较低。",
      command: firstCommand || null,
      files: [firstSource]
    });
  } else if (firstSource) {
    tasks.push({
      id: "add-focused-unit-test",
      title: "Add a focused unit test",
      titleZh: "添加聚焦单元测试",
      reason: "Pick one small source file and add a nearby behavior assertion.",
      reasonZh: "选择一个小源码文件，补一个邻近的行为断言。",
      command: firstCommand || null,
      files: [firstSource]
    });
  }

  return tasks.slice(0, 4);
}

function taskList(tasks) {
  if (!tasks || tasks.length === 0) return "- No safe first task detected / 未检测到安全新人任务";
  return tasks.map((task) => {
    const command = task.command ? ` Command / 命令: \`${task.command}\`.` : "";
    const files = task.files?.length ? ` Files / 文件: ${task.files.map((file) => `\`${file}\``).join(", ")}.` : "";
    return `- **${task.title} / ${task.titleZh}**: ${task.reason} / ${task.reasonZh}${command}${files}`;
  }).join("\n");
}

export function buildOnboardingMarkdown(scan) {
  const firstTasks = recommendFirstTasks(scan);
  const commandChecks = verifySuggestedCommands(scan);
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

## Command Checks / 命令检查

${commandCheckList(commandChecks)}

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

${taskList(firstTasks)}
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
  const firstTasks = recommendFirstTasks(scan);
  const commandChecks = verifySuggestedCommands(scan);
  return {
    scan,
    firstTasks,
    commandChecks,
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
