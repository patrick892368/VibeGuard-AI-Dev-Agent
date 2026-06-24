import { matchAnyGlob, matchCommand, normalizeRepoPath } from "./glob.js";
import { parsePatchFiles } from "../patch/parsePatch.js";

export class PolicyEngine {
  constructor(config, options = {}) {
    this.config = config;
    this.root = options.root || process.cwd();
  }

  checkPath(filePath, operation = "write") {
    const normalizedPath = normalizeRepoPath(filePath, this.root);
    const paths = this.config.paths || {};
    const deny = paths.deny || [];
    const requireConfirmation = paths.require_confirmation || [];
    const allow = paths.allow || [];

    if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
      return {
        status: "deny",
        operation,
        path: normalizedPath,
        reason: "Path escapes repository root"
      };
    }

    if (matchAnyGlob(normalizedPath, deny)) {
      return {
        status: "deny",
        operation,
        path: normalizedPath,
        reason: `Path matches deny policy`
      };
    }

    if (matchAnyGlob(normalizedPath, requireConfirmation)) {
      return {
        status: "require_confirmation",
        operation,
        path: normalizedPath,
        reason: `Path requires human confirmation`
      };
    }

    if (allow.length > 0 && !matchAnyGlob(normalizedPath, allow)) {
      return {
        status: "deny",
        operation,
        path: normalizedPath,
        reason: `Path is outside allowed policy scope`
      };
    }

    return {
      status: "allow",
      operation,
      path: normalizedPath,
      reason: `Path is allowed`
    };
  }

  checkCommand(command) {
    const commands = this.config.commands || {};
    const denyMatch = (commands.deny || []).find((pattern) => matchCommand(command, pattern));
    if (denyMatch) {
      return {
        status: "deny",
        command,
        reason: `Command matches deny policy: ${denyMatch}`
      };
    }

    const confirmMatch = (commands.require_confirmation || []).find((pattern) => matchCommand(command, pattern));
    if (confirmMatch) {
      return {
        status: "require_confirmation",
        command,
        reason: `Command requires human confirmation: ${confirmMatch}`
      };
    }

    return {
      status: "allow",
      command,
      reason: "Command is allowed"
    };
  }

  checkPatch(patchText) {
    const files = parsePatchFiles(patchText);
    const results = files.map((file) => this.checkPath(file, "patch"));
    const status = summarizeStatus(results);
    return {
      status,
      files,
      results,
      reason: status === "allow" ? "Patch is allowed" : `Patch contains ${status} file changes`
    };
  }
}

export function summarizeStatus(results) {
  if (results.some((result) => result.status === "deny")) return "deny";
  if (results.some((result) => result.status === "require_confirmation")) return "require_confirmation";
  return "allow";
}
