# Integrations

VibeGuard is designed around a CLI-first core so every integration uses the same policy checks.

## CLI

```bash
vibeguard debug --log error.log
vibeguard test --write
vibeguard review
vibeguard onboard --write
vibeguard policy check --path src/index.js
```

## Git Hooks

Print a hook without writing to `.git`:

```bash
vibeguard hooks print pre-commit
```

Install a hook with explicit confirmation:

```bash
vibeguard hooks install pre-commit --allow-git-dir
```

## MCP-Style Server

```bash
vibeguard mcp
```

Available tools:

- `check_policy`
- `debug_error`
- `fix_error`
- `onboard_repo`
- `write_tests`
- `review_pr`
- `summarize_pr`
- `detect_github`
- `github_checks`
- `eval_fixtures`
- `eval_history`

`eval_fixtures` supports policy-checked `output` reports and compact JSONL `history` appends for Codex/Grok quality tracking. `eval_history` summarizes those JSONL records for trend review.

## Codex

Codex is the current priority integration target.

Use the CLI directly from the Codex tool runner, or connect through the MCP-style stdio server. The important rule is that Codex must not bypass `.vibeguard.yaml`.

See `docs/CODEX.md` for the focused Codex workflow.

Grok is the current priority model provider. Other agent/provider integrations stay deferred until the Codex + Grok flow is stable.

The current Codex flow supports patch artifact output, Git/PR dry-run planning, and confirmed execution of branch/commit/push/PR commands from `fix`. Execution requires `--execute-git-plan --confirm --apply`; remote push and PR creation also require `--push --create-pr`, a GitHub remote, and authenticated `gh`.

## Deferred Agent Integrations

These integrations are intentionally deferred until the Codex flow is stable:

- Cursor
- Claude Code
- Cline

## VS Code

The repository includes a minimal extension scaffold in `integrations/vscode`.

The extension calls the local CLI and renders JSON results in a VS Code output channel. This is not the current priority; Codex comes first. The CLI remains the source of truth for policy decisions.

## GitHub

Detect the repository:

```bash
vibeguard github detect
```

Create a draft PR through the GitHub CLI. The command is dry-run by default:

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft
```

Execute the PR creation only when ready:

```bash
vibeguard github pr --title "Fix bug" --body-file pr-body.md --draft --execute
```

Read recent workflow run status:

```bash
vibeguard github checks --branch codex/fix-bug --limit 5
vibeguard github checks --branch codex/fix-bug --limit 5 --execute
```
