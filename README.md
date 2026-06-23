# VibeGuard AI Dev Agent

VibeGuard is a policy-bound AI developer agent for debugging, repository onboarding, test writing, and PR review.

The core design rule is simple: every agent must pass through Policy-as-Code before it modifies files, proposes patches, or runs risky commands.

## Current Capabilities

- `vibeguard policy check` checks paths, commands, and unified diff patches against `.vibeguard.yaml`.
- `vibeguard debug` parses Python and Node.js error logs, finds likely source files, and explains the failure context.
- `vibeguard test` scans Python and JavaScript source files for test candidates.
- `vibeguard test --write` writes minimal import/export tests after policy checks.
- `vibeguard review` analyzes a git diff for risky changes, security smells, missing tests, and policy concerns.
- `vibeguard onboard` scans a repository and can generate onboarding documentation.
- `vibeguard patch` checks or applies unified diffs through policy.
- `vibeguard hooks` prints or installs Git hook templates.
- `vibeguard pr summary` creates a GitHub-ready PR body from a diff.
- `vibeguard github` detects GitHub remotes and can create PRs through `gh`.
- `vibeguard run` executes commands only after command policy checks.
- `vibeguard mcp` starts a small JSON-RPC MCP-style stdio server for agent integrations.

This repository is intentionally dependency-light at the start. The CLI runs on Node.js built-ins so the project can be tested immediately after clone.

## Install Locally

```bash
npm link
```

Or run without linking:

```bash
node ./bin/vibeguard.js --help
```

## Commands

```bash
vibeguard policy check --path src/index.js
vibeguard policy check --command "npm test"
vibeguard policy check --patch fix.diff

vibeguard debug --log error.log
vibeguard test
vibeguard test --write --limit 1
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
vibeguard run --command "npm test" --dry-run
vibeguard mcp
```

## AI Patch Provider

`vibeguard debug --ai-patch` can call an OpenAI-compatible Responses API endpoint when these variables are set:

```bash
export VIBEGUARD_LLM_PROVIDER=openai-compatible
export OPENAI_API_KEY=...
export VIBEGUARD_MODEL=...
```

The generated patch is not applied automatically. It is checked by the Policy Engine first.

## Policy-as-Code

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
```

Policy result levels:

- `allow`: the operation is permitted.
- `require_confirmation`: the operation is possible but needs a human approval step.
- `deny`: the operation is blocked.

`deny` always wins over `require_confirmation`, and `require_confirmation` wins over `allow`.

## Tests

```bash
npm test
```

The test suite covers:

- YAML config parsing.
- Path and command policy checks.
- Patch file safety checks.
- Python and Node.js stack trace parsing.
- Review diff analysis.
- Repository scanning.

## Integration Targets

Planned and partially scaffolded integration surfaces:

- CLI
- Git hooks
- Codex
- MCP-style stdio server for Codex-driven workflows
- VS Code scaffold, deferred
- Cursor, deferred
- Claude Code, deferred
- Cline, deferred
