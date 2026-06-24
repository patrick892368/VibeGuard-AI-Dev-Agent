import fs from "node:fs";
import path from "node:path";
import { analyzeDebugLog } from "./debug.js";
import { buildPrSummary } from "./pr.js";
import { generateDebugPatch } from "../llm/provider.js";
import { applyPatchWithPolicy } from "../patch/safeApply.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "../patch/validatePatch.js";
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

function buildDecisionSummary({ status, stage = null, validation, policy, applyCheck, tests, outputPatch, prBody, gitPlan }) {
  const nextActions = [];
  if (status === "dry_run" || status === "ready") {
    nextActions.push("review_patch");
    if (applyCheck?.status === "checked") nextActions.push("apply_with_confirm");
    if (gitPlan) nextActions.push("review_git_plan");
  }
  if (status === "passed") {
    nextActions.push("review_pr_summary");
  }
  if (status === "deny" || status === "require_confirmation") {
    nextActions.push("stop_for_policy");
  }
  if (status === "blocked") {
    nextActions.push("configure_provider_or_supply_patch");
  }
  if (status === "failed") {
    nextActions.push("inspect_stage_error");
  }

  return {
    status,
    stage,
    patchValid: Boolean(validation?.valid),
    policyStatus: policy?.status || null,
    applyCheckStatus: applyCheck?.status || null,
    testStatus: tests?.status || null,
    outputPatchPath: outputPatch?.path || null,
    prBodyPath: prBody?.path || null,
    hasGitPlan: Boolean(gitPlan),
    nextActions
  };
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
    const status = "blocked";
    return {
      status,
      stage: "patch_generation",
      debug,
      patchSource,
      decision: buildDecisionSummary({ status, stage: "patch_generation" })
    };
  }

  patchSource.patch = normalizeUnifiedDiff(patchSource.patch);
  const validation = validateUnifiedDiff(patchSource.patch);
  if (!validation.valid) {
    const status = "deny";
    return {
      status,
      stage: "patch_validation",
      debug,
      patchSource: { ...patchSource, patch: undefined },
      validation,
      decision: buildDecisionSummary({ status, stage: "patch_validation", validation })
    };
  }

  const policy = engine.checkPatch(patchSource.patch);
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && options.confirmed)) {
    const status = policy.status;
    return {
      status,
      stage: "policy",
      debug,
      validation,
      policy,
      decision: buildDecisionSummary({ status, stage: "policy", validation, policy })
    };
  }

  let applyCheck;
  try {
    applyCheck = applyPatchWithPolicy(root, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed),
      checkOnly: true
    });
  } catch (error) {
    const status = "failed";
    return {
      status,
      stage: "patch_check",
      debug,
      validation,
      policy,
      error: error.message,
      decision: buildDecisionSummary({ status, stage: "patch_check", validation, policy })
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
        },
        decision: buildDecisionSummary({ status: outputPatchPolicy.status, stage: "output_patch", validation, policy, applyCheck })
      };
    }
    outputPatch = writeFileWithPolicy(root, options.outputPatch, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed)
    });
  }

  let prBody = null;
  if (options.writePrBody) {
    const prBodyPolicy = engine.checkPath(options.writePrBody, "write_pr_body");
    if (prBodyPolicy.status !== "allow" && !(prBodyPolicy.status === "require_confirmation" && options.confirmed)) {
      const status = prBodyPolicy.status;
      return {
        status,
        stage: "pr_body",
        ...base,
        outputPatch,
        prBody: {
          path: options.writePrBody,
          policy: prBodyPolicy
        },
        decision: buildDecisionSummary({ status, stage: "pr_body", validation, policy, applyCheck, outputPatch })
      };
    }
    prBody = writeFileWithPolicy(root, options.writePrBody, pr.body, engine, {
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
    prBody,
    gitPlan
  };

  if (options.dryRun || !options.apply) {
    const status = options.dryRun ? "dry_run" : "ready";
    return {
      status,
      ...plannedBase,
      decision: buildDecisionSummary({ status, validation, policy, applyCheck, outputPatch, prBody, gitPlan })
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
      error: error.message,
      decision: buildDecisionSummary({ status: "failed", stage: "patch_apply", validation, policy, applyCheck, outputPatch, prBody, gitPlan })
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

  const status = tests && tests.status !== "passed" ? "failed" : "passed";
  return {
    status,
    ...plannedBase,
    applyResult,
    tests,
    decision: buildDecisionSummary({ status, validation, policy, applyCheck, tests, outputPatch, prBody, gitPlan })
  };
}

export const fixInternals = {
  buildBranchName,
  buildCommitMessage,
  buildFixTitle,
  buildDecisionSummary
};
