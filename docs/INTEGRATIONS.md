# Integrations / 集成

VibeGuard uses a CLI-first core so every integration shares the same policy checks.

VibeGuard 采用 CLI-first 内核，因此所有集成都复用同一套 policy 检查。

Generated onboarding and architecture documents are bilingual Chinese/English by default.

生成的 onboarding 和 architecture 文档默认使用中英双语。

## CLI / CLI

```bash
vibeguard debug --log error.log
vibeguard debug --log error.log --ai-patch --output-patch reports/generated.patch
vibeguard debug --log django-error.log
vibeguard debug --log spring-error.log
vibeguard test --write
vibeguard test --write --run --limit 1
vibeguard test --write --run --repair --limit 1
vibeguard test --write --create-branch --commit --pr-dry-run --json
vibeguard test --write --run --create-branch --commit --execute-git-plan --confirm --json
vibeguard test --coverage coverage.json
vibeguard test --coverage coverage/lcov.info
vibeguard test --coverage coverage-before.json --coverage-after coverage-after.json
vibeguard review
vibeguard review --diff reports/change.diff --write-comment reports/review.md
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff
vibeguard onboard --write
vibeguard policy check --path src/index.js
vibeguard run --command "npm test" --audit-log reports/audit.jsonl
vibeguard audit summary --file reports/audit.jsonl
vibeguard audit report --file reports/audit.jsonl --output reports/audit.md
```

`debug` returns a structured `explanation` with a user-facing message, likely cause, and evidence such as error type, stack location, and framework. Source snippets are included only when path policy allows reading that file.

`debug` 会返回结构化 `explanation`，包含面向用户的说明、可能原因，以及错误类型、栈位置、框架等 evidence。源码片段只有在 path policy 允许读取该文件时才会返回。

`debug --log <file>` and `fix --log <file>` read log input files through path policy before parsing.

`debug --log <file>` 和 `fix --log <file>` 会先经过路径 policy 读取日志输入文件，然后才解析。

`test` reads coverage.py JSON or LCOV input files through path policy, then reports uncovered functions, classes, and interfaces. `test --write` can generate runtime tests for functions and classes, while TypeScript interface-only files stay as prioritization candidates instead of producing empty runtime tests.

`test` 会先通过 path policy 读取 coverage.py JSON 或 LCOV 输入文件，然后输出未覆盖函数、类和接口。`test --write` 可以为函数和类生成运行时测试；TypeScript interface-only 文件会保留为排序候选，而不会生成空的运行时测试。

`review` returns line-level findings, recommendations, severity summaries, actionItems, publishable `reviewComments`, and PR-comment Markdown when the diff hunk contains line metadata. `--diff` input files are read through path policy, `--write-comment` writes Markdown through Policy-as-Code so it can be passed to `github comment --body-file`, and `github review-comments` can publish the generated file-line comments in a policy-gated batch.

`review` 会在 diff hunk 提供行号时返回行号级 findings、recommendations、严重度汇总、actionItems、可发布的 `reviewComments` 和 PR 评论 Markdown。`--diff` 输入文件会经过路径 policy 读取，`--write-comment` 会经过 Policy-as-Code 写出这段 Markdown，方便继续传给 `github comment --body-file`，`github review-comments` 可以把生成的文件行级评论批量、受 policy 保护地发布。

`summarize_pr` builds a GitHub-ready PR body that includes changed files, review findings, severity counts, actionItems, and validation checkboxes. `writeBody` writes that body through policy for GitHub PR creation.

`summarize_pr` 会生成 GitHub-ready PR body，包含变更文件、review findings、严重度统计、actionItems 和验证 checklist。`writeBody` 会经过 policy 写出正文文件，供 GitHub PR 创建使用。

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

The MCP-style server supports `initialize`, `tools/list` with `inputSchema`, schema-validated `tools/call`, text content, `structuredContent`, and tool-level `isError` responses.

MCP-style server 支持 `initialize`、带 `inputSchema` 的 `tools/list`、经过 schema 校验的 `tools/call`、text content、`structuredContent` 和工具级 `isError` 响应。

Available tools:

可用 tools：

