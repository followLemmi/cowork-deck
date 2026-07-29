# English-only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every string a contributor or user reads — UI, comments, README, issues — English, and write down the rule that keeps it that way.

**Architecture:** Literals are replaced in place; no `strings.ts`, no i18n layer. Tests that assert on a string change in the same commit as the string, so the branch is never red. Russian pluralisation helpers collapse into plain interpolation. Two modules handle Cyrillic as behaviour rather than text and keep their logic exactly as-is.

**Tech Stack:** TypeScript + vite + vitest (frontend), Rust + Tauri v2 (backend), `gh` CLI (issues).

## Global Constraints

- Vocabulary, fixed by the README and not to be re-invented: **workspace** (пространство), **scenario** (сценарий), **session** (сессия).
- Tile state labels, keys unchanged: `idle` → `idle`, `working` → `working`, `waitingInput` → `needs input`, `done` → `done`, `ended` → **`exited`**, `error` → `error`.
- Weekdays `Sun Mon Tue Wed Thu Fri Sat`, index 0 = Sunday (matches `Date.getDay()`).
- Relative days: `today` / `yesterday` / `tomorrow`.
- Schedule rules: `hourly at :MM`, `daily at HH:MM`, `weekly on Ddd at HH:MM`.
- Guillemets `«»` become curly quotes `“”`.
- `src/placeholders.ts` regex `[\p{L}\p{N}_-]` and `src/commands.ts` `e.code` matching are **behaviour, not text**. Their code does not change; only the comments that justify it via "the interface is Russian".
- `docs/superpowers/plans/` and `specs/` predating this change are never touched — this plan and its spec excepted, being new.
- `cargo test` needs `npm run stage:reporter` first in a fresh worktree.

---

### Task 1: Schedule strings

**Files:**
- Modify: `src/schedule.ts` (WEEKDAYS, `describeSchedule`, `nextRunLabel`, `schedulePreview`, `OUTCOME_TEXT`, `scheduleRowText`, `stamp`, `validateSchedule`)
- Test: `tests/schedule.test.ts`, `tests/schedule-row.test.ts`

**Interfaces:**
- Produces: `describeSchedule` → `hourly at :05` / `daily at 09:00` / `weekly on Mon at 09:00`; `nextRunLabel` and `stamp` → `today 09:00` / `yesterday 09:00` / `tomorrow 09:00` / `Mon 09:00`; `schedulePreview` → `Runs <rule> · next run <when> · in workspace “X”.` or `… · in whichever workspace is active at the time.`; `OUTCOME_TEXT` values `no workspace` / `previous run still active` / `schedule is off`; `validateSchedule` errors `Minutes: 0–59`, `Hours: 0–23`, `Weekday: 0–6`, `Fill in a default value for {{name}}`. Tasks 2 and 4 render these.

- [ ] **Step 1: Update the two test files to expect English**

Change every asserted Russian string to its English counterpart above. Keep the assertions structural where they already are (counts, `·` separators, ordering) — only the literals move.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/schedule.test.ts tests/schedule-row.test.ts`
Expected: FAIL — received Russian, expected English.

- [ ] **Step 3: Translate `src/schedule.ts`**

`const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];` and the literals per the interface block. The `/** An instant as … */` docstring on `stamp` names Russian examples — update it to `"today 09:00" / "yesterday 09:00" / "tomorrow 09:00" / "Mon 09:00"`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/schedule.test.ts tests/schedule-row.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts tests/schedule.test.ts tests/schedule-row.test.ts
git commit -m "i18n: schedule strings in English"
```

---

### Task 2: Session states, the pill, and workspace/scenario panels

