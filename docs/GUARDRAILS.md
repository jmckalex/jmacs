# Guardrails for Claude Code

This document describes the safety setup for running Claude Code on this project, including overnight unsupervised sessions.

## Quick Install

From the project root:

```bash
# Set git to use the hooks directory under version control
git config core.hooksPath .githooks

# Set up local settings override
cp .claude/settings.local.json.example .claude/settings.local.json
# Edit .claude/settings.local.json with any personal overrides
```

## The Layered Approach

Four layers of safety, each catching what others might miss:

**Layer 1 — Permission scope (`.claude/settings.json`)**
Stops the agent from touching files outside the project or running dangerous commands. Active during the session.

**Layer 2 — Git as safety net (`overnight-prep.sh`, branch discipline, pre-commit hook)**
Stops the agent from destroying recoverable state. Recovery is always available via the start tag.

**Layer 3 — Filesystem isolation (containers, not used by default)**
Stops the agent from escaping the permission scope. Add only if Layer 1 proves insufficient.

**Layer 4 — Review discipline (`overnight-review.sh`, `architect-notes.md`)**
Stops bad code from reaching main. The morning review is non-negotiable.

If any layer fails, the next catches it. If all four fail simultaneously, you have bigger problems than agent autonomy.

## Files

### `.claude/settings.json` (committed)

Shared permission profile. Explicit allows and denies for tools and commands. Deny rules evaluated first, then ask, then allow; first match wins.

Key properties:
- Broad allow for `Read`, `Edit`, `Write` within the project
- Explicit denies for sensitive directories (SSH keys, AWS credentials, keychains)
- Allow list for common dev commands (`pnpm`, `git`, basic Unix tools)
- Hard denies for dangerous operations (`sudo`, `rm -rf /`, force push, publish)
- `defaultMode: "ask"` — anything not explicitly allowed prompts for confirmation

### `.claude/settings.local.json` (gitignored)

Personal overrides. Use to:
- Add personally-needed allows
- Switch to `bypassPermissions` mode for overnight runs
- Test changes before promoting to shared settings

**For overnight runs**: change `defaultMode` to `bypassPermissions` temporarily, revert after.

### `CLAUDE.md` (committed)

Project-level operating instructions Claude Code reads at session start. Establishes branching discipline, territory rules, stop-and-ask conventions, code style, glossary.

### `.githooks/pre-commit` (committed)

Pre-commit hook:
- Blocks direct commits to `main` or `master`
- Runs the test suite before allowing commit
- Blocks accidentally staged sensitive files
- Warns about `console.log` additions

Bypass with `git commit --no-verify` for legitimate exceptions.

### `scripts/overnight-prep.sh`

Run before launching an overnight session:

```bash
./scripts/overnight-prep.sh agent-1-storage
```

Verifies clean working tree, creates/switches to the agent branch, tags the start commit as `overnight-start-YYYYMMDD-HHMMSS`, verifies tests pass, initialises `architect-notes.md`, prints recovery commands.

### `scripts/overnight-review.sh`

Run in the morning:

```bash
./scripts/overnight-review.sh
```

Summarises commits, files changed, lines added/removed; shows the log; displays notes the agent left; runs tests; lists your options.

## The Overnight Workflow

End to end:

```bash
# Evening
./scripts/overnight-prep.sh agent-1-storage
# Edit .claude/settings.local.json: defaultMode → "bypassPermissions"
# Launch Claude Code with the agent prompt

# Morning
./scripts/overnight-review.sh
cat architect-notes.md
git diff overnight-start-YYYYMMDD-HHMMSS..HEAD

# Decide:
#   git checkout main && git merge --no-ff agent-1-storage   # accept
#   git rebase -i overnight-start-YYYYMMDD-HHMMSS            # cherry-pick
#   git reset --hard overnight-start-YYYYMMDD-HHMMSS         # reject

# Revert .claude/settings.local.json: defaultMode → "ask"

# Clean up if satisfied
git tag -d overnight-start-YYYYMMDD-HHMMSS
```

## Calibration Advice

For your first overnight run, scope small:
- One agent, one tightly defined task
- Something verifiable in 30 minutes
- A package you're not deeply invested in yet (storage is a good first target)

See what the agent does. Read the diff carefully. Note what kinds of decisions it made that you wouldn't have, and what worked well. After three or four sessions, you'll have a clear sense of which kinds of tasks suit overnight runs and which need supervision.

That calibration is the real outcome of this setup.

## A Note on Reliability

Permission `deny` rules in Claude Code aren't always perfectly enforced — there have been reports of them being bypassed. Don't treat the permission system as the sole safety mechanism. That's why the layered approach matters: even if the settings.json layer fails, the git tag + pre-commit hook layer catches problems before they become unrecoverable.

The morning review is the last line of defence and the only fully reliable one. Don't skip it.
