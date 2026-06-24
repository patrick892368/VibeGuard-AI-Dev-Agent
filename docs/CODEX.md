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

The optional MCP-style server supports `initialize`, `tools/list` with JSON schemas, `tools/call`, text content, and `structuredContent`. Codex should prefer `structuredContent` when available.

可选的 MCP-style server 支持 `initialize`、带 JSON schema 的 `tools/list`、`tools/call`、text content 和 `structuredContent`。Codex 可用时应优先读取 `structuredContent`。

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

`doctor` reports provider presence and the effective default model without exposing API keys.

`doctor` 会报告 provider 是否存在以及实际默认模型，但不会暴露 API key。

Analyze an error log:

分析报错日志：

```bash
node ./bin/vibeguard.js debug --log error.log --json
```

For Django tracebacks, Codex should inspect `frameworkContext`, `likelyFiles`, `hints`, and `suggestedTestCommands`. Django projects can include `python manage.py check` and `python manage.py test` when policy allows those commands.

Django traceback 场景下，Codex 应检查 `frameworkContext`、`likelyFiles`、`hints` 和 `suggestedTestCommands`。Django 项目会在 policy 允许时给出 `python manage.py check` 和 `python manage.py test`。

For any debug result, Codex should show or reuse `explanation.message`, `explanation.likelyCause`, and `explanation.evidence` before asking for or applying a patch.

对任何 debug 结果，Codex 在请求或应用 patch 前，都应该展示或复用 `explanation.message`、`explanation.likelyCause` 和 `explanation.evidence`。

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

Include remote push and draft PR creation only when GitHub remote and `gh` auth are ready:

只有在 GitHub remote 和 `gh` 认证就绪后，才加入远端 push 和 draft PR：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --apply --json
```

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

If provider proxy environment variables are not set, Codex runs inherit Git `https.proxy` / `http.proxy` for provider requests.

如果 provider 代理环境变量未设置，Codex 运行会继承 Git `https.proxy` / `http.proxy` 作为 provider 请求代理。

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
node ./bin/vibeguard.js test --write --create-branch --commit --pr-dry-run --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --execute-git-plan --confirm --json
```

Codex should inspect `coverage`, `coverageTargets`, `coverage.missingLines`, `uncoveredFunctions`, and JavaScript `metadata.moduleSystem` before asking VibeGuard to write new tests. If before/after reports are available, inspect `coverageDelta.summary.averagePercentDelta`, `coverageDelta.summary.missingLinesReduced`, and file-level `status`. When using `--run`, inspect `testRuns.status`, `testRuns.command`, `stdout`, `stderr`, `failureAnalysis`, and `failureAnalysis.repairPlan` before proposing a commit. When asking for a test PR, inspect `gitPlan`, `gitPolicy`, and `gitExecution`; Git state changes and PR creation still require policy confirmation, and local branch/commit execution is blocked unless generated tests have passed.

Codex 在要求 VibeGuard 写测试前，应先检查 `coverage`、`coverageTargets`、`coverage.missingLines`、`uncoveredFunctions` 和 JavaScript `metadata.moduleSystem`。如果有 before/after 报告，还要检查 `coverageDelta.summary.averagePercentDelta`、`coverageDelta.summary.missingLinesReduced` 和文件级 `status`。使用 `--run` 时，提交前还要检查 `testRuns.status`、`testRuns.command`、`stdout`、`stderr`、`failureAnalysis` 和 `failureAnalysis.repairPlan`。生成测试 PR 时，还要检查 `gitPlan`、`gitPolicy` 和 `gitExecution`；Git 状态变更和 PR 创建仍然需要 policy 确认，本地 branch/commit 执行会在生成测试未通过时被阻止。

When generated tests fail, `failureAnalysis.repairPlan` tells Codex whether a test-only retry is safe, which actions to take next, and which guardrails must not be violated.

生成测试失败时，`failureAnalysis.repairPlan` 会告诉 Codex 是否适合只重试测试文件、下一步动作是什么，以及哪些 guardrail 不能违反。

Generated tests may include behavior assertions for simple pure functions, clear branches such as null/None checks, object-property and dictionary-field fallbacks, numeric lower-bound branches including `<= 0`, empty collection checks, and clear exception branches such as `throw new RangeError(...)` or `raise ValueError(...)`. Python tests are generated as stdlib `unittest` cases so they can run without requiring pytest. More complex IO, database, dependency injection, and mock-heavy cases still require review.

生成的测试可能包含简单纯函数、明确分支、对象属性/字典字段 fallback、常见边界值和明确异常分支的行为断言，例如 null/None 检查、包含 `<= 0` 的数值下界分支、空集合检查、`throw new RangeError(...)` 或 `raise ValueError(...)`。Python 测试会生成为 stdlib `unittest` 用例，因此不强制依赖 pytest。更复杂的 IO、数据库、依赖注入和重 mock 场景仍需要人工 review。

