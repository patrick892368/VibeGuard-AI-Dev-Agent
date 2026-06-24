# Integrations / 集成

VibeGuard uses a CLI-first core so every integration shares the same policy checks.

VibeGuard 采用 CLI-first 内核，因此所有集成都复用同一套 policy 检查。

Generated onboarding and architecture documents are bilingual Chinese/English by default.

生成的 onboarding 和 architecture 文档默认使用中英双语。

## CLI / CLI

```bash
vibeguard debug --log error.log
vibeguard debug --log django-error.log
vibeguard debug --log spring-error.log
vibeguard test --write
vibeguard test --write --run --limit 1
vibeguard test --write --create-branch --commit --pr-dry-run --json
vibeguard test --write --run --create-branch --commit --execute-git-plan --confirm --json
vibeguard test --coverage coverage.json
vibeguard test --coverage coverage/lcov.info
vibeguard test --coverage coverage-before.json --coverage-after coverage-after.json
vibeguard review
vibeguard review --diff reports/change.diff --write-comment reports/review.md
vibeguard onboard --write
vibeguard policy check --path src/index.js
vibeguard run --command "npm test" --audit-log reports/audit.jsonl
vibeguard audit summary --file reports/audit.jsonl
```

`debug` returns a structured `explanation` with a user-facing message, likely cause, and evidence such as error type, stack location, and framework. Source snippets are included only when path policy allows reading that file.

`debug` 会返回结构化 `explanation`，包含面向用户的说明、可能原因，以及错误类型、栈位置、框架等 evidence。源码片段只有在 path policy 允许读取该文件时才会返回。

`review` returns line-level findings, recommendations, severity summaries, actionItems, and PR-comment Markdown when the diff hunk contains line metadata. `--diff` input files are read through path policy, and `--write-comment` writes Markdown through Policy-as-Code so it can be passed to `github comment --body-file`.

`review` 会在 diff hunk 提供行号时返回行号级 findings、recommendations、严重度汇总、actionItems 和 PR 评论 Markdown。`--diff` 输入文件会经过路径 policy 读取，`--write-comment` 会经过 Policy-as-Code 写出这段 Markdown，方便继续传给 `github comment --body-file`。

`summarize_pr` builds a GitHub-ready PR body that includes changed files, review findings, severity counts, actionItems, and validation checkboxes.

`summarize_pr` 会生成 GitHub-ready PR body，包含变更文件、review findings、严重度统计、actionItems 和验证 checklist。

## Git Hooks / Git Hooks

Print a hook without writing to `.git`:

打印 hook，不写入 `.git`：

```bash
vibeguard hooks print pre-commit
```

Install a hook with explicit confirmation:

显式确认后安装 hook：

```bash
vibeguard hooks install pre-commit --allow-git-dir
```

## MCP-Style Server / MCP-Style Server

```bash
vibeguard mcp
```

The MCP-style server supports `initialize`, `tools/list` with `inputSchema`, `tools/call`, text content, and `structuredContent`.

MCP-style server 支持 `initialize`、带 `inputSchema` 的 `tools/list`、`tools/call`、text content 和 `structuredContent`。

Available tools:

可用 tools：

- `check_policy`
- `debug_error`
- `fix_error`
- `onboard_repo`
- `write_tests`
- `review_pr`
- `summarize_pr`
- `detect_github`
- `github_pr`
- `github_checks`
- `github_comment`
- `eval_fixtures`
- `eval_history`
- `doctor`
- `audit_summary`

`eval_fixtures` supports policy-checked `output` reports, compact JSONL `history` appends, and `repeat` runs for Codex/Grok quality tracking.

`eval_fixtures` 支持经过 policy 检查的 `output` 报告、JSONL `history` 追加和 `repeat` 多轮运行，用于 Codex/Grok 质量跟踪。

`eval_history` summarizes those JSONL records for trend review.

`eval_history` 会汇总 JSONL 历史记录，方便看趋势。

`onboard_repo` returns bilingual onboarding Markdown, architecture Markdown, and structured `firstTasks` with low-risk commands and files for newcomers.

`onboard_repo` 会返回中英双语 onboarding Markdown、architecture Markdown，以及包含低风险命令和文件的新手任务 `firstTasks`。

`review_pr` can return structured findings and, when `writeComment` is provided, write the PR comment body through policy.

`review_pr` 可以返回结构化 findings；传入 `writeComment` 时，会经过 policy 写出 PR 评论正文文件。

`github_pr` returns a dry-run `gh pr create` command by default and requires policy confirmation for execution.

`github_pr` 默认返回 dry-run 的 `gh pr create` 命令；执行真实创建时需要经过 policy 确认。

`write_tests` can analyze coverage, compare before/after coverage, write generated ESM/CommonJS-aware JavaScript tests and stdlib `unittest` Python tests with simple behavior, object-property/dictionary-field fallback, and exception assertions, optionally run them through command policy, return `failureAnalysis.repairPlan` for failed runs, prepare a Git/PR dry-run plan, and execute a confirmed local branch/commit plan only after generated tests pass.

