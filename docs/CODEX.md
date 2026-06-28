# Codex Integration / Codex 集成

Codex is the current priority integration target for VibeGuard.

Codex 是 VibeGuard 当前优先支持的 agent 集成目标。

## Model / 集成模型

The integration is CLI-first:

集成方式以 CLI 为主：

1. Codex works inside the repository workspace. / Codex 在仓库工作区内运行。
2. Codex calls `node ./bin/vibeguard.js ...`. / Codex 调用 `node ./bin/vibeguard.js ...`。
3. VibeGuard checks `.vibeguard.yaml` before debug-context reads, writes, patches, and risky commands. / VibeGuard 在读取 debug context、写文件、patch 和风险命令前检查 `.vibeguard.yaml`。
4. Codex reads JSON output and decides the next action. / Codex 根据 JSON 输出决定下一步。

The optional MCP-style server supports `initialize`, `tools/list` with JSON schemas, schema-validated `tools/call`, text content, `structuredContent`, and tool-level `isError` responses. Codex should prefer `structuredContent` when available.

可选的 MCP-style server 支持 `initialize`、带 JSON schema 的 `tools/list`、经过 schema 校验的 `tools/call`、text content、`structuredContent` 和工具级 `isError` 响应。Codex 可用时应优先读取 `structuredContent`。

## Project Constraints / 项目约束

- Every completed work part must update relevant docs. / 每完成一个可交付部分，都必须同步更新相关文档。
- Current agent/provider priority is Codex and Grok only. / 当前 agent/provider 只优先 Codex 和 Grok。
- Cursor, Claude Code, and Cline remain deferred. / Cursor、Claude Code、Cline 暂缓。
- `.env` may contain the local Grok API key; never print, edit, or commit it. / `.env` 可能包含本地 Grok API key，不能打印、修改或提交。

## Recommended Commands / 推荐命令

Check local readiness and policy:

检查本地环境和 policy：

```bash
node ./bin/vibeguard.js doctor --json
node ./bin/vibeguard.js policy check --path src/index.js --json
node ./bin/vibeguard.js policy check --command "npm test" --json
node ./bin/vibeguard.js policy check --path src/index.js --audit-log reports/audit.jsonl --json
```

`doctor` reports provider presence, readiness, the effective default model, and machine-readable `nextActions` without exposing API keys.

`doctor` 会报告 provider 是否存在、是否 ready、实际默认模型，以及机器可读的 `nextActions`，但不会暴露 API key。

Analyze an error log:

分析报错日志：

```bash
node ./bin/vibeguard.js debug --log error.log --json
node ./bin/vibeguard.js debug --log error.log --ai-patch --output-patch reports/generated.patch --json
```

`debug --log <file>` and `fix --log <file>` read log files through path policy before parsing them.

`debug --log <file>` 和 `fix --log <file>` 会先经过路径 policy 读取日志文件，然后才解析内容。

For Django tracebacks, Codex should inspect `frameworkContext`, `likelyFiles`, `hints`, and `suggestedTestCommands`. Django projects can include `python manage.py check` and `python manage.py test` when policy allows those commands.

Django traceback 场景下，Codex 应检查 `frameworkContext`、`likelyFiles`、`hints` 和 `suggestedTestCommands`。Django 项目会在 policy 允许时给出 `python manage.py check` 和 `python manage.py test`。

For any debug result, Codex should show or reuse `explanation.message`, `explanation.likelyCause`, and `explanation.evidence` before asking for or applying a patch.

对任何 debug 结果，Codex 在请求或应用 patch 前，都应该展示或复用 `explanation.message`、`explanation.likelyCause` 和 `explanation.evidence`。

For AI/provider patch generation, Codex should inspect `aiPatch.repairPlan` or `patchSource.repairPlan` before applying anything. It gives the likely target files, concrete repair strategy, policy/apply-check requirements, and the smallest validation commands to run.