**Files:**
- Modify: `src/sessions.ts` (STATE_LABEL), `src/pill-util.ts`, `src/workspaces.ts`, `src/skills.ts`
- Test: `tests/sessions.test.ts`, `tests/sessions-util.test.ts`, `tests/sessions-scheduled.test.ts`, `tests/pill.test.ts`, `tests/workspace-delete-impact.test.ts`, `tests/skills.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `pillLabel(n)` → `N waiting for input`; `deleteImpact` → `Delete workspace?` or `Delete workspace? N scenario(s) are pinned to it[, N of them scheduled] — they will stop running.`

- [ ] **Step 1: Update the six test files to expect English**

`pillLabel` loses its Russian verb agreement: `1 waiting for input`, `2 waiting for input`. Any test case that exists purely to exercise `ждёт` vs `ждут` (the 11/21/101 boundary cases) tests a rule English does not have — replace with a plain singular/plural pair rather than deleting coverage outright.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/sessions.test.ts tests/sessions-util.test.ts tests/sessions-scheduled.test.ts tests/pill.test.ts tests/workspace-delete-impact.test.ts tests/skills.test.ts`
Expected: FAIL.

- [ ] **Step 3: Translate the four source files**

`STATE_LABEL` per the Global Constraints table. `pillLabel` collapses to `` `${n} waiting for input` `` — drop the `verb` line. `deleteImpact` drops the three-way Russian noun declension for `scenario` / `scenarios`. `skills.ts` and `workspaces.ts`: headings `Workspaces` / `Scenarios`, buttons `+ workspace` / `+ scenario`, icon-button labels `Edit workspace: X`, `Delete workspace: X`, `Edit scenario: X`, `Delete scenario: X`, `Run now: X`, confirm `Delete scenario?`, the orphaned-scenario note `workspace deleted — repoint it or delete it` and its longer form.

- [ ] **Step 4: Run them and watch them pass**

Run the same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/pill-util.ts src/workspaces.ts src/skills.ts tests/
git commit -m "i18n: session states, status pill and side panels in English"
```

---

### Task 3: Forms, modals, palette, and main

**Files:**
- Modify: `src/forms.ts`, `src/modal.ts`, `src/palette.ts`, `src/main.ts`, `src/icons.ts`, `src/placeholders.ts`
- Test: `tests/forms.test.ts`, `tests/modal.test.ts`, `tests/palette.test.ts`, `tests/placeholders.test.ts`, `tests/icons.test.ts`, `tests/commands.test.ts`

**Interfaces:**
- Consumes: `describeSchedule` and `schedulePreview` from Task 1 (the scenario form renders the preview live).
- Produces: command-palette titles used by no other task.

- [ ] **Step 1: Update the six test files to expect English**

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/forms.test.ts tests/modal.test.ts tests/palette.test.ts tests/placeholders.test.ts tests/icons.test.ts tests/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Translate the source files**

`forms.ts`: `Cancel`, `New workspace` / `Edit workspace`, `New scenario` / `Edit scenario`, `Name`, `Folder`, `Colour`, `Choose folder…`, `path to the project folder`, `Scenario mark`, `Task`, `Only for the current workspace` / `otherwise the scenario is visible and runs in any`, `On a schedule` / `run it without a human present`, `hourly` / `daily` / `weekly`, weekday buttons from Task 1's `WEEKDAYS`, `hours` / `minutes` aria-labels, unit labels `h` / `min` / `minute of the hour`, `Default parameter values`, `a scheduled run has nobody to ask, so the values are needed up front`, `value for {{name}}`, the footnote `Only fires while cowork-deck is open. Missed runs happen once, at the next start.`, `Launch parameters`, and the validation errors `Enter a workspace name.`, `Choose a project folder.`, `Enter a scenario name.`, `Describe the task for Claude.`

`modal.ts`: default cancel label `Cancel`. `palette.ts`: placeholder `Command…`.

`main.ts`: `+ session`; the boot-failure text; `Run skipped: the previous one is still active.`; `This scenario has no workspace available: pin it to one or pick a workspace.`; the pick-a-workspace-first guidance referring to `“+ workspace”`; the missing-`claude` binary message; command titles `New session`, `Close active session`, `Go to next session waiting for input`, `Zoom active session`, `Search in terminal`, `Clear terminal`, `Broadcast mode (type into several sessions)`, `Go to next region (F6)`, `Scenarios: focus the sidebar list`; the inline comment about not intercepting while a modal is open.

`icons.ts`: the docstring example becomes `Delete scenario Nightly review` / five buttons all called `Delete`.

`placeholders.ts`: rewrite only the comment. The current one argues from "The interface is Russian — Russian placeholder names are the normal case". The regex stays; the new comment argues from the prompt's language being the user's choice, independent of the UI's.

- [ ] **Step 4: Run them and watch them pass**

Run the same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/forms.ts src/modal.ts src/palette.ts src/main.ts src/icons.ts src/placeholders.ts tests/
git commit -m "i18n: forms, modals, palette and shell strings in English"
```

