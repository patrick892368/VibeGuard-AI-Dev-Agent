# VibeGuard AI Dev Agent

> 中文 / English bilingual documentation.

## 简介 / Overview

VibeGuard 是一个受 Policy-as-Code 约束的 AI 开发 Agent，用于 Debug、仓库 Onboarding、测试生成和 PR Review。

VibeGuard is a policy-bound AI developer agent for debugging, repository onboarding, test writing, and PR review.

核心规则：任何 agent 在写文件、生成或应用 patch、执行风险命令、创建远端变更前，都必须先经过 `.vibeguard.yaml` 检查。

Core rule: every agent must pass through `.vibeguard.yaml` policy checks before writing files, generating or applying patches, running risky commands, or creating remote changes.

当前优先方向是 Codex + Grok。Cursor、Claude Code、Cline 和 VS Code 深度集成暂缓。

The current priority is Codex + Grok. Cursor, Claude Code, Cline, and deeper VS Code integration are deferred.

## 当前能力 / Current Capabilities

- `vibeguard policy check`: 检查路径、命令和 unified diff patch。Checks paths, commands, and unified diff patches.
- `vibeguard debug`: 解析 Python、Django、Node.js、Java/Spring Boot 报错日志，定位可能文件并解释失败上下文。Parses Python, Django, Node.js, and Java/Spring Boot errors, finds likely files, and explains context.
- Debug snippets 会先包含 stack frame，再补充 framework 相关 likely files 的短预览，帮助 AI patch 看到真正需要修改的文件。Debug snippets include stack frames first, then short previews of framework-related likely files so AI patch generation can see the file that likely needs the change.
- `vibeguard fix`: 编排 debug、patch 校验、policy 检查、安全 apply、测试、PR summary 和 Git plan；会规范化 fenced diff、plain unified diff 和 hunk count。Orchestrates debug, patch validation, policy checks, safe apply, tests, PR summaries, and Git plans; normalizes fenced diffs, plain unified diffs, and hunk counts.
- `vibeguard test`: 扫描测试候选，并可使用 coverage.py JSON / LCOV 排序未覆盖文件和函数，也可比较 before/after coverage。Scans source files for test candidates, can use coverage.py JSON / LCOV to prioritize uncovered files and functions, and can compare before/after coverage.
- `vibeguard test --write`: 经过 policy 后写入基础测试，支持 ESM/CommonJS Node 模块，会为简单纯函数、明确分支、常见边界值和明确异常分支生成行为断言，可用 `--run` 继续通过 command policy 执行生成的测试，并输出失败分类和结构化 `repairPlan`。Writes basic tests after policy checks, supports ESM/CommonJS Node modules, generates behavior assertions for simple pure functions, clear branches, common boundary values, and clear exception branches, can use `--run` to execute generated tests through command policy, and returns failed-run categories plus a structured `repairPlan`.
- `vibeguard review`: 分析 diff 中的 bug、安全、性能、测试缺口和 policy 风险，并输出文件/行号级 findings、recommendations、actionItems 和 PR comment Markdown。Reviews diffs for bugs, security, performance, missing tests, and policy risk with file/line findings, recommendations, actionItems, and PR-comment Markdown.
- `vibeguard onboard`: 扫描仓库并生成中英双语 onboarding / architecture 文档和结构化 firstTasks 新人任务建议。Scans a repository and can generate bilingual onboarding / architecture docs plus structured firstTasks for newcomer work.
- `vibeguard patch`: 通过 policy 检查或应用 unified diff。Checks or applies unified diffs through policy.
- `vibeguard hooks`: 打印或安装 Git hook 模板。Prints or installs Git hook templates.
- `vibeguard pr summary`: 从 diff 生成 GitHub-ready PR body。Builds a GitHub-ready PR body from a diff.
- `vibeguard github`: 检测 GitHub remote、创建 PR/评论、读取 Actions 状态；执行时支持 `gh`，也支持 `GITHUB_TOKEN` / `GH_TOKEN` REST fallback。Detects GitHub remotes, creates PRs/comments, and reads Actions status; execution supports `gh` or a `GITHUB_TOKEN` / `GH_TOKEN` REST fallback.
- `vibeguard run`: 经过 command policy 后执行命令。Runs commands only after command policy checks.
- `--audit-log reports/audit.jsonl`: 为 policy 检查、写文件、patch 和命令执行追加 JSONL 审计事件。Appends JSONL audit events for policy checks, writes, patches, and command execution.
- `vibeguard audit summary`: 汇总 JSONL 审计日志。Summarizes JSONL audit logs.
- `vibeguard eval fixtures` / `eval history`: 用 Python / Node / Django-style / Spring Boot-style fixture 评测当前 LLM provider，并按 fixture 汇总历史结果。Evaluates the configured LLM provider against Python, Node, Django-style, and Spring Boot-style fixtures, with per-fixture history summaries.
- `vibeguard doctor`: 检查 policy、provider、proxy、Git、GitHub remote、`gh` 和 GitHub token 是否存在，不会打印密钥。Checks policy, provider, proxy, Git, GitHub remote, `gh`, and GitHub token presence without printing secrets.
- `vibeguard mcp`: 启动 MCP-style stdio server，支持 `initialize`、`tools/list` schema 和 structured tool output。Starts an MCP-style stdio server with `initialize`, `tools/list` schemas, and structured tool output.