AI/provider 生成 patch 时，Codex 在应用任何内容前应检查 `aiPatch.repairPlan` 或 `patchSource.repairPlan`。它会给出可能目标文件、具体修复策略、policy/apply check 要求，以及应运行的最小验证命令。

When `--output-patch` is used with `debug --ai-patch`, the patch is normalized, validated, checked by patch policy, and then written as an artifact; it is not applied. When a patch is checked or applied, the underlying `git apply --check` / `git apply` command is also command-policy gated.

`debug --ai-patch` 搭配 `--output-patch` 时，patch 会先规范化、校验、经过 patch policy 检查，然后作为 artifact 写出；它不会被应用。当 patch 被检查或应用时，底层 `git apply --check` / `git apply` 命令也会经过 command policy。

Debug snippets are read only when the target file is allowed by path policy; denied files may still appear as stack metadata, but their source text is not included in snippets or AI context.

Debug snippets 只有在目标文件通过 path policy 时才会读取；denied 文件仍可能作为 stack metadata 出现，但源码文本不会进入 snippets 或 AI context。

For Spring Boot stack traces, Codex should inspect `frameworkContext`, `frameworkContexts`, controller/service/repository/config likely files, and Maven/Gradle test commands before asking for a patch.

Spring Boot stack trace 场景下，Codex 应检查 `frameworkContext`、`frameworkContexts`、controller/service/repository/config 相关文件，以及 Maven/Gradle 测试命令，再决定是否要求生成 patch。

Run the safe fix workflow:

运行安全修复工作流：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --apply --json
node ./bin/vibeguard.js fix --log error.log --auto-test --apply --json
```

`fix` normalizes fenced diffs, plain unified diffs, non-standard `diff a/file b/file` headers, and incorrect hunk counts before policy and `git apply --check`.

`fix` 会在 policy 和 `git apply --check` 前规范化 fenced diff、plain unified diff、非标准 `diff a/file b/file` header 和错误的 hunk count。

When an AI/provider-generated patch fails `git apply --check`, Codex should inspect `patchDiagnostics` and `recovery`. VibeGuard can recover a clear Django `TemplateDoesNotExist` case by replacing a missing template string with the single matching existing template path; the fallback patch still goes through validation, policy, and apply check. User-provided patches are not silently replaced.

当 AI/provider 生成的 patch 在 `git apply --check` 失败时，Codex 应检查 `patchDiagnostics` 和 `recovery`。VibeGuard 可以恢复明确的 Django `TemplateDoesNotExist` 场景：把缺失模板字符串替换为仓库中唯一匹配的现有模板路径；fallback patch 仍会经过 validation、policy 和 apply check。用户手动提供的 patch 不会被静默替换。

Write generated patch artifacts after validation and policy checks:

在校验和 policy 通过后写出 patch artifact：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --output-patch patches/fix.diff --dry-run --json
```

Patch input files also pass read policy before VibeGuard reads them. Do not place patch artifacts in denied paths such as `.env`.

Patch 输入文件在 VibeGuard 读取前也会经过 read policy。不要把 patch artifact 放在 `.env` 等 denied 路径。

Through MCP, use `apply_patch_safely` for patch validation. It checks only by default and applies only when `apply` is true.

通过 MCP 时，使用 `apply_patch_safely` 做 patch 校验。它默认只检查，只有 `apply` 为 true 时才会应用。

Through MCP, `debug_error` can read `logFile` through path policy and can also generate an AI patch by passing `aiPatch: true`; if `outputPatch` is provided, the patch is normalized, validated, checked by policy, and written as an artifact without applying it.

通过 MCP 时，`debug_error` 可以先通过 path policy 读取 `logFile`，也可以通过 `aiPatch: true` 生成 AI patch；如果传入 `outputPatch`，patch 会先规范化、校验并经过 policy 检查，然后作为 artifact 写出，不会直接应用。

MCP `fix_error` can use `logFile` and `patchFile` as policy-checked file inputs when Codex should not read those files directly.

