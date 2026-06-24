import path from "node:path";
import { listRepoFiles, readTextIfExists } from "./files.js";

function unique(values) {
  return [...new Set(values)].sort();
}

function hasFile(files, name) {
  return files.includes(name);
}

function packageJsonScripts(root) {
  const text = readTextIfExists(root, "package.json");
  if (!text) return {};
  try {
    return JSON.parse(text).scripts || {};
  } catch {
    return {};
  }
}

export function scanRepository(root = process.cwd()) {
  const files = listRepoFiles(root);
  const extensions = files.map((file) => path.extname(file)).filter(Boolean);
  const languages = [];

  if (extensions.includes(".js") || extensions.includes(".mjs") || extensions.includes(".cjs")) languages.push("JavaScript");
  if (extensions.includes(".ts") || extensions.includes(".tsx")) languages.push("TypeScript");
  if (extensions.includes(".py")) languages.push("Python");
  if (extensions.includes(".java")) languages.push("Java");

  const scripts = packageJsonScripts(root);
  const frameworks = [];
  const packageJson = readTextIfExists(root, "package.json") || "";
  const pyproject = readTextIfExists(root, "pyproject.toml") || "";
  const requirements = readTextIfExists(root, "requirements.txt") || "";
  const isDjango = /django/i.test(pyproject + requirements) || files.includes("manage.py");

  if (/express/i.test(packageJson)) frameworks.push("Express");
  if (/react/i.test(packageJson)) frameworks.push("React");
  if (/vite/i.test(packageJson)) frameworks.push("Vite");
  if (/next/i.test(packageJson)) frameworks.push("Next.js");
  if (isDjango) frameworks.push("Django");
  if (/fastapi/i.test(pyproject + requirements)) frameworks.push("FastAPI");
  if (files.some((file) => file.endsWith("pom.xml"))) frameworks.push("Maven");
  if (files.some((file) => file.endsWith("build.gradle") || file.endsWith("build.gradle.kts"))) frameworks.push("Gradle");
  if (files.some((file) => file.endsWith("SpringBootApplication.java"))) frameworks.push("Spring Boot");

  const packageManagers = [];
  if (hasFile(files, "package.json")) packageManagers.push("npm");
  if (hasFile(files, "pnpm-lock.yaml")) packageManagers.push("pnpm");
  if (hasFile(files, "yarn.lock")) packageManagers.push("yarn");
  if (hasFile(files, "pyproject.toml")) packageManagers.push("python/pyproject");
  if (hasFile(files, "requirements.txt")) packageManagers.push("pip");
  if (files.some((file) => file.endsWith("pom.xml"))) packageManagers.push("maven");
  if (files.some((file) => file.endsWith("build.gradle") || file.endsWith("build.gradle.kts"))) packageManagers.push("gradle");

  const entrypoints = files.filter((file) =>
    ["src/index.js", "src/main.js", "src/index.ts", "src/main.ts", "index.js", "server.js", "app.js", "main.py", "manage.py"].includes(file) ||
    file.endsWith("Application.java")
  );

  const testFiles = files.filter((file) =>
    /(^|\/)(test|tests|__tests__)\//.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    file.endsWith("_test.py") ||
    file.startsWith("test_")
  );

  const suggestedCommands = [];
  if (scripts.test) suggestedCommands.push("npm test");
  if (scripts.lint) suggestedCommands.push("npm run lint");
  if (isDjango) suggestedCommands.push("python manage.py check", "python manage.py test");
  if (files.includes("pytest.ini") || files.includes("pyproject.toml") || testFiles.some((file) => file.endsWith(".py"))) suggestedCommands.push("python -m pytest");
  if (files.some((file) => file.endsWith("pom.xml"))) suggestedCommands.push("mvn test");
  if (files.some((file) => file.endsWith("build.gradle") || file.endsWith("build.gradle.kts"))) suggestedCommands.push("./gradlew test");

  return {
    root,
    files,
    fileCount: files.length,
    languages: unique(languages),
    frameworks: unique(frameworks),
    packageManagers: unique(packageManagers),
    entrypoints: unique(entrypoints),
    testFiles: unique(testFiles),
    suggestedCommands: unique(suggestedCommands)
  };
}
