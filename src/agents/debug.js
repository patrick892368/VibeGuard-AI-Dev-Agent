import fs from "node:fs";
import path from "node:path";
import { scanRepository } from "../repo/scan.js";
import { listRepoFiles } from "../repo/files.js";

const PYTHON_FRAME = /^\s*File "([^"]+)", line (\d+), in (.+)$/;
const NODE_FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
const JAVA_FRAME = /^\s*at\s+([\w.$<>]+)\(([^:()]+\.java):(\d+)\)$/;
const DJANGO_ERROR_WORDS = /DoesNotExist|DisallowedHost|NoReverseMatch|ImproperlyConfigured|PermissionDenied|SuspiciousOperation|TemplateDoesNotExist/;

function normalizeFramePath(framePath, root) {
  if (!framePath) return null;
  if (framePath.startsWith("node:") || framePath.startsWith("internal/")) return null;
  const absolute = path.isAbsolute(framePath) ? framePath : path.join(root, framePath);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (relative.startsWith("..")) return null;
  return relative;
}

export function parsePythonTraceback(logText, root = process.cwd()) {
  const lines = logText.replace(/\r\n/g, "\n").split("\n");
  const frames = [];
  for (const line of lines) {
    const match = line.match(PYTHON_FRAME);
    if (match) {
      const file = normalizeFramePath(match[1], root);
      if (file) {
        frames.push({
          language: "python",
          file,
          line: Number(match[2]),
          symbol: match[3].trim()
        });
      }
    }
  }
  return frames;
}

export function parseNodeStack(logText, root = process.cwd()) {
  const lines = logText.replace(/\r\n/g, "\n").split("\n");
  const frames = [];
  for (const line of lines) {
    const match = line.match(NODE_FRAME);
    if (match) {
      const file = normalizeFramePath(match[2], root);
      if (file) {
        frames.push({
          language: "node",
          file,
          line: Number(match[3]),
          column: Number(match[4]),
          symbol: (match[1] || "").trim()
        });
      }
    }
  }
  return frames;
}

export function parseJavaStack(logText, root = process.cwd(), repoFiles = listRepoFiles(root)) {
  const lines = logText.replace(/\r\n/g, "\n").split("\n");
  const frames = [];
  for (const line of lines) {
    const match = line.match(JAVA_FRAME);
    if (!match) continue;
    const filename = match[2];
    const candidates = repoFiles.filter((file) => file.endsWith(`/${filename}`) || file === filename);
    if (candidates.length === 0) continue;
    frames.push({
      language: "java",
      file: candidates[0],
      line: Number(match[3]),
      symbol: match[1]
    });
  }
  return frames;
}