当 Codex 不应该直接读取相关文件时，MCP `fix_error` 可以使用 `logFile` 和 `patchFile` 作为经过 policy 检查的文件输入。

Generate a branch, commit, and PR dry-run plan:

生成 branch、commit、PR dry-run 计划：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --pr-dry-run --pr-body-file patches/pr-body.md --dry-run --json
```

Execute local branch and commit after patch and tests pass:

patch 和测试通过后执行本地 branch 和 commit：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --execute-git-plan --confirm --apply --json
```

Include remote push and draft PR creation only when GitHub remote and `gh` auth are ready, or when a `GITHUB_TOKEN` / `GH_TOKEN` REST fallback is available:

只有在 GitHub remote 和 `gh` 认证就绪，或存在可用的 `GITHUB_TOKEN` / `GH_TOKEN` REST fallback 后，才加入远端 push 和 draft PR：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --apply --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --apply --github-api --json
```

GitHub detect and PR fallback prerequisites are command-policy gated. If repository policy requires confirmation for `git remote get-url origin` or `git branch --show-current`, Codex must stop at the returned policy result until confirmation is present.

GitHub detect 和 PR fallback prerequisite 会经过 command policy。如果仓库策略要求确认 `git remote get-url origin` 或 `git branch --show-current`，Codex 必须停在返回的 policy 结果，直到已有确认。

CLI and MCP GitHub paths pass the repository `PolicyEngine` into the helpers. Direct public GitHub helper calls must pass a `PolicyEngine` for remote detection and `dryRun:false` execution; otherwise VibeGuard rejects the GitHub operation before reaching `git`, `gh`, or the REST API fallback.

CLI 和 MCP 的 GitHub 路径会把仓库 `PolicyEngine` 传给 helper。直接调用公开 GitHub helper 时，remote 检测和 `dryRun:false` 真实执行都必须传入 `PolicyEngine`；否则 VibeGuard 会在调用 `git`、`gh` 或 REST API fallback 前拒绝 GitHub 操作。

For Fix workflows, executed Git plans route `create_pr` through the same helper as `github pr`, so Codex can use CLI `--github-api` or MCP `githubUseApi` / `GITHUB_TOKEN` when `gh` is unavailable while keeping policy confirmation in front of the operation.

对于 Fix workflow，执行型 Git plan 的 `create_pr` 会走和 `github pr` 相同的 helper；当本机没有 `gh` 时，Codex 可以用 CLI `--github-api` 或 MCP `githubUseApi` / `GITHUB_TOKEN`，同时仍然把 policy confirmation 放在操作前。

Run deterministic fixture demos:

运行确定性 fixture demo：

```bash
node ./bin/vibeguard.js --root fixtures/python-bug fix --log error.log --patch fixes/name-error.patch --test "python -m unittest discover -s tests" --dry-run --json
node ./bin/vibeguard.js --root fixtures/node-bug fix --log error.log --patch fixes/reference-error.patch --test "npm test" --dry-run --json
node ./bin/vibeguard.js --root fixtures/django-bug fix --log error.log --patch fixes/template-error.patch --auto-test --dry-run --json
node ./bin/vibeguard.js --root fixtures/spring-boot-bug fix --log error.log --patch fixes/service-annotation.patch --auto-test --dry-run --json
```

Evaluate the configured LLM provider:

评测当前 LLM provider：

```bash
node ./bin/vibeguard.js eval fixtures --json
node ./bin/vibeguard.js eval fixtures --repeat 3 --json
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

The baseline fixture set covers Python, Node, Django-style, and Spring Boot-style repair flows.

baseline fixture 集合覆盖 Python、Node、Django-style 和 Spring Boot-style 修复流程。

Use `--repeat <n>` to measure provider stability across repeated fixture runs; each result includes `run`.

使用 `--repeat <n>` 可以跨多轮 fixture run 衡量 provider 稳定性；每条结果都会包含 `run`。

