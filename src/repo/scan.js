import fs from "node:fs";
import path from "node:path";
import { listRepoFiles, readTextIfExists } from "./files.js";
import { appendAuditEvent } from "../policy/audit.js";

function unique(values) {
  return [...new Set(values)].sort();
}

function hasFile(files, name) {
  return files.includes(name);
}

function policyAllowed(result, options = {}) {
  return result.status === "allow" || (result.status === "require_confirmation" && options.confirmed);
}

function createMetadataReader(root, options = {}) {
  const cache = new Map();
  const results = [];

  function read(file) {
    if (cache.has(file)) return cache.get(file);
    const absolute = path.join(root, file);
    if (!fsExists(absolute)) {
      cache.set(file, "");
      return "";
    }

    if (!options.engine) {
      const text = readTextIfExists(root, file) || "";
      cache.set(file, text);
      return text;
    }

    const policy = options.engine.checkPath(file, "read_repo_metadata");
    const allowed = policyAllowed(policy, options);
    const auditLog = appendAuditEvent(root, options.engine, options.auditLog, {
      operation: "read_repo_metadata",
      target: file,
      policyStatus: policy.status,
      outcome: allowed ? "allowed" : "blocked",
      reason: policy.reason
    }, options);
    const result = {
      file,
      status: policy.status,
      outcome: allowed ? "allowed" : "blocked",
      reason: policy.reason,
      policy,
      auditLog
    };
    results.push(result);
    const text = allowed ? readTextIfExists(root, file) || "" : "";
    cache.set(file, text);
    return text;
  }

  return {
    read,
    summary() {
      if (!options.engine) {
        return {
          status: "not_checked",
          total: 0,
          allowed: 0,
          skipped: 0,
          results: []
        };
      }
      const skipped = results.filter((result) => result.outcome === "blocked");
      const status = skipped.some((result) => result.status === "deny")
        ? "deny"
        : skipped.length > 0
          ? "require_confirmation"
          : "allow";
      return {
        status,
        total: results.length,
        allowed: results.length - skipped.length,
        skipped: skipped.length,
        results: results.filter((result) => result.status !== "allow")
      };
    },
    skippedFiles() {
      return results.filter((result) => result.outcome === "blocked");
    }
  };
}

function fsExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function packageJsonScripts(text) {
  if (!text) return {};
  try {
    return JSON.parse(text).scripts || {};
  } catch {
    return {};
  }
}

function packageJsonDependencies(text) {
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const sections = [
    ["dependencies", "runtime"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"]
  ];
  return sections.flatMap(([section, scope]) =>
    Object.entries(parsed[section] || {}).map(([name, version]) => ({
      name,
      version: String(version),
      source: "package.json",
      scope
    }))
  );
}

function requirementDependency(line) {
  const cleaned = line.split("#")[0].trim();
  if (!cleaned || cleaned.startsWith("-")) return null;
  const normalized = cleaned.split(";")[0].trim();
  const match = normalized.match(/^([a-zA-Z0-9_.-]+)\s*(.*)$/);
  if (!match) return null;
  return {
    name: match[1],
    version: match[2].trim() || null,
    source: "requirements.txt",
    scope: "runtime"
  };
}

function requirementsDependencies(text) {
  return text.split(/\r?\n/).map(requirementDependency).filter(Boolean);
}

function quotedDependencyRecords(text, source, scope) {
  const records = [];
  for (const match of text.matchAll(/["']([^"']+)["']/g)) {
    const record = requirementDependency(match[1]);
    if (record) records.push({ ...record, source, scope });
  }
  return records;
}

function pyprojectDependencies(text) {
  if (!text) return [];
  const records = [];
  const dependencies = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)]/m);
  if (dependencies) records.push(...quotedDependencyRecords(dependencies[1], "pyproject.toml", "runtime"));

  const poetry = text.match(/\[tool\.poetry\.dependencies]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (poetry) {
    for (const rawLine of poetry[1].split(/\r?\n/)) {
      const line = rawLine.split("#")[0].trim();
      if (!line || line.startsWith("python")) continue;
      const match = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
      if (match) {
        records.push({
          name: match[1],
          version: match[2].trim().replace(/^["']|["']$/g, ""),
          source: "pyproject.toml",
          scope: "runtime"
        });
      }
    }
  }
  return records;
}

function pomDependencies(text, source) {
  const records = [];
  for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1];
    const groupId = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1] || "";
    const artifactId = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
    if (!artifactId) continue;
    const version = block.match(/<version>([^<]+)<\/version>/)?.[1] || null;
    const scope = block.match(/<scope>([^<]+)<\/scope>/)?.[1] || "runtime";
    records.push({
      name: groupId ? `${groupId}:${artifactId}` : artifactId,
      version,
      source,
      scope
    });
  }
  return records;
}

