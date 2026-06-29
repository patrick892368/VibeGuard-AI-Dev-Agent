# VibeGuard AI Dev Agent

> 中文 / English bilingual documentation.

## 简介 / Overview

VibeGuard 是一个受 Policy-as-Code 约束的 AI 开发 Agent，用于 Debug、仓库 Onboarding、测试生成和 PR Review。

VibeGuard is a policy-bound AI developer agent for debugging, repository onboarding, test writing, and PR review.

核心规则：任何 agent 在读取 debug context、写文件、生成或应用 patch、执行风险命令、创建远端变更前，都必须先经过 `.vibeguard.yaml` 检查。

Core rule: every agent must pass through `.vibeguard.yaml` policy checks before reading debug context, writing files, generating or applying patches, running risky commands, or creating remote changes.

当前优先方向是 Codex + Grok。Cursor、Claude Code、Cline 和 VS Code 深度集成暂缓。

The current priority is Codex + Grok. Cursor, Claude Code, Cline, and deeper VS Code integration are deferred.

## 当前能力 / Current Capabilities

- `vibeguard policy check`: 检查路径、命令和 unified diff patch。Checks paths, commands, and unified diff patches.
- `vibeguard debug`: 通过 read policy 读取报错日志，解析 Python、Django、Node.js、Java/Spring Boot 报错，Java 栈会优先用完整包名消歧同名源码文件，定位可能文件，并输出结构化 `explanation` 解释为什么失败。Reads error logs through read policy, parses Python, Django, Node.js, and Java/Spring Boot errors, uses fully qualified Java package names to disambiguate duplicate source filenames, finds likely files, and returns a structured `explanation` for why the failure happened.
- `debug --ai-patch` 和 `fix` 的 provider patch source 会返回结构化 `repairPlan`，包含 primary file、target files、策略步骤和建议测试命令，即使 provider 暂时不可用也能给出下一步修复方案；fixture provider 的 patch file 读取也会经过 path policy，避免测试/评测入口读取 `.env` 等 denied 文件。`debug --ai-patch` and `fix` provider patch sources return a structured `repairPlan` with the primary file, target files, strategy steps, and suggested test commands, so callers still get a repair plan even when the provider is temporarily unavailable; fixture-provider patch-file reads also pass path policy to prevent test/eval entry points from reading denied files such as `.env`.
- Debug snippets 会先经过 path policy，再包含 stack frame 和 framework 相关 likely files 的短预览，帮助 AI patch 看到真正需要修改的文件但不读取 denied 路径。Debug snippets pass through path policy before including stack frames and short previews of framework-related likely files, so AI patch generation can see likely targets without reading denied paths.
- `vibeguard fix`: 通过 read policy 读取日志和 patch 文件，编排 debug、patch 校验、policy 检查、安全 apply、测试、PR summary 和 Git plan；会规范化 fenced diff、plain unified diff、非标准 diff header 和 hunk count，并在生成的 Django TemplateDoesNotExist patch 无法应用时尝试本地恢复，恢复用源码读取也会经过 path policy；执行 Git/PR plan 时可用 `--check-ci` 读取 head branch 的 CI gate summary，也可用 `--wait-ci` 等待 pass/fail，并返回 `ciStatus`。Reads log and patch files through read policy, orchestrates debug, patch validation, policy checks, safe apply, tests, PR summaries, and Git plans; normalizes fenced diffs, plain unified diffs, non-standard diff headers, and hunk counts, and can try a local recovery when a generated Django TemplateDoesNotExist patch cannot apply, with recovery source reads also passing path policy; executed Git/PR plans can use `--check-ci` to read the head-branch CI gate summary, `--wait-ci` to wait for pass/fail, and return `ciStatus`.
- `vibeguard test`: 扫描测试候选，候选源码读取会先经过 path policy，并可通过 read policy 读取 coverage.py JSON / LCOV；coverage 文件读取会限制在仓库 root 内，排序未覆盖文件、函数、类和接口，也可比较 before/after coverage，并用 `coverageDeltaStatus` 标明是否已比较。Scans source files for test candidates, checks candidate source reads through path policy, reads coverage.py JSON / LCOV through read policy; coverage-file reads are contained inside the repository root, can prioritize uncovered files, functions, classes, and interfaces, can compare before/after coverage, and reports `coverageDeltaStatus`.
- `vibeguard test --write`: 经过 policy 后写入基础测试，支持 ESM/CommonJS Node 模块（包含 `exports["name"]` bracket export）、stdlib `unittest` Python 测试和 JUnit 5 Java 测试；会为简单纯函数、ESM/CommonJS async JS 函数、Java public static / 可无参构造实例方法、集合 map/filter、Promise.resolve、类导出 smoke checks、明确分支、对象属性/字典字段 fallback、简单 Python dependency `Mock` 调用、常见边界值和 JS/Python/Java 明确异常分支生成行为断言；TypeScript interface-only 文件会进入候选但不会生成无运行时意义的空测试；可用 `--run` 继续通过 command policy 执行生成的测试，`--repair` 可对安全的生成测试失败做一轮 test-only 修复，`--coverage-command` 可在写测试前后通过 command policy 运行同一 coverage 命令并回填 `coverageRuns` / before-after `coverageDelta`；并按生成测试目标自动生成 branch/commit/PR dry-run plan，测试 PR body 会包含覆盖率变化摘要；只有最终生成测试通过且 `--execute-git-plan --confirm` 通过策略后才执行 Git plan，`--check-ci` 可在执行后读取测试 PR 分支 CI，`--wait-ci` 可等待 CI pass/fail，`--github-api` 可让测试 PR 创建显式走 GitHub REST fallback。Writes basic tests after policy checks, supports ESM/CommonJS Node modules including `exports["name"]` bracket exports, stdlib `unittest` Python tests, and JUnit 5 Java tests; generates behavior assertions for simple pure functions, ESM/CommonJS async JS functions, Java public static / no-arg-constructible instance methods, collection map/filter returns, Promise.resolve returns, class-export smoke checks, clear branches, object-property/dictionary-field fallbacks, simple Python dependency `Mock` calls, common boundary values, and clear JS/Python/Java exception branches; TypeScript interface-only files are surfaced as candidates but do not get meaningless runtime-empty tests; can use `--run` to execute generated tests through command policy, `--repair` can run one safe test-only repair retry for generated-test failures, `--coverage-command` can run the same coverage command before and after writing tests through command policy and return `coverageRuns` plus before/after `coverageDelta`; can generate target-derived branch/commit/PR dry-run plans whose test PR body includes a coverage-change summary, and only executes the Git plan after final generated tests pass and `--execute-git-plan --confirm` passes policy; `--check-ci` can read test PR branch CI after execution; `--wait-ci` can wait for CI pass/fail; `--github-api` can explicitly route test PR creation through the GitHub REST fallback.
- `vibeguard review`: 分析 diff 中的 bug、安全、性能、测试缺口和 policy 风险，包含 secret、SQL/HTML/deserialization、SSRF、TLS 校验关闭、弱 hash、安全敏感随机数、shell injection、Java `Runtime.exec` / `ProcessBuilder`、Java URL/URI SSRF、动态执行、同步 I/O 和常见 bug-prone 规则，并输出文件/行号级 findings、recommendations、actionItems、可发布的 `reviewComments` 和 PR comment Markdown；默认读取 `git diff` 前会先过 command policy，也可用 `--github-pr` 通过 `gh pr diff` 或 REST fallback 读取远端 PR diff；可用 `--write-comment` 经过 policy 写出评论正文文件，也可用 `--comment-pr` / `--publish-comment --execute --confirm` 直接把生成的 review Markdown 受 policy 保护地发布为 GitHub PR comment，`--github-api` 可强制 REST fallback。Reviews diffs for bugs, security, performance, missing tests, and policy risk, including secret, SQL/HTML/deserialization, SSRF, disabled TLS verification, weak hashes, security-sensitive randomness, shell-injection, Java `Runtime.exec` / `ProcessBuilder`, Java URL/URI SSRF, dynamic-execution, sync-I/O, and common bug-prone rules, with file/line findings, recommendations, actionItems, publishable `reviewComments`, and PR-comment Markdown; default `git diff` reads pass command policy first, `--github-pr` can read remote PR diffs through `gh pr diff` or the REST fallback, `--write-comment` can write the comment body file through policy, and `--comment-pr` / `--publish-comment --execute --confirm` can directly publish the generated review Markdown as a policy-gated GitHub PR comment, with `--github-api` forcing the REST fallback.
- `vibeguard onboard`: 扫描仓库并生成中英双语 onboarding / architecture 文档；依赖 manifest、Spring/Django 元数据读取会先经过 path policy，并返回 `metadataReadPolicy` / `skippedMetadataFiles`；同时输出结构化依赖清单、`coreModules`、仓库相关 Mermaid 架构图、firstTasks 和带 command policy 状态的 `commandChecks`。Scans a repository and can generate bilingual onboarding / architecture docs; dependency manifests plus Spring/Django metadata reads pass path policy first and return `metadataReadPolicy` / `skippedMetadataFiles`, alongside structured dependencies, `coreModules`, repository-specific Mermaid architecture diagrams, firstTasks, and `commandChecks` with command-policy status.
- `vibeguard patch`: 通过 policy 检查或应用 unified diff；`--file` 输入路径本身会先经过 read policy，底层 `git apply --check/apply` 也会经过 command policy。Checks or applies unified diffs through policy; `--file` input paths pass read policy first, and underlying `git apply --check/apply` commands also pass command policy.
- `vibeguard hooks`: 打印或安装 Git hook 模板；安装时即使传入 `--allow-git-dir`，`.git/hooks/<hook>` 写入仍必须通过 path policy。Prints or installs Git hook templates; installation still checks `.git/hooks/<hook>` through path policy even when `--allow-git-dir` is supplied.
- `vibeguard pr summary` / `pr plan`: 从 diff 生成包含 review findings、actionItems、自动 PR title、branch name 和 commit message 的 GitHub-ready PR body；`pr plan` 还会生成受 policy 保护的 branch/stage/commit/PR dry-run 或执行计划，`git add` 的每个 staged 文件和 PR body 文件都会经过 path policy，并可用 `--check-ci` / MCP `checkCi` 在执行 Git/PR plan 后读取 CI gate summary，或用 `--wait-ci` / MCP `waitCi` 等待 CI pass/fail；MCP-style `plan_pr` 暴露同一能力给 Codex；默认读取 `git diff` 前会先过 command policy，也可用 `--github-pr` 读取远端 PR diff；可用 `--write-body` 经过 policy 写出 PR body 文件。Builds a GitHub-ready PR body plus automatic PR title, branch name, and commit message with review findings and actionItems from a diff; `pr plan` also builds a policy-gated branch/stage/commit/PR dry-run or execution plan, checks every `git add` staged file and PR body file through path policy, and `--check-ci` / MCP `checkCi` can read a CI gate summary after the Git/PR plan executes, while `--wait-ci` / MCP `waitCi` can wait for CI pass/fail; MCP-style `plan_pr` exposes the same capability to Codex; default `git diff` reads pass command policy first, `--github-pr` can read remote PR diffs, and `--write-body` can write the PR body file through policy.
- `vibeguard github`: 检测 GitHub remote、单独预检 GitHub 写权限、创建 PR、发布普通评论/单条或批量文件行级 review comment、读取 Actions 状态并归一成 CI gate summary，`github auth` 会通过 policy-gated remote detection、`gh --version` 和 `gh auth status` 返回不泄密的 `githubAuth.canWrite` / `nextActions`；`github checks --wait` 可轮询到 pass/fail 或 timeout；批量 review comments 在使用 `--github-pr` 时可自动读取 PR head SHA；执行时支持 `gh`，也支持 REST fallback，可用 `--github-api` 显式强制走 REST API；公开仓库的只读 GET（PR diff、PR head、Actions runs）可以无 token 读取，PR/comment/review comment 等写操作仍需要 `GITHUB_TOKEN` / `GH_TOKEN`，缺认证时会返回结构化 `auth_required` 而不是普通崩溃；`--body-file` 和批量 diff 输入会先经过 path policy，detect、PR fallback prerequisite 和 `checks --execute` 也会先经过 command policy；CLI/MCP 会传入 PolicyEngine，公共 JS helper 在检测 remote 或 `dryRun:false` 真实执行时缺少 PolicyEngine 会拒绝执行；底层 `git` / `gh` 子进程统一通过 policy runner 执行。Detects GitHub remotes, preflights GitHub write auth, creates PRs, posts general comments and single or batched file-line review comments, reads Actions status normalized into a CI gate summary, and `github auth` returns secret-safe `githubAuth.canWrite` / `nextActions` through policy-gated remote detection, `gh --version`, and `gh auth status`; `github checks --wait` can poll until pass/fail or timeout; batched review comments can infer the PR head SHA when `--github-pr` is used; execution supports `gh` or the REST fallback, `--github-api` can explicitly force the REST API path; public-repo read-only GETs such as PR diff, PR head, and Actions runs can be read without a token, while PR/comment/review-comment writes still require `GITHUB_TOKEN` / `GH_TOKEN`, and missing auth returns structured `auth_required` instead of a plain crash; `--body-file` plus batched diff inputs are checked by path policy first, and detect, PR fallback prerequisites, and `checks --execute` are gated by command policy; CLI/MCP pass a PolicyEngine, public JS helpers reject remote detection or `dryRun:false` execution without one, and underlying `git` / `gh` subprocesses run through the policy runner.
- `vibeguard run`: 经过 command policy 后执行命令。Runs commands only after command policy checks.
- `--audit-log reports/audit.jsonl`: 为 policy 检查、写文件、patch 和命令执行追加 JSONL 审计事件。Appends JSONL audit events for policy checks, writes, patches, and command execution.
- `vibeguard audit summary` / `audit report`: 汇总 JSONL 审计日志，或写出 Markdown 审计报告。Summarizes JSONL audit logs or writes a Markdown audit report.
- `vibeguard eval fixtures` / `eval history`: 用 Python / Node / Django-style / Spring Boot-style fixture 评测当前 LLM provider，Django fixture 通过 dependency-free `manage.py test` shim 覆盖真实入口形态，Spring Boot fixture 包含 `application.properties`、`spring-boot-starter-test` 和 JUnit-style smoke test source，并用 Node smoke runner 保持本地无外部依赖；报告会输出每个 fixture 的 `framework` 和 `testCommand`，临时副本不做内部 Git 初始化，并按 fixture 汇总历史结果。Evaluates the configured LLM provider against Python, Node, Django-style, and Spring Boot-style fixtures; the Django fixture uses a dependency-free `manage.py test` shim for a realistic entrypoint shape, the Spring Boot fixture includes `application.properties`, `spring-boot-starter-test`, and JUnit-style smoke test source while keeping a dependency-light Node smoke runner, reports include each fixture `framework` and `testCommand`, temporary copies are not internally initialized as Git repos, and history is summarized per fixture.
- `vibeguard doctor`: 检查 policy、provider、默认模型、proxy、Git、GitHub remote、`gh`、`gh auth status` 和 GitHub token 来源是否存在；`git --version` / `gh --version` / `gh auth status` 探测也会先经过 command policy，并返回机器可读 `githubAuth.canWrite`、`capabilityReadiness`（Debug、Onboarding、Test Writer、PR Review、Policy、Codex+Grok、GitHub PR loop）和 `nextActions`；provider HTTP 失败会返回短错误摘要，但不会打印密钥。Checks policy, provider, default model, proxy, Git, GitHub remote, `gh`, `gh auth status`, and GitHub token source presence; `git --version`, `gh --version`, and `gh auth status` probes also pass command policy first, and doctor returns machine-readable `githubAuth.canWrite`, `capabilityReadiness` for Debug, Onboarding, Test Writer, PR Review, Policy, Codex+Grok, and GitHub PR loop plus `nextActions`; provider HTTP failures return short error summaries without printing secrets.
- `vibeguard mcp`: 启动 MCP-style stdio server，支持 `initialize`、`ping`、`tools/list` schema、`resources/list` / `resources/templates/list` / `resources/read` 暴露 README、Codex、Integrations、Policy 文档和 `.vibeguard.yaml`、`prompts/list` / `prompts/get` 暴露 Debug、Onboarding、Test Writer、PR Review 和 GitHub PR loop 工作流提示、structured tool output、受 read policy 保护的 log/patch/diff/coverage/resource 文件输入、`debug_error` AI patch artifact、`apply_patch_safely`、`plan_pr`，以及 `github_auth`、GitHub PR dry-run、普通/批量 review comments、checks 等 Codex 工作流工具。Starts an MCP-style stdio server with `initialize`, `ping`, `tools/list` schemas, `resources/list` / `resources/templates/list` / `resources/read` for README, Codex, Integrations, Policy docs, and `.vibeguard.yaml`, `prompts/list` / `prompts/get` for Debug, Onboarding, Test Writer, PR Review, and GitHub PR loop workflow prompts, structured tool output, read-policy-protected log/patch/diff/coverage/resource file inputs, `debug_error` AI patch artifacts, `apply_patch_safely`, `plan_pr`, and Codex workflow tools such as `github_auth`, GitHub PR dry-runs, general/batched review comments, and checks.

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
vibeguard debug --log error.log --ai-patch --output-patch reports/generated.patch
vibeguard fix --log error.log --patch fix.diff --test "npm test" --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --apply --audit-log reports/audit.jsonl
vibeguard fix --log error.log --patch fix.diff --auto-test --apply
vibeguard fix --log error.log --patch fix.diff --test "npm test" --output-patch patches/fix.diff --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --create-branch --commit --pr-dry-run --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --create-branch --commit --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --apply
vibeguard fix --log error.log --patch fix.diff --test "npm test" --apply
vibeguard test
vibeguard test --coverage coverage.json
vibeguard test --coverage coverage/lcov.info
vibeguard test --coverage coverage-before.json --coverage-after coverage-after.json
vibeguard test --write --limit 1
vibeguard test --write --coverage coverage.json --run --limit 1
vibeguard test --write --coverage coverage.json --coverage-command "npm run coverage -- --json" --run --limit 1
vibeguard test --write --run --repair --limit 1
vibeguard test --write --run --test-command "node --test {testFile}"
vibeguard test --write --create-branch --commit --pr-dry-run --json
vibeguard test --write --run --create-branch --commit --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --json
vibeguard review
vibeguard review --diff reports/change.diff --write-comment reports/review.md
vibeguard review --diff reports/change.diff --comment-pr 12 --execute --confirm --github-api
vibeguard review --github-pr 12 --publish-comment --execute --confirm --github-api
vibeguard onboard
vibeguard onboard --write
vibeguard patch check --file fix.diff
vibeguard patch apply --file fix.diff --check-only
vibeguard hooks list
vibeguard hooks print pre-commit
vibeguard review --github-pr 12 --github-api --json
vibeguard pr summary --diff reports/change.diff --write-body reports/pr-body.md
vibeguard pr plan --diff reports/change.diff --write-body reports/pr-body.md
vibeguard pr plan --diff reports/change.diff --write-body reports/pr-body.md --check-ci --wait-ci --ci-timeout 300
vibeguard pr plan --github-pr 12 --github-api --write-body reports/pr-body.md
vibeguard github detect
vibeguard github auth
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft --execute --confirm --github-api
vibeguard github comment --pr 12 --body-file review.md
vibeguard github review-comment --pr 12 --commit abc123 --path src/app.js --line 10 --body-file review.md
vibeguard github review-comments --pr 12 --github-pr 12 --github-api
vibeguard github review-comments --pr 12 --commit abc123 --diff reports/change.diff
vibeguard github checks --branch codex/fix-bug --limit 5
vibeguard github checks --branch codex/fix-bug --limit 5 --execute --wait --wait-timeout 300
vibeguard run --command "npm test" --dry-run
vibeguard run --command "npm test" --audit-log reports/audit.jsonl
vibeguard audit summary --file reports/audit.jsonl
vibeguard audit report --file reports/audit.jsonl --output reports/audit.md
vibeguard eval fixtures --json
vibeguard eval fixtures --repeat 3 --json
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

