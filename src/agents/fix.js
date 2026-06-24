import fs from "node:fs";
import path from "node:path";
import { analyzeDebugLog } from "./debug.js";
import { buildPrSummary } from "./pr.js";
import { generateDebugPatch } from "../llm/provider.js";
import { applyPatchWithPolicy } from "../patch/safeApply.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "../patch/validatePatch.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";
import { runCommandWithPolicy } from "../runner/safeCommand.js";
import { buildFixGitPlan, checkGitPlanPolicy, executeGitPlan } from "../integrations/gitPlan.js";
import { scanRepository } from "../repo/scan.js";
import { generateFallbackPatch } from "./fallbackPatch.js";

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

function buildDecisionSummary({ status, stage = null, validation, policy, applyCheck, tests, outputPatch, prBody, gitPlan, gitPolicy, gitExecution, selectedTestCommand }) {
  const nextActions = [];
  if (status === "dry_run" || status === "ready") {
    nextActions.push("review_patch");
    if (applyCheck?.status === "checked") nextActions.push("apply_with_confirm");
    if (gitPlan) nextActions.push("review_git_plan");
  }
  if (status === "passed") {
    nextActions.push("review_pr_summary");
    if (gitPlan && !gitExecution) nextActions.push("execute_git_plan_with_confirm");
    if (gitExecution?.status === "executed") nextActions.push("inspect_created_branch_or_pr");
  }
  if (status === "deny" || status === "require_confirmation") {
    nextActions.push("stop_for_policy");
    if (gitPolicy?.status === "require_confirmation") nextActions.push("confirm_git_plan");
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
    selectedTestCommand: selectedTestCommand || null,
    outputPatchPath: outputPatch?.path || null,
    prBodyPath: prBody?.path || null,
    hasGitPlan: Boolean(gitPlan),
    gitPolicyStatus: gitPolicy?.status || null,
    gitExecutionStatus: gitExecution?.status || null,
    nextActions
  };
}

function summarizePatchSource(patchSource) {
  if (!patchSource) return null;
  const { patch, ...summary } = patchSource;
  return {
    ...summary,
    patchLength: patch ? patch.length : 0
  };
}

function buildPatchDiagnostics(patchText, error) {
  const lines = String(patchText || "").replace(/\r\n/g, "\n").split("\n");
  return {
    error: error?.message || String(error || ""),
    lineCount: patchText ? lines.length : 0,
    hunkHeaders: lines.filter((line) => line.startsWith("@@ ")).slice(0, 5)
  };
}

function canRecoverPatchCheck(patchSource) {
  return patchSource?.status && patchSource.status !== "provided";
}

function attemptPatchCheckRecovery(root, debug, engine, options = {}) {
  const fallback = generateFallbackPatch(debug, { root });
  if (!fallback?.patch) {
    return {
      status: "unavailable",
      reason: "No deterministic fallback patch matched this error."
    };
  }

  fallback.patch = normalizeUnifiedDiff(fallback.patch);
  const validation = validateUnifiedDiff(fallback.patch);
  if (!validation.valid) {
    return {
      status: "failed",
      stage: "patch_validation",
      patchSource: summarizePatchSource(fallback),
      validation,
      reason: validation.reason
    };
  }

  const policy = engine.checkPatch(fallback.patch);
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && options.confirmed)) {
    return {
      status: policy.status,
      stage: "policy",
      patchSource: summarizePatchSource(fallback),
      validation,
      policy,
      reason: policy.reason
    };
  }

  try {
    const applyCheck = applyPatchWithPolicy(root, fallback.patch, engine, {
      confirmed: Boolean(options.confirmed),
      checkOnly: true,
      auditLog: options.auditLog
    });
    return {
      status: "recovered",
      patchSource: fallback,
      validation,
      policy,
      applyCheck
    };
  } catch (error) {
    return {
      status: "failed",
      stage: "patch_check",
      patchSource: summarizePatchSource(fallback),
      validation,
      policy,
      error: error.message,
      diagnostics: buildPatchDiagnostics(fallback.patch, error)
    };
  }
}