项目当前保持 dependency-light，CLI 基于 Node.js built-ins，clone 后即可测试。

The project is intentionally dependency-light; the CLI uses Node.js built-ins and can be tested immediately after clone.

## 本地安装 / Local Install

```bash
npm link
```

不安装也可以直接运行：

Run without linking:

```bash
node ./bin/vibeguard.js --help
```

## 常用命令 / Commands

```bash
vibeguard policy check --path src/index.js
vibeguard policy check --command "npm test"
vibeguard policy check --patch fix.diff
vibeguard policy check --path src/index.js --audit-log reports/audit.jsonl

vibeguard debug --log error.log
vibeguard fix --log error.log --patch fix.diff --test "npm test" --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --apply --audit-log reports/audit.jsonl
vibeguard fix --log error.log --patch fix.diff --auto-test --apply
vibeguard fix --log error.log --patch fix.diff --test "npm test" --output-patch patches/fix.diff --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --create-branch --commit --pr-dry-run --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --create-branch --commit --execute-git-plan --confirm --apply
vibeguard fix --log error.log --patch fix.diff --test "npm test" --apply
vibeguard test
vibeguard test --coverage coverage.json
vibeguard test --coverage coverage/lcov.info
vibeguard test --coverage coverage-before.json --coverage-after coverage-after.json
vibeguard test --write --limit 1
vibeguard test --write --coverage coverage.json --run --limit 1
vibeguard test --write --run --test-command "node --test {testFile}"
vibeguard review
vibeguard onboard
vibeguard onboard --write
vibeguard patch check --file fix.diff
vibeguard patch apply --file fix.diff --check-only
vibeguard hooks list
vibeguard hooks print pre-commit
vibeguard pr summary --diff change.diff
vibeguard github detect
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft
vibeguard github comment --pr 12 --body-file review.md
vibeguard github checks --branch codex/fix-bug --limit 5
vibeguard run --command "npm test" --dry-run
vibeguard run --command "npm test" --audit-log reports/audit.jsonl
vibeguard audit summary --file reports/audit.jsonl
vibeguard eval fixtures --json
vibeguard eval fixtures --output reports/eval-fixtures.json --json
vibeguard eval fixtures --history reports/eval-history.jsonl --json
vibeguard eval history --file reports/eval-history.jsonl --json
vibeguard doctor
vibeguard mcp
```

## AI Patch Provider / AI Patch Provider