Use a real Grok provider:

使用真实 Grok provider：

```bash
export VIBEGUARD_LLM_PROVIDER=grok
export XAI_API_KEY=...
export VIBEGUARD_MODEL=grok-4.3
node ./bin/vibeguard.js eval fixtures --json
```

The CLI loads local `.env` by default, so the same values can live there for local Codex runs.

CLI 默认加载本地 `.env`，所以本地 Codex 运行可以直接使用其中的 Grok 配置。

If provider proxy environment variables are not set, Codex runs inherit Git `https.proxy` / `http.proxy` for provider requests by parsing `.git/config` instead of running `git config --get`.

如果 provider 代理环境变量未设置，Codex 运行会通过解析 `.git/config` 继承 Git `https.proxy` / `http.proxy` 作为 provider 请求代理，而不是执行 `git config --get`。

If a provider request returns HTTP 4xx/5xx, `patchSourceReason` includes a bounded provider error summary. It does not include API keys.

如果 provider 请求返回 HTTP 4xx/5xx，`patchSourceReason` 会包含长度受限的 provider 错误摘要，不包含 API key。

Codex should inspect `summary.successRate`, fixture `outcome`, `policyStatus`, `stage`, `patchSourceReason`, `patchRecoveryStatus`, and `patchRecoveryStrategy` before applying generated patches.

Codex 应该先检查 `summary.successRate`、fixture `outcome`、`policyStatus`、`stage`、`patchSourceReason`、`patchRecoveryStatus` 和 `patchRecoveryStrategy`，再决定是否应用生成的 patch。

For trend checks, inspect `summary.fixtureOutcomeCounts` from `eval history` to identify which fixture is regressing.

查看趋势时，应检查 `eval history` 的 `summary.fixtureOutcomeCounts`，定位具体哪个 fixture 在退化。

Run tests through command policy:

通过 command policy 运行测试：

```bash
node ./bin/vibeguard.js run --command "npm test" --json
node ./bin/vibeguard.js run --command "npm test" --audit-log reports/audit.jsonl --json
node ./bin/vibeguard.js audit summary --file reports/audit.jsonl --json
node ./bin/vibeguard.js audit report --file reports/audit.jsonl --output reports/audit.md --json
```

Codex should use `--audit-log reports/audit.jsonl` for reviewed write/patch/command workflows when a persistent local audit trail is useful. The audit log path is checked by policy before any JSONL event is appended.

需要保留本地审计轨迹时，Codex 应在已审查的写文件、patch、命令流程中使用 `--audit-log reports/audit.jsonl`。追加 JSONL 事件前，审计日志路径本身也会经过 policy 检查。

Codex can use `audit summary` to inspect operation counts, policy statuses, blocked events, recent entries, and parse errors. Use `audit report` to write a Markdown report through policy for human review.

Codex 可以使用 `audit summary` 查看操作次数、policy 状态、blocked 事件、最近记录和解析错误。使用 `audit report` 可以经过 policy 写出 Markdown 报告，供人工 review。

Find test targets with coverage reports:

结合 coverage report 查找测试候选：

```bash
node ./bin/vibeguard.js test --coverage coverage.json --json
node ./bin/vibeguard.js test --coverage coverage/lcov.info --json
node ./bin/vibeguard.js test --coverage coverage-before.json --coverage-after coverage-after.json --json
node ./bin/vibeguard.js test --write --coverage coverage.json --run --limit 1 --json
node ./bin/vibeguard.js test --write --run --repair --limit 1 --json
node ./bin/vibeguard.js test --write --create-branch --commit --pr-dry-run --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --execute-git-plan --confirm --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --create-pr --execute-git-plan --confirm --github-api --json
```

Coverage report file inputs pass path policy before parsing. Keep reports in allowed paths such as `reports/**`, root `coverage*.json`, `coverage/**`, or another repository-configured allow path.