AI 生成的 patch 不会自动应用，必须先通过 Policy Engine 检查。`debug --ai-patch --output-patch <file>` 可以经过 policy 写出规范化 patch artifact。

Generated patches are not applied automatically. They must pass the Policy Engine first. `debug --ai-patch --output-patch <file>` can write the normalized patch artifact through policy.

用于测试和评测的 fixture provider 如果通过 `VIBEGUARD_FIXTURE_PATCH_FILE` 读取本地 patch 文件，CLI/MCP/Fix 会先执行 path policy；被拒绝或需要确认的路径会返回结构化 `fixture_patch_file_policy` 状态。

When the fixture provider used for tests and evaluations reads a local patch through `VIBEGUARD_FIXTURE_PATCH_FILE`, CLI/MCP/Fix paths check path policy first; denied or confirmation-required paths return a structured `fixture_patch_file_policy` status.

如果没有设置 `HTTPS_PROXY` / `HTTP_PROXY`，VibeGuard 会从当前仓库的 Git `https.proxy` / `http.proxy` 继承代理用于 provider 请求；该继承通过解析 `.git/config` 完成，不执行 `git config --get`。

If `HTTPS_PROXY` / `HTTP_PROXY` are not set, VibeGuard inherits Git `https.proxy` / `http.proxy` from the current repository for provider requests; this is done by parsing `.git/config`, not by running `git config --get`.

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

