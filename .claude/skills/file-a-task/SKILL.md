---
name: file-a-task
description: Use when you notice a problem, bug, or improvement that is outside the current task's scope - files it as a tracker card instead of expanding scope or forgetting it
---

# File a task in the tracker

You are working inside cowork-deck. If you notice a problem along the way that
is **not part** of the current task, do not widen your scope and do not let it
drop. File a card and carry on with what you were doing.

## When to use this

- You found a bug in code you are not touching.
- You saw a TODO or a hack worth fixing separately.
- You thought of an improvement nobody asked you for.

## When NOT to use this

- The problem **is** part of your task — just fix it.
- You are not sure it is a problem — check first, then file.
- A card already exists: look at `ls "$COWORK_TASKS_DIR"` first.

## How

```bash
"$COWORK_TASK_BIN" new --kind bug --title "A short title" <<'EOF'
What is wrong, how to reproduce it, where to look.
EOF
```

`--kind` is `bug`, `task` or `idea`. The body is read from stdin and is
optional, but a card without a repro is close to useless.

If the environment variables are missing, no tracker is configured for this
workspace — say so to the human rather than guessing at a path.

## Closing a card

If you are working **on** a card (its id is in your first prompt) and the work
is finished:

```bash
"$COWORK_TASK_BIN" done <id>
```

Do not close cards you did not work on. `done` finds a card by id anywhere
under `$COWORK_TASKS_DIR` and does not check `project:` — on a shared root (the
same vault serving several workspaces, say) that means guessing an id can close
someone else's card. Close only the card you were given in your prompt.

## Reading the backlog

With ordinary tools, no wrappers: `ls "$COWORK_TASKS_DIR"`, grep the directory.
Cards are markdown with frontmatter.