Coverage report 文件输入会在解析前经过 path policy。建议把报告放在 `reports/**`、仓库根部 `coverage*.json`、`coverage/**` 或仓库配置允许的其他路径。

Codex should inspect `coverage`, `coverageTargets`, `coverage.missingLines`, `uncoveredFunctions`, `uncoveredClasses`, `uncoveredInterfaces`, `classes`, `interfaces`, and JavaScript `metadata.moduleSystem` before asking VibeGuard to write new tests. TypeScript interface-only candidates are useful for prioritization but are intentionally skipped for runtime test writes unless a concrete function or class is also present. Inspect `coverageDeltaStatus`; if before/after reports are available, also inspect `coverageDelta.summary.averagePercentDelta`, `coverageDelta.summary.missingLinesReduced`, and file-level `status`. When using `--run`, inspect `testRuns.status`, `testRuns.command`, `stdout`, `stderr`, `failureAnalysis`, and `failureAnalysis.repairPlan` before proposing a commit. When `--repair` is used, also inspect `initialTestRuns`, `repairRuns`, and the final `testRuns`; only the final `testRuns` gate Git execution. When asking for a test PR, inspect `gitPlan`, `gitPolicy`, and `gitExecution`; Git state changes and PR creation still require policy confirmation, and branch/commit/PR execution is blocked unless generated tests have passed. Use CLI `--github-api` or MCP `githubUseApi` when Codex should force token REST fallback for test PR creation.

Codex 在要求 VibeGuard 写测试前，应先检查 `coverage`、`coverageTargets`、`coverage.missingLines`、`uncoveredFunctions`、`uncoveredClasses`、`uncoveredInterfaces`、`classes`、`interfaces` 和 JavaScript `metadata.moduleSystem`。TypeScript interface-only 候选用于排序和定位，但除非同一个文件还有具体函数或类，否则会有意跳过运行时测试写入。先检查 `coverageDeltaStatus`；如果有 before/after 报告，还要检查 `coverageDelta.summary.averagePercentDelta`、`coverageDelta.summary.missingLinesReduced` 和文件级 `status`。使用 `--run` 时，提交前还要检查 `testRuns.status`、`testRuns.command`、`stdout`、`stderr`、`failureAnalysis` 和 `failureAnalysis.repairPlan`。使用 `--repair` 时，还要检查 `initialTestRuns`、`repairRuns` 和最终 `testRuns`；只有最终 `testRuns` 用作 Git 执行门。生成测试 PR 时，还要检查 `gitPlan`、`gitPolicy` 和 `gitExecution`；Git 状态变更和 PR 创建仍然需要 policy 确认，branch/commit/PR 执行会在生成测试未通过时被阻止。当 Codex 需要强制用 token REST fallback 创建测试 PR 时，使用 CLI `--github-api` 或 MCP `githubUseApi`。

When generated tests fail, `failureAnalysis.repairPlan` tells Codex whether a test-only retry is safe, which actions to take next, and which guardrails must not be violated.

生成测试失败时，`failureAnalysis.repairPlan` 会告诉 Codex 是否适合只重试测试文件、下一步动作是什么，以及哪些 guardrail 不能违反。

With `--repair`, VibeGuard can rewrite only the generated test file through Policy-as-Code and rerun the same focused command for safe categories. The first supported successful repair is `python_source_dir_sys_path`, which fixes generated Python tests that fail because local source-directory imports are not on `sys.path`.

使用 `--repair` 时，VibeGuard 可以只通过 Policy-as-Code 重写生成的测试文件，并对安全分类重新运行同一个聚焦命令。首个已支持的成功修复策略是 `python_source_dir_sys_path`，用于修复 Python 生成测试因源码目录本地 import 未进入 `sys.path` 而失败的场景。

