import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { scanRepository } from "../src/repo/scan.js";
import { analyzeTestTargets, compareCoverageReports, parseCoverageReport } from "../src/agents/testWriter.js";
import { analyzeRepository, buildOnboardingMarkdown, identifyCoreModules, recommendFirstTasks, verifySuggestedCommands } from "../src/agents/onboard.js";
import { PolicyEngine } from "../src/policy/engine.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-repo-"));
}

test("scanRepository detects JavaScript project metadata", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: { express: "^1.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "src", "index.js"), "export function run() {}\n", "utf8");
  fs.writeFileSync(path.join(root, "test", "index.test.js"), "import test from 'node:test';\n", "utf8");

  const scan = scanRepository(root);
  assert.ok(scan.languages.includes("JavaScript"));
  assert.ok(scan.frameworks.includes("Express"));
  assert.ok(scan.suggestedCommands.includes("npm test"));
  assert.ok(scan.entrypoints.includes("src/index.js"));
  assert.ok(scan.dependencies.some((dependency) =>
    dependency.name === "express" &&
    dependency.version === "^1.0.0" &&
    dependency.source === "package.json"
  ));
});

test("scanRepository detects Django project commands", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "manage.py"), "from django.core.management import execute_from_command_line\n", "utf8");
  fs.writeFileSync(path.join(root, "requirements.txt"), "Django==5.0\n", "utf8");

  const scan = scanRepository(root);
  assert.ok(scan.frameworks.includes("Django"));
  assert.ok(scan.entrypoints.includes("manage.py"));
  assert.ok(scan.suggestedCommands.includes("python manage.py check"));
  assert.ok(scan.suggestedCommands.includes("python manage.py test"));
  assert.ok(scan.dependencies.some((dependency) =>
    dependency.name === "Django" &&
    dependency.version === "==5.0" &&
    dependency.source === "requirements.txt"
  ));
});

test("scanRepository detects Spring Boot from dependencies and annotation", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "pom.xml"), "<dependency><artifactId>spring-boot-starter-web</artifactId></dependency>\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "DemoApplication.java"), `package com.example;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {}
`, "utf8");

  const scan = scanRepository(root);
  assert.ok(scan.frameworks.includes("Spring Boot"));
  assert.ok(scan.frameworks.includes("Maven"));
  assert.ok(scan.entrypoints.includes("src/main/java/com/example/DemoApplication.java"));
  assert.ok(scan.suggestedCommands.includes("mvn test"));
  assert.ok(scan.dependencies.some((dependency) =>
    dependency.name === "spring-boot-starter-web" &&
    dependency.source === "pom.xml"
  ));
});

test("scanRepository parses pyproject and Gradle dependencies", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "pyproject.toml"), `[project]
dependencies = ["fastapi==0.110.0", "uvicorn>=0.29"]

[tool.poetry.dependencies]
requests = "^2.31.0"
`, "utf8");
  fs.writeFileSync(path.join(root, "build.gradle"), `dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web:3.3.0'
  testImplementation "org.junit.jupiter:junit-jupiter:5.10.0"
}
`, "utf8");

  const scan = scanRepository(root);
  assert.ok(scan.dependencies.some((dependency) => dependency.name === "fastapi" && dependency.version === "==0.110.0"));
  assert.ok(scan.dependencies.some((dependency) => dependency.name === "requests" && dependency.version === "^2.31.0"));
  assert.ok(scan.dependencies.some((dependency) => dependency.name === "org.springframework.boot:spring-boot-starter-web"));
  assert.ok(scan.dependencies.some((dependency) => dependency.name === "org.junit.jupiter:junit-jupiter" && dependency.scope === "testImplementation"));
});

test("scanRepository skips denied metadata reads", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "requirements.txt"), "Django==5.0\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: ["requirements.txt"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const scan = scanRepository(root, { engine });

  assert.equal(scan.metadataReadPolicy.status, "deny");
  assert.equal(scan.metadataReadPolicy.skipped, 1);
  assert.equal(scan.skippedMetadataFiles[0].file, "requirements.txt");
  assert.equal(scan.dependencies.some((dependency) => dependency.name === "Django"), false);
  assert.equal(scan.frameworks.includes("Django"), false);
});

test("analyzeRepository can confirm protected metadata reads", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "requirements.txt"), "Django==5.0\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: ["requirements.txt"] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const blocked = analyzeRepository({ root, engine });
  const confirmed = analyzeRepository({ root, engine, confirmed: true });

  assert.equal(blocked.scan.metadataReadPolicy.status, "require_confirmation");
  assert.equal(blocked.scan.dependencies.some((dependency) => dependency.name === "Django"), false);
  assert.equal(confirmed.scan.metadataReadPolicy.status, "allow");
  assert.equal(confirmed.scan.dependencies.some((dependency) => dependency.name === "Django"), true);
});

test("analyzeTestTargets finds source functions without likely tests", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");

  const result = analyzeTestTargets({ root });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceFile, "src/math.js");
  assert.deepEqual(result.candidates[0].functions, ["add"]);
});

test("analyzeTestTargets skips denied source files before reading test targets", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  fs.writeFileSync(path.join(root, "secret.py"), "def leak():\n    return 'secret'\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: ["secret.py"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const result = analyzeTestTargets({ root, engine });

  assert.deepEqual(result.candidates.map((candidate) => candidate.sourceFile), ["src/math.js"]);
  assert.equal(result.sourceReadPolicy.status, "deny");
  assert.equal(result.sourceReadPolicy.skipped, 1);
  assert.equal(result.skippedSourceFiles[0].sourceFile, "secret.py");
  assert.equal(result.skippedSourceFiles[0].policy.operation, "read_test_target");
});

test("parseCoverageReport parses coverage.py JSON", () => {
  const root = tempRepo();
  const report = parseCoverageReport(JSON.stringify({
    files: {
      "src/math.py": {
        missing_lines: [3, 4],
        summary: {
          covered_lines: 2,
          num_statements: 4,
          percent_covered: 50
        }
      }
    }
  }), { root });

  assert.equal(report.format, "coverage.py-json");
  assert.equal(report.summary.totalFiles, 1);
  assert.equal(report.files[0].file, "src/math.py");
  assert.deepEqual(report.files[0].missingLines, [3, 4]);
  assert.equal(report.files[0].percentCovered, 50);
});

test("parseCoverageReport parses LCOV", () => {
  const root = tempRepo();
  const report = parseCoverageReport(`TN:
SF:src/math.js
DA:1,1
DA:2,0
LF:2
LH:1
end_of_record
`, { root });

  assert.equal(report.format, "lcov");
  assert.equal(report.files[0].file, "src/math.js");
  assert.deepEqual(report.files[0].missingLines, [2]);
  assert.equal(report.files[0].percentCovered, 50);
});

test("compareCoverageReports summarizes coverage changes", () => {
  const root = tempRepo();
  const before = parseCoverageReport(JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [1, 2],
        summary: { percent_covered: 50 }
      }
    }
  }), { root });
  const after = parseCoverageReport(JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [2],
        summary: { percent_covered: 75 }
      }
    }
  }), { root });

  const delta = compareCoverageReports(before, after);
  assert.equal(delta.summary.averagePercentDelta, 25);
  assert.equal(delta.summary.missingLinesReduced, 1);
  assert.equal(delta.files[0].status, "improved");
});

test("analyzeTestTargets prioritizes uncovered coverage files", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "covered.js"), "export function covered() { return true; }\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "uncovered.js"), "export function uncovered() { return false; }\n", "utf8");
  const coveragePath = path.join(root, "coverage.json");
  fs.writeFileSync(coveragePath, JSON.stringify({
    files: {
      "src/covered.js": {
        missing_lines: [],
        summary: { percent_covered: 100 }
      },
      "src/uncovered.js": {
        missing_lines: [1],
        summary: { percent_covered: 0 }
      }
    }
  }), "utf8");

  const result = analyzeTestTargets({ root, coverageFile: coveragePath });
  assert.equal(result.coverage.summary.filesWithMissingLines, 1);
  assert.equal(result.coverageDeltaStatus.status, "not_compared");
  assert.equal(result.coverageDeltaStatus.reason, "coverage_after_missing");
  assert.equal(result.candidates[0].sourceFile, "src/uncovered.js");
  assert.equal(result.candidates[0].coverage.missingLineCount, 1);
});

test("analyzeTestTargets rejects coverage files outside the repository root", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const outside = path.join(os.tmpdir(), `vibeguard-outside-coverage-${Date.now()}.json`);
  fs.writeFileSync(outside, JSON.stringify({ files: {} }), "utf8");

  assert.throws(() => analyzeTestTargets({ root, coverageFile: outside }), /Path escapes repository root/);
});

test("analyzeTestTargets includes coverage delta when before and after reports are provided", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const beforePath = path.join(root, "coverage-before.json");
  const afterPath = path.join(root, "coverage-after.json");
  fs.writeFileSync(beforePath, JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [1],
        summary: { percent_covered: 0 }
      }
    }
  }), "utf8");
  fs.writeFileSync(afterPath, JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [],
        summary: { percent_covered: 100 }
      }
    }
  }), "utf8");

  const result = analyzeTestTargets({ root, coverageFile: beforePath, coverageAfterFile: afterPath });
  assert.equal(result.coverageDelta.summary.averagePercentDelta, 100);
  assert.equal(result.coverageDelta.summary.missingLinesReduced, 1);
  assert.equal(result.coverageDeltaStatus.status, "compared");
  assert.equal(result.coverageDeltaStatus.summary.missingLinesReduced, 1);
});

test("analyzeTestTargets maps missing coverage lines to functions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), `export function covered() {
  return true;
}

export function uncovered() {
  return false;
}
`, "utf8");
  const coveragePath = path.join(root, "coverage.json");
  fs.writeFileSync(coveragePath, JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [6],
        summary: { percent_covered: 50 }
      }
    }
  }), "utf8");

  const result = analyzeTestTargets({ root, coverageFile: coveragePath });
  assert.deepEqual(result.candidates[0].functions, ["covered", "uncovered"]);
  assert.deepEqual(result.candidates[0].uncoveredFunctions, ["uncovered"]);
  assert.deepEqual(result.candidates[0].functionRanges.map((range) => range.name), ["covered", "uncovered"]);
});

test("analyzeTestTargets maps missing coverage lines to classes and interfaces", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "shape.ts"), `export interface Shape {
  draw(): string;
}