`vibeguard debug --ai-patch`、`vibeguard fix` 和 `vibeguard eval fixtures` 可以调用 AI provider 生成 patch。

`vibeguard debug --ai-patch`, `vibeguard fix`, and `vibeguard eval fixtures` can call an AI provider to generate patches.

Grok 通过 xAI OpenAI-compatible Responses API 支持。把本地密钥放在 `.env`：

Grok is supported through xAI's OpenAI-compatible Responses API. Put local credentials in `.env`:

```bash
XAI_API_KEY=...
VIBEGUARD_LLM_PROVIDER=grok
VIBEGUARD_MODEL=grok-4.3
```

`.env` 已被 Git ignore 且被 policy deny，不能提交。

`.env` is ignored by Git and denied by policy. Do not commit it.

也支持 OpenAI-compatible provider：

OpenAI-compatible providers are also supported:

```bash
export VIBEGUARD_LLM_PROVIDER=openai-compatible
export OPENAI_API_KEY=...
export VIBEGUARD_MODEL=...
```

AI 生成的 patch 不会自动应用，必须先通过 Policy Engine 检查。

Generated patches are not applied automatically. They must pass the Policy Engine first.

## Codex 修复工作流 / Codex Fix Workflow

当前主线是 Codex 驱动：

The current priority workflow is Codex-driven:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --apply --json
node ./bin/vibeguard.js fix --log error.log --auto-test --apply --json
```

确定性本地 demo 和测试可以传入已知 patch：

For deterministic local demos and tests, pass a known patch file:

```bash
node ./bin/vibeguard.js --root fixtures/node-bug fix --log error.log --patch fixes/reference-error.patch --test "npm test" --dry-run --json
node ./bin/vibeguard.js --root fixtures/django-bug fix --log error.log --patch fixes/template-error.patch --auto-test --dry-run --json
node ./bin/vibeguard.js --root fixtures/spring-boot-bug fix --log error.log --patch fixes/service-annotation.patch --auto-test --dry-run --json
```

`fix` 总是先校验 patch shape、检查 policy、运行 `git apply --check`，只有传入 `--apply` 才真正应用 patch。

`fix` always validates patch shape, checks policy, runs `git apply --check`, and only applies the patch when `--apply` is present.

`--auto-test` 会在 apply 后优先运行 stack trace 或源码文件对应的最小相关测试；如果找不到单文件测试，再回退到仓库分析建议的第一个测试命令。所有测试命令仍经过 command policy。

`--auto-test` first runs the smallest relevant test inferred from the stack trace or source file after apply. If no matching test file is found, it falls back to the first repository-suggested test command. Every test command still goes through command policy.

## 评测 / Evaluation

用真实 provider 评测 Python / Node / Django-style / Spring Boot-style fixtures：

Evaluate a real provider against Python, Node, Django-style, and Spring Boot-style fixtures:

```bash
export VIBEGUARD_LLM_PROVIDER=grok
export XAI_API_KEY=...
export VIBEGUARD_MODEL=...
node ./bin/vibeguard.js eval fixtures --json
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

评测会报告成功率、patch validation 失败、policy deny、patch check 失败和 provider blocked。

Evaluation reports success rate, patch validation failures, policy denials, patch check failures, and blocked provider calls.

`--output` 和 `--history` 都经过 Policy-as-Code；`.env` 等 denied 路径会被阻止。`reports/*.json` 和 `reports/*.jsonl` 是本地输出，默认不提交。

`--output` and `--history` both pass through Policy-as-Code; denied paths such as `.env` are blocked. `reports/*.json` and `reports/*.jsonl` are local outputs and ignored by default.

## Git / PR 编排 / Git and PR Orchestration

Codex 可以先请求 dry-run 计划：

Codex can first request a dry-run plan:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --output-patch patches/fix.diff --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --pr-dry-run --pr-body-file patches/pr-body.md --dry-run --json
```

确认后才能执行本地 branch / commit：

After confirmation, local branch / commit execution is available:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --execute-git-plan --confirm --apply --json
```