`fix` 总是先校验 patch shape、检查 policy、运行 `git apply --check`，只有传入 `--apply` 才真正应用 patch。`--patch <file>` 的输入文件读取也会先经过 read policy。对 AI/provider 生成的 patch，如果 `git apply --check` 失败且命中明确的 Django TemplateDoesNotExist 字符串替换场景，`fix` 会在 path policy 允许读取源码时生成一个本地 fallback patch，再重新经过 validation、policy 和 apply check；用户手动提供的 patch 不会被静默替换。

`fix` always validates patch shape, checks policy, runs `git apply --check`, and only applies the patch when `--apply` is present. `--patch <file>` input file reads also pass read policy first. For AI/provider-generated patches, if `git apply --check` fails and the error matches a clear Django TemplateDoesNotExist string replacement case, `fix` generates a local fallback patch only when path policy allows reading the source file, then runs validation, policy, and apply check again; user-provided patches are not silently replaced.

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
node ./bin/vibeguard.js eval fixtures --repeat 3 --json
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

评测会报告成功率、patch validation 失败、policy deny、patch check 失败、provider blocked，以及 `patchRecoveryStatus` / `patchRecoveryStrategy` 等恢复诊断；`--repeat <n>` 可做多轮稳定性评测。

Evaluation reports success rate, patch validation failures, policy denials, patch check failures, blocked provider calls, and recovery diagnostics such as `patchRecoveryStatus` / `patchRecoveryStrategy`; use `--repeat <n>` for multi-run stability checks.

