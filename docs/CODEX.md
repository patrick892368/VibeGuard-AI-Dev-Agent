# Codex Integration

Codex is the current priority integration target for VibeGuard.

The integration model is CLI-first:

1. Codex works in the repository workspace.
2. Codex calls `node ./bin/vibeguard.js ...`.
3. VibeGuard checks `.vibeguard.yaml` before writes, patches, and risky commands.
4. Codex uses the JSON output to decide the next action.

## Recommended Commands

Check policy:

```bash
node ./bin/vibeguard.js policy check --path src/index.js --json
node ./bin/vibeguard.js policy check --command "npm test" --json
```

Analyze an error log:

```bash
node ./bin/vibeguard.js debug --log error.log --json
```

Generate and validate a patch:

```bash
node ./bin/vibeguard.js debug --log error.log --ai-patch --json
node ./bin/vibeguard.js patch check --file fix.diff --json
node ./bin/vibeguard.js patch apply --file fix.diff --check-only --json
```

Run tests through policy:

```bash
node ./bin/vibeguard.js run --command "npm test" --json
```

Review changes:

```bash
node ./bin/vibeguard.js review --json
node ./bin/vibeguard.js pr summary --diff change.diff --json
```

## Codex Operating Rules

- Do not bypass `.vibeguard.yaml`.
- Do not modify denied paths.
- Use `--check-only` before applying patches.
- Use `run --command` for commands that should go through policy.
- Keep `ROADMAP.md` local and uncommitted.

## Deferred Integrations

Cursor, Claude Code, and Cline are intentionally deferred until the Codex flow is stable.
