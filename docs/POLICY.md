# Policy-as-Code / Policy-as-Code

VibeGuard uses `.vibeguard.yaml` as the repository safety boundary.

VibeGuard 使用 `.vibeguard.yaml` 作为仓库安全边界。

All agents must respect this policy before writes, patch apply, risky commands, Git/PR actions, and generated artifacts.

所有 agent 在写文件、应用 patch、执行风险命令、Git/PR 操作和写生成物前，都必须遵守该 policy。

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
- Applying patches. / 应用 patch。
- Running risky commands. / 执行风险命令。
- Preparing Git hooks. / 准备 Git hooks。
- Creating PR branches, pushes, PRs, or comments. / 创建 PR branch、push、PR 或 comment。
- Writing reports or generated artifacts. / 写报告或生成物。

## Audit Logs / 审计日志

Audit logging is explicit. Pass `--audit-log reports/audit.jsonl` to append JSONL events for policy checks, writes, patch checks/apply operations, and command execution.

审计日志是显式启用的。传入 `--audit-log reports/audit.jsonl` 后，会为 policy check、写文件、patch 检查/应用和命令执行追加 JSONL 事件。

The audit log path is checked by the same path policy before any event is written. If the audit path is denied or requires unconfirmed human approval, the event is not written and the result reports the audit policy status.

写入任何审计事件前，审计日志路径本身也会经过同一套路经 policy 检查。如果审计路径被拒绝，或需要但尚未获得人工确认，则事件不会写入，结果会返回审计路径的 policy 状态。

Recommended local path:

推荐本地路径：

```bash
reports/audit.jsonl
```

Summarize an audit log:

汇总审计日志：

```bash
vibeguard audit summary --file reports/audit.jsonl
```

## Local Secrets / 本地密钥

`.env` may contain local provider credentials such as Grok / xAI API keys.

`.env` 可能包含本地 provider 凭据，例如 Grok / xAI API key。

It must remain ignored by Git, denied by policy, and never printed in logs, docs, reports, or diagnostics.

它必须保持 Git ignored、policy denied，并且不能出现在日志、文档、报告或诊断输出中。