Generated tests may include behavior assertions for simple pure functions, clear branches such as null/None checks, object-property and dictionary-field fallbacks, numeric lower-bound branches including `<= 0`, empty collection checks, and clear exception branches such as `throw new RangeError(...)` or `raise ValueError(...)`. JavaScript module detection supports ESM, CommonJS, and CommonJS bracket exports such as `exports["name"] = value`. Python tests are generated as stdlib `unittest` cases so they can run without requiring pytest. More complex IO, database, dependency injection, and mock-heavy cases still require review.

生成的测试可能包含简单纯函数、明确分支、对象属性/字典字段 fallback、常见边界值和明确异常分支的行为断言，例如 null/None 检查、包含 `<= 0` 的数值下界分支、空集合检查、`throw new RangeError(...)` 或 `raise ValueError(...)`。JavaScript 模块识别支持 ESM、CommonJS，以及 `exports["name"] = value` 这类 CommonJS bracket export。Python 测试会生成为 stdlib `unittest` 用例，因此不强制依赖 pytest。更复杂的 IO、数据库、依赖注入和重 mock 场景仍需要人工 review。

Generate bilingual onboarding and architecture docs:

生成中英双语 onboarding 和 architecture 文档：

```bash
node ./bin/vibeguard.js onboard --write --json
```

Codex should inspect `scan.dependencies`, `coreModules`, and `firstTasks` after onboarding. `scan.dependencies` lists package.json, requirements.txt, pyproject.toml, pom.xml, and Gradle dependencies with source, scope, and version when available. `coreModules` ranks likely entrypoint, routing, service, data-model, UI, and framework-config areas with bilingual reasons and representative files; `firstTasks` are repository-specific low-risk starting points with optional commands and files.

Codex 在 onboarding 后应检查 `scan.dependencies`、`coreModules` 和 `firstTasks`。`scan.dependencies` 会列出 package.json、requirements.txt、pyproject.toml、pom.xml 和 Gradle 依赖，并尽量提供来源、scope 和版本。`coreModules` 会按入口、路由、服务、数据模型、UI 和框架配置等维度排序核心模块，并给出中英双语原因和代表文件；`firstTasks` 是按仓库扫描结果生成的低风险新人任务，可包含建议命令和相关文件。

Codex should also inspect `commandChecks` before telling a user to run onboarding commands. A command can be `available`, `needs_dependency`, `missing_wrapper`, or another explicit status with a bilingual reason.

Codex 在建议用户运行 onboarding 命令前，也应检查 `commandChecks`。命令可能是 `available`、`needs_dependency`、`missing_wrapper` 或其他明确状态，并附带中英双语原因。

Review changes:

审查变更：

```bash
node ./bin/vibeguard.js review --json
node ./bin/vibeguard.js review --diff reports/change.diff --write-comment reports/review.md --json
node ./bin/vibeguard.js review --github-pr 12 --github-api --write-comment reports/review.md --json
node ./bin/vibeguard.js review --diff reports/change.diff --comment-pr 12 --execute --confirm --github-api --json
node ./bin/vibeguard.js review --github-pr 12 --publish-comment --execute --confirm --github-api --json
node ./bin/vibeguard.js pr summary --diff reports/change.diff --write-body reports/pr-body.md --json
node ./bin/vibeguard.js pr summary --github-pr 12 --github-api --write-body reports/pr-body.md --json
node ./bin/vibeguard.js github review-comments --pr 12 --commit abc123 --diff reports/change.diff --json
node ./bin/vibeguard.js github review-comments --pr 12 --commit abc123 --github-pr 12 --github-api --json
```