export function detectErrorSummary(logText) {
  const lines = logText.trim().split(/\r?\n/).filter(Boolean);
  const last = [...lines].reverse().find((line) => /Error|Exception|Traceback|TypeError|ReferenceError|SyntaxError|ModuleNotFoundError|Caused by:/.test(line) || DJANGO_ERROR_WORDS.test(line));
  if (!last) return { type: "UnknownError", message: lines.at(-1) || "No error text provided" };

  const causedBy = last.match(/^Caused by:\s+([\w.$]+(?:Error|Exception))(?::\s*(.*))?$/);
  if (causedBy) return { type: causedBy[1], message: causedBy[2] || "" };

  const javaStyle = last.match(/^(?:Exception in thread "[^"]+"\s+)?([\w.$]+(?:Error|Exception))(?::\s*(.*))?$/);
  if (javaStyle) return { type: javaStyle[1], message: javaStyle[2] || "" };

  const pythonStyle = last.match(/^([\w.]+(?:Error|Exception|DoesNotExist|DisallowedHost|NoReverseMatch|ImproperlyConfigured|PermissionDenied|SuspiciousOperation)):\s*(.*)$/);
  if (pythonStyle) return { type: pythonStyle[1], message: pythonStyle[2] };

  const nodeStyle = last.match(/^(\w*Error):\s*(.*)$/);
  if (nodeStyle) return { type: nodeStyle[1], message: nodeStyle[2] };

  return { type: "Error", message: last.trim() };
}

function djangoProjectFiles(repoFiles) {
  return {
    settings: repoFiles.filter((file) => file.endsWith("settings.py")),
    urls: repoFiles.filter((file) => file.endsWith("urls.py")),
    views: repoFiles.filter((file) => file.endsWith("views.py")),
    models: repoFiles.filter((file) => file.endsWith("models.py")),
    templates: repoFiles.filter((file) => /(^|\/)templates\//.test(file))
  };
}

function springProjectFiles(repoFiles) {
  return {
    configs: repoFiles.filter((file) =>
      /(^|\/)(application|bootstrap)(-[\w-]+)?\.(properties|ya?ml)$/.test(file) ||
      /(Config|Configuration)\.java$/.test(file)
    ),
    controllers: repoFiles.filter((file) => /(Controller|Resource)\.java$/.test(file)),
    services: repoFiles.filter((file) => /(Service|Manager)\.java$/.test(file)),
    repositories: repoFiles.filter((file) => /(Repository|Dao)\.java$/.test(file)),
    entities: repoFiles.filter((file) => /(Entity|Model)\.java$/.test(file)),
    entrypoints: repoFiles.filter((file) => file.endsWith("Application.java") || file.endsWith("SpringBootApplication.java"))
  };
}

function firstFew(values, limit = 5) {
  return values.slice(0, limit);
}

function djangoDebugContext(summary, logText, repo) {
  const isDjango = repo.frameworks.includes("Django") || /django\./i.test(logText) || DJANGO_ERROR_WORDS.test(summary.type);
  if (!isDjango) return null;

  const projectFiles = djangoProjectFiles(repo.files);
  const likelyFiles = [];
  const hints = [];

  if (/TemplateDoesNotExist/.test(summary.type)) {
    const templateName = summary.message.trim().split(/\s+/)[0];
    const matchingTemplates = projectFiles.templates.filter((file) => file.endsWith(`/${templateName}`) || file.endsWith(templateName));
    likelyFiles.push(...matchingTemplates, ...firstFew(projectFiles.views), ...firstFew(projectFiles.settings, 2));
    hints.push("For Django TemplateDoesNotExist, verify the template path, app template directory, and TEMPLATES DIRS/APP_DIRS settings.");
  }
  if (/NoReverseMatch/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.urls), ...firstFew(projectFiles.views));
    hints.push("For Django NoReverseMatch, verify url names, app_name namespaces, and arguments passed to reverse or the url template tag.");
  }
  if (/DisallowedHost|ImproperlyConfigured/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.settings));
    hints.push("Check Django settings for ALLOWED_HOSTS, INSTALLED_APPS, middleware, database, template, or environment configuration.");
  }
  if (!/TemplateDoesNotExist/.test(summary.type) && /DoesNotExist|OperationalError|IntegrityError/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.models), ...firstFew(projectFiles.views));
    hints.push("Check the Django model/query assumptions, fixture data, and whether the test database schema matches the code.");
  }

  if (likelyFiles.length === 0) {
    likelyFiles.push(...firstFew(projectFiles.views), ...firstFew(projectFiles.urls), ...firstFew(projectFiles.settings, 2));
  }
  if (hints.length === 0) {
    hints.push("Start with the first in-repository Django frame, then inspect the related view, URL route, settings, model, or template.");
  }

  return {
    framework: "Django",
    likelyFiles: [...new Set(likelyFiles)],
    hints,
    suggestedCommands: ["python manage.py check", "python manage.py test"]
  };
}

function springDebugContext(summary, logText, repo) {
  const isSpring = repo.frameworks.includes("Spring Boot") || /org\.springframework|springframework/i.test(logText);
  if (!isSpring) return null;

  const projectFiles = springProjectFiles(repo.files);
  const likelyFiles = [];
  const hints = [];

  if (/NoSuchBeanDefinitionException|UnsatisfiedDependencyException|BeanCreationException/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.services), ...firstFew(projectFiles.repositories), ...firstFew(projectFiles.configs), ...firstFew(projectFiles.entrypoints, 2));
    hints.push("For Spring dependency injection failures, inspect bean annotations, constructor dependencies, component scanning, profiles, and configuration classes.");
  }
  if (/BindException|ConfigurationProperties|IllegalStateException/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.configs), ...firstFew(projectFiles.entrypoints, 2));
    hints.push("For Spring configuration binding or startup failures, verify application properties, active profiles, and configuration property names/types.");
  }
  if (/HttpMessageNotReadableException|MethodArgument|MissingServletRequest|ServletException/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.controllers), ...firstFew(projectFiles.services));
    hints.push("For Spring web request failures, inspect controller method signatures, request body DTOs, validation annotations, and route mappings.");
  }
  if (/DataIntegrityViolationException|JpaSystemException|ConstraintViolationException|SQL|SQLException/.test(summary.type)) {
    likelyFiles.push(...firstFew(projectFiles.repositories), ...firstFew(projectFiles.entities), ...firstFew(projectFiles.configs, 2));
    hints.push("For Spring data failures, inspect entity mappings, repository queries, transaction boundaries, and datasource configuration.");
  }

  if (likelyFiles.length === 0) {
    likelyFiles.push(...firstFew(projectFiles.controllers), ...firstFew(projectFiles.services), ...firstFew(projectFiles.configs), ...firstFew(projectFiles.entrypoints, 2));
  }
  if (hints.length === 0) {
    hints.push("Start with the first in-repository Spring frame, then inspect the related controller, service, repository, configuration, or application entrypoint.");
  }

  return {
    framework: "Spring Boot",
    likelyFiles: [...new Set(likelyFiles)],
    hints,
    suggestedCommands: repo.suggestedCommands.filter((command) => command === "mvn test" || command === "./gradlew test")
  };
}

