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
```

Analyze an error log:

分析报错日志：

```bash
node ./bin/vibeguard.js debug --log error.log --json
```

Run the safe fix workflow:

运行安全修复工作流：

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --apply --json
node ./bin/vibeguard.js fix --log error.log --auto-test --apply --json
```

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
```

Evaluate the configured LLM provider:

评测当前 LLM provider：

```bash
node ./bin/vibeguard.js eval fixtures --json
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

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

Run tests through command policy:

通过 command policy 运行测试：

```bash
node ./bin/vibeguard.js run --command "npm test" --json
```

Find test targets with coverage reports:

结合 coverage report 查找测试候选：

```bash
node ./bin/vibeguard.js test --coverage coverage.json --json
node ./bin/vibeguard.js test --coverage coverage/lcov.info --json
node ./bin/vibeguard.js test --coverage coverage-before.json --coverage-after coverage-after.json --json
node ./bin/vibeguard.js test --write --coverage coverage.json --run --limit 1 --json
```

Codex should inspect `coverage`, `coverageTargets`, `coverage.missingLines`, and `uncoveredFunctions` before asking VibeGuard to write new tests. If before/after reports are available, inspect `coverageDelta.summary.averagePercentDelta`, `coverageDelta.summary.missingLinesReduced`, and file-level `status`. When using `--run`, inspect `testRuns.status`, `testRuns.command`, `stdout`, and `stderr` before proposing a commit.

Codex 在要求 VibeGuard 写测试前，应先检查 `coverage`、`coverageTargets`、`coverage.missingLines` 和 `uncoveredFunctions`。如果有 before/after 报告，还要检查 `coverageDelta.summary.averagePercentDelta`、`coverageDelta.summary.missingLinesReduced` 和文件级 `status`。使用 `--run` 时，提交前还要检查 `testRuns.status`、`testRuns.command`、`stdout` 和 `stderr`。

Review changes:

审查变更：

```bash
node ./bin/vibeguard.js review --json
node ./bin/vibeguard.js pr summary --diff change.diff --json
```

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

## Operating Rules / 操作规则

- Do not bypass `.vibeguard.yaml`. / 不要绕过 `.vibeguard.yaml`。
- Do not modify denied paths. / 不要修改 denied 路径。
- Use `--check-only` before applying patches. / 应用 patch 前先用 `--check-only`。
- Prefer `fix --dry-run` before `fix --apply`. / 优先先跑 `fix --dry-run`，再跑 `fix --apply`。
- Use `--auto-test` only when the suggested repository test command is acceptable. / 只有在建议测试命令可接受时才用 `--auto-test`。
- Treat `gitPlan` as reviewable until `--execute-git-plan --confirm --apply` is present. / 没有 `--execute-git-plan --confirm --apply` 时，`gitPlan` 只是可审查计划。
- Execute remote `--push --create-pr` only after local branch, commit, tests, and PR body are reviewed. / 只有本地 branch、commit、测试和 PR body 都审查后才执行远端 `--push --create-pr`。
- Use `run --command` for commands that should go through policy. / 需要经过 policy 的命令用 `run --command`。
- Keep `ROADMAP.md` local and uncommitted. / `ROADMAP.md` 保持本地且不提交。

## Deferred Integrations / 暂缓集成

Cursor, Claude Code, and Cline are deferred until the Codex flow is stable.

Cursor、Claude Code、Cline 暂缓，等 Codex 流程稳定后再做。
