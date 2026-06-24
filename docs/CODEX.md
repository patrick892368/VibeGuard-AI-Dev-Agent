# Codex Integration

Codex is the current priority integration target for VibeGuard.

The integration model is CLI-first:

1. Codex works in the repository workspace.
2. Codex calls `node ./bin/vibeguard.js ...`.
3. VibeGuard checks `.vibeguard.yaml` before writes, patches, and risky commands.
4. Codex uses the JSON output to decide the next action.

Project constraint:

- Every completed work part must update the relevant docs.
- Current agent/provider priority is Codex and Grok only.
- Cursor, Claude Code, and Cline remain deferred.
- `.env` may contain the local Grok API key; do not print, edit, or commit it.

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

Run the full safe fix workflow:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --dry-run --json
node ./bin/vibeguard.js fix --log error.log --test "npm test" --apply --json
node ./bin/vibeguard.js fix --log error.log --auto-test --apply --json
```

Write a generated patch artifact after validation and policy checks:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --output-patch patches/fix.diff --dry-run --json
```

Ask VibeGuard for the branch, commit, and PR dry-run plan:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --pr-dry-run --pr-body-file patches/pr-body.md --dry-run --json
```

Execute the local branch and commit plan after the patch and tests pass:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --execute-git-plan --confirm --apply --json
```

Include remote push and draft PR creation only when the repo remote and `gh` auth are ready:

```bash
node ./bin/vibeguard.js fix --log error.log --test "npm test" --create-branch --commit --push --create-pr --pr-body-file patches/pr-body.md --execute-git-plan --confirm --apply --json
```

Run deterministic fixture demos:

```bash
node ./bin/vibeguard.js --root fixtures/python-bug fix --log error.log --patch fixes/name-error.patch --test "python -m unittest discover -s tests" --dry-run --json
node ./bin/vibeguard.js --root fixtures/node-bug fix --log error.log --patch fixes/reference-error.patch --test "npm test" --dry-run --json
```

Evaluate the configured LLM provider against both fixtures:

```bash
node ./bin/vibeguard.js eval fixtures --json
node ./bin/vibeguard.js eval fixtures --output reports/eval-fixtures.json --json
node ./bin/vibeguard.js eval fixtures --history reports/eval-history.jsonl --json
node ./bin/vibeguard.js eval history --file reports/eval-history.jsonl --json
```

With a real provider:

```bash
export VIBEGUARD_LLM_PROVIDER=grok
export XAI_API_KEY=...
export VIBEGUARD_MODEL=grok-4.3
node ./bin/vibeguard.js eval fixtures --json
```

The CLI also loads a local `.env` file by default, so the same values can live there for local Codex runs.

Codex should inspect `summary.successRate`, each fixture `outcome`, and any `policyStatus`, `stage`, or `patchSourceReason` before deciding whether to apply a generated patch.
When `--output` is used, VibeGuard writes the report through `.vibeguard.yaml` path policy.
When `--history` is used, VibeGuard appends a compact JSONL record through the same policy and omits temporary fixture paths.
Use `eval history` to compare latest, average, best, and worst success rate before changing provider prompts or model settings.

Run tests through policy:

```bash
node ./bin/vibeguard.js run --command "npm test" --json
```

Review changes:

```bash
node ./bin/vibeguard.js review --json
node ./bin/vibeguard.js pr summary --diff change.diff --json
```

Read recent GitHub Actions run status:

```bash
node ./bin/vibeguard.js github checks --branch codex/fix-bug --limit 5 --json
node ./bin/vibeguard.js github checks --branch codex/fix-bug --limit 5 --execute --json
```

Post a PR summary or review note:

```bash
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --json
node ./bin/vibeguard.js github comment --pr 12 --body-file review.md --execute --confirm --json
```

## Codex Operating Rules

- Do not bypass `.vibeguard.yaml`.
- Do not modify denied paths.
- Use `--check-only` before applying patches.
- Prefer `fix --dry-run` before `fix --apply`.
- Use `--auto-test` only when the suggested repository test command is acceptable for the current change.
- Treat `gitPlan` output as a reviewable plan until `--execute-git-plan --confirm --apply` is present.
- Execute remote `--push --create-pr` only after local branch, commit, tests, and PR body are reviewed.
- Use `run --command` for commands that should go through policy.
- Keep `ROADMAP.md` local and uncommitted.

## Deferred Integrations

Cursor, Claude Code, and Cline are intentionally deferred until the Codex flow is stable.
