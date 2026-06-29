# Policy-as-Code / Policy-as-Code

VibeGuard uses `.vibeguard.yaml` as the repository safety boundary.

VibeGuard 使用 `.vibeguard.yaml` 作为仓库安全边界。

All agents must respect this policy before repository metadata reads, debug-context reads, writes, patch apply, risky commands, Git/PR actions, and generated artifacts.

所有 agent 在读取仓库元数据、读取 debug context、写文件、应用 patch、执行风险命令、Git/PR 操作和写生成物前，都必须遵守该 policy。

## Path Policy / 路径策略

Path checks return one of three statuses:

路径检查返回三种状态之一：

- `allow`: the agent can proceed. / agent 可以继续执行。
- `require_confirmation`: the agent must stop until a human confirms. / agent 必须暂停，等待人工确认。
- `deny`: the agent must not proceed. / agent 必须阻止执行。

Priority order:

优先级：

1. `deny`
2. `require_confirmation`
3. `allow`

If `paths.allow` is not empty, files outside the allow list are denied unless they match `paths.require_confirmation`.

如果 `paths.allow` 不为空，不在 allow list 内的文件会被拒绝，除非它匹配 `paths.require_confirmation`。

The Policy Engine denies any path that escapes the repository root, including paths found inside unified diffs. Policy-gated file reads, writes, and appends also resolve the final absolute path and reject escaped targets before touching the filesystem.

Policy Engine 会拒绝任何逃出仓库 root 的路径，包括 unified diff 中的路径。经过 policy 的文件读取、写入和追加也会解析最终绝对路径，并在触碰文件系统前拒绝逃逸目标。

Sensitive examples:

敏感示例：

- `.env`
- `.env.*`
- `.git/**`
- CI/CD config / CI/CD 配置
- migrations / 数据库 migration
- lockfiles / lockfile
- deployment and infrastructure config / 部署和基础设施配置

## Command Policy / 命令策略

Command checks use the same statuses: `allow`, `require_confirmation`, and `deny`.

命令检查使用同样的三种状态：`allow`、`require_confirmation`、`deny`。

Dangerous commands such as force pushes, recursive deletes, and shell pipe installers should be placed in `commands.deny`.

危险命令，例如 force push、递归删除、pipe installer，应该放入 `commands.deny`。

Command wildcards match across the whole normalized command string, including `/` in URLs or paths. For example, `curl * | sh` blocks `curl https://example.com/install.sh | sh`.

命令 wildcard 会匹配规范化后的整条命令，包括 URL 或路径里的 `/`。例如，`curl * | sh` 会阻止 `curl https://example.com/install.sh | sh`。

Commands that can change dependencies, schemas, infrastructure, deployment state, Git state, or remote PR state should be placed in `commands.require_confirmation`.

可能改变依赖、schema、基础设施、部署状态、Git 状态或远端 PR 状态的命令，应该放入 `commands.require_confirmation`。

Default Git/PR confirmation commands:

默认需要确认的 Git/PR 命令：

- `git switch -c`
- `git commit`
- `git push`
- `gh pr create`
- `gh pr comment`

## Patch Policy / Patch 策略

Patch checks parse unified diffs and evaluate every changed file.

Patch 检查会解析 unified diff，并逐个检查涉及的文件。

A patch is denied if any changed file is denied.

如果任一文件是 denied，整个 patch 会被拒绝。

A patch requires confirmation if no file is denied and at least one changed file requires confirmation.

如果没有 denied 文件，但至少一个文件需要确认，则整个 patch 进入 `require_confirmation`。

## Agent Rule / Agent 规则

All agents must call the Policy Engine before:

所有 agent 必须在以下操作前调用 Policy Engine：

- Writing files. / 写文件。
- Reading repository metadata such as dependency manifests and framework config probes. / 读取仓库元数据，例如依赖 manifest 和框架配置探测文件。
- Reading debug context snippets. / 读取 debug context 片段。
- Reading coverage, diff, log, patch, PR body, or audit input files. / 读取 coverage、diff、log、patch、PR body 或 audit 输入文件。
- Applying patches. / 应用 patch。
- Running risky commands. / 执行风险命令。
- Preparing Git hooks, including `.git/hooks/<hook>` writes. / 准备 Git hooks，包括写入 `.git/hooks/<hook>`。
- Creating PR branches, pushes, PRs, or comments. / 创建 PR branch、push、PR 或 comment。
- Writing reports or generated artifacts. / 写报告或生成物。

## Audit Logs / 审计日志

Audit logging is explicit. Pass `--audit-log reports/audit.jsonl` to append JSONL events for policy checks, writes, patch checks/apply operations, and command execution.

审计日志是显式启用的。传入 `--audit-log reports/audit.jsonl` 后，会为 policy check、写文件、patch 检查/应用和命令执行追加 JSONL 事件。

The audit log path is checked by the same path policy before any event is written, including repository-root escape checks. If the audit path is denied or requires unconfirmed human approval, the event is not written and the result reports the audit policy status.

审计日志路径在写入任何事件前也会经过同一套 path policy，包括仓库 root 逃逸检查。如果 audit 路径被拒绝或需要尚未确认的人工批准，该事件不会写入，结果会返回 audit policy 状态。

Recommended local path:

推荐本地路径：

```bash
reports/audit.jsonl
```

Summarize an audit log:

汇总审计日志：

```bash
vibeguard audit summary --file reports/audit.jsonl
vibeguard audit report --file reports/audit.jsonl --output reports/audit.md
```

The audit log and Markdown report paths are checked by path policy before reading or writing.

审计日志和 Markdown 报告路径在读取或写入前都会经过 path policy 检查。

## Local Secrets / 本地密钥

`.env` may contain local provider credentials such as Grok / xAI API keys.

`.env` 可能包含本地 provider 凭据，例如 Grok / xAI API key。

It must remain ignored by Git, denied by policy, and never printed in logs, docs, reports, or diagnostics.

它必须保持 Git ignored、policy denied，并且不能出现在日志、文档、报告或诊断输出中。
