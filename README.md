# VibeGuard AI Dev Agent

VibeGuard is a policy-bound AI developer agent for debugging, repository onboarding, test writing, and PR review.

The core design rule is simple: every agent must pass through Policy-as-Code before it modifies files, proposes patches, or runs risky commands.

## Current Capabilities

- `vibeguard policy check` checks paths, commands, and unified diff patches against `.vibeguard.yaml`.
- `vibeguard debug` parses Python and Node.js error logs, finds likely source files, and explains the failure context.
- `vibeguard fix` orchestrates debug analysis, patch validation, policy checks, safe patch apply, test execution, and PR summary generation.
- `vibeguard test` scans Python and JavaScript source files for test candidates.
- `vibeguard test --write` writes minimal import/export tests after policy checks.
- `vibeguard review` analyzes a git diff for risky changes, security smells, missing tests, and policy concerns.
- `vibeguard onboard` scans a repository and can generate onboarding documentation.
- `vibeguard patch` checks or applies unified diffs through policy.
- `vibeguard hooks` prints or installs Git hook templates.
- `vibeguard pr summary` creates a GitHub-ready PR body from a diff.
- `vibeguard github` detects GitHub remotes and can create PRs through `gh`.
- `vibeguard run` executes commands only after command policy checks.
- `vibeguard eval fixtures` evaluates the configured LLM provider against Python and Node fix fixtures.
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
vibeguard fix --log error.log --patch fix.diff --test "npm test" --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --output-patch patches/fix.diff --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --create-branch --commit --pr-dry-run --dry-run
vibeguard fix --log error.log --patch fix.diff --test "npm test" --create-branch --commit --execute-git-plan --confirm --apply
vibeguard fix --log error.log --patch fix.diff --test "npm test" --apply
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
vibeguard eval fixtures --json
vibeguard eval fixtures --output reports/eval-fixtures.json --json
vibeguard eval fixtures --history reports/eval-history.jsonl --json
vibeguard eval history --file reports/eval-history.jsonl --json
vibeguard mcp
```

## AI Patch Provider

`vibeguard debug --ai-patch`, `vibeguard fix`, and `vibeguard eval fixtures` can call an AI provider to generate patches.

Grok is supported through xAI's OpenAI-compatible Responses API. Put this in your local `.env` file:

```bash
XAI_API_KEY=...
VIBEGUARD_LLM_PROVIDER=grok
VIBEGUARD_MODEL=grok-4.3
```

`.env` is ignored by Git and denied by policy. Do not commit it.

OpenAI-compatible providers are also supported:

```bash
export VIBEGUARD_LLM_PROVIDER=openai-compatible
export OPENAI_API_KEY=...
export VIBEGUARD_MODEL=...
```

The generated patch is not applied automatically. It is checked by the Policy Engine first.

## Codex Fix Workflow

The current priority workflow is Codex-driven:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --apply --json
```

For deterministic local demos and tests, pass a known patch file:

```bash
node ./bin/vibeguard.js --root fixtures/node-bug fix --log error.log --patch fixes/reference-error.patch --test "npm test" --dry-run --json
```

`fix` always validates patch shape, checks policy, runs `git apply --check`, and only applies the patch when `--apply` is present.

To evaluate a real OpenAI-compatible provider against both fixtures:

```bash
export VIBEGUARD_LLM_PROVIDER=grok
export XAI_API_KEY=...
export VIBEGUARD_MODEL=...
node ./bin/vibeguard.js eval fixtures --json
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

The evaluation reports success rate, patch validation failures, policy denials, patch check failures, and blocked provider calls.
Report output is written through Policy-as-Code, so denied paths such as `.env` are blocked.
History output is appended as compact JSONL without temporary fixture paths. Local `reports/*.json` and `reports/*.jsonl` files are ignored by Git.
`eval history` summarizes JSONL trends: latest, average, best, and worst success rate plus outcome counts.

Optional Codex orchestration:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --output-patch patches/fix.diff --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --pr-dry-run --pr-body-file patches/pr-body.md --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --execute-git-plan --confirm --apply --json
```

The first Git/PR command returns a structured dry-run plan for Codex review. `--execute-git-plan --confirm --apply` executes the local branch and commit plan only after patch validation, policy checks, `git apply --check`, patch apply, and tests pass.

Remote actions are available behind the same explicit execution gate:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --apply --json
```

`git switch -c`, `git commit`, `git push`, and `gh pr create` require confirmation by default. Remote PR creation also requires a configured GitHub remote and authenticated `gh`.

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
    - "git switch -c"
    - "git commit"
    - "git push"
    - "gh pr create"
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
- Safe fix workflow over Python and Node.js fixture projects.
- Fixture evaluation for AI patch dry-runs.
- Python and Node.js stack trace parsing.
- Review diff analysis.
- Repository scanning.
- Confirmed Codex Git plan execution for local branch and commit flows.
- Confirmed push plan execution against a local bare Git remote.
- Confirmed PR create command dispatch through the protected runner.
- Compact fixture evaluation history output.

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
