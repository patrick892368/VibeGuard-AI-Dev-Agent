import fs from "node:fs";
import path from "node:path";
import { scanRepository } from "../repo/scan.js";
import { listRepoFiles } from "../repo/files.js";

const PYTHON_FRAME = /^\s*File "([^"]+)", line (\d+), in (.+)$/;
const NODE_FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
const JAVA_FRAME = /^\s*at\s+([\w.$]+)\(([^:()]+\.java):(\d+)\)$/;

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
  const last = [...lines].reverse().find((line) => /Error|Exception|Traceback|TypeError|ReferenceError|SyntaxError|ModuleNotFoundError|Caused by:/.test(line));
  if (!last) return { type: "UnknownError", message: lines.at(-1) || "No error text provided" };

  const causedBy = last.match(/^Caused by:\s+([\w.$]+(?:Error|Exception))(?::\s*(.*))?$/);
  if (causedBy) return { type: causedBy[1], message: causedBy[2] || "" };

  const javaStyle = last.match(/^(?:Exception in thread "[^"]+"\s+)?([\w.$]+(?:Error|Exception))(?::\s*(.*))?$/);
  if (javaStyle) return { type: javaStyle[1], message: javaStyle[2] || "" };

  const pythonStyle = last.match(/^([\w.]+(?:Error|Exception)):\s*(.*)$/);
  if (pythonStyle) return { type: pythonStyle[1], message: pythonStyle[2] };

  const nodeStyle = last.match(/^(\w*Error):\s*(.*)$/);
  if (nodeStyle) return { type: nodeStyle[1], message: nodeStyle[2] };

  return { type: "Error", message: last.trim() };
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

export function analyzeDebugLog(logText, options = {}) {
  const root = options.root || process.cwd();
  const repo = scanRepository(root);
  const pythonFrames = parsePythonTraceback(logText, root);
  const nodeFrames = parseNodeStack(logText, root);
  const javaFrames = parseJavaStack(logText, root, repo.files);
  const frames = [...pythonFrames, ...nodeFrames, ...javaFrames];
  const summary = detectErrorSummary(logText);
  const uniqueFiles = [...new Set(frames.map((frame) => frame.file))];
  const snippets = frames.slice(0, 5).map((frame) => sourceSnippet(root, frame.file, frame.line)).filter(Boolean);

  return {
    summary,
    frames,
    likelyFiles: uniqueFiles,
    snippets,
    hints: likelyFixHints(summary),
    suggestedTestCommands: repo.suggestedCommands
  };
}