Generate bilingual onboarding and architecture docs:

生成中英双语 onboarding 和 architecture 文档：

```bash
node ./bin/vibeguard.js onboard --write --json
```

Codex should inspect `firstTasks` after onboarding. Those tasks are repository-specific low-risk starting points with optional commands and files.

Codex 在 onboarding 后应检查 `firstTasks`。这些任务是按仓库扫描结果生成的低风险新人任务，可包含建议命令和相关文件。

Review changes:

审查变更：

```bash
node ./bin/vibeguard.js review --json
node ./bin/vibeguard.js review --diff reports/change.diff --write-comment reports/review.md --json
node ./bin/vibeguard.js pr summary --diff reports/change.diff --write-body reports/pr-body.md --json
```

Review findings include `file`, `line`, `severity`, `category`, `message`, and `recommendation` when line information is available. Codex can use `actionItems` for planning, `markdown` as a PR comment body, or `--write-comment` to write that body through Policy-as-Code before calling `github comment --body-file`. `--diff` input files are also read through path policy.

Review findings 在有行号信息时会包含 `file`、`line`、`severity`、`category`、`message` 和 `recommendation`。Codex 可以使用 `actionItems` 做执行计划，直接用 `markdown` 作为 PR 评论正文，或用 `--write-comment` 先经过 Policy-as-Code 写出正文文件，再调用 `github comment --body-file`。`--diff` 输入文件也会经过路径 policy 读取。

`pr summary` includes review findings, severity counts, and action items in the generated PR body. `--write-body` writes that body through policy so it can be reused by `github pr --body-file`.

`pr summary` 会在生成的 PR body 中包含 review findings、严重度统计和 action items。`--write-body` 会经过 policy 写出正文文件，方便继续用于 `github pr --body-file`。

Read GitHub Actions status:

读取 GitHub Actions 状态：

```bash
node ./bin/vibeguard.js github checks --branch codex/fix-bug --limit 5 --json
node ./bin/vibeguard.js github checks --branch codex/fix-bug --limit 5 --execute --json
```

Post a PR summary or review note:

发布 PR summary 或 review note：

```bash
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --json
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --execute --confirm --json
```

The MCP-style server exposes the same GitHub PR path as `github_pr`, which returns a dry-run `gh pr create` command unless `execute` is true and policy confirmation is present.

MCP-style server 也通过 `github_pr` 暴露同一条 GitHub PR 路径；默认返回 dry-run 的 `gh pr create` 命令，只有 `execute` 为 true 且通过 policy 确认时才执行。

When `gh` is unavailable, execute mode can use `GITHUB_TOKEN` or `GH_TOKEN` through the GitHub REST API fallback. Policy confirmation is still required for PR creation and PR comments.

当本机没有 `gh` 时，execute 模式可以使用 `GITHUB_TOKEN` 或 `GH_TOKEN` 通过 GitHub REST API fallback 执行。创建 PR 和发布 PR comment 仍然需要 policy 确认。

## Operating Rules / 操作规则

- Do not bypass `.vibeguard.yaml`. / 不要绕过 `.vibeguard.yaml`。
- Do not modify denied paths. / 不要修改 denied 路径。
- Use `--check-only` before applying patches. / 应用 patch 前先用 `--check-only`。
- Prefer `fix --dry-run` before `fix --apply`. / 优先先跑 `fix --dry-run`，再跑 `fix --apply`。
- Use `--auto-test` when stack-trace or source-file based minimal test selection is acceptable; it falls back to the repository command when no matching test file is found. / 当可以接受基于 stack trace 或源码文件选择最小测试时使用 `--auto-test`；找不到匹配测试文件时会回退到仓库测试命令。
- Treat `gitPlan` as reviewable until `--execute-git-plan --confirm --apply` is present. / 没有 `--execute-git-plan --confirm --apply` 时，`gitPlan` 只是可审查计划。
- Execute remote `--push --create-pr` only after local branch, commit, tests, and PR body are reviewed. / 只有本地 branch、commit、测试和 PR body 都审查后才执行远端 `--push --create-pr`。
- Use `run --command` for commands that should go through policy. / 需要经过 policy 的命令用 `run --command`。
- Keep `ROADMAP.md` local and uncommitted. / `ROADMAP.md` 保持本地且不提交。

## Deferred Integrations / 暂缓集成

Cursor, Claude Code, and Cline are deferred until the Codex flow is stable.

Cursor、Claude Code、Cline 暂缓，等 Codex 流程稳定后再做。
