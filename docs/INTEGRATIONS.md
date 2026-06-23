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
- `eval_fixtures`

## Codex

Codex is the current priority integration target.

Use the CLI directly from the Codex tool runner, or connect through the MCP-style stdio server. The important rule is that Codex must not bypass `.vibeguard.yaml`.

See `docs/CODEX.md` for the focused Codex workflow.

The current Codex flow supports patch artifact output and Git/PR dry-run planning. It does not execute branch creation, commits, pushes, or PR creation from `fix`.

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