function likelyFixHints(summary) {
  const text = `${summary.type}: ${summary.message}`;
  const hints = [];
  if (/ModuleNotFoundError|Cannot find module/.test(text)) {
    hints.push("Check whether the dependency is installed and whether the import path is correct.");
  }
  if (/NameError|ReferenceError/.test(text)) {
    hints.push("Check for a misspelled variable, missing import, or scope issue near the top stack frame.");
  }
  if (/TypeError/.test(text)) {
    hints.push("Check whether a value is null, undefined, or has a different shape than expected.");
  }
  if (/NullPointerException/.test(text)) {
    hints.push("Check which object is null at the first application stack frame and add validation or correct initialization.");
  }
  if (/SyntaxError/.test(text)) {
    hints.push("Inspect the reported line for malformed syntax before changing surrounding logic.");
  }
  if (/ENOENT|No such file or directory/.test(text)) {
    hints.push("Check whether the file path is generated correctly and whether the file exists at runtime.");
  }
  if (hints.length === 0) {
    hints.push("Start with the first in-repository stack frame and inspect inputs passed into that function.");
  }
  return hints;
}

function sourceSnippet(root, file, line, radius = 3) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) return null;
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return {
    file,
    start,
    end,
    text: lines.slice(start - 1, end).map((value, index) => `${start + index}: ${value}`).join("\n")
  };
}

function sourcePreview(root, file, limit = 40) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) return null;
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  const end = Math.min(lines.length, limit);
  return {
    file,
    start: 1,
    end,
    text: lines.slice(0, end).map((value, index) => `${index + 1}: ${value}`).join("\n")
  };
}

export function analyzeDebugLog(logText, options = {}) {
  const root = options.root || process.cwd();
  const repo = scanRepository(root);
  const pythonFrames = parsePythonTraceback(logText, root);
  const nodeFrames = parseNodeStack(logText, root);
  const javaFrames = parseJavaStack(logText, root, repo.files);
  const frames = [...pythonFrames, ...nodeFrames, ...javaFrames];
  const summary = detectErrorSummary(logText);
  const djangoContext = djangoDebugContext(summary, logText, repo);
  const springContext = springDebugContext(summary, logText, repo);
  const frameworkContexts = [djangoContext, springContext].filter(Boolean);
  const uniqueFiles = [...new Set([...frames.map((frame) => frame.file), ...frameworkContexts.flatMap((context) => context.likelyFiles)])];
  const snippets = [];
  const snippetFiles = new Set();
  for (const frame of frames.slice(0, 5)) {
    const snippet = sourceSnippet(root, frame.file, frame.line);
    if (!snippet) continue;
    snippets.push(snippet);
    snippetFiles.add(frame.file);
  }
  for (const file of uniqueFiles) {
    if (snippets.length >= 8 || snippetFiles.has(file)) continue;
    const snippet = sourcePreview(root, file);
    if (!snippet) continue;
    snippets.push(snippet);
    snippetFiles.add(file);
  }

  return {
    summary,
    frames,
    likelyFiles: uniqueFiles,
    snippets,
    hints: [...likelyFixHints(summary), ...frameworkContexts.flatMap((context) => context.hints)],
    suggestedTestCommands: [...new Set([...repo.suggestedCommands, ...frameworkContexts.flatMap((context) => context.suggestedCommands)])],
    frameworkContext: frameworkContexts[0] || null,
    frameworkContexts
  };
}