`--output` 和 `--history` 都经过 Policy-as-Code；`.env` 等 denied 路径会被阻止。`reports/*.json` 和 `reports/*.jsonl` 是本地输出，默认不提交。

`--output` and `--history` both pass through Policy-as-Code; denied paths such as `.env` are blocked. `reports/*.json` and `reports/*.jsonl` are local outputs and ignored by default.

## Git / PR 编排 / Git and PR Orchestration

Codex 可以先请求 dry-run 计划：

Codex can first request a dry-run plan:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --output-patch patches/fix.diff --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --pr-dry-run --pr-body-file patches/pr-body.md --dry-run --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --pr-dry-run --json
```

确认后才能执行本地 branch / commit：

After confirmation, local branch / commit execution is available:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --apply --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --create-pr --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --github-api --json
```

远端 push / PR 也在同一个显式执行门后面：

Remote push / PR actions sit behind the same explicit execution gate:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --apply --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --apply --github-api --json
node ./bin/vibeguard.js test --write --run --create-branch --commit --push --create-pr --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --github-api --json
node ./bin/vibeguard.js pr plan --diff reports/change.diff --write-body reports/pr-body.md --push --execute-git-plan --confirm --check-ci --wait-ci --ci-timeout 300 --github-api --json
```

默认策略要求 `git switch -c`、`git commit`、`git push`、`gh pr create`、`gh pr comment`、`gh api` 人工确认。远端 PR / comment 还要求 GitHub remote 和已认证的 `gh`，或可用的 GitHub token fallback。

Default policy requires confirmation for `git switch -c`, `git commit`, `git push`, `gh pr create`, `gh pr comment`, and `gh api`. Remote PR/comment actions also require a GitHub remote and authenticated `gh`, or an available GitHub token fallback.

GitHub detect and REST fallback prerequisites such as `git remote get-url origin` and `git branch --show-current` are also checked through command policy before execution.

GitHub detect 和 REST fallback 需要的 `git remote get-url origin`、`git branch --show-current` 等 prerequisite 命令，也会在执行前经过 command policy。REST fallback 读取 `bodyFile` 时同样限制在仓库 root 内；CLI/MCP 会自动传入 `PolicyEngine`，直接调用公开 GitHub helper 时，remote 检测和 `dryRun:false` 真实执行都必须传入 `PolicyEngine`，让 GitHub 操作、prerequisite 命令和 `bodyFile` 读取经过同一套 policy。

REST fallback body-file reads are also contained inside the repository root; CLI/MCP pass a `PolicyEngine` automatically, and direct public GitHub helper calls must pass a `PolicyEngine` for remote detection and `dryRun:false` execution so GitHub operations, prerequisite commands, and `bodyFile` reads go through the same policy gates.

Git plan PR body files are checked through `read_pr_body` path policy before any protected branch/commit/push/PR execution. Fix dry-runs also include `gitPolicy` so Codex can review command and body-file policy before execution.

Git plan 中的 PR body 文件也会在受保护的 branch / commit / push / PR 执行前经过 `read_pr_body` path policy。Fix dry-run 也会返回 `gitPolicy`，方便 Codex 在执行前审查 command 和 body-file policy。

When a Fix Git plan is executed, its `create_pr` step uses the same GitHub helper path as `vibeguard github pr`; it can create the draft PR through authenticated `gh` or through the `GITHUB_TOKEN` / `GH_TOKEN` REST fallback after policy confirmation. Pass `--github-api` to force the REST API path from the CLI.

Fix Git plan 执行时，`create_pr` 步骤会复用 `vibeguard github pr` 的 GitHub helper 路径；通过 policy 确认后，可以用已认证的 `gh` 创建 draft PR，也可以在存在 `GITHUB_TOKEN` / `GH_TOKEN` 时走 REST fallback。CLI 可传 `--github-api` 显式强制走 REST API。

## Policy-as-Code / Policy-as-Code

`.vibeguard.yaml` 定义仓库安全边界：

`.vibeguard.yaml` defines the repository safety boundary:

默认策略允许 `*.log` 和 `logs/**` 作为错误日志 artifact，但 `.env` 等 deny 路径仍然优先拒绝。

The default policy allows `*.log` and `logs/**` as error-log artifacts, while deny paths such as `.env` still take priority.

```yaml
paths:
  allow:
    - "src/**"
    - "test/**"
    - "*.log"
    - "logs/**"
  deny:
    - ".env"
    - ".git/**"
  require_confirmation:
    - ".github/workflows/**"
    - "migrations/**"

commands:
  deny:
    - "rm -rf"
    - "curl * | sh"
    - "wget * | sh"
    - "git reset --hard"
  require_confirmation:
    - "npm install"
    - "git switch -c"
    - "git commit"
    - "git push"
    - "gh pr create"
    - "gh pr comment"
    - "gh api"
```

策略结果：

Policy result levels:

- `allow`: 允许执行。The operation is permitted.
- `require_confirmation`: 需要人工确认。The operation needs human confirmation.
- `deny`: 阻止执行。The operation is blocked.

优先级：`deny` > `require_confirmation` > `allow`。

Priority: `deny` > `require_confirmation` > `allow`.

Command policy wildcards match across the normalized command string, including URL/path separators, so patterns such as `curl * | sh` block pipe installers like `curl https://example.com/install.sh | sh`.

命令策略的 wildcard 会匹配规范化后的整条命令，包括 URL/path 分隔符；因此 `curl * | sh` 会阻止 `curl https://example.com/install.sh | sh` 这类 pipe installer。

## 测试 / Tests

```bash
npm test
```

测试覆盖：

The test suite covers:

- YAML 配置解析。YAML config parsing.
- 路径和命令 policy。Path and command policy checks.
- Policy Engine 和 policy-gated 文件操作的仓库 root containment。Repository-root containment for the Policy Engine and policy-gated file operations.
- Patch 安全检查，以及底层 `git apply --check/apply` command policy 门禁。Patch file safety checks plus command-policy gates for underlying `git apply --check/apply`.
- Debug/fix 日志输入和 patch 输入文件读取的 Policy-as-Code 边界。Policy-as-Code boundaries for reading debug/fix log inputs and patch input files.
- Patch 输出规范化和生成补丁失败后的 Django fallback 恢复。Patch output normalization and Django fallback recovery after generated patch-check failures.
- AI patch provider 的结构化 `repairPlan`，覆盖 provider unavailable、fixture 和 Grok-compatible 返回路径。Structured AI patch provider `repairPlan` coverage for provider-unavailable, fixture, and Grok-compatible return paths.
- Python / Node / Django-style / Spring Boot-style fixture 的 safe fix 工作流，包含 Django `manage.py test` shim 和 Spring Boot 配置/JUnit-style smoke source。Safe fix workflow over Python, Node, Django-style, and Spring Boot-style fixture projects, including the Django `manage.py test` shim and Spring Boot config/JUnit-style smoke source.
- AI patch fixture 评测。Fixture evaluation for AI patch dry-runs.
- Python / Django / Node / Java / Spring Boot 报错解析。Python / Django / Node / Java / Spring Boot error parsing.
- Review diff 分析、bug/security/performance/testing 风险规则（包含 shell injection、SSRF、TLS 校验关闭、弱 hash 和不安全随机数）、严重度汇总、可执行 actionItems 和 PR review comment body 的 policy-gated 写出。Review diff analysis, bug/security/performance/testing risk rules including shell injection, SSRF, disabled TLS verification, weak hashes, and insecure randomness, severity summaries, actionable actionItems, and policy-gated writing of PR review comment bodies.
- `review` / `pr summary` / `pr plan` 默认 `git diff` 读取的 command policy 门禁。Command-policy gates for default `git diff` reads in `review`, `pr summary`, and `pr plan`.
- Git hook 安装写 `.git/hooks/<hook>` 前的 path policy 门禁。Path-policy gates before Git hook installation writes `.git/hooks/<hook>`.
- 仓库扫描。Repository scanning.
- Onboarding command checks，用于标注建议命令的依据、缺失 wrapper 或需要确认的依赖。Onboarding command checks for suggested command evidence, missing wrappers, or dependencies that need confirmation.
- Onboarding dependency extraction from package.json, requirements.txt, pyproject.toml, pom.xml, and Gradle files. / Onboarding 从 package.json、requirements.txt、pyproject.toml、pom.xml 和 Gradle 文件提取依赖。
- 本地 branch / commit / push / PR plan 的受保护执行，并检查 PR body-file path policy；通用 `pr plan` / MCP `plan_pr` 也会返回 `gitPlan`、`gitPolicy` 和可选 `gitExecution`，并覆盖确认后的 REST PR 创建链路。Confirmed protected local branch / commit / push / PR plan flows, including PR body-file path policy; generic `pr plan` / MCP `plan_pr` also returns `gitPlan`, `gitPolicy`, and optional `gitExecution`, with coverage for confirmed REST PR creation.
- PR 创建调度、`--github-api` 显式 REST fallback、Fix/Test Writer Git plan REST PR 创建、普通 PR comment dry-run、单条/批量 review comment dry-run、GitHub detect/PR prerequisite policy、CI checks execute policy、CI gate summary、REST fallback bodyFile root containment、direct helper GitHub command/path policy、policy confirmation 和 REST fallback。PR creation dispatch, explicit `--github-api` REST fallback, Fix/Test Writer Git plan REST PR creation, general PR comment dry-runs, single/batched review comment dry-runs, GitHub detect/PR prerequisite policy, CI checks execute policy, CI gate summaries, REST fallback bodyFile root containment, direct helper GitHub command/path policy, policy confirmation, and REST fallback.
- Public JS API exports for GitHub helpers, sync/async Git plan policy/execution, and Test Writer write/coverage helpers. / Public JS API 已导出 GitHub helper、同步/异步 Git plan policy/execution，以及 Test Writer 写测试和 coverage helper。
- `--auto-test` 测试命令选择。`--auto-test` command selection.
- 评测历史 JSONL 和趋势汇总。Evaluation history JSONL and trend summary.
- fixture 级评测历史 outcome 汇总。Per-fixture evaluation history outcome summaries.
- MCP stdio JSON-RPC smoke test，真实启动 `vibeguard mcp` 并调用 initialize、tools/list、resources/list、resources/read、prompts/list、prompts/get 和 tools/call；单元测试覆盖 non-empty resources/prompts、policy-gated `resources/read` 和 `prompts/get`。MCP stdio JSON-RPC smoke test starts `vibeguard mcp` and calls initialize, tools/list, resources/list, resources/read, prompts/list, prompts/get, and tools/call; unit tests cover non-empty resources/prompts, policy-gated `resources/read`, and `prompts/get`.
- Policy-gated JSONL 审计日志和仓库 root 边界检查。Policy-gated JSONL audit logs and repository-root containment checks.
- 默认策略对 CI/CD、migration、lockfile、部署和基础设施配置的人工确认门禁。Default-policy confirmation gates for CI/CD, migrations, lockfiles, deployment, and infrastructure config.
- Markdown 审计报告写出。Markdown audit report generation.
- Repo metadata 读取的 path policy gate、`metadataReadPolicy` / `skippedMetadataFiles` 输出、Test Writer 候选源码读取和 coverage.py JSON / LCOV 输入文件的 path policy 读取、仓库 root containment、未覆盖文件排序、missing line 到函数/类/接口映射、before/after coverage delta、`coverageDeltaStatus`、生成测试后的 policy-gated test run，以及写测试前后的 policy-gated coverage command 组合测试。Path-policy gates for repository metadata reads with `metadataReadPolicy` / `skippedMetadataFiles`, Test Writer candidate source files, and coverage.py JSON / LCOV inputs, repository-root containment, uncovered file prioritization, missing-line-to-function/class/interface mapping, before/after coverage deltas, `coverageDeltaStatus`, policy-gated test runs after generating tests, and integration coverage for policy-gated coverage commands before and after writing tests.
- Python `unittest` 风格测试生成和运行。Python `unittest`-style test generation and execution.
- 简单纯函数、ESM/CommonJS async JS 函数、集合 map/filter、Promise.resolve、类导出 smoke check、明确分支、对象属性/字典字段 fallback、简单 Python dependency `Mock` 调用、常见边界值、明确异常分支行为断言生成，以及 CommonJS bracket export 识别。Simple pure-function, ESM/CommonJS async JS function, collection map/filter, Promise.resolve, class-export smoke check, clear-branch, object-property/dictionary-field fallback, simple Python dependency `Mock` call, common-boundary, clear-exception-branch behavior assertion generation, and CommonJS bracket export detection.
- 生成测试失败后的结构化修复计划和 Python local import path 的 test-only 自动修复。Structured repair plans after generated test failures and test-only auto-repair for Python local import paths.
- Test Writer 生成测试后的 Git/PR dry-run plan，以及确认后执行本地 branch/commit 前的测试通过门。Git/PR dry-run plans after Test Writer creates tests, plus the passing-test gate before confirmed local branch/commit execution.

## 集成目标 / Integration Targets

- CLI
- Git hooks
- Codex
- MCP-style stdio server for Codex workflows
- VS Code scaffold, deferred / VS Code scaffold，暂缓
- Cursor, deferred / Cursor 暂缓
- Claude Code, deferred / Claude Code 暂缓
- Cline, deferred / Cline 暂缓