- `check_policy`
- `debug_error`
- `fix_error`
- `onboard_repo`
- `write_tests`
- `review_pr`
- `apply_patch_safely`
- `summarize_pr`
- `detect_github`
- `github_pr`
- `github_checks`
- `github_comment`
- `github_review_comment`
- `github_review_comments`
- `eval_fixtures`
- `eval_history`
- `doctor`
- `audit_summary`
- `audit_report`

`eval_fixtures` supports policy-checked `output` reports, compact JSONL `history` appends, and `repeat` runs for Codex/Grok quality tracking.

`eval_fixtures` 支持经过 policy 检查的 `output` 报告、JSONL `history` 追加和 `repeat` 多轮运行，用于 Codex/Grok 质量跟踪。

`eval_history` summarizes those JSONL records for trend review.

`eval_history` 会汇总 JSONL 历史记录，方便看趋势。

`debug_error` can parse pasted logs or read `logFile` through path policy. When `aiPatch` is true it calls the configured provider, normalizes and validates the generated diff, checks patch policy, and can write a patch artifact through `outputPatch`.

`debug_error` 可以解析粘贴的日志，也可以通过 path policy 读取 `logFile`；当 `aiPatch` 为 true 时，会调用配置的 provider，规范化并校验生成的 diff，执行 patch policy 检查，并可通过 `outputPatch` 写出 patch artifact。

`fix_error` accepts pasted `log` / `patch` text or `logFile` / `patchFile` inputs; file inputs are read through path policy before debug analysis or patch parsing.

`fix_error` 支持粘贴的 `log` / `patch` 文本，也支持 `logFile` / `patchFile` 输入；文件输入会先经过 path policy 读取，然后才进入 debug 分析或 patch 解析。

`onboard_repo` returns bilingual onboarding Markdown, architecture Markdown, structured dependency lists, structured `coreModules`, repository-specific Mermaid diagrams, structured `firstTasks` with low-risk commands and files for newcomers, and `commandChecks` for suggested command readiness.

`onboard_repo` 会返回中英双语 onboarding Markdown、architecture Markdown、结构化依赖清单、结构化 `coreModules`、仓库相关 Mermaid 图、包含低风险命令和文件的新手任务 `firstTasks`，以及建议命令可用性说明 `commandChecks`。

`review_pr` can accept pasted `diff` or a `diffFile` read through path policy, return structured findings, and, when `writeComment` is provided, write the PR comment body through policy.

`review_pr` 可以接收粘贴的 `diff`，也可以通过 path policy 读取 `diffFile`，返回结构化 findings；传入 `writeComment` 时，会经过 policy 写出 PR 评论正文文件。

`apply_patch_safely` validates a unified diff through patch validation, path policy, and `git apply --check` by default; it only applies when `apply` is true.

`apply_patch_safely` 默认通过 patch validation、路径 policy 和 `git apply --check` 校验 unified diff；只有 `apply` 为 true 时才会真正应用。

CLI patch input files, including `policy check --patch`, `patch check/apply --file`, and `fix --patch <file>`, are read through path policy before their contents are parsed.

CLI patch 输入文件，包括 `policy check --patch`、`patch check/apply --file` 和 `fix --patch <file>`，都会先经过路径 policy 读取，然后才解析内容。

`summarize_pr` can accept pasted `diff` or a `diffFile` read through path policy, return a GitHub-ready PR body, and, when `writeBody` is provided, write that body through policy.

`summarize_pr` 可以接收粘贴的 `diff`，也可以通过 path policy 读取 `diffFile`，返回 GitHub-ready PR body；传入 `writeBody` 时，会经过 policy 写出 PR body 文件。

`github_pr` returns a dry-run `gh pr create` command by default and requires policy confirmation for execution. `bodyFile` / `--body-file` inputs are checked through path policy before dry-run or execution.

`github_pr` 默认返回 dry-run 的 `gh pr create` 命令；执行真实创建时需要经过 policy 确认。`bodyFile` / `--body-file` 输入会先经过 path policy 检查，然后才进入 dry-run 或执行。

