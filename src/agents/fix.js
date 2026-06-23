import fs from "node:fs";
import path from "node:path";
import { analyzeDebugLog } from "./debug.js";
import { buildPrSummary } from "./pr.js";
import { generateDebugPatch } from "../llm/provider.js";
import { applyPatchWithPolicy } from "../patch/safeApply.js";
import { validateUnifiedDiff } from "../patch/validatePatch.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";
import { runCommandWithPolicy } from "../runner/safeCommand.js";
import { buildFixGitPlan } from "../integrations/gitPlan.js";

function buildFixTitle(debug) {
  const type = debug.summary?.type || "bug";
  return `Fix ${type}`;
}

function buildCommitMessage(debug) {
  const type = debug.summary?.type || "bug";
  return `fix: address ${type}`;
}

function buildBranchName(debug) {
  const type = String(debug.summary?.type || "bug")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "bug";
  return `codex/fix-${type}`;
}

function resolveRootPath(root, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function patchFromOptions(options) {
  if (options.patchText) {
    return {
      status: "provided",
      patch: options.patchText
    };
  }
  if (options.patchFile) {
    const patchFile = resolveRootPath(options.root || process.cwd(), options.patchFile);
    return {
      status: "provided",
      patch: fs.readFileSync(patchFile, "utf8"),
      patchFile
    };
  }
  return null;
}

export async function runFixWorkflow(options = {}) {
  const root = options.root || process.cwd();
  const logText = options.logText || (options.logFile ? fs.readFileSync(resolveRootPath(root, options.logFile), "utf8") : "");
  if (!logText.trim()) {
    throw new Error("fix requires --log <file> or logText");
  }

  const engine = options.engine;
  if (!engine) {
    throw new Error("runFixWorkflow requires a PolicyEngine");
  }

  const debug = analyzeDebugLog(logText, { root });
  const providedPatch = patchFromOptions(options);
  const patchSource = providedPatch || await generateDebugPatch({ ...debug, log: logText }, options.env || process.env);

  if (!patchSource.patch) {
    return {
      status: "blocked",
      stage: "patch_generation",
      debug,
      patchSource
    };
  }

  const validation = validateUnifiedDiff(patchSource.patch);
  if (!validation.valid) {
    return {
      status: "deny",
      stage: "patch_validation",
      debug,
      patchSource: { ...patchSource, patch: undefined },
      validation
    };
  }

  const policy = engine.checkPatch(patchSource.patch);
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && options.confirmed)) {
    return {
      status: policy.status,
      stage: "policy",
      debug,
      validation,
      policy
    };
  }

  let applyCheck;
  try {
    applyCheck = applyPatchWithPolicy(root, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed),
      checkOnly: true
    });
  } catch (error) {
    return {
      status: "failed",
      stage: "patch_check",
      debug,
      validation,
      policy,
      error: error.message
    };
  }

  const pr = buildPrSummary(patchSource.patch);
  pr.title = buildFixTitle(debug);
  pr.branch = buildBranchName(debug);
  pr.commitMessage = buildCommitMessage(debug);

  const base = {
    debug,
    validation,
    policy,
    applyCheck,
    pr
  };

  let outputPatch = null;
  if (options.outputPatch) {
    const outputPatchPolicy = engine.checkPath(options.outputPatch, "write_patch_artifact");
    if (outputPatchPolicy.status !== "allow" && !(outputPatchPolicy.status === "require_confirmation" && options.confirmed)) {
      return {
        status: outputPatchPolicy.status,
        stage: "output_patch",
        ...base,
        outputPatch: {
          path: options.outputPatch,
          policy: outputPatchPolicy
        }
      };
    }
    outputPatch = writeFileWithPolicy(root, options.outputPatch, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed)
    });
  }

  const gitPlan = (options.createBranch || options.commit || options.prDryRun)
    ? buildFixGitPlan({
      patch: patchSource.patch,
      branch: pr.branch,
      commitMessage: pr.commitMessage,
      title: pr.title,
      body: pr.body,
      bodyFile: options.prBodyFile,
      createBranch: Boolean(options.createBranch),
      commit: Boolean(options.commit),
      prDryRun: Boolean(options.prDryRun)
    })
    : null;

  const plannedBase = {
    ...base,
    outputPatch,
    gitPlan
  };

  if (options.dryRun || !options.apply) {
    return {
      status: options.dryRun ? "dry_run" : "ready",
      ...plannedBase
    };
  }

  let applyResult;
  try {
    applyResult = applyPatchWithPolicy(root, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed),
      checkOnly: false
    });
  } catch (error) {
    return {
      status: "failed",
      stage: "patch_apply",
      ...plannedBase,
      error: error.message
    };
  }

  let tests = null;
  if (options.testCommand) {
    try {
      tests = runCommandWithPolicy(root, options.testCommand, engine, {
        confirmed: Boolean(options.confirmed)
      });
    } catch (error) {
      tests = {
        status: "failed",
        command: options.testCommand,
        error: error.message
      };
    }
  }

  return {
    status: tests && tests.status !== "passed" ? "failed" : "passed",
    ...plannedBase,
    applyResult,
    tests
  };
}

export const fixInternals = {
  buildBranchName,
  buildCommitMessage,
  buildFixTitle
};