Review findings include `file`, `line`, `severity`, `category`, `message`, and `recommendation` when line information is available. The bug category currently covers Python mutable defaults, assignment inside JavaScript/TypeScript conditionals, and swallowed exceptions. Codex can use `actionItems` for planning, `reviewComments` for file-line GitHub review comments, `markdown` as a general PR comment body, `--write-comment` to write that body through Policy-as-Code, or `review --comment-pr` / `review --publish-comment` to directly publish the generated review Markdown as a policy-gated GitHub PR comment. When `review` is called without `--diff`, its default `git diff --cached` / `git diff` reads are command-policy gated. `--github-pr` and MCP `githubPr` read remote PR diffs through policy-checked `gh pr diff` or REST fallback; use `--github-api` / `useApi` to force the token API path. `github review-comments` can turn the generated `reviewComments` into a batched dry-run or confirmed execution plan. CLI `--diff` input files and MCP `review_pr.diffFile` / `summarize_pr.diffFile` / `github_review_comments.diffFile` inputs are also read through path policy.

Review findings 在有行号信息时会包含 `file`、`line`、`severity`、`category`、`message` 和 `recommendation`。bug 类规则当前覆盖 Python mutable default、JavaScript/TypeScript 条件里的疑似赋值、以及吞掉异常。Codex 可以使用 `actionItems` 做执行计划，使用 `reviewComments` 发布文件行级 GitHub review comment，直接用 `markdown` 作为普通 PR 评论正文，用 `--write-comment` 先经过 Policy-as-Code 写出正文文件，或用 `review --comment-pr` / `review --publish-comment` 直接把生成的 review Markdown 受 policy 保护地发布为 GitHub PR comment。当 `review` 未传 `--diff` 时，默认 `git diff --cached` / `git diff` 读取会经过 command policy。`--github-pr` 和 MCP `githubPr` 会通过 policy 检查后的 `gh pr diff` 或 REST fallback 读取远端 PR diff；用 `--github-api` / `useApi` 可以强制走 token API 路径。`github review-comments` 可以把生成的 `reviewComments` 转成批量 dry-run 或确认后的执行计划。CLI `--diff` 输入文件和 MCP `review_pr.diffFile` / `summarize_pr.diffFile` / `github_review_comments.diffFile` 输入也会经过路径 policy 读取。

`pr summary` includes review findings, severity counts, and action items in the generated PR body. When no explicit diff is supplied through `--diff` or stdin, its default `git diff` read is command-policy gated. `--write-body` writes that body through policy so it can be reused by `github pr --body-file`.

`pr summary` 会在生成的 PR body 中包含 review findings、严重度统计和 action items。未通过 `--diff` 或 stdin 传入显式 diff 时，默认 `git diff` 读取会经过 command policy。`--write-body` 会经过 policy 写出正文文件，方便继续用于 `github pr --body-file`。

Read GitHub Actions status:

读取 GitHub Actions 状态：

```bash
node ./bin/vibeguard.js github checks --branch codex/fix-bug --limit 5 --json
node ./bin/vibeguard.js github checks --branch codex/fix-bug --limit 5 --execute --json
```

`github checks --execute` first builds the `gh run list` dry-run command and checks it against command policy before reading remote CI state.

`github checks --execute` 会先生成 `gh run list` dry-run 命令，并在读取远端 CI 状态前经过 command policy 检查。

Post a PR summary or review note:

发布 PR summary 或 review note：

```bash
node ./bin/vibeguard.js review --diff reports/change.diff --comment-pr 12 --json
node ./bin/vibeguard.js review --diff reports/change.diff --comment-pr 12 --execute --confirm --github-api --json
node ./bin/vibeguard.js review --github-pr 12 --publish-comment --execute --confirm --github-api --json
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --json
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --execute --confirm --json
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --execute --confirm --github-api --json
node ./bin/vibeguard.js github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md --json
node ./bin/vibeguard.js github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md --execute --confirm --json
node ./bin/vibeguard.js github review-comments --pr 12 --commit abc123 --diff reports/change.diff --json
node ./bin/vibeguard.js github review-comments --pr 12 --commit abc123 --diff reports/change.diff --execute --confirm --json
```

The MCP-style server exposes the same GitHub PR path as `github_pr`, which returns a dry-run `gh pr create` command unless `execute` is true and policy confirmation is present. Pass `useApi` on GitHub MCP tools to force token REST fallback.