`github_review_comments` accepts pasted `diff` or a `diffFile` read through path policy, analyzes review findings, and builds a batch of file-line review comment commands. Dry-run is the default; execute mode requires command policy confirmation for every generated `gh api` command.

`github_review_comments` 支持粘贴 `diff` 或通过 path policy 读取 `diffFile`，先分析 review findings，再生成一批文件行级 review comment 命令。默认 dry-run；execute 模式会要求每条生成的 `gh api` 命令都通过 command policy 确认。

`write_tests` can read coverage files through path policy, analyze coverage, compare before/after coverage, write generated ESM/CommonJS-aware JavaScript tests including CommonJS bracket exports, write stdlib `unittest` Python tests with simple behavior, object-property/dictionary-field fallback, and exception assertions, optionally run them through command policy, return `failureAnalysis.repairPlan` for failed runs, run one safe test-only repair retry with `repair`, prepare a Git/PR dry-run plan, and execute a confirmed local branch/commit plan only after final generated tests pass.

`write_tests` 可以先通过 path policy 读取 coverage 文件，再分析 coverage、比较 before/after coverage、写入识别 ESM/CommonJS 的 JavaScript 生成测试（包含 CommonJS bracket export）和 stdlib `unittest` Python 测试，并包含简单行为、对象属性/字典字段 fallback 和异常断言；也可以通过 command policy 执行这些测试、为失败运行返回 `failureAnalysis.repairPlan`、通过 `repair` 做一轮安全的 test-only 修复重试、准备 Git/PR dry-run plan，并且只会在最终生成测试通过后执行已确认的本地 branch/commit plan。

The MCP `write_tests` tool exposes the same `repair` boolean as the CLI.

MCP `write_tests` tool 暴露与 CLI 相同的 `repair` 布尔参数。

`doctor` checks local policy, provider, proxy, Git, GitHub remote, and `gh` readiness without exposing secrets, and returns `nextActions` for missing provider or GitHub execution prerequisites.

`doctor` 检查本地 policy、provider、proxy、Git、GitHub remote 和 `gh` 是否就绪，且不会暴露密钥；如果缺少 provider 或 GitHub 执行前置条件，会返回 `nextActions`。

`--audit-log reports/audit.jsonl` can be used from CLI or MCP-style workflows to append policy-gated JSONL audit events.

CLI 或 MCP-style 工作流可以使用 `--audit-log reports/audit.jsonl` 追加经过 policy 检查的 JSONL 审计事件。

`audit_summary` summarizes JSONL audit logs for operation counts, policy statuses, blocked events, recent entries, and parse errors. `audit_report` writes the same information as Markdown through policy.

`audit_summary` 会汇总 JSONL 审计日志，展示操作次数、policy 状态、blocked 事件、最近记录和解析错误。`audit_report` 会经过 policy 把同类信息写成 Markdown 报告。

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

Post a file-line PR review comment when a finding has a concrete diff line. It requires the PR head commit SHA, file path, and diff line:

当 finding 有明确 diff 行号时，可以发布文件行级 PR review comment。它需要 PR head commit SHA、文件路径和 diff line：

```bash
vibeguard github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md
vibeguard github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md --execute --confirm
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff --execute --confirm
```

PR and comment body files are checked through path policy before dry-run or execution; batch review-comment diff files are also checked before analysis. Do not pass denied files such as `.env`.

PR 和 comment 的正文文件会先经过 path policy 检查，然后才进入 dry-run 或执行；批量 review comment 的 diff 文件也会在分析前经过检查。不要传入 `.env` 等 denied 文件。

Read recent workflow run status:

读取最近的 workflow run 状态：

```bash
vibeguard github checks --branch codex/fix-bug --limit 5
vibeguard github checks --branch codex/fix-bug --limit 5 --execute
```

`gh pr create` and `gh pr comment` require policy confirmation. Execution uses authenticated `gh` when available, or `GITHUB_TOKEN` / `GH_TOKEN` through the REST API fallback when `gh` is missing.

`gh pr create` 和 `gh pr comment` 需要 policy 确认。执行时优先使用已认证的 `gh`；如果本机缺少 `gh`，可使用 `GITHUB_TOKEN` / `GH_TOKEN` 通过 REST API fallback 执行。
