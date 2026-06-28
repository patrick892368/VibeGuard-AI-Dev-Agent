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

function modulePathForFile(file) {
  const parts = file.split("/");
  if (file.startsWith("src/main/java/")) {
    return parts.length > 5 ? parts.slice(0, parts.length - 1).join("/") : "src/main/java";
  }
  if (parts[0] === "src" && parts.length > 2) return parts.slice(0, 2).join("/");
  if (["app", "apps", "lib", "server", "packages"].includes(parts[0]) && parts.length > 2) {
    return parts.slice(0, 2).join("/");
  }
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

function classifyModule(modulePath, files, scan) {
  const joined = `${modulePath}\n${files.join("\n")}`.toLowerCase();
  const hasEntrypoint = files.some((file) => scan.entrypoints.includes(file));
  if (hasEntrypoint) return "entrypoint";
  if (/(route|routes|url|urls|controller|view|api)/.test(joined)) return "web-routing";
  if (/(model|models|schema|entity|repository|repositories|dao)/.test(joined)) return "data-model";
  if (/(service|services|domain|usecase|use-case|handler|handlers)/.test(joined)) return "business-logic";
  if (/(component|components|page|pages|screen|screens|react|vue)/.test(joined)) return "ui";
  if (scan.frameworks.includes("Django") && /(settings|wsgi|asgi|manage\.py)/.test(joined)) return "framework-config";
  if (scan.frameworks.includes("Spring Boot") && /src\/main\/java/.test(joined)) return "application-code";
  return "source";
}

function moduleReason(kind, modulePath, files, scan) {
  const count = files.length;
  const hasEntrypoint = files.some((file) => scan.entrypoints.includes(file));
  const reasons = {
    entrypoint: [
      "Contains a detected entrypoint and is likely the first runtime boundary.",
      "包含已检测到的入口文件，通常是第一层运行边界。"
    ],
    "web-routing": [
      "Contains routing, controller, view, URL, or API files.",
      "包含 routing、controller、view、URL 或 API 相关文件。"
    ],
    "data-model": [
      "Contains model, schema, entity, repository, or DAO files.",
      "包含 model、schema、entity、repository 或 DAO 相关文件。"
    ],
    "business-logic": [
      "Contains service, domain, use-case, or handler files.",
      "包含 service、domain、use-case 或 handler 相关文件。"
    ],
    ui: [
      "Contains UI component, page, or screen files.",
      "包含 UI component、page 或 screen 相关文件。"
    ],
    "framework-config": [
      "Contains framework configuration or startup glue.",
      "包含框架配置或启动胶水代码。"
    ],
    "application-code": [
      "Contains main application source under the framework source tree.",
      "包含框架源码树下的主要应用代码。"
    ],
    source: [
      "Contains source files and is a likely development touchpoint.",
      "包含源码文件，是常见开发入口。"
    ]
  };
  const [reason, reasonZh] = reasons[kind] || reasons.source;
  return {
    reason: `${reason} ${count} source file${count === 1 ? "" : "s"} detected in ${modulePath}.${hasEntrypoint ? " Entrypoint present." : ""}`,
    reasonZh: `${reasonZh} 在 ${modulePath} 检测到 ${count} 个源码文件。${hasEntrypoint ? "包含入口文件。" : ""}`
  };
}

function moduleScore(kind, files, scan) {
  const hasEntrypoint = files.some((file) => scan.entrypoints.includes(file));
  const kindWeights = {
    entrypoint: 100,
    "web-routing": 80,
    "business-logic": 70,
    "data-model": 65,
    ui: 55,
    "framework-config": 50,
    "application-code": 45,
    source: 20
  };
  return (kindWeights[kind] || 0) + (hasEntrypoint ? 30 : 0) + Math.min(files.length, 20);
}

export function identifyCoreModules(scan) {
  const modules = new Map();
  for (const file of scan.files.filter(isSourceFile)) {
    const modulePath = modulePathForFile(file);
    if (!modules.has(modulePath)) modules.set(modulePath, []);
    modules.get(modulePath).push(file);
  }

  return [...modules.entries()]
    .map(([modulePath, files]) => {
      const sortedFiles = files.sort();
      const kind = classifyModule(modulePath, sortedFiles, scan);
      const reason = moduleReason(kind, modulePath, sortedFiles, scan);
      return {
        path: modulePath,
        kind,
        score: moduleScore(kind, sortedFiles, scan),
        files: sortedFiles.slice(0, 8),
        fileCount: sortedFiles.length,
        entrypoints: sortedFiles.filter((file) => scan.entrypoints.includes(file)),
        ...reason
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 8);
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

function coreModuleList(modules) {
  if (!modules || modules.length === 0) return "- No core modules detected / 未检测到核心模块";
  return modules.map((module) => {
    const entrypoints = module.entrypoints.length ? ` Entrypoints / 入口: ${module.entrypoints.map((file) => `\`${file}\``).join(", ")}.` : "";
    const files = module.files.length ? ` Files / 文件: ${module.files.map((file) => `\`${file}\``).join(", ")}.` : "";
    return `- **${module.path}** (${module.kind}, score ${module.score}): ${module.reason} / ${module.reasonZh}${entrypoints}${files}`;
  }).join("\n");
}

function mermaidText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "'");
}

function architectureDiagram(scan, coreModules) {
  const moduleLines = coreModules.slice(0, 6).flatMap((module, index) => {
    const id = `M${index}`;
    const label = mermaidText(`${module.path} / ${module.kind}`);
    const target = module.entrypoints.length ? "Entry" : "Repo";
    return [
      `  ${id}["${label}"]`,
      `  ${target} --> ${id}`
    ];
  });
  const commandLines = scan.suggestedCommands.slice(0, 3).map((command, index) => {
    const id = `C${index}`;
    return [
      `  ${id}["${mermaidText(command)}"]`,
      `  Commands --> ${id}`
    ].join("\n");
  });

  return `\`\`\`mermaid
flowchart TD
  Repo["Repository / 仓库"]
  Entry["Entrypoints / 入口"]
  Tests["Tests / 测试"]
  Commands["Suggested Commands / 建议命令"]
  Repo --> Entry
  Repo --> Tests
  Repo --> Commands
${moduleLines.join("\n") || "  Repo --> Unknown[\"No core modules detected / 未检测到核心模块\"]"}
${commandLines.join("\n")}
\`\`\``;
}

export function buildOnboardingMarkdown(scan) {
  const firstTasks = recommendFirstTasks(scan);
  const commandChecks = verifySuggestedCommands(scan);
  const coreModules = identifyCoreModules(scan);
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

## Core Modules / 核心模块

${coreModuleList(coreModules)}

## Suggested Commands / 建议命令

${bulletList(scan.suggestedCommands)}

## Command Checks / 命令检查

${commandCheckList(commandChecks)}

## Architecture / 架构

${architectureDiagram(scan, coreModules)}

## First Tasks / 新人任务

${taskList(firstTasks)}
`;
}

export function buildArchitectureMarkdown(scan) {
  const coreModules = identifyCoreModules(scan);
  return `# Architecture / 架构

## Repository Shape / 仓库形态

- Files scanned / 已扫描文件数: ${scan.fileCount}
- Languages / 语言: ${scan.languages.length ? scan.languages.join(", ") : "Not detected / 未检测到"}
- Frameworks / 框架: ${scan.frameworks.length ? scan.frameworks.join(", ") : "Not detected / 未检测到"}

## Entrypoints / 入口文件

${bulletList(scan.entrypoints)}

## Test Surface / 测试面

${bulletList(scan.testFiles.slice(0, 30))}

## Core Modules / 核心模块

${coreModuleList(coreModules)}

## High-Level Flow / 高层流程

${architectureDiagram(scan, coreModules)}
`;
}

export function analyzeRepository(options = {}) {
  const root = options.root || process.cwd();
  const scan = scanRepository(root);
  const firstTasks = recommendFirstTasks(scan);
  const commandChecks = verifySuggestedCommands(scan);
  const coreModules = identifyCoreModules(scan);
  return {
    scan,
    firstTasks,
    commandChecks,
    coreModules,
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