MCP-style server 也通过 `github_pr` 暴露同一条 GitHub PR 路径；默认返回 dry-run 的 `gh pr create` 命令，只有 `execute` 为 true 且通过 policy 确认时才执行。GitHub MCP 工具可传 `useApi` 强制使用 token REST fallback。

For one file-line PR review comment, use `github review-comment` or MCP `github_review_comment` with the PR head commit SHA, file path, and diff line. For all generated diff findings, use `github review-comments` or MCP `github_review_comments`; each generated `gh api` command is checked by command policy before execution.

对于单条文件行级 PR review comment，使用 `github review-comment` 或 MCP `github_review_comment`，并传入 PR head commit SHA、文件路径和 diff line。对于 diff 中生成的全部 findings，使用 `github review-comments` 或 MCP `github_review_comments`；每条生成的 `gh api` 命令都会在执行前经过 command policy。

When `gh` is unavailable, execute mode can use `GITHUB_TOKEN` or `GH_TOKEN` through the GitHub REST API fallback; `--github-api` / `useApi` can also force that path even if `gh` exists. Policy confirmation is still required for PR creation and PR comments.

当本机没有 `gh` 时，execute 模式可以使用 `GITHUB_TOKEN` 或 `GH_TOKEN` 通过 GitHub REST API fallback 执行；即使存在 `gh`，也可以用 `--github-api` / `useApi` 强制走这条路径。创建 PR 和发布 PR comment 仍然需要 policy 确认。

For CLI and MCP-style GitHub PR/comment flows, `--body-file` / `bodyFile` is checked through path policy before dry-run or execution, so denied files such as `.env` cannot be reused as PR or comment bodies. For generated Git plans, PR body files are also checked through `read_pr_body` path policy before any protected branch/commit/push/PR execution.

对于 CLI 和 MCP-style 的 GitHub PR/comment 流程，`--body-file` / `bodyFile` 会先经过 path policy 检查，然后才进入 dry-run 或执行，因此 `.env` 等 denied 文件不能被当作 PR 或 comment 正文复用。对于生成的 Git plan，PR body 文件也会在受保护的 branch / commit / push / PR 执行前经过 `read_pr_body` path policy。

## Operating Rules / 操作规则

- Do not bypass `.vibeguard.yaml`. / 不要绕过 `.vibeguard.yaml`。
- Do not modify denied paths. / 不要修改 denied 路径。
- Use `--check-only` before applying patches. / 应用 patch 前先用 `--check-only`。
- Prefer `fix --dry-run` before `fix --apply`. / 优先先跑 `fix --dry-run`，再跑 `fix --apply`。
- Use `--auto-test` when stack-trace or source-file based minimal test selection is acceptable; it falls back to the repository command when no matching test file is found. / 当可以接受基于 stack trace 或源码文件选择最小测试时使用 `--auto-test`；找不到匹配测试文件时会回退到仓库测试命令。
- Treat `gitPlan` as reviewable until `--execute-git-plan --confirm --apply` is present; inspect `gitPolicy.results` and `gitPolicy.pathResults` before execution. / 没有 `--execute-git-plan --confirm --apply` 时，`gitPlan` 只是可审查计划；执行前要检查 `gitPolicy.results` 和 `gitPolicy.pathResults`。
- Execute remote `--push --create-pr` only after local branch, commit, tests, and PR body are reviewed. / 只有本地 branch、commit、测试和 PR body 都审查后才执行远端 `--push --create-pr`。
- Use `run --command` for commands that should go through policy. / 需要经过 policy 的命令用 `run --command`。
- Keep `ROADMAP.md` local and uncommitted. / `ROADMAP.md` 保持本地且不提交。

## Deferred Integrations / 暂缓集成

Cursor, Claude Code, and Cline are deferred until the Codex flow is stable.

Cursor、Claude Code、Cline 暂缓，等 Codex 流程稳定后再做。
