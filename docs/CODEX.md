# Codex Integration / Codex 集成

Codex is the current priority integration target for VibeGuard.

Codex 是 VibeGuard 当前优先支持的 agent 集成目标。

## Model / 集成模型

The integration is CLI-first:

集成方式以 CLI 为主：

1. Codex works inside the repository workspace. / Codex 在仓库工作区内运行。
2. Codex calls `node ./bin/vibeguard.js ...`. / Codex 调用 `node ./bin/vibeguard.js ...`。
3. VibeGuard checks `.vibeguard.yaml` before writes, patches, and risky commands. / VibeGuard 在写文件、patch 和风险命令前检查 `.vibeguard.yaml`。
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

Analyze an error log:

分析报错日志：

```bash
node ./bin/vibeguard.js debug --log error.log --json
```

For Django tracebacks, Codex should inspect `frameworkContext`, `likelyFiles`, `hints`, and `suggestedTestCommands`. Django projects can include `python manage.py check` and `python manage.py test` when policy allows those commands.

Django traceback 场景下，Codex 应检查 `frameworkContext`、`likelyFiles`、`hints` 和 `suggestedTestCommands`。Django 项目会在 policy 允许时给出 `python manage.py check` 和 `python manage.py test`。

For Spring Boot stack traces, Codex should inspect `frameworkContext`, `frameworkContexts`, controller/service/repository/config likely files, and Maven/Gradle test commands before asking for a patch.

Spring Boot stack trace 场景下，Codex 应检查 `frameworkContext`、`frameworkContexts`、controller/service/repository/config 相关文件，以及 Maven/Gradle 测试命令，再决定是否要求生成 patch。

Run the safe fix workflow:

运行安全修复工作流：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --apply --json
node ./bin/vibeguard.js fix --log error.log --auto-test --apply --json
```

`fix` normalizes fenced diffs, plain unified diffs, and incorrect hunk counts before policy and `git apply --check`.

`fix` 会在 policy 和 `git apply --check` 前规范化 fenced diff、plain unified diff 和错误的 hunk count。

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
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

The baseline fixture set covers Python, Node, Django-style, and Spring Boot-style repair flows.

baseline fixture 集合覆盖 Python、Node、Django-style 和 Spring Boot-style 修复流程。

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

Codex should inspect `summary.successRate`, fixture `outcome`, `policyStatus`, `stage`, and `patchSourceReason` before applying generated patches.

Codex 应该先检查 `summary.successRate`、fixture `outcome`、`policyStatus`、`stage` 和 `patchSourceReason`，再决定是否应用生成的 patch。

For trend checks, inspect `summary.fixtureOutcomeCounts` from `eval history` to identify which fixture is regressing.

查看趋势时，应检查 `eval history` 的 `summary.fixtureOutcomeCounts`，定位具体哪个 fixture 在退化。

Run tests through command policy:

通过 command policy 运行测试：

```bash
node ./bin/vibeguard.js run --command "npm test" --json
node ./bin/vibeguard.js run --command "npm test" --audit-log reports/audit.jsonl --json
node ./bin/vibeguard.js audit summary --file reports/audit.jsonl --json
```

Codex should use `--audit-log reports/audit.jsonl` for reviewed write/patch/command workflows when a persistent local audit trail is useful. The audit log path is checked by policy before any JSONL event is appended.

需要保留本地审计轨迹时，Codex 应在已审查的写文件、patch、命令流程中使用 `--audit-log reports/audit.jsonl`。追加 JSONL 事件前，审计日志路径本身也会经过 policy 检查。

Codex can use `audit summary` to inspect operation counts, policy statuses, blocked events, recent entries, and parse errors.

Codex 可以使用 `audit summary` 查看操作次数、policy 状态、blocked 事件、最近记录和解析错误。

Find test targets with coverage reports:

结合 coverage report 查找测试候选：

```bash
node ./bin/vibeguard.js test --coverage coverage.json --json
node ./bin/vibeguard.js test --coverage coverage/lcov.info --json
node ./bin/vibeguard.js test --coverage coverage-before.json --coverage-after coverage-after.json --json
node ./bin/vibeguard.js test --write --coverage coverage.json --run --limit 1 --json
```

Codex should inspect `coverage`, `coverageTargets`, `coverage.missingLines`, `uncoveredFunctions`, and JavaScript `metadata.moduleSystem` before asking VibeGuard to write new tests. If before/after reports are available, inspect `coverageDelta.summary.averagePercentDelta`, `coverageDelta.summary.missingLinesReduced`, and file-level `status`. When using `--run`, inspect `testRuns.status`, `testRuns.command`, `stdout`, `stderr`, `failureAnalysis`, and `failureAnalysis.repairPlan` before proposing a commit.

Codex 在要求 VibeGuard 写测试前，应先检查 `coverage`、`coverageTargets`、`coverage.missingLines`、`uncoveredFunctions` 和 JavaScript `metadata.moduleSystem`。如果有 before/after 报告，还要检查 `coverageDelta.summary.averagePercentDelta`、`coverageDelta.summary.missingLinesReduced` 和文件级 `status`。使用 `--run` 时，提交前还要检查 `testRuns.status`、`testRuns.command`、`stdout`、`stderr`、`failureAnalysis` 和 `failureAnalysis.repairPlan`。

When generated tests fail, `failureAnalysis.repairPlan` tells Codex whether a test-only retry is safe, which actions to take next, and which guardrails must not be violated.

生成测试失败时，`failureAnalysis.repairPlan` 会告诉 Codex 是否适合只重试测试文件、下一步动作是什么，以及哪些 guardrail 不能违反。

Generated tests may include behavior assertions for simple pure functions, clear branches such as null/None checks, numeric lower-bound branches including `<= 0`, empty collection checks, and clear exception branches such as `throw new RangeError(...)` or `raise ValueError(...)`. More complex IO, database, dependency injection, and mock-heavy cases still require review.

生成的测试可能包含简单纯函数、明确分支、常见边界值和明确异常分支的行为断言，例如 null/None 检查、包含 `<= 0` 的数值下界分支、空集合检查、`throw new RangeError(...)` 或 `raise ValueError(...)`。更复杂的 IO、数据库、依赖注入和重 mock 场景仍需要人工 review。

Generate bilingual onboarding and architecture docs:

生成中英双语 onboarding 和 architecture 文档：

```bash
node ./bin/vibeguard.js onboard --write --json
```

Review changes:

审查变更：

```bash
node ./bin/vibeguard.js review --json
node ./bin/vibeguard.js pr summary --diff change.diff --json
```

Review findings include `file`, `line`, `severity`, `category`, and `message` when line information is available.

Review findings 在有行号信息时会包含 `file`、`line`、`severity`、`category` 和 `message`。

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