export class Circle {
  area() {
    return 3;
  }
}
`, "utf8");
  const coveragePath = path.join(root, "coverage.json");
  fs.writeFileSync(coveragePath, JSON.stringify({
    files: {
      "src/shape.ts": {
        missing_lines: [2, 7],
        summary: { percent_covered: 40 }
      }
    }
  }), "utf8");

  const result = analyzeTestTargets({ root, coverageFile: coveragePath });
  assert.deepEqual(result.candidates[0].classes, ["Circle"]);
  assert.deepEqual(result.candidates[0].interfaces, ["Shape"]);
  assert.deepEqual(result.candidates[0].uncoveredClasses, ["Circle"]);
  assert.deepEqual(result.candidates[0].uncoveredInterfaces, ["Shape"]);
  assert.deepEqual(result.coverageTargets[0].uncoveredClasses, ["Circle"]);
  assert.deepEqual(result.coverageTargets[0].uncoveredInterfaces, ["Shape"]);
});

test("analyzeTestTargets finds Java methods and suggested JUnit path", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "Calculator.java"), `package com.example;

public class Calculator {
  public int add(int a, int b) {
    return a + b;
  }
}
`, "utf8");

  const result = analyzeTestTargets({ root });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].suggestedTestFile, "src/test/java/com/example/CalculatorTest.java");
  assert.deepEqual(result.candidates[0].functions, ["add"]);
  assert.equal(result.candidates[0].metadata.className, "Calculator");
});

test("analyzeTestTargets finds Java interfaces without concrete methods", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main", "java", "com", "example", "UserRepository.java"), `package com.example;

public interface UserRepository {
}
`, "utf8");

  const result = analyzeTestTargets({ root });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].interfaces, ["UserRepository"]);
  assert.equal(result.candidates[0].suggestedTestFile, "src/test/java/com/example/UserRepositoryTest.java");
  assert.equal(result.candidates[0].metadata.className, "UserRepository");
});

test("buildOnboardingMarkdown includes command and architecture sections", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.js"), "export function run() {}\n", "utf8");
  const result = analyzeRepository({ root });
  const markdown = buildOnboardingMarkdown(result.scan);

  assert.match(markdown, /Repository Onboarding/);
  assert.match(markdown, /仓库上手指南/);
  assert.match(markdown, /Suggested Commands/);
  assert.match(markdown, /建议命令/);
  assert.match(markdown, /Command Checks/);
  assert.match(markdown, /命令检查/);
  assert.match(markdown, /Dependencies/);
  assert.match(markdown, /依赖/);
  assert.match(markdown, /Core Modules/);
  assert.match(markdown, /核心模块/);
  assert.match(markdown, /mermaid/);
  assert.match(markdown, /Baseline test command/);
  assert.match(markdown, /npm test/);
  assert.equal(result.coreModules[0].path, "src");
  assert.equal(result.firstTasks[0].id, "baseline-command");
  assert.equal(result.commandChecks[0].status, "available");
});

test("identifyCoreModules ranks entrypoints, routes, services, and models", () => {
  const modules = identifyCoreModules({
    files: [
      "src/index.js",
      "src/routes/users.js",
      "src/services/userService.js",
      "src/models/user.js",
      "src/helpers/format.js"
    ],
    frameworks: ["Express"],
    entrypoints: ["src/index.js"],
    testFiles: [],
    suggestedCommands: ["npm test"]
  });

  assert.equal(modules[0].path, "src");
  assert.equal(modules[0].kind, "entrypoint");
  assert.ok(modules.some((module) => module.path === "src/routes" && module.kind === "web-routing"));
  assert.ok(modules.some((module) => module.path === "src/services" && module.kind === "business-logic"));
  assert.ok(modules.some((module) => module.path === "src/models" && module.kind === "data-model"));
});

test("recommendFirstTasks returns repo-specific low-risk tasks", () => {
  const tasks = recommendFirstTasks({
    files: ["src/index.js"],
    frameworks: [],
    entrypoints: ["src/index.js"],
    testFiles: [],
    suggestedCommands: ["npm test"]
  });

  assert.deepEqual(tasks.map((task) => task.id), [
    "baseline-command",
    "trace-entrypoint",
    "add-first-smoke-test"
  ]);
  assert.equal(tasks[0].command, "npm test");
  assert.deepEqual(tasks[1].files, ["src/index.js"]);
});

test("verifySuggestedCommands flags missing Gradle wrapper", () => {
  const checks = verifySuggestedCommands({
    files: ["build.gradle"],
    suggestedCommands: ["./gradlew test"]
  });

  assert.equal(checks[0].command, "./gradlew test");
  assert.equal(checks[0].status, "missing_wrapper");
  assert.match(checks[0].reason, /gradlew wrapper was not detected/);
});
