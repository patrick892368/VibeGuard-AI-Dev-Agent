# Integrations / 集成

VibeGuard uses a CLI-first core so every integration shares the same policy checks.

VibeGuard 采用 CLI-first 内核，因此所有集成都复用同一套 policy 检查。

## CLI / CLI

```bash
vibeguard debug --log error.log
vibeguard debug --log django-error.log
vibeguard debug --log spring-error.log
vibeguard test --write
vibeguard test --write --run --limit 1
vibeguard test --coverage coverage.json
vibeguard test --coverage coverage/lcov.info
vibeguard test --coverage coverage-before.json --coverage-after coverage-after.json
vibeguard review
vibeguard onboard --write
vibeguard policy check --path src/index.js
vibeguard run --command "npm test" --audit-log reports/audit.jsonl
```

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
- `github_checks`
- `github_comment`
- `eval_fixtures`
- `eval_history`
- `doctor`

`eval_fixtures` supports policy-checked `output` reports and compact JSONL `history` appends for Codex/Grok quality tracking.

`eval_fixtures` 支持经过 policy 检查的 `output` 报告，也支持 JSONL `history` 追加，用于 Codex/Grok 质量跟踪。

`eval_history` summarizes those JSONL records for trend review.

`eval_history` 会汇总 JSONL 历史记录，方便看趋势。

`write_tests` can analyze coverage, compare before/after coverage, write generated tests, and optionally run them through command policy when called with `write: true` and `run: true`.

`write_tests` 可以分析 coverage、比较 before/after coverage、写入生成测试，并在传入 `write: true` 和 `run: true` 时通过 command policy 执行这些测试。

`doctor` checks local policy, provider, proxy, Git, GitHub remote, and `gh` readiness without exposing secrets.

`doctor` 检查本地 policy、provider、proxy、Git、GitHub remote 和 `gh` 是否就绪，且不会暴露密钥。

`--audit-log reports/audit.jsonl` can be used from CLI or MCP-style workflows to append policy-gated JSONL audit events.

CLI 或 MCP-style 工作流可以使用 `--audit-log reports/audit.jsonl` 追加经过 policy 检查的 JSONL 审计事件。

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

The current Codex flow supports patch artifact output, Git/PR dry-run planning, confirmed branch/commit/push/PR execution, fixture evaluation history, and environment diagnosis.

当前 Codex 流程支持 patch artifact 输出、Git/PR dry-run 计划、确认后执行 branch/commit/push/PR、fixture 评测历史和环境诊断。

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

Create a draft PR through the GitHub CLI. The command is dry-run by default:

通过 GitHub CLI 创建 draft PR。默认 dry-run：

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft
```

Execute PR creation only when ready:

确认就绪后才执行 PR 创建：

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft --execute --confirm
```

Post a PR comment through the GitHub CLI. The command is dry-run by default:

通过 GitHub CLI 发布 PR comment。默认 dry-run：

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

`gh pr create` and `gh pr comment` require policy confirmation and authenticated `gh`.

`gh pr create` 和 `gh pr comment` 需要 policy 确认，并且本机要有已认证的 `gh`。
