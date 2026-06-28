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
vibeguard review --diff reports/change.diff --comment-pr 12 --execute --confirm --github-api
vibeguard review --github-pr 12 --publish-comment --execute --confirm --github-api
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff
vibeguard onboard --write
vibeguard policy check --path src/index.js
vibeguard run --command "npm test" --audit-log reports/audit.jsonl
vibeguard audit summary --file reports/audit.jsonl
vibeguard audit report --file reports/audit.jsonl --output reports/audit.md
```

`debug` returns a structured `explanation` with a user-facing message, likely cause, and evidence such as error type, stack location, and framework. Source snippets are included only when path policy allows reading that file.

`debug` 会返回结构化 `explanation`，包含面向用户的说明、可能原因，以及错误类型、栈位置、框架等 evidence。源码片段只有在 path policy 允许读取该文件时才会返回。

When `debug --ai-patch` or `fix` calls a provider, the patch source includes `repairPlan` with the primary file, target files, strategy, policy/apply-check requirements, and suggested validation commands. This is returned even for provider unavailable/error states when debug context is available.

当 `debug --ai-patch` 或 `fix` 调用 provider 时，patch source 会包含 `repairPlan`，列出 primary file、target files、修复策略、policy/apply check 要求和建议验证命令。只要已有 debug context，即使 provider unavailable/error 也会返回这份方案。

`debug --log <file>` and `fix --log <file>` read log input files through path policy before parsing.

`debug --log <file>` 和 `fix --log <file>` 会先经过路径 policy 读取日志输入文件，然后才解析。

Repository metadata reads used by `debug`, `fix`, `test`, and `onboard` pass path policy when those agents receive a `PolicyEngine`. The result exposes `metadataReadPolicy` and `skippedMetadataFiles`, so Codex/MCP callers can see which dependency manifests or framework metadata files were not read.

当 `debug`、`fix`、`test` 和 `onboard` 收到 `PolicyEngine` 时，它们使用的仓库元数据读取会先经过 path policy。结果会暴露 `metadataReadPolicy` 和 `skippedMetadataFiles`，让 Codex/MCP 调用方知道哪些依赖 manifest 或框架元数据文件没有被读取。

`test` checks candidate source-file reads through path policy, reads coverage.py JSON or LCOV input files through path policy, then reports uncovered functions, classes, and interfaces. It returns `sourceReadPolicy`, `skippedSourceFiles`, and `coverageDeltaStatus` so callers can tell whether source reads were skipped and whether before/after coverage was compared. `test --write` can generate runtime tests for functions, async JavaScript functions, and classes, while TypeScript interface-only files stay as prioritization candidates instead of producing empty runtime tests.

`test` 会先通过 path policy 检查候选源码文件读取，也会通过 path policy 读取 coverage.py JSON 或 LCOV 输入文件，然后输出未覆盖函数、类和接口。它会返回 `sourceReadPolicy`、`skippedSourceFiles` 和 `coverageDeltaStatus`，让调用方知道是否有源码读取被跳过，以及 before/after coverage 是否已比较。`test --write` 可以为函数、async JavaScript 函数和类生成运行时测试；TypeScript interface-only 文件会保留为排序候选，而不会生成空的运行时测试。

`review` returns line-level findings, recommendations, severity summaries, actionItems, publishable `reviewComments`, and PR-comment Markdown when the diff hunk contains line metadata. It includes bug-prone addition checks such as Python mutable defaults, assignment inside JavaScript/TypeScript conditionals, and swallowed exceptions, alongside security checks for secrets, SQL/HTML/deserialization, dynamic execution, shell injection risks, general process execution, plus performance, deployment, database, maintainability, and testing rules. Without `--diff`, default `git diff` reads are command-policy gated; `--diff` input files are read through path policy; `--github-pr` reads remote PR diffs through policy-checked `gh pr diff` or token REST fallback; `--write-comment` writes Markdown through Policy-as-Code; `--comment-pr` or `--publish-comment` can directly publish that generated Markdown as a policy-gated GitHub PR comment; and `github review-comments` can publish the generated file-line comments in a policy-gated batch.

`review` 会在 diff hunk 提供行号时返回行号级 findings、recommendations、严重度汇总、actionItems、可发布的 `reviewComments` 和 PR 评论 Markdown。它会检查 Python mutable default、JavaScript/TypeScript 条件里的疑似赋值、吞掉异常等 bug-prone 新增代码，同时覆盖 secret、SQL/HTML/deserialization、动态执行、shell injection、一般进程执行、performance、deployment、database、maintainability 和 testing 规则。未传 `--diff` 时，默认 `git diff` 读取会先经过 command policy；`--diff` 输入文件会经过路径 policy 读取；`--github-pr` 会通过 policy 检查后的 `gh pr diff` 或 token REST fallback 读取远端 PR diff；`--write-comment` 会经过 Policy-as-Code 写出这段 Markdown；`--comment-pr` 或 `--publish-comment` 可以把生成的 Markdown 直接、受 policy 保护地发布为 GitHub PR comment；`github review-comments` 可以把生成的文件行级评论批量、受 policy 保护地发布。

`summarize_pr` builds a GitHub-ready PR body that includes changed files, review findings, severity counts, actionItems, and validation checkboxes. Without an explicit diff file, PR number, or stdin diff, the default `git diff` read is command-policy gated. `githubPr` / `--github-pr` can pull remote PR diffs through the same GitHub helper path. `writeBody` writes that body through policy for GitHub PR creation.

`summarize_pr` 会生成 GitHub-ready PR body，包含变更文件、review findings、严重度统计、actionItems 和验证 checklist。未传显式 diff 文件、PR 编号或 stdin diff 时，默认 `git diff` 读取会先经过 command policy。`githubPr` / `--github-pr` 可以复用同一 GitHub helper 路径拉取远端 PR diff。`writeBody` 会经过 policy 写出正文文件，供 GitHub PR 创建使用。

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

Hook installation writes to `.git/hooks/<hook>`, so `--allow-git-dir` is only the explicit operation flag. The target path must still pass `.vibeguard.yaml` path policy, and default policy denies `.git/**` unless the repository policy is changed.

Hook 安装会写入 `.git/hooks/<hook>`，所以 `--allow-git-dir` 只是显式操作开关；目标路径仍必须通过 `.vibeguard.yaml` path policy。默认策略会拒绝 `.git/**`，除非仓库策略显式调整。

## MCP-Style Server / MCP-Style Server

```bash
vibeguard mcp
```

The MCP-style server supports `initialize`, `ping`, `tools/list` with `inputSchema`, empty compatible `resources/list`, `resources/templates/list`, and `prompts/list` responses, schema-validated `tools/call`, text content, `structuredContent`, and tool-level `isError` responses.

MCP-style server 支持 `initialize`、`ping`、带 `inputSchema` 的 `tools/list`、空兼容 `resources/list`、`resources/templates/list` 和 `prompts/list` 响应、经过 schema 校验的 `tools/call`、text content、`structuredContent` 和工具级 `isError` 响应。

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

`review_pr` can accept pasted `diff`, a `diffFile` read through path policy, or `githubPr` fetched through the GitHub helper; it returns structured findings, can write the PR comment body through policy with `writeComment`, and can directly build or execute a policy-gated PR comment publish plan with `commentPr` or `publishComment`.

`review_pr` 可以接收粘贴的 `diff`、通过 path policy 读取的 `diffFile`，或通过 GitHub helper 获取的 `githubPr`；它会返回结构化 findings，传入 `writeComment` 时会经过 policy 写出 PR 评论正文文件，也可以通过 `commentPr` 或 `publishComment` 直接生成或执行受 policy 保护的 PR comment 发布计划。

`apply_patch_safely` validates a unified diff through patch validation, path policy, command policy for `git apply --check`, and then `git apply --check` by default; it only applies when `apply` is true, and `git apply` is command-policy gated too.

`apply_patch_safely` 默认通过 patch validation、路径 policy、`git apply --check` 的 command policy 和 `git apply --check` 校验 unified diff；只有 `apply` 为 true 时才会真正应用，而且 `git apply` 本身也会经过 command policy。

CLI patch input files, including `policy check --patch`, `patch check/apply --file`, and `fix --patch <file>`, are read through path policy before their contents are parsed.

CLI patch 输入文件，包括 `policy check --patch`、`patch check/apply --file` 和 `fix --patch <file>`，都会先经过路径 policy 读取，然后才解析内容。

`summarize_pr` can accept pasted `diff` or a `diffFile` read through path policy, return a GitHub-ready PR body, and, when `writeBody` is provided, write that body through policy.

`summarize_pr` 可以接收粘贴的 `diff`，也可以通过 path policy 读取 `diffFile`，返回 GitHub-ready PR body；传入 `writeBody` 时，会经过 policy 写出 PR body 文件。

`github_pr` returns a dry-run `gh pr create` command by default and requires policy confirmation for execution. `bodyFile` / `--body-file` inputs are checked through path policy before dry-run or execution.

`github_pr` 默认返回 dry-run 的 `gh pr create` 命令；执行真实创建时需要经过 policy 确认。`bodyFile` / `--body-file` 输入会先经过 path policy 检查，然后才进入 dry-run 或执行。

`github_review_comments` accepts pasted `diff` or a `diffFile` read through path policy, analyzes review findings, and builds a batch of file-line review comment commands. Dry-run is the default; execute mode requires command policy confirmation for every generated `gh api` command.

`github_review_comments` 支持粘贴 `diff` 或通过 path policy 读取 `diffFile`，先分析 review findings，再生成一批文件行级 review comment 命令。默认 dry-run；execute 模式会要求每条生成的 `gh api` 命令都通过 command policy 确认。

`write_tests` can read coverage files through path policy, analyze coverage, compare before/after coverage, write generated ESM/CommonJS-aware JavaScript tests including CommonJS bracket exports, write stdlib `unittest` Python tests with simple behavior, object-property/dictionary-field fallback, and exception assertions, optionally run them through command policy, return `failureAnalysis.repairPlan` for failed runs, run one safe test-only repair retry with `repair`, prepare a Git/PR dry-run plan, and execute a confirmed branch/commit/PR plan only after final generated tests pass. CLI `test --write` accepts `--github-api`; MCP `write_tests` accepts `githubUseApi` for token REST fallback PR creation.

`write_tests` 可以先通过 path policy 读取 coverage 文件，再分析 coverage、比较 before/after coverage、写入识别 ESM/CommonJS 的 JavaScript 生成测试（包含 CommonJS bracket export）和 stdlib `unittest` Python 测试，并包含简单行为、对象属性/字典字段 fallback 和异常断言；也可以通过 command policy 执行这些测试、为失败运行返回 `failureAnalysis.repairPlan`、通过 `repair` 做一轮安全的 test-only 修复重试、准备 Git/PR dry-run plan，并且只会在最终生成测试通过后执行已确认的 branch/commit/PR plan。CLI `test --write` 支持 `--github-api`；MCP `write_tests` 支持 `githubUseApi`，用于 token REST fallback 创建测试 PR。

The MCP `write_tests` tool exposes the same `repair` boolean as the CLI.

MCP `write_tests` tool 暴露与 CLI 相同的 `repair` 布尔参数。

`doctor` checks local policy, provider, proxy, Git, GitHub remote, and `gh` readiness without exposing secrets. Tool probes such as `git --version` and `gh --version` pass command policy first, and doctor returns `nextActions` for missing provider or GitHub execution prerequisites.

`doctor` 检查本地 policy、provider、proxy、Git、GitHub remote 和 `gh` 是否就绪，且不会暴露密钥；`git --version`、`gh --version` 等工具探测会先经过 command policy；如果缺少 provider 或 GitHub 执行前置条件，会返回 `nextActions`。

Provider proxy fallback reads Git `http.proxy` / `https.proxy` by parsing `.git/config`; it does not shell out to `git config --get`.

Provider 代理 fallback 会通过解析 `.git/config` 读取 Git `http.proxy` / `https.proxy`，不会 shell out 执行 `git config --get`。

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

Fixture evaluation copies scenarios into temporary directories without internally initializing Git repos; patch check/apply still runs through the normal policy-gated patch workflow.

Fixture 评测会把场景复制到临时目录，但不会在内部初始化 Git 仓库；patch check/apply 仍由正常的、受 policy 保护的 patch workflow 处理。

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

`github detect` checks `git remote get-url origin` through command policy before reading the remote. PR execute paths also check fallback prerequisites such as `git branch --show-current` when VibeGuard may need to build a REST API payload.

`github detect` 会先通过 command policy 检查 `git remote get-url origin`，然后才读取 remote。PR execute 路径在可能需要构造 REST API payload 时，也会检查 `git branch --show-current` 等 fallback prerequisite。

Create a draft PR through the GitHub CLI or the REST API fallback when `GITHUB_TOKEN` / `GH_TOKEN` is present. Pass `--github-api` to force the REST API path. The command is dry-run by default:

通过 GitHub CLI 创建 draft PR；如果存在 `GITHUB_TOKEN` / `GH_TOKEN`，执行时也可使用 REST API fallback。传 `--github-api` 可以强制走 REST API。默认 dry-run：

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft
```

Execute PR creation only when ready:

确认就绪后才执行 PR 创建：

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft --execute --confirm
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft --execute --confirm --github-api
```

Post a PR comment through the GitHub CLI or REST API fallback. Pass `--github-api` to force the REST API path. The command is dry-run by default:

通过 GitHub CLI 或 REST API fallback 发布 PR comment。传 `--github-api` 可以强制走 REST API。默认 dry-run：

```bash
vibeguard review --diff reports/change.diff --comment-pr 12
vibeguard review --diff reports/change.diff --comment-pr 12 --execute --confirm --github-api
vibeguard review --github-pr 12 --publish-comment --execute --confirm --github-api
vibeguard github comment --pr 12 --body-file review.md
vibeguard github comment --pr 12 --body-file review.md --execute --confirm
vibeguard github comment --pr 12 --body-file review.md --execute --confirm --github-api
```

Post a file-line PR review comment when a finding has a concrete diff line. It requires the PR head commit SHA, file path, and diff line:

当 finding 有明确 diff 行号时，可以发布文件行级 PR review comment。它需要 PR head commit SHA、文件路径和 diff line：

```bash
vibeguard github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md
vibeguard github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md --execute --confirm
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff --execute --confirm
```

PR and comment body files are checked through path policy before dry-run or execution; batch review-comment diff files are also checked before analysis. REST fallback body-file reads are contained inside the repository root. CLI and MCP paths pass a `PolicyEngine` into the GitHub helpers, and direct public helper calls must also pass a `PolicyEngine` for remote detection and `dryRun:false` execution so real GitHub operations, prerequisite commands, and body-file reads use policy gates. Do not pass denied files such as `.env`.

PR 和 comment 的正文文件会先经过 path policy 检查，然后才进入 dry-run 或执行；批量 review comment 的 diff 文件也会在分析前经过检查。REST fallback 读取 bodyFile 时会限制在仓库 root 内。CLI 和 MCP 路径会把 `PolicyEngine` 传给 GitHub helper；直接调用公开 helper 时，remote 检测和 `dryRun:false` 真实执行都必须传入 `PolicyEngine`，让真实 GitHub 操作、prerequisite 命令和正文文件读取使用 policy gate。不要传入 `.env` 等 denied 文件。

Underlying GitHub helper subprocesses for `git` and `gh` use the shared policy runner instead of direct process execution.

GitHub helper 底层的 `git` / `gh` 子进程会通过共享 policy runner 执行，不再直接执行进程。

Read recent workflow run status:

读取最近的 workflow run 状态：

```bash
vibeguard github checks --branch codex/fix-bug --limit 5
vibeguard github checks --branch codex/fix-bug --limit 5 --execute
```

`checks --execute` checks the generated `gh run list` command against command policy before it calls GitHub or the REST fallback.

`checks --execute` 会先把生成的 `gh run list` 命令交给 command policy 检查，然后才调用 GitHub 或 REST fallback。

`gh pr create` and `gh pr comment` require policy confirmation. Execution uses authenticated `gh` when available, or `GITHUB_TOKEN` / `GH_TOKEN` through the REST API fallback when `gh` is missing.

`gh pr create` 和 `gh pr comment` 需要 policy 确认。执行时优先使用已认证的 `gh`；如果本机缺少 `gh`，可使用 `GITHUB_TOKEN` / `GH_TOKEN` 通过 REST API fallback 执行。

Git plans generated by Debug/Fix or Test Writer also check PR body files through `read_pr_body` path policy before protected Git/PR execution.

Debug/Fix 或 Test Writer 生成的 Git plan，也会在受保护的 Git/PR 执行前用 `read_pr_body` path policy 检查 PR body 文件。

Executed Debug/Fix Git plans route `create_pr` through the GitHub helper, so the same policy gates, `gh` execution, and token-based REST fallback are used by `fix --execute-git-plan --create-pr`. CLI `fix` accepts `--github-api`; MCP `fix_error` accepts `githubUseApi`; GitHub MCP tools accept `useApi`.

执行 Debug/Fix Git plan 时，`create_pr` 会走 GitHub helper，因此 `fix --execute-git-plan --create-pr` 会复用同一套 policy gate、`gh` 执行和 token REST fallback。CLI `fix` 支持 `--github-api`；MCP `fix_error` 支持 `githubUseApi`；GitHub MCP 工具支持 `useApi`。