`write_tests` 可以分析 coverage、比较 before/after coverage、写入识别 ESM/CommonJS 的 JavaScript 生成测试和 stdlib `unittest` Python 测试，并包含简单行为、对象属性/字典字段 fallback 和异常断言；也可以通过 command policy 执行这些测试、为失败运行返回 `failureAnalysis.repairPlan`、准备 Git/PR dry-run plan，并且只会在生成测试通过后执行已确认的本地 branch/commit plan。

`doctor` checks local policy, provider, proxy, Git, GitHub remote, and `gh` readiness without exposing secrets.

`doctor` 检查本地 policy、provider、proxy、Git、GitHub remote 和 `gh` 是否就绪，且不会暴露密钥。

`--audit-log reports/audit.jsonl` can be used from CLI or MCP-style workflows to append policy-gated JSONL audit events.

CLI 或 MCP-style 工作流可以使用 `--audit-log reports/audit.jsonl` 追加经过 policy 检查的 JSONL 审计事件。

`audit_summary` summarizes JSONL audit logs for operation counts, policy statuses, blocked events, recent entries, and parse errors.

`audit_summary` 会汇总 JSONL 审计日志，展示操作次数、policy 状态、blocked 事件、最近记录和解析错误。

## Codex / Codex

Codex is the current priority integration target.

Codex 是当前优先集成目标。

Use the CLI directly from Codex, or connect through the MCP-style stdio server. Codex must not bypass `.vibeguard.yaml`.

Codex 可以直接调用 CLI，也可以通过 MCP-style stdio server 连接。Codex 不能绕过 `.vibeguard.yaml`。

See `docs/CODEX.md` for the focused Codex workflow.

Codex 专用流程见 `docs/CODEX.md`。

Grok is the current priority model provider. Other agent/provider integrations are deferred until Codex + Grok is stable.

Grok 是当前优先模型 provider。其他 agent/provider 集成等 Codex + Grok 稳定后再做。

Django support is exposed through the same CLI and MCP-style paths; integrations should inspect `frameworkContext` and must still honor `.vibeguard.yaml`.

Django 支持通过同一套 CLI 和 MCP-style 路径暴露；集成侧应检查 `frameworkContext`，并且仍必须遵守 `.vibeguard.yaml`。

Spring Boot support uses the same flow and returns Spring-specific `frameworkContext` / `frameworkContexts` for dependency injection, configuration, web, and data-layer failures.

Spring Boot 支持也使用同一流程，并针对依赖注入、配置、Web 和数据层失败返回 Spring 专用的 `frameworkContext` / `frameworkContexts`。

The current Codex flow supports patch artifact output, stack-trace based minimal test selection, Git/PR dry-run planning, confirmed branch/commit/push/PR execution, fixture evaluation history, and environment diagnosis.

当前 Codex 流程支持 patch artifact 输出、基于 stack trace 的最小测试选择、Git/PR dry-run 计划、确认后执行 branch/commit/push/PR、fixture 评测历史和环境诊断。

## Deferred Agent Integrations / 暂缓 Agent 集成

These integrations are deferred until Codex is stable:

以下集成在 Codex 稳定前暂缓：

- Cursor
- Claude Code
- Cline

## VS Code / VS Code

The repository includes a minimal extension scaffold in `integrations/vscode`.

仓库包含一个最小 VS Code extension scaffold，位于 `integrations/vscode`。

The extension calls the local CLI and renders JSON results in a VS Code output channel. It is not the current priority; Codex remains the source of truth.

该 extension 调用本地 CLI 并在 VS Code output channel 展示 JSON。它不是当前重点；Codex 和 CLI 仍是 policy 决策来源。

## GitHub / GitHub

Detect the repository:

检测仓库：

```bash
vibeguard github detect
```

Create a draft PR through the GitHub CLI or the REST API fallback when `GITHUB_TOKEN` / `GH_TOKEN` is present. The command is dry-run by default:

通过 GitHub CLI 创建 draft PR；如果存在 `GITHUB_TOKEN` / `GH_TOKEN`，执行时也可使用 REST API fallback。默认 dry-run：

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft
```

Execute PR creation only when ready:

确认就绪后才执行 PR 创建：

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft --execute --confirm
```

Post a PR comment through the GitHub CLI or REST API fallback. The command is dry-run by default:

通过 GitHub CLI 或 REST API fallback 发布 PR comment。默认 dry-run：

```bash
vibeguard github comment --pr 12 --body-file review.md
vibeguard github comment --pr 12 --body-file review.md --execute --confirm
```

Read recent workflow run status:

读取最近的 workflow run 状态：

```bash
vibeguard github checks --branch codex/fix-bug --limit 5
vibeguard github checks --branch codex/fix-bug --limit 5 --execute
```

`gh pr create` and `gh pr comment` require policy confirmation. Execution uses authenticated `gh` when available, or `GITHUB_TOKEN` / `GH_TOKEN` through the REST API fallback when `gh` is missing.

`gh pr create` 和 `gh pr comment` 需要 policy 确认。执行时优先使用已认证的 `gh`；如果本机缺少 `gh`，可使用 `GITHUB_TOKEN` / `GH_TOKEN` 通过 REST API fallback 执行。