function gradleDependencies(text, source) {
  const records = [];
  const pattern = /\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(?\s*["']([^:"']+):([^:"']+)(?::([^"']+))?["']/g;
  for (const match of text.matchAll(pattern)) {
    records.push({
      name: `${match[2]}:${match[3]}`,
      version: match[4] || null,
      source,
      scope: match[1]
    });
  }
  return records;
}

function uniqueDependencies(dependencies) {
  const seen = new Map();
  for (const dependency of dependencies) {
    const key = `${dependency.source}:${dependency.scope}:${dependency.name}:${dependency.version || ""}`;
    if (!seen.has(key)) seen.set(key, dependency);
  }
  return [...seen.values()].sort((a, b) =>
    a.source.localeCompare(b.source) ||
    a.scope.localeCompare(b.scope) ||
    a.name.localeCompare(b.name)
  );
}

export function scanRepository(root = process.cwd(), options = {}) {
  const files = listRepoFiles(root);
  const metadata = createMetadataReader(root, options);
  const extensions = files.map((file) => path.extname(file)).filter(Boolean);
  const languages = [];

  if (extensions.includes(".js") || extensions.includes(".mjs") || extensions.includes(".cjs")) languages.push("JavaScript");
  if (extensions.includes(".ts") || extensions.includes(".tsx")) languages.push("TypeScript");
  if (extensions.includes(".py")) languages.push("Python");
  if (extensions.includes(".java")) languages.push("Java");

  const packageJson = metadata.read("package.json");
  const pyproject = metadata.read("pyproject.toml");
  const requirements = metadata.read("requirements.txt");
  const pomFiles = files.filter((file) => file.endsWith("pom.xml"));
  const gradleFiles = files.filter((file) => file.endsWith("build.gradle") || file.endsWith("build.gradle.kts"));
  const scripts = packageJsonScripts(packageJson);
  const frameworks = [];
  const pomText = pomFiles.map((file) => metadata.read(file)).join("\n");
  const gradleText = gradleFiles.map((file) => metadata.read(file)).join("\n");
  const dependencies = [
    ...packageJsonDependencies(packageJson),
    ...requirementsDependencies(requirements),
    ...pyprojectDependencies(pyproject),
    ...pomFiles.flatMap((file) => pomDependencies(metadata.read(file), file)),
    ...gradleFiles.flatMap((file) => gradleDependencies(metadata.read(file), file))
  ];
  const springBootEntrypoints = files.filter((file) =>
    file.endsWith(".java") && /@SpringBootApplication/.test(metadata.read(file))
  );
  const isDjango = /django/i.test(pyproject + requirements) || files.includes("manage.py");
  const isSpringBoot = /spring-boot/i.test(pomText + gradleText) || springBootEntrypoints.length > 0;

  if (/express/i.test(packageJson)) frameworks.push("Express");
  if (/react/i.test(packageJson)) frameworks.push("React");
  if (/vite/i.test(packageJson)) frameworks.push("Vite");
  if (/next/i.test(packageJson)) frameworks.push("Next.js");
  if (isDjango) frameworks.push("Django");
  if (/fastapi/i.test(pyproject + requirements)) frameworks.push("FastAPI");
  if (files.some((file) => file.endsWith("pom.xml"))) frameworks.push("Maven");
  if (files.some((file) => file.endsWith("build.gradle") || file.endsWith("build.gradle.kts"))) frameworks.push("Gradle");
  if (isSpringBoot) frameworks.push("Spring Boot");

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
    file.endsWith("Application.java") ||
    springBootEntrypoints.includes(file)
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
    dependencies: uniqueDependencies(dependencies),
    entrypoints: unique(entrypoints),
    testFiles: unique(testFiles),
    suggestedCommands: unique(suggestedCommands),
    metadataReadPolicy: metadata.summary(),
    skippedMetadataFiles: metadata.skippedFiles()
  };
}