function resolveRootPath(root, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function quoteCommandPart(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function isTestFile(file) {
  return /(^|\/)(test|tests|__tests__)\//.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    file.endsWith("_test.py") ||
    path.posix.basename(file).startsWith("test_") ||
    file.endsWith("Test.java");
}

function pythonModuleName(file) {
  return file.replace(/\.py$/, "").replace(/\//g, ".");
}

function testCommandForFile(root, repo, testFile) {
  const extension = path.posix.extname(testFile);
  if (extension === ".py") {
    const absolute = path.join(root, testFile);
    const text = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
    if (/unittest/.test(text)) return `python -m unittest ${quoteCommandPart(testFile)}`;
    if (repo.frameworks.includes("Django") && repo.files.includes("manage.py")) {
      return `python manage.py test ${pythonModuleName(testFile)}`;
    }
    if (repo.files.includes("pytest.ini") || /pytest/.test(text)) return `python -m pytest ${quoteCommandPart(testFile)}`;
    return `python -m unittest ${quoteCommandPart(testFile)}`;
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return `node --test ${quoteCommandPart(testFile)}`;
  }
  if (extension === ".java") {
    if (repo.suggestedCommands.includes("mvn test")) return "mvn test";
    if (repo.suggestedCommands.includes("./gradlew test")) return "./gradlew test";
  }
  return null;
}

function sourceStem(file) {
  return path.posix.basename(file, path.posix.extname(file)).replace(/[._-](test|spec)$/i, "");
}

function normalizedTestStem(file) {
  return sourceStem(file).replace(/^test[_-]/i, "");
}

function scoreTestFileForSource(testFile, sourceFile) {
  const source = sourceStem(sourceFile).toLowerCase();
  const test = normalizedTestStem(testFile).toLowerCase();
  if (test === source) return 100;
  if (test.includes(source) || source.includes(test)) return 50;
  const sourceDir = path.posix.dirname(sourceFile).replace(/^src\//, "");
  if (sourceDir !== "." && testFile.includes(sourceDir)) return 10;
  return 0;
}

function selectAutoTestCommand(debug, root) {
  const repo = scanRepository(root);
  const frameTest = debug.frames.find((frame) => isTestFile(frame.file));
  if (frameTest) {
    const command = testCommandForFile(root, repo, frameTest.file);
    if (command) return command;
  }

  const sourceFiles = [...new Set([
    ...debug.frames.filter((frame) => !isTestFile(frame.file)).map((frame) => frame.file),
    ...(debug.likelyFiles || []).filter((file) => !isTestFile(file))
  ])];
  let best = null;
  for (const testFile of repo.testFiles) {
    const score = Math.max(0, ...sourceFiles.map((sourceFile) => scoreTestFileForSource(testFile, sourceFile)));
    if (score > 0 && (!best || score > best.score || (score === best.score && testFile < best.file))) {
      best = { file: testFile, score };
    }
  }
  if (best) {
    const command = testCommandForFile(root, repo, best.file);
    if (command) return command;
  }

  return debug.suggestedTestCommands?.[0] || null;
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

  const debug = analyzeDebugLog(logText, { root, engine });
  const selectedTestCommand = options.testCommand || (options.autoTest ? selectAutoTestCommand(debug, root) : null);
  const providedPatch = patchFromOptions(options);
  let patchSource = providedPatch || await generateDebugPatch({ ...debug, log: logText }, options.env || process.env);

  if (!patchSource.patch) {
    const status = "blocked";
    return {
      status,
      stage: "patch_generation",
      debug,
      patchSource,
      decision: buildDecisionSummary({ status, stage: "patch_generation", selectedTestCommand })
    };
  }

  patchSource.patch = normalizeUnifiedDiff(patchSource.patch);
  let validation = validateUnifiedDiff(patchSource.patch);
  if (!validation.valid) {
    const status = "deny";
    return {
      status,
      stage: "patch_validation",
      debug,
      patchSource: summarizePatchSource(patchSource),
      validation,
      decision: buildDecisionSummary({ status, stage: "patch_validation", validation, selectedTestCommand })
    };
  }

  let policy = engine.checkPatch(patchSource.patch);
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && options.confirmed)) {
    const status = policy.status;
    return {
      status,
      stage: "policy",
      debug,
      patchSource: summarizePatchSource(patchSource),
      validation,
      policy,
      decision: buildDecisionSummary({ status, stage: "policy", validation, policy, selectedTestCommand })
    };
  }

  let applyCheck;
  let recovery = null;
  try {
    applyCheck = applyPatchWithPolicy(root, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed),
      checkOnly: true,
      auditLog: options.auditLog
    });
  } catch (error) {
    const patchDiagnostics = buildPatchDiagnostics(patchSource.patch, error);
    recovery = canRecoverPatchCheck(patchSource)
      ? attemptPatchCheckRecovery(root, debug, engine, {
        confirmed: Boolean(options.confirmed),
        auditLog: options.auditLog
      })
      : {
        status: "skipped",
        reason: "Patch recovery is only attempted for generated patches."
      };

    if (recovery.status === "recovered") {
      patchSource = recovery.patchSource;
      validation = recovery.validation;
      policy = recovery.policy;
      applyCheck = recovery.applyCheck;
    } else {
      const status = recovery.status === "require_confirmation" || recovery.status === "deny"
        ? recovery.status
        : "failed";
      const stage = recovery.status === "require_confirmation" || recovery.status === "deny"
        ? "patch_recovery_policy"
        : "patch_check";
      return {
        status,
        stage,
        debug,
        patchSource: summarizePatchSource(patchSource),
        validation,
        policy,
        error: error.message,
        patchDiagnostics,
        recovery,
        decision: buildDecisionSummary({ status, stage, validation, policy, selectedTestCommand })
      };
    }
  }

  const pr = buildPrSummary(patchSource.patch);
  pr.title = buildFixTitle(debug);
  pr.branch = buildBranchName(debug);
  pr.commitMessage = buildCommitMessage(debug);

  const base = {
    debug,
    patchSource: summarizePatchSource(patchSource),
    validation,
    policy,
    applyCheck,
    recovery,
    pr,
    selectedTestCommand
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
        decision: buildDecisionSummary({ status: outputPatchPolicy.status, stage: "output_patch", validation, policy, applyCheck, selectedTestCommand })
      };
    }
    outputPatch = writeFileWithPolicy(root, options.outputPatch, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed),
      auditLog: options.auditLog
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
        decision: buildDecisionSummary({ status, stage: "pr_body", validation, policy, applyCheck, outputPatch, selectedTestCommand })
      };
    }
    prBody = writeFileWithPolicy(root, options.writePrBody, pr.body, engine, {
      confirmed: Boolean(options.confirmed),
      auditLog: options.auditLog
    });
  }

  const gitPlan = (options.createBranch || options.commit || options.push || options.prDryRun || options.createPr)
    ? buildFixGitPlan({
      patch: patchSource.patch,
      branch: pr.branch,
      commitMessage: pr.commitMessage,
      title: pr.title,
      body: pr.body,
      bodyFile: options.prBodyFile,
      createBranch: Boolean(options.createBranch),
      commit: Boolean(options.commit),
      push: Boolean(options.push),
      prDryRun: Boolean(options.prDryRun || options.createPr)
    })
    : null;

  let gitPolicy = null;
  if (options.executeGitPlan && options.apply && !options.dryRun && gitPlan) {
    gitPolicy = checkGitPlanPolicy(gitPlan, engine, {
      confirmed: Boolean(options.confirmed)
    });
    if (gitPolicy.status !== "allow") {
      const status = gitPolicy.status;
      return {
        status,
        stage: "git_plan_policy",
        ...base,
        outputPatch,
        prBody,
        gitPlan,
        gitPolicy,
        decision: buildDecisionSummary({ status, stage: "git_plan_policy", validation, policy, applyCheck, outputPatch, prBody, gitPlan, gitPolicy, selectedTestCommand })
      };
    }
  }

  const plannedBase = {
    ...base,
    outputPatch,
    prBody,
    gitPlan,
    gitPolicy
  };

  if (options.dryRun || !options.apply) {
    const status = options.dryRun ? "dry_run" : "ready";
    return {
      status,
      ...plannedBase,
      decision: buildDecisionSummary({ status, validation, policy, applyCheck, outputPatch, prBody, gitPlan, gitPolicy, selectedTestCommand })
    };
  }

  let applyResult;
  try {
    applyResult = applyPatchWithPolicy(root, patchSource.patch, engine, {
      confirmed: Boolean(options.confirmed),
      checkOnly: false,
      auditLog: options.auditLog
    });
  } catch (error) {
    return {
      status: "failed",
      stage: "patch_apply",
      ...plannedBase,
      error: error.message,
      decision: buildDecisionSummary({ status: "failed", stage: "patch_apply", validation, policy, applyCheck, outputPatch, prBody, gitPlan, gitPolicy, selectedTestCommand })
    };
  }

  let tests = null;
  if (selectedTestCommand) {
    try {
      tests = runCommandWithPolicy(root, selectedTestCommand, engine, {
        confirmed: Boolean(options.confirmed),
        auditLog: options.auditLog
      });
    } catch (error) {
      tests = {
        status: "failed",
        command: selectedTestCommand,
        error: error.message
      };
    }
  }

  let status = tests && tests.status !== "passed" ? "failed" : "passed";
  let gitExecution = null;
  if (status === "passed" && options.executeGitPlan && gitPlan) {
    gitExecution = executeGitPlan(root, gitPlan, engine, {
      confirmed: Boolean(options.confirmed)
    });
    if (gitExecution.status !== "executed") {
      status = gitExecution.status === "deny" || gitExecution.status === "require_confirmation"
        ? gitExecution.status
        : "failed";
    }
  }

  return {
    status,
    ...plannedBase,
    applyResult,
    tests,
    gitExecution,
    selectedTestCommand,
    decision: buildDecisionSummary({
      status,
      stage: gitExecution && gitExecution.status !== "executed" ? gitExecution.stage : null,
      validation,
      policy,
      applyCheck,
      tests,
      outputPatch,
      prBody,
      gitPlan,
      gitPolicy,
      gitExecution,
      selectedTestCommand
    })
  };
}

export const fixInternals = {
  buildBranchName,
  buildCommitMessage,
  buildFixTitle,
  buildDecisionSummary,
  selectAutoTestCommand
};