---

### Task 4: Remaining comments — TypeScript and CSS

**Files:**
- Modify: `src/ipc.ts`, `src/terminal.ts`, `src/commands.ts`, `src/styles.css`
- Test: none change (comments only)

- [ ] **Step 1: Translate the comments**

`ipc.ts`: the `waitingInput` / `done` docstring. `terminal.ts`: the "intercept ONLY recognised app hotkeys" comment. `commands.ts`: the `matchHotkey` docstring — it ends "in an app whose interface is Russian", which stops being true; rewrite so the reason is the user's keyboard layout, not the app's language. `styles.css`: all 35 comment lines.

- [ ] **Step 2: Verify no behaviour moved**

Run: `npm test`
Expected: 190 passed — the same count as the baseline, since no assertion was touched.

- [ ] **Step 3: Commit**

```bash
git add src/ipc.ts src/terminal.ts src/commands.ts src/styles.css
git commit -m "docs: code comments in English"
```

---

### Task 5: Rust

**Files:**
- Modify: `src-tauri/src/scheduler.rs:261-262`, `src-tauri/src/store.rs:264`, `src-tauri/src/model.rs:157`

- [ ] **Step 1: Translate**

`scheduler.rs` — user-facing: `Could not save schedule state ({e}). Until this is fixed, scheduled scenarios will not fire.` `store.rs` — test fixture name `"терминал · P"` → `"terminal · P"`. `model.rs` — the doc comment on the UI-state struct.

- [ ] **Step 2: Verify**

Run: `npm run stage:reporter && (cd src-tauri && cargo test)`
Expected: 44 passed, matching the baseline.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/scheduler.rs src-tauri/src/store.rs src-tauri/src/model.rs
git commit -m "i18n: Rust strings and comments in English"
```

---

### Task 6: README and CLAUDE.md

**Files:**
- Modify: `README.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Fix the README**

Lines 74–75, 82, 104, 108 quote Russian state labels inline (`завершён`, `ошибка`, `работает`, `ждёт ввода`, `доделал`, `готов`) with English glosses in parentheses. Each becomes the single English label from the Global Constraints, and the now-redundant gloss goes. Lines 110–111 are a `> **Note:**` block announcing the UI is Russian — delete it outright.

- [ ] **Step 2: Write CLAUDE.md**

Root-level, language policy only. It must state: English for code, comments, commit messages, PR titles and bodies, issues, and new specs and plans; conversation with the user stays in the user's language; documents under `docs/superpowers/` dated before 2026-07-27 are Russian by design and are not to be translated.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: English-only README and the rule that keeps it that way"
```

---

### Task 7: The grep gate

**Files:** none — verification only.

- [ ] **Step 1: Prove the sweep is complete**

```bash
git ls-files | xargs grep -lP '[\x{0400}-\x{04FF}]' 2>/dev/null | grep -v '^docs/superpowers/' || echo "CLEAN"
```
Expected: `CLEAN`. Anything listed is a miss — fix it and amend the owning commit.

- [ ] **Step 2: Full suite, both languages**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: 190 + 44 passing.

---

### Task 8: GitHub issues

**Files:** none — `gh` only. Not part of any commit.

- [ ] **Step 1: Rewrite all 36 open issues**

For each of #24–#62: `gh issue edit N --title '…' --body '…'`. Translate, do not summarise — a checklist stays a checklist and a body's structure survives. Preserve every `#NN` cross-reference, `- [ ]` box, and code span verbatim. The `GH-аккаунт K/13` and `[epic]` prefixes become `GitHub account K/13` and `[epic]`.

- [ ] **Step 2: Verify**

```bash
gh issue list --state open --limit 200 --json number,title \
  | grep -cP '[\x{0400}-\x{04FF}]' || echo "CLEAN"
```
Expected: `CLEAN`.
