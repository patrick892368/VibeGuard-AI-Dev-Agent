# Policy-as-Code

VibeGuard uses `.vibeguard.yaml` as the repository safety boundary.

## Path Policy

Path checks return one of three statuses:

- `allow`: the agent can proceed.
- `require_confirmation`: the agent must stop until a human confirms.
- `deny`: the agent must not proceed.

Priority order:

1. `deny`
2. `require_confirmation`
3. `allow`

If `paths.allow` is not empty, files outside the allow list are denied unless they match `paths.require_confirmation`.

## Command Policy

Command checks use the same three statuses. Dangerous commands such as force pushes, recursive deletes, and shell pipe installers should be placed in `commands.deny`.

Commands that can change dependencies, schemas, infrastructure, or deployment state should be placed in `commands.require_confirmation`.

The default policy also requires confirmation for Codex Git/PR operations that change local or remote repository state:

- `git switch -c`
- `git commit`
- `git push`
- `gh pr create`
- `gh pr comment`

## Patch Policy

Patch checks parse unified diffs and evaluate every changed file. A patch is denied if any file is denied. A patch requires confirmation if no file is denied and at least one file requires confirmation.

## Agent Rule

All agents must call the Policy Engine before:

- Writing files.
- Applying patches.
- Running risky commands.
- Preparing Git hooks.
- Creating PR changes.