远端 push / PR 也在同一个显式执行门后面：

Remote push / PR actions sit behind the same explicit execution gate:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --apply --json
```

默认策略要求 `git switch -c`、`git commit`、`git push`、`gh pr create`、`gh pr comment` 人工确认。远端 PR / comment 还要求 GitHub remote 和已认证的 `gh`。

Default policy requires confirmation for `git switch -c`, `git commit`, `git push`, `gh pr create`, and `gh pr comment`. Remote PR/comment actions also require a GitHub remote and authenticated `gh`.

## Policy-as-Code / Policy-as-Code

`.vibeguard.yaml` 定义仓库安全边界：

`.vibeguard.yaml` defines the repository safety boundary:

```yaml
paths:
  allow:
    - "src/**"
    - "test/**"
  deny:
    - ".env"
    - ".git/**"
  require_confirmation:
    - ".github/workflows/**"
    - "migrations/**"

commands:
  deny:
    - "rm -rf"
    - "git reset --hard"
  require_confirmation:
    - "npm install"
    - "git switch -c"
    - "git commit"
    - "git push"
    - "gh pr create"
    - "gh pr comment"
```

策略结果：

Policy result levels:

- `allow`: 允许执行。The operation is permitted.
- `require_confirmation`: 需要人工确认。The operation needs human confirmation.
- `deny`: 阻止执行。The operation is blocked.

优先级：`deny` > `require_confirmation` > `allow`。

Priority: `deny` > `require_confirmation` > `allow`.

## 测试 / Tests

```bash
npm test
```

测试覆盖：

The test suite covers:

- YAML 配置解析。YAML config parsing.
- 路径和命令 policy。Path and command policy checks.
- Patch 安全检查。Patch file safety checks.
- Python / Node / Django-style / Spring Boot-style fixture 的 safe fix 工作流。Safe fix workflow over Python, Node, Django-style, and Spring Boot-style fixture projects.
- AI patch fixture 评测。Fixture evaluation for AI patch dry-runs.
- Python / Django / Node / Java / Spring Boot 报错解析。Python / Django / Node / Java / Spring Boot error parsing.
- Review diff 分析、严重度汇总和可执行 actionItems。Review diff analysis, severity summaries, and actionable actionItems.
- 仓库扫描。Repository scanning.
- 本地 branch / commit / push 的受保护执行。Confirmed protected local branch / commit / push flows.
- PR 创建调度和 PR comment dry-run。PR creation dispatch and PR comment dry-run.
- `--auto-test` 测试命令选择。`--auto-test` command selection.
- 评测历史 JSONL 和趋势汇总。Evaluation history JSONL and trend summary.
- fixture 级评测历史 outcome 汇总。Per-fixture evaluation history outcome summaries.
- Policy-gated JSONL 审计日志。Policy-gated JSONL audit logs.
- coverage.py JSON / LCOV 解析、未覆盖文件排序、missing line 到函数映射、before/after coverage delta，以及生成测试后的 policy-gated test run。coverage.py JSON / LCOV parsing, uncovered file prioritization, missing-line-to-function mapping, before/after coverage deltas, and policy-gated test runs after generating tests.
- 简单纯函数、明确分支、常见边界值和明确异常分支行为断言生成。Simple pure-function, clear-branch, common-boundary, and clear-exception-branch behavior assertion generation.
- 生成测试失败后的结构化修复计划。Structured repair plans after generated test failures.

## 集成目标 / Integration Targets

- CLI
- Git hooks
- Codex
- MCP-style stdio server for Codex workflows
- VS Code scaffold, deferred / VS Code scaffold，暂缓
- Cursor, deferred / Cursor 暂缓
- Claude Code, deferred / Claude Code 暂缓
- Cline, deferred / Cline 暂缓
