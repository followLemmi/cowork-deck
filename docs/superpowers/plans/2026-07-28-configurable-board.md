# Configurable Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board becomes a screen of its own with cards of one size that open for reading and editing, and each project declares its own workflow steps and card kinds in a `board.json` beside its cards.

**Architecture:** A new `src-tauri/src/tasks/board.rs` owns `StepId`, `KindId` and `BoardConfig`, and is the only authority on which step and kind values are legal — which is what lets `frontmatter::parse_card` stop judging values and lets `FsTaskProvider::resolve` target the first terminal step instead of the literal `done`. The configuration reaches the frontend once, flattened into the reply of `task_capabilities`, so the board, the card modal and the `⚙` editor all read one object. The session participates through the existing sidecar and hook channels: `COWORK_TASK_ID` joins the launch environment, three subcommands join `cowork_task`, and `UserPromptSubmit` and `Stop` each gain a second hook command beside the reporter.

**Tech Stack:** Rust + Tauri 2 backend (`serde`, `serde_json`, `ulid`, `chrono`, `tempfile` for tests), TypeScript frontend with Vitest + jsdom. No new dependencies.

## Global Constraints

- **English only.** Every string, comment, test name and doc is English. See `CLAUDE.md`; the only Cyrillic exceptions are the existing fixtures in `placeholders.ts`, `commands.ts`, `frontmatter.rs::slugify_keeps_cyrillic_and_strips_punctuation` and the filename assertion in `fs.rs`. Do not add new ones.
- **Baselines every task must hold.** `npx vitest run` from the repo root: 33 files, 245 tests passing before Task 1. `cd src-tauri && cargo test`: 146 tests passing. `cd src-tauri && cargo clippy --all-targets`: exactly 6 warnings (4 × `std::io::Error::other`, 2 × `too_many_arguments`). A task may raise the test counts; it may never raise the warning count.
- **`BOARD_FILE = "board.json"`** is declared once, in `tasks/board.rs`, and never spelled as a literal anywhere else outside test assertions.
- **`BoardConfig` is the only authority on validity.** No other module may hard-code a step id or a kind id. The strings `"open"` and `"done"` appear only in `default_config()` and in test fixtures — nowhere in control flow.
- **A file we cannot parse is never rewritten.** An invalid `board.json` yields the default configuration plus an error string, and the bytes on disk stay exactly as they were.
- **The guard never blocks a session on a tracker problem.** Every failure path in `cowork_task guard` exits 0.
- **Card writes go through `set_fields`, never `render_card`.** `render_card` knows nine keys; a vault card carrying `tags:` or Dataview fields would lose them. `render_card` is for creation only.
- **A card's file is never renamed.** Its identity is its `id`; a rename would break Obsidian links and make the watcher report a delete plus a create.
- **Only cards whose `project:` matches are written.** A shared root holds other projects' cards.

## File Structure

**Created**

- `src-tauri/src/tasks/board.rs` — `StepId`, `KindId`, `Step`, `Kind`, `BoardConfig`, `BoardConfigError`, `default_config`, `parse`, `load_or_create`, `save`, `copy_if_absent`, `BOARD_FILE` (Tasks 2–3).
- `src/view.ts` — `applyView`, the DOM half of the screen switch, extracted from `main.ts` so it can be tested against the real stylesheet (Task 1).
- `src/board-config.ts` — the TypeScript-side readers of `BoardConfig`: `stepLabel`, `kindLabel`, `isKnownStep`, `isTerminal`, `stepBefore`, `stepAfter`, `workingStep`, `firstTerminal` (Task 4).
- `src/card-modal.ts` — the opened card: its form, and the patch it computes (Task 7).
- `src/board-editor.ts` — the `⚙` editor for steps and kinds (Task 9).
- `tests/view-switch.test.ts` (Task 1), `tests/board-config.test.ts` (Task 4), `tests/card-modal.test.ts` (Task 7), `tests/board-drag.test.ts` (Task 8), `tests/board-editor.test.ts` (Task 9).

**Modified**

- `src/styles.css` — `#deck.tk-hidden` (Task 1); column layout and fixed-height cards (Task 6); modal, drag and editor styling (Tasks 7, 8, 9).
- `src/main.ts` — `setView` delegates to `applyView` and passes the terminals-only sidebar blocks (Task 1); `captureTask` passes the configuration (Task 4); wires the modal, the drag handlers and the editor (Tasks 7–9).
- `src-tauri/src/tasks/mod.rs` — declare `board` (Task 2).
- `src-tauri/src/tasks/model.rs` — `Task.kind: KindId`, `Task.status: StepId`, `TaskDraft.kind: KindId`; `TaskKind` and `TaskStatus` deleted (Task 4); `UnknownStep` and `UnknownKind` join `TaskError` (Task 5).
- `src-tauri/src/tasks/frontmatter.rs` — two arms of `parse_card` stop damaging; `kind_str`/`status_str` deleted; `set_step` replaces `set_status_done` (Task 4); `set_fields` becomes `pub` and `replace_body` joins it (Task 5).
- `src-tauri/src/tasks/fs.rs` — `FsTaskProvider` carries a `BoardConfig`; `resolve` targets the first terminal step; `capabilities` reports the configured ids (Task 4); `writable_card` and `update` (Task 5).
- `src-tauri/src/tasks/migrate.rs` — carry `board.json` to the destination (Task 3).
- `src-tauri/src/tasks/provider.rs` — `TaskPatch`, and `update` joins the trait (Task 5).
- `src-tauri/src/tasks_cmd.rs` — capabilities carry the configuration and its error (Task 4); `tasks_update` (Task 5); `board_config_save`, `board_step_rewrite`, `board_step_usage` (Task 9).
- `src-tauri/src/commands.rs` — `start_session` takes `task_id` and exports `COWORK_TASK_ID` (Task 10); the `build_settings_json` call gains the sidecar path (Task 11).
- `src-tauri/src/hooks.rs` — a second hook command on `UserPromptSubmit` and `Stop` (Task 11).
- `src-tauri/src/bin/cowork_task.rs` — kinds validated against the configuration (Task 4); `status` and `steps` (Task 10); `guard` (Task 11).
- `src-tauri/src/main.rs` — register `tasks_update` (Task 5) and the three `board_*` commands (Task 9).
- `src/ipc.ts` — `StepId`, `KindId`, `BoardConfig`, the reshaped `Task` and `ProviderCapabilities` (Task 4); `TaskPatch` and `updateTask` (Task 5); the `board_*` wrappers (Task 9); `taskId` on `startSession` (Task 10).
- `src/board.ts` — the configuration threaded through (Task 4); columns, fixed-height cards, the stale marker (Task 6); the card opens (Task 7); drag targets and arrows (Task 8); the `⚙` button and the configuration-error banner (Task 9).
- `src/tasks.ts` — `derivedStatus` and `boardColumns` take the configuration (Task 4); `boardColumns` over N steps and `isStale` (Task 6); `taskPrompt` gains the step line (Task 11).
- `src/forms.ts` — `taskForm` builds its kind buttons from the configuration (Task 4).
- `src/sessions.ts` — `launchFromTask` passes `taskId` and moves the card to the working step (Task 10).
- `.claude/skills/file-a-task/SKILL.md` and `README.md` — `board.json`, `cowork_task steps` and `status` (Task 11).

**Tests updated rather than created:** `tests/board.test.ts`, `tests/tasks.test.ts`, `tests/task-form.test.ts`, `tests/ipc.test.ts`, `src-tauri/tests/cowork_task.rs`, and the `frontmatter.rs` value-damage assertions.

---

## Task 1: The view switch actually switches, and the sidebar sheds what the board cannot use

**Files:**
- Create: `src/view.ts`
- Create: `tests/view-switch.test.ts`
- Modify: `src/styles.css:416`
- Modify: `src/main.ts:62-83`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface ViewElements { deck: HTMLElement; board: HTMLElement; termBtn: HTMLElement; boardBtn: HTMLElement; terminalsOnly: HTMLElement[] }` and `export function applyView(el: ViewElements, showBoard: boolean): void`.

**Why this task is first.** It is the bug the person actually sees, it depends on nothing, and it is the only task in this plan whose deliverable is visible without a configuration file existing.

**Why `applyView` is extracted.** `main.ts` does its work at module load and is imported by no test — that is why nothing covered the switch. A function taking its elements as an argument can be mounted in jsdom against the real stylesheet. `main.ts` keeps the refresh timer and the IPC; only the DOM toggling moves.

- [ ] **Step 1: Write the failing test**

Create `tests/view-switch.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { applyView, type ViewElements } from "../src/view";

function mount(): ViewElements {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  document.head.append(style);
  document.body.innerHTML =
    '<div id="app"><aside id="sidebar"><div id="ws"></div><div id="sk"></div>' +
    '<button id="new"></button><div id="list"></div></aside>' +
    '<main id="deck"></main><div id="board" class="hidden"></div></div>';
  const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  return {
    deck: pick("#deck"),
    board: pick("#board"),
    termBtn: document.createElement("button"),
    boardBtn: document.createElement("button"),
    terminalsOnly: [pick("#sk"), pick("#new"), pick("#list")],
  };
}

const shown = (el: HTMLElement) => getComputedStyle(el).display !== "none";

describe("applyView", () => {
  let el: ViewElements;
  beforeEach(() => { el = mount(); });

  it("hides the deck on the board screen, against the real stylesheet", () => {
    applyView(el, true);
    // The regression this test exists for: #deck { display: grid } is an id
    // selector and outweighs .tk-hidden, so asserting the class would pass
    // while the terminals stayed on screen.
    expect(getComputedStyle(el.deck).display).toBe("none");
    expect(shown(el.board)).toBe(true);
  });

  it("brings the deck back on the terminals screen", () => {
    applyView(el, true);
    applyView(el, false);
    expect(getComputedStyle(el.deck).display).toBe("grid");
    expect(shown(el.board)).toBe(false);
  });

  it("hides the terminals-only sidebar blocks on the board screen", () => {
    applyView(el, true);
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(false);
  });

  it("restores the terminals-only sidebar blocks", () => {
    applyView(el, true);
    applyView(el, false);
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(true);
  });

  it("marks the active button", () => {
    applyView(el, true);
    expect(el.boardBtn.classList.contains("active")).toBe(true);
    expect(el.termBtn.classList.contains("active")).toBe(false);
    applyView(el, false);
    expect(el.termBtn.classList.contains("active")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/view-switch.test.ts`
Expected: FAIL — `Failed to resolve import "../src/view"`.

- [ ] **Step 3: Create `src/view.ts`**

```ts
/** The two screens: terminals and the board. Which sidebar blocks belong to the
 *  terminals screen is the caller's business — this module only hides them. */
export interface ViewElements {
  deck: HTMLElement;
  board: HTMLElement;
  termBtn: HTMLElement;
  boardBtn: HTMLElement;
  /** Sidebar blocks that lead nowhere on the board screen: the scenario list,
   *  "+ session", and the session list. Workspaces stay — the board shows one
   *  workspace at a time and switching between them is the point. */
  terminalsOnly: HTMLElement[];
}

/** Show one screen or the other. DOM only: no IPC and no timers, so it can be
 *  tested against the real stylesheet, which is where the bug this replaces
 *  lived. */
export function applyView(el: ViewElements, showBoard: boolean): void {
  el.deck.classList.toggle("tk-hidden", showBoard);
  el.board.classList.toggle("hidden", !showBoard);
  el.termBtn.classList.toggle("active", !showBoard);
  el.boardBtn.classList.toggle("active", showBoard);
  for (const node of el.terminalsOnly) node.classList.toggle("tk-hidden", showBoard);
}
```

- [ ] **Step 4: Add the missing CSS rule**

In `src/styles.css`, replace line 416:

```css
#board.hidden, .tk-hidden { display: none; }
/* `#deck` sets `display: grid` with an id selector, which outweighs a class.
   Without this rule `tk-hidden` never hid the deck, and the board opened beside
   the terminals instead of replacing them. */
#deck.tk-hidden { display: none; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/view-switch.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Rewire `main.ts` to use it**

In `src/main.ts`, import `applyView` and replace the DOM lines of `setView` (lines 62-67) with a call, leaving the timer logic alone:

```ts
import { applyView } from "./view";

function setView(showBoard: boolean) {
  boardVisible = showBoard;
  applyView({ deck: deckEl, board: boardEl, termBtn, boardBtn,
              terminalsOnly: [skMount, newBtn, listMount] }, showBoard);
  if (showBoard) {
    void refreshBoard();
    // (timer block unchanged)
```

- [ ] **Step 7: Verify the whole suite**

Run: `npx vitest run`
Expected: 34 files, 250 tests passing.

Run: `cd src-tauri && cargo clippy --all-targets`
Expected: 6 warnings.

- [ ] **Step 8: Commit**

```bash
git add src/view.ts tests/view-switch.test.ts src/styles.css src/main.ts
git commit -m "fix: hide the deck on the board screen, and shed the sidebar blocks it cannot use"
```

---

## Task 2: `BoardConfig` — the type, its parsing, its validation

**Files:**
- Create: `src-tauri/src/tasks/board.rs`
- Modify: `src-tauri/src/tasks/mod.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:

```rust
pub struct StepId(pub String);           // as_str() -> &str
pub struct KindId(pub String);           // as_str() -> &str
pub struct Step { pub id: StepId, pub label: String, pub terminal: bool, pub working: bool }
pub struct Kind { pub id: KindId, pub label: String }
pub struct BoardConfig { pub v: u8, pub steps: Vec<Step>, pub kinds: Vec<Kind> }

pub const BOARD_FILE: &str = "board.json";
impl BoardConfig {
    pub fn default_config() -> BoardConfig;
    pub fn validate(&self) -> Result<(), BoardConfigError>;
    pub fn first_terminal(&self) -> &StepId;
    pub fn is_terminal(&self, id: &StepId) -> bool;
    pub fn working_step(&self) -> Option<&StepId>;
    pub fn has_step(&self, id: &StepId) -> bool;
    pub fn has_kind(&self, id: &KindId) -> bool;
    pub fn step_ids(&self) -> Vec<String>;
}
pub fn parse(text: &str) -> Result<BoardConfig, BoardConfigError>;
pub enum BoardConfigError { Json(String), NoSteps, EmptyStepId, WhitespaceInStepId(String),
    DuplicateStepId(String), NoTerminalStep, TwoWorkingSteps, NoKinds, EmptyKindId,
    DuplicateKindId(String) }  // implements Display
```

**This task is pure.** No filesystem, no callers. Task 3 gives it a disk; Tasks 4–5 give it users.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/tasks/board.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"v":1,
      "steps":[{"id":"todo","label":"To do"},
               {"id":"doing","label":"Doing","working":true},
               {"id":"done","label":"Done","terminal":true}],
      "kinds":[{"id":"bug","label":"Bug"}]}"#;

    #[test]
    fn parses_a_good_config_and_keeps_step_order() {
        let c = parse(GOOD).expect("valid");
        assert_eq!(c.step_ids(), vec!["todo", "doing", "done"]);
        assert_eq!(c.steps[1].label, "Doing");
    }

    #[test]
    fn flags_default_to_false_when_absent() {
        let c = parse(GOOD).unwrap();
        assert!(!c.steps[0].terminal && !c.steps[0].working);
        assert!(c.steps[2].terminal);
    }

    #[test]
    fn reports_the_terminal_and_working_steps() {
        let c = parse(GOOD).unwrap();
        assert_eq!(c.first_terminal().as_str(), "done");
        assert_eq!(c.working_step().map(StepId::as_str), Some("doing"));
        assert!(c.is_terminal(&StepId("done".into())));
        assert!(!c.is_terminal(&StepId("todo".into())));
    }

    #[test]
    fn a_config_without_a_working_step_is_valid_and_reports_none() {
        let text = r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                       "kinds":[{"id":"k","label":"K"}]}"#;
        assert_eq!(parse(text).unwrap().working_step(), None);
    }

    #[test]
    fn knows_which_steps_and_kinds_it_has() {
        let c = parse(GOOD).unwrap();
        assert!(c.has_step(&StepId("todo".into())));
        assert!(!c.has_step(&StepId("next".into())));
        assert!(c.has_kind(&KindId("bug".into())));
        assert!(!c.has_kind(&KindId("chore".into())));
    }

    #[test]
    fn the_version_defaults_to_one_when_absent() {
        let text = r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                       "kinds":[{"id":"k","label":"K"}]}"#;
        assert_eq!(parse(text).unwrap().v, 1);
    }

    #[test]
    fn the_default_config_is_valid_and_is_today_s_two_steps() {
        let c = BoardConfig::default_config();
        c.validate().expect("the default must be valid");
        assert_eq!(c.step_ids(), vec!["open", "done"]);
        assert_eq!(c.first_terminal().as_str(), "done");
        assert_eq!(c.working_step(), None);
        let kinds: Vec<&str> = c.kinds.iter().map(|k| k.id.as_str()).collect();
        assert_eq!(kinds, vec!["bug", "task", "idea"]);
    }

    // One test per rule: a single "invalid config" test would pass while
    // silently accepting the four cases it does not exercise.

    #[test]
    fn rejects_an_empty_step_list() {
        let e = parse(r#"{"steps":[],"kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::NoSteps), "{e}");
    }

    #[test]
    fn rejects_an_empty_step_id() {
        let e = parse(r#"{"steps":[{"id":"","label":"A","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::EmptyStepId), "{e}");
    }

    #[test]
    fn rejects_whitespace_in_a_step_id() {
        // It would go into YAML frontmatter unquoted and into a CLI argument.
        let e = parse(r#"{"steps":[{"id":"in progress","label":"A","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::WhitespaceInStepId(ref s) if s == "in progress"), "{e}");
    }

    #[test]
    fn rejects_duplicate_step_ids() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true},
                                   {"id":"a","label":"Again"}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::DuplicateStepId(ref s) if s == "a"), "{e}");
    }

    #[test]
    fn rejects_a_config_with_no_terminal_step() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A"}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::NoTerminalStep), "{e}");
    }

    #[test]
    fn accepts_more_than_one_terminal_step() {
        // So a `cancelled` step can join `done` later without a model change,
        // and `first_terminal` is the one ✓ writes.
        let c = parse(r#"{"steps":[{"id":"a","label":"A"},
                                   {"id":"done","label":"Done","terminal":true},
                                   {"id":"cancelled","label":"Cancelled","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap();
        assert_eq!(c.first_terminal().as_str(), "done");
        assert!(c.is_terminal(&StepId("cancelled".into())));
    }

    #[test]
    fn rejects_two_working_steps() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","working":true},
                                   {"id":"b","label":"B","working":true},
                                   {"id":"d","label":"D","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::TwoWorkingSteps), "{e}");
    }

    #[test]
    fn rejects_an_empty_kind_list() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true}],"kinds":[]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::NoKinds), "{e}");
    }

    #[test]
    fn rejects_an_empty_kind_id() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                          "kinds":[{"id":"","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::EmptyKindId), "{e}");
    }

    #[test]
    fn rejects_duplicate_kind_ids() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                          "kinds":[{"id":"k","label":"K"},{"id":"k","label":"K2"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::DuplicateKindId(ref s) if s == "k"), "{e}");
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        let e = parse("{not json").unwrap_err();
        assert!(matches!(e, BoardConfigError::Json(_)), "{e}");
    }

    #[test]
    fn round_trips_through_serde() {
        let c = parse(GOOD).unwrap();
        let back = parse(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.step_ids(), c.step_ids());
        assert_eq!(back.steps[1].working, c.steps[1].working);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Add `pub mod board;` to `src-tauri/src/tasks/mod.rs` (after `pub mod fs;`, keeping the list alphabetical is not the existing convention — append it after `pub mod watch;` is wrong too; put it first, before `pub mod fs;`, matching the file's current loose ordering).

Run: `cd src-tauri && cargo test board::`
Expected: FAIL to compile — `cannot find function parse in this scope`.

- [ ] **Step 3: Write the implementation**

At the top of `src-tauri/src/tasks/board.rs`, above the test module:

```rust
use serde::{Deserialize, Serialize};

/// The file a project's workflow lives in, beside its cards. Named once here:
/// the card scan ignores it because `fs.rs` accepts only `.md`.
pub const BOARD_FILE: &str = "board.json";

fn board_v1() -> u8 { 1 }
fn is_false(b: &bool) -> bool { !*b }

/// A step id and a kind id are both strings and both travel through the same
/// functions — `cowork_task status <id> <step>`, the drag handler, the modal's
/// two selects. Newtypes so swapping them is a compile error rather than a card
/// written into the wrong field.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StepId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct KindId(pub String);

impl StepId {
    pub fn as_str(&self) -> &str { &self.0 }
}
impl KindId {
    pub fn as_str(&self) -> &str { &self.0 }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub id: StepId,
    pub label: String,
    /// The target of ✓ and of `cowork_task done`, and "closed" for the sidebar
    /// counts. More than one is legal; the first in order is what ✓ writes.
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminal: bool,
    /// Where ▶ moves a card when it launches a session. At most one.
    #[serde(default, skip_serializing_if = "is_false")]
    pub working: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kind {
    pub id: KindId,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardConfig {
    #[serde(rename = "v", default = "board_v1")]
    pub v: u8,
    /// Order is the order of the columns.
    pub steps: Vec<Step>,
    pub kinds: Vec<Kind>,
}

#[derive(Debug)]
pub enum BoardConfigError {
    Json(String),
    NoSteps,
    EmptyStepId,
    WhitespaceInStepId(String),
    DuplicateStepId(String),
    NoTerminalStep,
    TwoWorkingSteps,
    NoKinds,
    EmptyKindId,
    DuplicateKindId(String),
}

impl std::fmt::Display for BoardConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoardConfigError::Json(e) => write!(f, "board.json is not valid JSON: {e}"),
            BoardConfigError::NoSteps => write!(f, "board.json lists no steps"),
            BoardConfigError::EmptyStepId => write!(f, "a step has an empty id"),
            BoardConfigError::WhitespaceInStepId(s) => {
                write!(f, "step id \"{s}\" contains whitespace")
            }
            BoardConfigError::DuplicateStepId(s) => write!(f, "two steps share the id \"{s}\""),
            BoardConfigError::NoTerminalStep => {
                write!(f, "no step is marked terminal, so no step means \"closed\"")
            }
            BoardConfigError::TwoWorkingSteps => {
                write!(f, "more than one step is marked working")
            }
            BoardConfigError::NoKinds => write!(f, "board.json lists no card kinds"),
            BoardConfigError::EmptyKindId => write!(f, "a kind has an empty id"),
            BoardConfigError::DuplicateKindId(s) => write!(f, "two kinds share the id \"{s}\""),
        }
    }
}

impl BoardConfig {
    /// What a project gets before anyone configures it: today's two steps and
    /// three kinds, so a board that has never been configured looks exactly as
    /// it did before this existed.
    pub fn default_config() -> BoardConfig {
        let step = |id: &str, terminal: bool| Step {
            id: StepId(id.to_string()),
            label: id.to_string(),
            terminal,
            working: false,
        };
        let kind = |id: &str| Kind { id: KindId(id.to_string()), label: id.to_string() };
        BoardConfig {
            v: 1,
            steps: vec![step("open", false), step("done", true)],
            kinds: vec![kind("bug"), kind("task"), kind("idea")],
        }
    }

    pub fn validate(&self) -> Result<(), BoardConfigError> {
        if self.steps.is_empty() {
            return Err(BoardConfigError::NoSteps);
        }
        let mut seen: Vec<&str> = Vec::new();
        for s in &self.steps {
            let id = s.id.as_str();
            if id.is_empty() {
                return Err(BoardConfigError::EmptyStepId);
            }
            if id.chars().any(char::is_whitespace) {
                return Err(BoardConfigError::WhitespaceInStepId(id.to_string()));
            }
            if seen.contains(&id) {
                return Err(BoardConfigError::DuplicateStepId(id.to_string()));
            }
            seen.push(id);
        }
        if !self.steps.iter().any(|s| s.terminal) {
            return Err(BoardConfigError::NoTerminalStep);
        }
        if self.steps.iter().filter(|s| s.working).count() > 1 {
            return Err(BoardConfigError::TwoWorkingSteps);
        }
        if self.kinds.is_empty() {
            return Err(BoardConfigError::NoKinds);
        }
        let mut seen: Vec<&str> = Vec::new();
        for k in &self.kinds {
            let id = k.id.as_str();
            if id.is_empty() {
                return Err(BoardConfigError::EmptyKindId);
            }
            if seen.contains(&id) {
                return Err(BoardConfigError::DuplicateKindId(id.to_string()));
            }
            seen.push(id);
        }
        Ok(())
    }

    /// Where ✓ and `cowork_task done` send a card. Never panics on a validated
    /// config: `validate` refuses one with no terminal step, and every
    /// `BoardConfig` in the program comes through `parse` or `default_config`.
    pub fn first_terminal(&self) -> &StepId {
        &self
            .steps
            .iter()
            .find(|s| s.terminal)
            .expect("validate guarantees a terminal step")
            .id
    }

    pub fn is_terminal(&self, id: &StepId) -> bool {
        self.steps.iter().any(|s| &s.id == id && s.terminal)
    }

    pub fn working_step(&self) -> Option<&StepId> {
        self.steps.iter().find(|s| s.working).map(|s| &s.id)
    }

    pub fn has_step(&self, id: &StepId) -> bool {
        self.steps.iter().any(|s| &s.id == id)
    }

    pub fn has_kind(&self, id: &KindId) -> bool {
        self.kinds.iter().any(|k| &k.id == id)
    }

    /// What `ProviderCapabilities.statuses` reports, in board order.
    pub fn step_ids(&self) -> Vec<String> {
        self.steps.iter().map(|s| s.id.0.clone()).collect()
    }
}

/// Read a configuration from text. Invalid JSON and an invalid configuration are
/// the same kind of answer to the caller: fall back and say why.
pub fn parse(text: &str) -> Result<BoardConfig, BoardConfigError> {
    let cfg: BoardConfig =
        serde_json::from_str(text).map_err(|e| BoardConfigError::Json(e.to_string()))?;
    cfg.validate()?;
    Ok(cfg)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test board::`
Expected: PASS, 19 tests.

Run: `cd src-tauri && cargo clippy --all-targets`
Expected: 6 warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks/board.rs src-tauri/src/tasks/mod.rs
git commit -m "feat: a board configuration that judges its own steps and kinds"
```

---

## Task 3: `board.json` on disk — read it, create it, and let it follow the cards

**Files:**
- Modify: `src-tauri/src/tasks/board.rs`
- Modify: `src-tauri/src/tasks/migrate.rs`

**Interfaces:**
- Consumes: `BoardConfig`, `parse`, `BOARD_FILE`, `default_config` (Task 2).
- Produces:

```rust
pub struct Loaded { pub config: BoardConfig, pub error: Option<String> }
pub fn load_or_create(root: &std::path::Path) -> Loaded;
pub fn save(root: &std::path::Path, cfg: &BoardConfig) -> Result<(), crate::tasks::model::TaskError>;
pub fn copy_if_absent(from: &std::path::Path, to: &std::path::Path);
```

**The name says the side effect.** `load_or_create`, not `load`: reading a configuration for a project that has none writes the default, and a function called `load` that writes a file is a trap for the next reader.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/tasks/board.rs`:

```rust
    #[test]
    fn creates_the_default_when_the_file_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load_or_create(dir.path());
        assert!(loaded.error.is_none());
        assert_eq!(loaded.config.step_ids(), vec!["open", "done"]);
        let on_disk = std::fs::read_to_string(dir.path().join(BOARD_FILE)).expect("written");
        assert_eq!(parse(&on_disk).unwrap().step_ids(), vec!["open", "done"]);
    }

    #[test]
    fn reads_an_existing_file_without_rewriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(BOARD_FILE);
        std::fs::write(&path, GOOD).unwrap();
        let before = std::fs::read(&path).unwrap();
        let loaded = load_or_create(dir.path());
        assert!(loaded.error.is_none());
        assert_eq!(loaded.config.step_ids(), vec!["todo", "doing", "done"]);
        assert_eq!(std::fs::read(&path).unwrap(), before, "an existing file is not rewritten");
    }

    #[test]
    fn a_broken_file_yields_the_default_plus_an_error_and_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(BOARD_FILE);
        std::fs::write(&path, "{ \"steps\": [ oops").unwrap();
        let before = std::fs::read(&path).unwrap();
        let loaded = load_or_create(dir.path());
        assert_eq!(loaded.config.step_ids(), vec!["open", "done"]);
        let msg = loaded.error.expect("the person has to see why");
        assert!(msg.contains("board.json"), "{msg}");
        // Overwriting would erase the typo together with what they meant to write.
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn an_invalid_but_parseable_file_is_also_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(BOARD_FILE);
        // Valid JSON, invalid configuration: no terminal step.
        std::fs::write(&path, r#"{"steps":[{"id":"a","label":"A"}],"kinds":[{"id":"k","label":"K"}]}"#).unwrap();
        let before = std::fs::read(&path).unwrap();
        let loaded = load_or_create(dir.path());
        assert_eq!(loaded.config.step_ids(), vec!["open", "done"]);
        assert!(loaded.error.unwrap().contains("terminal"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn an_unreachable_root_reports_an_error_rather_than_panicking() {
        let loaded = load_or_create(std::path::Path::new("/definitely/not/here"));
        assert_eq!(loaded.config.step_ids(), vec!["open", "done"]);
        assert!(loaded.error.is_some());
    }

    #[test]
    fn save_round_trips_through_load() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = parse(GOOD).unwrap();
        save(dir.path(), &cfg).expect("saved");
        assert_eq!(load_or_create(dir.path()).config.step_ids(), vec!["todo", "doing", "done"]);
    }

    #[test]
    fn copy_if_absent_carries_the_configuration_to_a_new_root() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        std::fs::write(from.path().join(BOARD_FILE), GOOD).unwrap();
        copy_if_absent(from.path(), to.path());
        // Without this the destination would fall back to open/done and every
        // migrated card would land in the unknown-step column.
        assert_eq!(load_or_create(to.path()).config.step_ids(), vec!["todo", "doing", "done"]);
    }

    #[test]
    fn copy_if_absent_does_not_overwrite_a_destination_that_has_one() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        std::fs::write(from.path().join(BOARD_FILE), GOOD).unwrap();
        let mine = r#"{"steps":[{"id":"mine","label":"Mine","terminal":true}],
                       "kinds":[{"id":"k","label":"K"}]}"#;
        std::fs::write(to.path().join(BOARD_FILE), mine).unwrap();
        copy_if_absent(from.path(), to.path());
        assert_eq!(load_or_create(to.path()).config.step_ids(), vec!["mine"]);
    }

    #[test]
    fn copy_if_absent_is_silent_when_the_source_has_none() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        copy_if_absent(from.path(), to.path());
        assert!(!to.path().join(BOARD_FILE).exists());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test board::`
Expected: FAIL to compile — `cannot find function load_or_create in this scope`.

- [ ] **Step 3: Write the implementation**

Append to `src-tauri/src/tasks/board.rs`, above the test module:

```rust
use crate::tasks::model::TaskError;
use std::path::Path;

/// A configuration and, when the file on disk could not be used, the reason.
/// Both together: the board must draw either way, and the person must be told.
pub struct Loaded {
    pub config: BoardConfig,
    pub error: Option<String>,
}

fn fallback(reason: String) -> Loaded {
    Loaded { config: BoardConfig::default_config(), error: Some(reason) }
}

/// Read the project's configuration, writing the default when there is none.
///
/// A file that cannot be used is never rewritten: the default is returned with
/// the reason attached, and the bytes on disk stay as they are so the person can
/// fix their own typo.
pub fn load_or_create(root: &Path) -> Loaded {
    let path = root.join(BOARD_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => match parse(&text) {
            Ok(config) => Loaded { config, error: None },
            Err(e) => fallback(format!("{}: {e}", BOARD_FILE)),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let config = BoardConfig::default_config();
            match save(root, &config) {
                Ok(()) => Loaded { config, error: None },
                Err(e) => fallback(format!("could not create {}: {e}", BOARD_FILE)),
            }
        }
        Err(e) => fallback(format!("could not read {}: {e}", BOARD_FILE)),
    }
}

pub fn save(root: &Path, cfg: &BoardConfig) -> Result<(), TaskError> {
    let text = serde_json::to_string_pretty(cfg).map_err(|e| TaskError::Io(e.to_string()))?;
    std::fs::write(root.join(BOARD_FILE), text + "\n").map_err(|e| TaskError::Io(e.to_string()))
}

/// Carry a configuration to a root that has none. Best effort by design: it runs
/// during a card migration, and a migration that moved every card must not be
/// reported as failed because a configuration copy did not land.
pub fn copy_if_absent(from: &Path, to: &Path) {
    let src = from.join(BOARD_FILE);
    let dst = to.join(BOARD_FILE);
    if dst.exists() || !src.exists() {
        return;
    }
    let _ = std::fs::copy(&src, &dst);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test board::`
Expected: PASS, 28 tests.

- [ ] **Step 5: Call `copy_if_absent` from the migration**

In `src-tauri/src/tasks/migrate.rs`, find the function that performs the move (the one that walks the cards and writes them into the destination) and call `copy_if_absent(from_root, to_root)` **before** the first card is written, so a destination created moments earlier already has the workflow the cards refer to. Add the comment:

```rust
// Before any card moves: the cards name steps that only the source's
// configuration defines, so a destination without it would show every one of
// them in the unknown-step column.
crate::tasks::board::copy_if_absent(from_root, to_root);
```

- [ ] **Step 6: Write the migration test**

Add to the `tests` module in `src-tauri/src/tasks/migrate.rs`, following the fixture style already used there for building a source and destination root:

```rust
    #[test]
    fn migrating_carries_the_board_configuration_to_the_destination() {
        // Build a source root with one card and a three-step configuration, and
        // an empty destination, using this module's existing fixture helpers.
        // After the move the destination knows the steps the card refers to.
        let (from, to) = two_roots_with_one_card();
        std::fs::write(
            from.join(crate::tasks::board::BOARD_FILE),
            r#"{"steps":[{"id":"todo","label":"To do"},{"id":"done","label":"Done","terminal":true}],
                "kinds":[{"id":"task","label":"Task"}]}"#,
        )
        .unwrap();
        run_migration(&from, &to);
        assert_eq!(
            crate::tasks::board::load_or_create(&to).config.step_ids(),
            vec!["todo", "done"]
        );
    }
```

Adapt `two_roots_with_one_card()` and `run_migration(&from, &to)` to the helper and entry-point names this module already has; do not add new helpers if equivalents exist.

- [ ] **Step 7: Verify**

Run: `cd src-tauri && cargo test`
Expected: PASS, 175 tests.

Run: `cd src-tauri && cargo clippy --all-targets`
Expected: 6 warnings.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/tasks/board.rs src-tauri/src/tasks/migrate.rs
git commit -m "feat: read and create board.json, and carry it when the cards move"
```

---

## Task 4: `StepId` and `KindId` replace the two enums, and the provider carries the configuration

**Files:**
- Modify: `src-tauri/src/tasks/board.rs` (add `initial_step`)
- Modify: `src-tauri/src/tasks/model.rs` (`TaskKind` and `TaskStatus` deleted)
- Modify: `src-tauri/src/tasks/frontmatter.rs:1, 57-69, 106-124, 149-151`
- Modify: `src-tauri/src/tasks/fs.rs:1-2, 56-62, 128-133, 144-160, 168-200`
- Modify: `src-tauri/src/bin/cowork_task.rs:20-27, 100-101`
- Create: `src/board-config.ts`
- Modify: `src/ipc.ts:99-115`
- Modify: `src/tasks.ts:1-26`
- Modify: `src/forms.ts` (`taskForm` takes the configuration)
- Create: `tests/board-config.test.ts`
- Test: `src-tauri/src/tasks/{board,frontmatter,fs}.rs`, `src-tauri/tests/cowork_task.rs`, `tests/tasks.test.ts`, `tests/task-form.test.ts`, `tests/board.test.ts`

**Interfaces:**
- Consumes: `BoardConfig`, `StepId`, `KindId`, `load_or_create`, `first_terminal`, `working_step`, `step_ids` (Tasks 2–3).
- Produces:

```rust
impl BoardConfig { pub fn initial_step(&self) -> &StepId }
pub fn frontmatter::set_step(text: &str, step: &StepId, resolved_ts: Option<&str>) -> Option<String>
impl FsTaskProvider {
    pub fn with_board(root: PathBuf, creation: RootCreation, board: BoardConfig) -> Self
    pub fn board(&self) -> &BoardConfig
    pub fn board_error(&self) -> Option<&str>
}
```

```ts
// src/board-config.ts
export function stepLabel(cfg: BoardConfig, id: StepId): string
export function kindLabel(cfg: BoardConfig, id: KindId): string
export function isTerminal(cfg: BoardConfig, id: StepId): boolean
export function isKnownStep(cfg: BoardConfig, id: StepId): boolean
export function stepBefore(cfg: BoardConfig, id: StepId): StepId | null
export function stepAfter(cfg: BoardConfig, id: StepId): StepId | null
export function workingStep(cfg: BoardConfig): StepId | null
export function firstTerminal(cfg: BoardConfig): StepId | null
```

**Why this is one task and not two.** Deleting `TaskStatus` forces `resolve` to name its target some other way, and the only other way is `board.first_terminal()`. A version where the provider does not yet hold a configuration would have to write the literal `"done"`, which the global constraints forbid. The enum removal and the configuration arriving are the same compile.

**What changes about damage, precisely.** Exactly two arms stop damaging: `Some(_) => damage("unknown kind")` and `Some(_) => damage("unknown status")`. Every `None` arm keeps the behaviour it has today — a missing `status:` still damages the card, because a card that does not say where it is, is malformed whatever the configuration says. A missing `kind:` still does *not* damage it, which is today's leniency; it becomes an empty `KindId`, and the meta row omits the chip.

- [ ] **Step 1: Write the failing Rust tests**

Add to the `tests` module in `src-tauri/src/tasks/board.rs`:

```rust
    #[test]
    fn a_new_card_lands_in_the_first_non_terminal_step() {
        let c = parse(GOOD).unwrap();
        assert_eq!(c.initial_step().as_str(), "todo");
    }

    #[test]
    fn a_config_whose_only_step_is_terminal_puts_new_cards_there() {
        // Legal, and there is nowhere else to put them.
        let c = parse(r#"{"steps":[{"id":"d","label":"D","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap();
        assert_eq!(c.initial_step().as_str(), "d");
    }
```

Replace the two value-damage tests in `src-tauri/src/tasks/frontmatter.rs` (around lines 267-273) with their inverted form, and add the clearing test:

```rust
    #[test]
    fn an_unrecognised_status_is_carried_through_undamaged() {
        // Whether "nonsense" means anything is board.json's business now. The
        // parser's opinion would mass-damage a board the moment a step was
        // renamed, and a damaged card loses both ▶ and ✓.
        let text = "---\nid: 01K1B7QW9XZ3M4N5P6R7S8T9V0\nstatus: nonsense\n---\nbody\n";
        let card = parse_card(text, "/t/c.md").expect("a card");
        assert_eq!(card.status.as_str(), "nonsense");
        assert_eq!(card.damaged, None);
    }

    #[test]
    fn an_unrecognised_kind_is_carried_through_undamaged() {
        let text = "---\nid: 01K1\nstatus: open\ntitle: t\nproject: p\ncreated: c\nkind: chore\n---\n";
        let card = parse_card(text, "/t/c.md").expect("a card");
        assert_eq!(card.kind.as_str(), "chore");
        assert_eq!(card.damaged, None);
    }

    #[test]
    fn a_missing_status_field_still_damages_the_card() {
        // Unchanged on purpose: a card that does not say where it is, is
        // malformed whatever the configuration says.
        let text = "---\nid: 01K1\ntitle: t\nproject: p\ncreated: c\n---\nbody\n";
        let card = parse_card(text, "/t/c.md").expect("a card");
        assert_eq!(card.damaged.as_deref(), Some("no status field"));
    }

    #[test]
    fn a_missing_kind_field_does_not_damage_the_card() {
        let text = "---\nid: 01K1\ntitle: t\nproject: p\ncreated: c\nstatus: open\n---\n";
        let card = parse_card(text, "/t/c.md").expect("a card");
        assert_eq!(card.damaged, None);
        assert_eq!(card.kind.as_str(), "");
    }

    #[test]
    fn set_step_stamps_resolved_for_a_terminal_move() {
        let text = "---\nid: 01K1\nstatus: todo\ntags: [inbox]\n---\nbody\n";
        let out = set_step(text, &StepId("done".into()), Some("2026-07-28T14:00:00Z")).unwrap();
        assert!(out.contains("status: done"), "{out}");
        assert!(out.contains("resolved: 2026-07-28T14:00:00Z"), "{out}");
        assert!(out.contains("tags: [inbox]"), "unknown keys survive: {out}");
    }

    #[test]
    fn set_step_clears_resolved_when_a_card_moves_back_out_of_a_terminal_step() {
        // Otherwise a card sitting in `todo` would still show when it was
        // closed. `set_fields` cannot delete a line, and it does not need to:
        // `field()` already treats an empty value as absent.
        let text = "---\nid: 01K1\nstatus: done\nresolved: 2020-01-01T00:00:00Z\n---\nbody\n";
        let out = set_step(text, &StepId("todo".into()), None).unwrap();
        assert!(out.contains("status: todo"), "{out}");
        let card = parse_card(&out, "/t/c.md").expect("a card");
        assert_eq!(card.resolved, None);
    }
```

Add to the `tests` module in `src-tauri/src/tasks/fs.rs`:

```rust
    #[test]
    fn resolve_moves_a_card_to_the_first_terminal_step_of_the_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"todo","label":"To do"},{"id":"shipped","label":"Shipped","terminal":true}],
                "kinds":[{"id":"task","label":"Task"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::with_board(dir.path().to_path_buf(), RootCreation::Always, cfg);
        let card = p.create(TaskDraft {
            title: "T".into(), kind: KindId("task".into()), body: String::new(),
            project: "proj".into(), origin: TaskOrigin::Human, session: None,
        }).unwrap();
        assert_eq!(card.status.as_str(), "todo", "a new card lands in the first non-terminal step");
        let closed = p.resolve(&card.id).unwrap();
        assert_eq!(closed.status.as_str(), "shipped");
        assert!(closed.resolved.is_some());
    }

    #[test]
    fn capabilities_report_the_configured_steps_in_board_order() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"z","label":"Z","terminal":true}],
                "kinds":[{"id":"k","label":"K"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::with_board(dir.path().to_path_buf(), RootCreation::Always, cfg);
        assert_eq!(p.capabilities().statuses, vec!["a", "b", "z"]);
    }

    #[test]
    fn a_provider_built_without_a_configuration_reads_the_one_beside_the_cards() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(crate::tasks::board::BOARD_FILE),
            r#"{"steps":[{"id":"only","label":"Only","terminal":true}],"kinds":[{"id":"k","label":"K"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::new(dir.path().to_path_buf(), RootCreation::Always);
        assert_eq!(p.board().step_ids(), vec!["only"]);
        assert_eq!(p.board_error(), None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test`
Expected: FAIL to compile — `cannot find function set_step`, `no function or associated item named with_board`, `no method named initial_step`.

- [ ] **Step 3: Reshape the model**

In `src-tauri/src/tasks/model.rs`, delete the `TaskKind` and `TaskStatus` enums entirely and change the two structs:

```rust
use crate::tasks::board::{KindId, StepId};

// … TaskOrigin unchanged …

pub struct Task {
    pub id: String,
    pub title: String,
    /// Free-form: `BoardConfig` decides whether it means anything, and a value
    /// it does not know still has to reach the board.
    pub kind: KindId,
    pub status: StepId,
    // … every other field unchanged …
}

pub struct TaskDraft {
    pub title: String,
    pub kind: KindId,
    pub body: String,
    pub project: String,
    pub origin: TaskOrigin,
    pub session: Option<String>,
}
```

- [ ] **Step 4: Add `initial_step` to the configuration**

In `src-tauri/src/tasks/board.rs`, inside `impl BoardConfig`:

```rust
    /// Where a new card lands: the first non-terminal step, so a board that opens
    /// with `backlog` puts new cards in the backlog rather than in `done`. When
    /// every step is terminal — legal, if unusual — that is where they go,
    /// because there is nowhere else.
    pub fn initial_step(&self) -> &StepId {
        self.steps
            .iter()
            .find(|s| !s.terminal)
            .map(|s| &s.id)
            .unwrap_or_else(|| self.first_terminal())
    }
```

- [ ] **Step 5: Teach the parser to stop judging values**

In `src-tauri/src/tasks/frontmatter.rs`, change the import on line 1 to
`use crate::tasks::board::{KindId, StepId}; use crate::tasks::model::{Task, TaskOrigin};`
and replace the `kind` and `status` blocks (lines 57-69) with:

```rust
    // A missing `kind:` is legal and stays legal: the card simply does not say,
    // and the board omits the chip. An unrecognised one is carried through —
    // whether it means anything is board.json's business.
    let kind = KindId(field(head, "kind").unwrap_or("").to_string());

    let status = match field(head, "status") {
        Some(s) => StepId(s.to_string()),
        // Unchanged: a card that does not say where it is, is malformed.
        None => { damage("no status field"); StepId(String::new()) }
    };
```

Delete `kind_str` and `status_str` (lines 106-111) and use the ids directly in `render_card`:

```rust
    out.push_str(&format!("kind: {}\n", t.kind.as_str()));
    out.push_str(&format!("status: {}\n", t.status.as_str()));
```

Replace `set_status_done` (lines 149-151) with:

```rust
/// Move a card to a step, stamping `resolved:` on the way into a terminal one
/// and clearing it on the way out.
///
/// Clearing matters: a card dragged back from `done` to `todo` would otherwise
/// keep showing when it was closed. `set_fields` cannot delete a line, and does
/// not need to — `field()` treats an empty value as absent (see line 20).
///
/// Goes through `set_fields` rather than `render_card` for the reason
/// `set_status_done` did: `render_card` knows nine keys, so a vault card also
/// carrying `tags:`, `aliases:` or Dataview fields would lose them.
pub fn set_step(text: &str, step: &StepId, resolved_ts: Option<&str>) -> Option<String> {
    set_fields(text, &[("status", step.as_str()), ("resolved", resolved_ts.unwrap_or(""))])
}
```

- [ ] **Step 6: Give the provider its configuration**

In `src-tauri/src/tasks/fs.rs`, change the imports on lines 1-2 to bring in
`crate::tasks::board::{self, BoardConfig, KindId, StepId}` and
`crate::tasks::frontmatter::{parse_card, render_card, set_step, slugify}`, then:

```rust
pub struct FsTaskProvider {
    root: PathBuf,
    creation: RootCreation,
    board: BoardConfig,
    board_error: Option<String>,
}

impl FsTaskProvider {
    /// Reads the configuration beside the cards, creating the default when there
    /// is none. Once, at construction: `list` runs on every board tick and every
    /// sidebar count, and re-reading the file per call would put a filesystem
    /// round trip in front of each of them.
    pub fn new(root: PathBuf, creation: RootCreation) -> Self {
        let loaded = board::load_or_create(&root);
        Self { root, creation, board: loaded.config, board_error: loaded.error }
    }

    /// For tests and for callers that already hold a configuration. Touches no
    /// file, so a test does not need a `board.json` on disk to describe a
    /// workflow.
    pub fn with_board(root: PathBuf, creation: RootCreation, board: BoardConfig) -> Self {
        Self { root, creation, board, board_error: None }
    }

    pub fn board(&self) -> &BoardConfig { &self.board }
    pub fn board_error(&self) -> Option<&str> { self.board_error.as_deref() }

    // … ensure_root, scan, write_atomic, now_iso unchanged …
}
```

In `capabilities`, replace the hard-coded list:

```rust
            statuses: self.board.step_ids(),
```

In `create`, replace `status: TaskStatus::Open` with:

```rust
            status: self.board.initial_step().clone(),
```

In `resolve`, replace the `set_status_done` call and the two lines after the write:

```rust
                let step = self.board.first_terminal().clone();
                let resolved = Self::now_iso();
                let text = std::fs::read_to_string(&path).map_err(|e| TaskError::Io(e.to_string()))?;
                let updated = set_step(&text, &step, Some(&resolved)).ok_or_else(|| {
                    TaskError::Io("the card has no frontmatter block".to_string())
                })?;
                self.write_atomic(&path, &updated)?;

                let mut card = card.clone();
                card.status = step;
                card.resolved = Some(resolved);
                card.conflict = false;
                Ok(card)
```

- [ ] **Step 7: Update the CLI's kind parsing**

In `src-tauri/src/bin/cowork_task.rs`, delete `kind_from_str` (lines 20-27) and validate against the configuration instead. Replace the `Cmd::New` arm's kind resolution:

```rust
            let kind = KindId(kind);
            if !provider.board().has_kind(&kind) {
                return Err(format!(
                    "unknown --kind: {} (configured: {})",
                    kind.as_str(),
                    provider.board().kinds.iter().map(|k| k.id.as_str()).collect::<Vec<_>>().join(", ")
                ));
            }
```

Move the `provider` construction above the `match cmd` so both arms can use it — it is already constructed before the match, so only the kind check moves inside.

Update `USAGE` to stop naming the three kinds:

```rust
  cowork_task new --kind <kind> --title \"…\"   (the body is read from stdin)
  cowork_task done <id>
```

Update `src-tauri/tests/cowork_task.rs`: the `kind_from_str` tests go; replace them with one asserting that `new --kind chore` fails against the default configuration and succeeds against one that lists `chore`.

- [ ] **Step 8: Send the configuration to the frontend**

The frontend needs more than `statuses`: labels, both flags, and the kinds. So the
command composes rather than widening the provider trait — a trait carrying an
`fs`-shaped configuration would be a poor fit for the GitHub and Jira providers
that field is otherwise general enough for.

In `src-tauri/src/tasks_cmd.rs`, beside the existing `task_capabilities`:

```rust
/// Capabilities plus the board configuration, flattened into one object: the
/// board, the card modal and the ⚙ editor all read the same thing, so there is
/// no second channel to fall out of step with the first.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCapabilities {
    #[serde(flatten)]
    pub caps: ProviderCapabilities,
    pub board: BoardConfig,
    /// Why `board.json` could not be used, when it could not. The board draws
    /// either way; the person has to be told which they are looking at.
    pub board_error: Option<String>,
}
```

and change `task_capabilities` to return `Option<BoardCapabilities>`, building it
from the provider it already constructs:

```rust
    Some(BoardCapabilities {
        caps: provider.capabilities(),
        board: provider.board().clone(),
        board_error: provider.board_error().map(str::to_string),
    })
```

Keep the existing `None`-for-unconfigured behaviour exactly as it is: `caps === null`
is a legal state the board already handles (`board.ts:29`).

Add a test asserting that a workspace whose root holds a broken `board.json`
reports the default steps together with a non-empty `boardError`.

- [ ] **Step 9: Mirror the types in TypeScript**

Replace `src/ipc.ts:99-115`:

```ts
export type StepId = string;
export type KindId = string;

export interface BoardStep { id: StepId; label: string; terminal?: boolean; working?: boolean }
export interface BoardKind { id: KindId; label: string }
export interface BoardConfig { v: number; steps: BoardStep[]; kinds: BoardKind[] }

export interface Task {
  // … unchanged fields …
  kind: KindId;
  status: StepId;
}
export interface TaskDraft { title: string; kind: KindId; body: string }
export interface ProviderCapabilities {
  canCreate: boolean;
  canResolve: boolean;
  statuses: StepId[];
  board: BoardConfig;
  boardError: string | null;
}
```

Keep the rest of the `Task` interface exactly as it is; only `kind` and `status` change type.

- [ ] **Step 10: Write the failing tests for the configuration readers**

Create `tests/board-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  firstTerminal, isKnownStep, isTerminal, kindLabel, stepAfter, stepBefore, stepLabel, workingStep,
} from "../src/board-config";
import type { BoardConfig } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

describe("board-config readers", () => {
  it("labels a step, falling back to its id when the configuration does not know it", () => {
    expect(stepLabel(CFG, "todo")).toBe("To do");
    // A card can name a step nothing defines, and it still has to be readable.
    expect(stepLabel(CFG, "legacy")).toBe("legacy");
  });

  it("labels a kind, and returns empty for a card that names none", () => {
    expect(kindLabel(CFG, "bug")).toBe("Bug");
    expect(kindLabel(CFG, "chore")).toBe("chore");
    expect(kindLabel(CFG, "")).toBe("");
  });

  it("knows its own steps", () => {
    expect(isKnownStep(CFG, "doing")).toBe(true);
    expect(isKnownStep(CFG, "legacy")).toBe(false);
  });

  it("reports the terminal and working steps", () => {
    expect(isTerminal(CFG, "done")).toBe(true);
    expect(isTerminal(CFG, "todo")).toBe(false);
    expect(firstTerminal(CFG)).toBe("done");
    expect(workingStep(CFG)).toBe("doing");
    expect(workingStep({ ...CFG, steps: CFG.steps.map((s) => ({ ...s, working: false })) })).toBeNull();
  });

  it("walks neighbours and stops at the ends", () => {
    expect(stepBefore(CFG, "todo")).toBe("backlog");
    expect(stepAfter(CFG, "todo")).toBe("doing");
    expect(stepBefore(CFG, "backlog")).toBeNull();
    expect(stepAfter(CFG, "done")).toBeNull();
  });

  it("gives an unknown step no neighbours at all", () => {
    // Which is why a card in the unknown-step column gets no ‹ › arrows.
    expect(stepBefore(CFG, "legacy")).toBeNull();
    expect(stepAfter(CFG, "legacy")).toBeNull();
  });

  it("returns the first terminal step when there are several", () => {
    const two = { ...CFG, steps: [...CFG.steps, { id: "cancelled", label: "Cancelled", terminal: true }] };
    expect(firstTerminal(two)).toBe("done");
    expect(isTerminal(two, "cancelled")).toBe(true);
  });
});
```

Run: `npx vitest run tests/board-config.test.ts`
Expected: FAIL — cannot resolve `../src/board-config`.

- [ ] **Step 11: Create `src/board-config.ts`**

```ts
import type { BoardConfig, KindId, StepId } from "./ipc";

/** The label for a step, falling back to its id: a card can name a step the
 *  configuration does not know, and it still has to be readable. */
export function stepLabel(cfg: BoardConfig, id: StepId): string {
  return cfg.steps.find((s) => s.id === id)?.label ?? id;
}

/** Empty for a card that does not say — a missing `kind:` is legal, and the
 *  meta row omits the chip rather than inventing one. */
export function kindLabel(cfg: BoardConfig, id: KindId): string {
  if (!id) return "";
  return cfg.kinds.find((k) => k.id === id)?.label ?? id;
}

export function isKnownStep(cfg: BoardConfig, id: StepId): boolean {
  return cfg.steps.some((s) => s.id === id);
}

export function isTerminal(cfg: BoardConfig, id: StepId): boolean {
  return cfg.steps.some((s) => s.id === id && s.terminal === true);
}

/** `null` for the first step and for a step the configuration does not know —
 *  an unknown step has no neighbours, so the card gets no arrows. */
export function stepBefore(cfg: BoardConfig, id: StepId): StepId | null {
  const i = cfg.steps.findIndex((s) => s.id === id);
  return i > 0 ? cfg.steps[i - 1].id : null;
}

export function stepAfter(cfg: BoardConfig, id: StepId): StepId | null {
  const i = cfg.steps.findIndex((s) => s.id === id);
  return i >= 0 && i < cfg.steps.length - 1 ? cfg.steps[i + 1].id : null;
}

export function workingStep(cfg: BoardConfig): StepId | null {
  return cfg.steps.find((s) => s.working === true)?.id ?? null;
}

export function firstTerminal(cfg: BoardConfig): StepId | null {
  return cfg.steps.find((s) => s.terminal === true)?.id ?? null;
}
```

- [ ] **Step 12: Adapt `tasks.ts` minimally**

In `src/tasks.ts`, delete the `KIND_LABEL` record and the local `kindLabel`, re-export the one from `board-config`, and make `derivedStatus` and `boardColumns` take the configuration. Keep them two-column for now — Task 6 replaces `boardColumns` with N columns, and doing both here would put a layout change inside a type change:

```ts
import type { BoardConfig, SessionState, StepId, Task } from "./ipc";
import { isTerminal } from "./board-config";

export function derivedStatus(
  task: Task, links: TaskSessionLink[], cfg: BoardConfig,
): "open" | "done" | "working" {
  if (isTerminal(cfg, task.status)) return "done";
  const busy = links.some((l) => l.taskId === task.id && BUSY.includes(l.state));
  return busy ? "working" : "open";
}

export function boardColumns(
  tasks: Task[], project: string, cfg: BoardConfig, doneLimit = 20,
): BoardColumns {
  // … the `mine` / `foreignCount` split is unchanged …
  const open = mine.filter((t) => !isTerminal(cfg, t.status))
    .sort((a, b) => byTimeDesc(a.created, b.created));
  const doneAll = mine.filter((t) => isTerminal(cfg, t.status))
    .sort((a, b) => byTimeDesc(a.resolved ?? "", b.resolved ?? ""));
  // … the return is unchanged …
}
```

`taskPrompt` keeps working: it reads `kindLabel(task.kind)` — change that call to `kindLabel(cfg, task.kind)` and give `taskPrompt` a `cfg` parameter, updating its caller in `main.ts:168`.

- [ ] **Step 13: Adapt `forms.ts` and `board.ts` to the new signatures**

`taskForm()` currently offers three hard-coded kind buttons. Change its signature to `taskForm(cfg: BoardConfig): Promise<TaskDraft | null>` and build one `.tk-f-kind` button per `cfg.kinds` entry, selecting the first by default. Update `captureTask` in `main.ts:145` to pass the configuration it already fetched via `taskCapabilities`.

`board.ts` needs `state.caps.board` threaded into its `derivedStatus`, `kindLabel` and `boardColumns` calls. No behaviour changes here — Task 6 rewrites the rendering.

Update `tests/tasks.test.ts`, `tests/task-form.test.ts` and `tests/board.test.ts` to pass a configuration. Add a shared fixture at the top of each rather than inlining it per test:

```ts
const CFG: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
  kinds: [{ id: "bug", label: "bug" }, { id: "task", label: "task" }, { id: "idea", label: "idea" }],
};
```

- [ ] **Step 14: Verify**

This task rewrites existing tests as well as adding them, so an absolute total is
not the gate. The gate is: everything passes, the warning count has not moved, and
the only tests that disappeared are the ones this task deliberately rewrote.

Run: `cd src-tauri && cargo test`
Expected: all passing. Compared with the previous task, the suite gains the two
`initial_step` tests, four `parse_card` tests, three `fs` tests, and one
`cowork_task` kind test; it loses the two `frontmatter` value-damage assertions
(rewritten, listed in the brief) and the `kind_from_str` tests (that function is
deleted). Report the before and after numbers and account for the difference.

Run: `cd src-tauri && cargo clippy --all-targets`
Expected: exactly 6 warnings.

Run: `npx vitest run`
Expected: all passing, one new file (`tests/board-config.test.ts`, 7 tests).
Existing tests are adapted to the new signatures, not deleted — if a count drops,
say which test went and why.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
git add src-tauri/src src/board-config.ts src/ipc.ts src/tasks.ts src/forms.ts src/board.ts src/main.ts tests
git commit -m "refactor: step and kind ids instead of two enums, decided by the board configuration"
```

---

## Task 5: `tasks_update` — editing a card without clobbering it

**Files:**
- Modify: `src-tauri/src/tasks/provider.rs`
- Modify: `src-tauri/src/tasks/fs.rs`
- Modify: `src-tauri/src/tasks_cmd.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/ipc.ts`
- Test: `src-tauri/src/tasks/fs.rs`, `tests/ipc.test.ts`

**Interfaces:**
- Consumes: `FsTaskProvider`, `BoardConfig`, `set_step`, `set_fields` (Task 4).
- Produces:

```rust
pub struct TaskPatch {
    pub title: Option<String>,
    pub kind: Option<KindId>,
    pub status: Option<StepId>,
    pub body: Option<String>,
}
// on the TaskProvider trait:
fn update(&self, id: &str, patch: TaskPatch) -> Result<Task, TaskError>;
// command — `tasks_`, plural, like every sibling in tasks_cmd.rs:
#[tauri::command] pub fn tasks_update(state: State<AppState>, workspace_id: String, id: String, patch: TaskPatch) -> Result<Task, String>
```

```ts
export interface TaskPatch { title?: string; kind?: KindId; status?: StepId; body?: string }
export const updateTask = (workspaceId: string, id: string, patch: TaskPatch) => Promise<Task>
```

**One command for four callers.** The modal's Save, a drop, `‹`/`›`, and `cowork_task status` are all "write these fields of this card". A step-only move is a patch carrying only `status`, so no second command is needed.

**Why every field is optional.** Save applies only what the person touched. Between opening the modal and pressing Save the file may have changed — an agent moved the step, a sync brought another machine's version — and a patch that carried all four fields would silently undo that.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `src-tauri/src/tasks/fs.rs`:

```rust
    fn three_step_provider(dir: &std::path::Path) -> FsTaskProvider {
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"todo","label":"To do"},{"id":"doing","label":"Doing","working":true},
                         {"id":"done","label":"Done","terminal":true}],
                "kinds":[{"id":"bug","label":"Bug"},{"id":"task","label":"Task"}]}"#,
        ).unwrap();
        FsTaskProvider::with_board(dir.to_path_buf(), RootCreation::Always, cfg)
    }

    fn a_card(p: &FsTaskProvider) -> Task {
        p.create(TaskDraft {
            title: "Original".into(), kind: KindId("task".into()), body: "Body.\n".into(),
            project: "proj".into(), origin: TaskOrigin::Human, session: None,
        }).unwrap()
    }

    #[test]
    fn update_writes_only_the_fields_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let after = p.update(&card.id, TaskPatch {
            title: Some("Renamed".into()), kind: None, status: None, body: None,
        }).unwrap();
        assert_eq!(after.title, "Renamed");
        assert_eq!(after.kind.as_str(), "task", "an untouched field is untouched");
        assert_eq!(after.status.as_str(), "todo");
        assert_eq!(after.body, "Body.\n");
    }

    #[test]
    fn update_never_renames_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let before = card.path.clone();
        let after = p.update(&card.id, TaskPatch {
            title: Some("A completely different title".into()),
            kind: None, status: None, body: None,
        }).unwrap();
        // The id is the identity. A rename would break Obsidian links and make
        // the watcher report a delete plus a create instead of an edit.
        assert_eq!(after.path, before);
        assert!(std::path::Path::new(&before).exists());
    }

    #[test]
    fn update_preserves_frontmatter_keys_it_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let path = std::path::PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("---\nid:", "---\ntags: [inbox]\nid:")).unwrap();
        p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("doing".into())), body: None }).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("tags: [inbox]"), "{after}");
    }

    #[test]
    fn a_step_only_patch_moves_the_card_and_stamps_or_clears_resolved() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let closed = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("done".into())), body: None }).unwrap();
        assert!(closed.resolved.is_some(), "a terminal step stamps when");
        let back = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("todo".into())), body: None }).unwrap();
        assert_eq!(back.resolved, None, "moving back out clears it");
    }

    #[test]
    fn update_rewrites_the_body_only_when_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let after = p.update(&card.id, TaskPatch { title: None, kind: None, status: None,
            body: Some("Replaced.\n".into()) }).unwrap();
        assert_eq!(after.body, "Replaced.\n");
        let on_disk = std::fs::read_to_string(&card.path).unwrap();
        assert!(on_disk.contains("Replaced.\n"), "{on_disk}");
        assert!(!on_disk.contains("Body.\n"));
    }

    #[test]
    fn update_refuses_a_damaged_card() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        // A card with an `id` and nothing else may be an ordinary vault note.
        std::fs::write(dir.path().join("note.md"), "---\nid: 01ABC\n---\nA note.\n").unwrap();
        let e = p.update("01ABC", TaskPatch { title: Some("Mine now".into()),
            kind: None, status: None, body: None }).unwrap_err();
        assert!(matches!(e, TaskError::Damaged(_)), "{e}");
    }

    #[test]
    fn update_refuses_a_conflicting_id() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let text = std::fs::read_to_string(&card.path).unwrap();
        std::fs::write(dir.path().join("copy.md"), text).unwrap();
        let e = p.update(&card.id, TaskPatch { title: Some("X".into()),
            kind: None, status: None, body: None }).unwrap_err();
        assert!(matches!(e, TaskError::Conflict(_)), "{e}");
    }

    #[test]
    fn update_refuses_a_step_the_configuration_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let e = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("invented".into())), body: None }).unwrap_err();
        assert!(matches!(e, TaskError::UnknownStep(ref s) if s == "invented"), "{e}");
    }

    #[test]
    fn update_refuses_a_kind_the_configuration_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let e = p.update(&card.id, TaskPatch { title: None, kind: Some(KindId("chore".into())),
            status: None, body: None }).unwrap_err();
        assert!(matches!(e, TaskError::UnknownKind(ref s) if s == "chore"), "{e}");
    }

    #[test]
    fn update_accepts_a_card_currently_sitting_in_an_unknown_step() {
        // The whole point of the unknown-step column: the card is alive, and the
        // modal is how it gets out.
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let path = std::path::PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("status: todo", "status: legacy")).unwrap();
        let after = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("todo".into())), body: None }).unwrap();
        assert_eq!(after.status.as_str(), "todo");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test fs::`
Expected: FAIL to compile — `cannot find struct TaskPatch`, `no method named update`, `no variant UnknownStep`.

- [ ] **Step 3: Add the two error variants**

In `src-tauri/src/tasks/model.rs`, add to `TaskError` and to its `Display`:

```rust
    /// The caller named a step or kind `board.json` does not define. Refused
    /// rather than written: a card carrying a value nothing defines lands in the
    /// unknown-step column, and we would have put it there ourselves.
    UnknownStep(String),
    UnknownKind(String),
```

```rust
            TaskError::UnknownStep(s) => write!(f, "no step named {s} in board.json"),
            TaskError::UnknownKind(s) => write!(f, "no kind named {s} in board.json"),
```

- [ ] **Step 4: Add `TaskPatch` and the trait method**

In `src-tauri/src/tasks/provider.rs`:

```rust
use crate::tasks::board::{KindId, StepId};

/// Which fields of a card to write. Every one optional because Save applies only
/// what the person touched: between opening the modal and pressing it, an agent
/// may have moved the step or a sync may have brought another machine's version,
/// and a patch carrying all four fields would silently undo that.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub kind: Option<KindId>,
    pub status: Option<StepId>,
    pub body: Option<String>,
}

pub trait TaskProvider {
    fn capabilities(&self) -> ProviderCapabilities;
    fn list(&self, project: &str) -> Result<Vec<Task>, TaskError>;
    fn create(&self, draft: TaskDraft) -> Result<Task, TaskError>;
    fn resolve(&self, id: &str) -> Result<Task, TaskError>;
    fn update(&self, id: &str, patch: TaskPatch) -> Result<Task, TaskError>;
}
```

- [ ] **Step 5: Implement `update`**

In `src-tauri/src/tasks/fs.rs`, factor the card lookup `resolve` already does into a helper, then add `update`:

```rust
impl FsTaskProvider {
    /// The one card with this id, refusing the two states we will not write
    /// into. Shared by `resolve` and `update` so the refusals cannot drift apart.
    fn writable_card(&self, id: &str) -> Result<Task, TaskError> {
        let cards = self.scan()?;
        let matches: Vec<&Task> = cards.iter().filter(|c| c.id == id).collect();
        match matches.len() {
            0 => Err(TaskError::NotFound(id.to_string())),
            n if n > 1 => Err(TaskError::Conflict(id.to_string())),
            _ => {
                let card = matches[0];
                // May well be an unrelated Obsidian note that merely has an
                // `id:` field. Refuse before touching the filesystem.
                if card.damaged.is_some() {
                    return Err(TaskError::Damaged(card.path.clone()));
                }
                Ok(card.clone())
            }
        }
    }
}
```

Rewrite `resolve` in terms of it, then:

```rust
    fn update(&self, id: &str, patch: TaskPatch) -> Result<Task, TaskError> {
        if let Some(k) = &patch.kind {
            if !self.board.has_kind(k) {
                return Err(TaskError::UnknownKind(k.0.clone()));
            }
        }
        if let Some(s) = &patch.status {
            if !self.board.has_step(s) {
                return Err(TaskError::UnknownStep(s.0.clone()));
            }
        }
        let mut card = self.writable_card(id)?;
        let path = PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).map_err(|e| TaskError::Io(e.to_string()))?;

        // Frontmatter first, one `set_fields` pass, so a card carrying keys we do
        // not know keeps them.
        let mut fields: Vec<(&str, String)> = Vec::new();
        let flat = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(t) = &patch.title {
            fields.push(("title", flat(t)));
            card.title = t.clone();
        }
        if let Some(k) = &patch.kind {
            fields.push(("kind", k.0.clone()));
            card.kind = k.clone();
        }
        if let Some(s) = &patch.status {
            let resolved = if self.board.is_terminal(s) { Some(Self::now_iso()) } else { None };
            fields.push(("status", s.0.clone()));
            // Empty clears it: `field()` treats an empty value as absent, and
            // `set_fields` cannot delete a line.
            fields.push(("resolved", resolved.clone().unwrap_or_default()));
            card.status = s.clone();
            card.resolved = resolved;
        }

        let mut updated = text;
        if !fields.is_empty() {
            let refs: Vec<(&str, &str)> =
                fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
            updated = crate::tasks::frontmatter::set_fields(&updated, &refs)
                .ok_or_else(|| TaskError::Io("the card has no frontmatter block".to_string()))?;
        }
        if let Some(b) = &patch.body {
            updated = crate::tasks::frontmatter::replace_body(&updated, b)
                .ok_or_else(|| TaskError::Io("the card has no frontmatter block".to_string()))?;
            card.body = b.clone();
        }
        self.write_atomic(&path, &updated)?;
        card.conflict = false;
        Ok(card)
    }
```

- [ ] **Step 6: Expose the two frontmatter helpers `update` needs**

In `src-tauri/src/tasks/frontmatter.rs`, make `set_fields` reachable and add a body replacement. `set_fields` becomes `pub` in place, with the caller's obligation written into its existing doc comment — a wrapper that only forwards would be one more name for the same function:

```rust
/// Set each `key: value` in an existing frontmatter block, replacing the line
/// where the key is already present and appending it where it is not.
///
/// … (the existing doc comment stays; add:)
///
/// Values must already be single-line: a newline in one would end the
/// frontmatter block early. `render_card` flattens with `split_whitespace` and
/// callers outside this module must do the same.
pub fn set_fields(text: &str, fields: &[(&str, &str)]) -> Option<String> {
```

and add a body replacement beside it:

```rust
/// Replace the body, leaving the frontmatter block byte-for-byte. Returns `None`
/// when there is no frontmatter block.
pub fn replace_body(text: &str, body: &str) -> Option<String> {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (head, _) = split_frontmatter(text)?;
    let mut out = String::from("---");
    out.push_str(nl);
    for line in head.lines() {
        out.push_str(line);
        out.push_str(nl);
    }
    out.push_str("---");
    out.push_str(nl);
    if !body.is_empty() {
        if !body.starts_with('\n') { out.push_str(nl); }
        out.push_str(body);
        if !body.ends_with('\n') { out.push_str(nl); }
    }
    Some(out)
}
```

Add a test that `replace_body` leaves an unknown frontmatter key alone and that a CRLF document stays CRLF.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: all passing, with the ten `update` tests and the two `replace_body`
tests added and nothing removed.

- [ ] **Step 8: Add the command and its IPC wrapper**

In `src-tauri/src/tasks_cmd.rs`, beside `task_resolve`, following the same workspace lookup and provider construction it uses:

```rust
#[tauri::command]
pub fn tasks_update(
    state: State<AppState>,
    workspace_id: String,
    id: String,
    patch: TaskPatch,
) -> Result<Task, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    p.update(&id, patch).map_err(|e| e.to_string())
}
```

That is `tasks_resolve`'s shape exactly — the module's two helpers are
`workspace(&state, id)` and `provider_for(&ws)`, in that order. There is no
single-call `provider_for(&state, &workspace_id)`; do not add one.

Register it in `src-tauri/src/main.rs` beside the other `tasks_*` commands.

In `src/ipc.ts`, in the arrow-const style of its neighbours (`resolveTask`,
`createTask`) rather than as an `async function`:

```ts
export interface TaskPatch { title?: string; kind?: KindId; status?: StepId; body?: string }

export const updateTask = (workspaceId: string, id: string, patch: TaskPatch) =>
  invoke<Task>("tasks_update", { workspaceId, id, patch });
```

Add a test to `tests/ipc.test.ts` in the style of its neighbours, asserting the invoke name and argument shape.

- [ ] **Step 9: Verify**

Run: `cd src-tauri && cargo test` — all passing, nothing removed.
Run: `cd src-tauri && cargo clippy --all-targets` — exactly 6 warnings.
Run: `npx vitest run` — all passing, with the new `updateTask` case in `tests/ipc.test.ts`.
Run: `npx tsc --noEmit` — no errors.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src src/ipc.ts tests/ipc.test.ts
git commit -m "feat(update): write only the fields a caller names, and refuse the cards we do not own"
```

---

## Task 6: Columns from the configuration, and cards of one size

**Files:**
- Modify: `src/tasks.ts` (`boardColumns` and `BoardColumns`)
- Modify: `src/board.ts` (`BoardView.render`, `column`, `card`)
- Modify: `src/styles.css:429-447`
- Test: `tests/tasks.test.ts`, `tests/board.test.ts`

**Interfaces:**
- Consumes: `BoardConfig`, `isTerminal`, `isKnownStep`, `stepLabel`, `kindLabel`, `workingStep` (Task 4).
- Produces:

```ts
export interface BoardColumn { step: BoardStep; tasks: Task[]; hidden: number }
export interface BoardColumns {
  columns: BoardColumn[];
  unknown: Task[];
  foreign: { project: string; count: number }[];
}
export function boardColumns(tasks: Task[], project: string, cfg: BoardConfig, doneLimit?: number): BoardColumns
export function isStale(task: Task, links: TaskSessionLink[], cfg: BoardConfig): boolean
```

- [ ] **Step 1: Write the failing tests**

Replace the `boardColumns` describe block in `tests/tasks.test.ts` with:

```ts
const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

const card = (over: Partial<Task>): Task => ({
  id: "1", title: "T", kind: "task", status: "todo", project: "p",
  created: "2026-07-01T00:00:00Z", resolved: null, origin: "human", session: null,
  body: "", path: "/t/1.md", damaged: null, conflict: false, ...over,
});

describe("boardColumns", () => {
  it("returns one column per configured step, in configuration order", () => {
    const cols = boardColumns([], "p", CFG);
    expect(cols.columns.map((c) => c.step.id)).toEqual(["backlog", "todo", "doing", "done"]);
  });

  it("places each card in the column its status names", () => {
    const cols = boardColumns(
      [card({ id: "a", status: "backlog" }), card({ id: "b", status: "doing" })], "p", CFG);
    const at = (id: string) => cols.columns.find((c) => c.step.id === id)!.tasks.map((t) => t.id);
    expect(at("backlog")).toEqual(["a"]);
    expect(at("doing")).toEqual(["b"]);
    expect(at("todo")).toEqual([]);
  });

  it("collects a card whose step the configuration does not know", () => {
    const cols = boardColumns([card({ id: "x", status: "legacy" })], "p", CFG);
    expect(cols.unknown.map((t) => t.id)).toEqual(["x"]);
    // Not silently dropped into some column: it would look like it moved.
    expect(cols.columns.every((c) => c.tasks.length === 0)).toBe(true);
  });

  it("caps a terminal column and counts what it hid", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      card({ id: `d${i}`, status: "done", resolved: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const done = boardColumns(many, "p", CFG, 20).columns.find((c) => c.step.id === "done")!;
    expect(done.tasks).toHaveLength(20);
    expect(done.hidden).toBe(5);
  });

  it("never caps a non-terminal column", () => {
    const many = Array.from({ length: 25 }, (_, i) => card({ id: `t${i}`, status: "todo" }));
    const todo = boardColumns(many, "p", CFG, 20).columns.find((c) => c.step.id === "todo")!;
    // A card in `todo` hidden behind a limit is a lost task.
    expect(todo.tasks).toHaveLength(25);
    expect(todo.hidden).toBe(0);
  });

  it("sorts a terminal column by resolved and the others by created, newest first", () => {
    const cols = boardColumns([
      card({ id: "old", status: "todo", created: "2026-01-01T00:00:00Z" }),
      card({ id: "new", status: "todo", created: "2026-07-01T00:00:00Z" }),
      card({ id: "r1", status: "done", resolved: "2026-01-01T00:00:00Z" }),
      card({ id: "r2", status: "done", resolved: "2026-07-01T00:00:00Z" }),
    ], "p", CFG);
    const at = (id: string) => cols.columns.find((c) => c.step.id === id)!.tasks.map((t) => t.id);
    expect(at("todo")).toEqual(["new", "old"]);
    expect(at("done")).toEqual(["r2", "r1"]);
  });

  it("counts other projects' cards instead of showing them", () => {
    const cols = boardColumns([card({ id: "f", project: "other" })], "p", CFG);
    expect(cols.foreign).toEqual([{ project: "other", count: 1 }]);
    expect(cols.columns.every((c) => c.tasks.length === 0)).toBe(true);
  });

  it("keeps a damaged card whatever its project says", () => {
    // It may be damaged *because* the project field is missing.
    const cols = boardColumns(
      [card({ id: "d", project: "", status: "todo", damaged: "no project field" })], "p", CFG);
    expect(cols.columns.find((c) => c.step.id === "todo")!.tasks.map((t) => t.id)).toEqual(["d"]);
  });
});

describe("isStale", () => {
  it("is true for a card in the working step with no live session", () => {
    expect(isStale(card({ id: "a", status: "doing" }), [], CFG)).toBe(true);
  });
  it("is false while a session is alive on it", () => {
    expect(isStale(card({ id: "a", status: "doing" }),
      [{ session: "s", taskId: "a", state: "working" }], CFG)).toBe(false);
  });
  it("is false for a card outside the working step", () => {
    expect(isStale(card({ id: "a", status: "todo" }), [], CFG)).toBe(false);
  });
  it("is false when no step is marked working", () => {
    const cfg = { ...CFG, steps: CFG.steps.map((s) => ({ ...s, working: false })) };
    expect(isStale(card({ id: "a", status: "doing" }), [], cfg)).toBe(false);
  });
});
```

Add to `tests/board.test.ts`:

```ts
  it("renders one column per step plus the unknown column only when it has cards", () => {
    view.render({ project: "p", caps: capsWith(CFG), error: null,
                  tasks: [card({ status: "todo" })], links: [] });
    expect(view.mount.querySelectorAll(".tk-col")).toHaveLength(4);
    expect(view.mount.querySelector(".tk-col-unknown")).toBeNull();

    view.render({ project: "p", caps: capsWith(CFG), error: null,
                  tasks: [card({ status: "legacy" })], links: [] });
    expect(view.mount.querySelectorAll(".tk-col")).toHaveLength(5);
    expect(view.mount.querySelector(".tk-col-unknown")).not.toBeNull();
  });

  it("gives every card a meta row and an action row whatever its content", () => {
    // This is what makes the fixed height hold: the rows are always there, so
    // they sit at the same offset in a short card and a long one.
    view.render({ project: "p", caps: capsWith(CFG), error: null, tasks: [
      card({ id: "short", title: "T", status: "todo" }),
      card({ id: "long", title: "A ".repeat(60), status: "todo", damaged: "no created field" }),
    ], links: [] });
    for (const el of view.mount.querySelectorAll(".tk-card")) {
      expect(el.querySelector(".tk-meta")).not.toBeNull();
      expect(el.querySelector(".tk-acts")).not.toBeNull();
    }
  });

  it("shows damage as a glyph on the card, not as a paragraph", () => {
    view.render({ project: "p", caps: capsWith(CFG), error: null,
                  tasks: [card({ status: "todo", damaged: "no created field" })], links: [] });
    const warn = view.mount.querySelector(".tk-warn-glyph")!;
    expect(warn.getAttribute("aria-label")).toContain("no created field");
    expect(view.mount.querySelector("p.tk-warn")).toBeNull();
  });

  it("marks a card left in the working step with no session", () => {
    view.render({ project: "p", caps: capsWith(CFG), error: null,
                  tasks: [card({ status: "doing" })], links: [] });
    expect(view.mount.querySelector(".tk-stale")!.textContent).toBe("no live session");
  });

  it("omits the kind chip for a card that does not name a kind", () => {
    view.render({ project: "p", caps: capsWith(CFG), error: null,
                  tasks: [card({ status: "todo", kind: "" })], links: [] });
    expect(view.mount.querySelector(".tk-kind")).toBeNull();
  });
```

Add a `capsWith(cfg: BoardConfig): ProviderCapabilities` helper to that file returning
`{ canCreate: true, canResolve: true, statuses: cfg.steps.map((s) => s.id), board: cfg, boardError: null }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tasks.test.ts tests/board.test.ts`
Expected: FAIL — `cols.columns is undefined`, `isStale is not a function`.

- [ ] **Step 3: Rewrite `boardColumns` and add `isStale`**

In `src/tasks.ts`:

```ts
export interface BoardColumn {
  step: BoardStep;
  tasks: Task[];
  /** How many the cap is hiding. Always 0 for a non-terminal step. */
  hidden: number;
}

export interface BoardColumns {
  columns: BoardColumn[];
  /** Cards naming a step the configuration does not know. Alive and visible:
   *  they arrive from a hand-edited or synced board.json, not from the editor. */
  unknown: Task[];
  foreign: { project: string; count: number }[];
}

export function boardColumns(
  tasks: Task[], project: string, cfg: BoardConfig, doneLimit = 20,
): BoardColumns {
  const mine: Task[] = [];
  const foreignCount = new Map<string, number>();
  for (const t of tasks) {
    // A damaged card is always ours to show: it may be damaged *because* the
    // project field is missing, and hiding it would lose the task silently.
    if (t.damaged || t.project === project) mine.push(t);
    else foreignCount.set(t.project, (foreignCount.get(t.project) ?? 0) + 1);
  }

  const columns = cfg.steps.map((step) => {
    const all = mine.filter((t) => t.status === step.id);
    const sorted = step.terminal === true
      ? all.sort((a, b) => byTimeDesc(a.resolved ?? "", b.resolved ?? ""))
      : all.sort((a, b) => byTimeDesc(a.created, b.created));
    // The cap is for a column that only grows and is only ever reviewed. A
    // non-terminal column hiding a card is hiding work.
    if (step.terminal !== true) return { step, tasks: sorted, hidden: 0 };
    return {
      step,
      tasks: sorted.slice(0, doneLimit),
      hidden: Math.max(0, sorted.length - doneLimit),
    };
  });

  return {
    columns,
    unknown: mine.filter((t) => !isKnownStep(cfg, t.status)),
    foreign: [...foreignCount.entries()].map(([p, count]) => ({ project: p, count })),
  };
}

/** A card parked in the working step with nothing running on it. Possible only
 *  because ▶ now writes the step, so the board has to say so rather than let it
 *  read as work in progress. */
export function isStale(task: Task, links: TaskSessionLink[], cfg: BoardConfig): boolean {
  const working = workingStep(cfg);
  if (working === null || task.status !== working) return false;
  return !links.some((l) => l.taskId === task.id && ALIVE.includes(l.state));
}
```

- [ ] **Step 4: Rewrite the rendering**

In `src/board.ts`:

- `render` builds `cols.columns.map((c) => this.column(c, state, caps))` and appends an extra column with class `tk-col tk-col-unknown` when `cols.unknown.length > 0`, headed `unknown step (n)`.
- A column heading is `stepLabel` plus the count, and `+n` appended when `hidden > 0` — the shape `done (3+17)` has today.
- `column` takes a `BoardColumn` rather than a label and a list, and sets `data-step` to the step id (Task 8 reads it as the drop target).
- `card` changes three things: the kind chip is omitted when `kindLabel` returns empty; `damaged` and `conflict` become a single `span.tk-warn-glyph` with text `⚠` and an `aria-label` and `title` carrying the full message including the id and path; and `isStale` adds `span.tk-stale` reading `no live session` with a `title` of
  `This card sits in the working step, but no session is running on it.`
- The `p.tk-warn` paragraphs are deleted.

- [ ] **Step 5: Restyle the columns and the card**

In `src/styles.css`, replace the `.tk-cols` rule and add the card sizing:

```css
/* As many columns as the configuration has steps. The wrapper scrolls, never
   the page. */
.tk-cols {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(240px, 1fr);
  gap: var(--sp-4);
  align-items: start;
  overflow-x: auto;
  padding-bottom: var(--sp-2);
}
.tk-col-unknown .tk-col-head { color: var(--st-error); }

/* One height for every card, so a column reads as a grid. The title clamps and
   the two bottom rows are pinned, which is what makes them line up rather than
   nearly line up. */
.tk-card {
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  height: 108px;
  box-sizing: border-box;
}
.tk-card-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tk-warn-glyph { color: var(--st-error); cursor: help; }
.tk-stale { color: var(--st-error); }
```

Keep the existing `.tk-card` border, padding and state colours; only add the layout properties above to that rule.

- [ ] **Step 6: Show the configuration error, because the fallback lies quietly**

Moved here from Task 9 after Task 4's review, and the reason matters more than the
banner. `boardError` already crosses the IPC boundary and nothing reads it. Picture
the state it exists to explain: `board.json` is broken in a project whose terminal
step is `shipped`. The board falls back to the default two steps, so `shipped` is
no longer terminal — **every closed card reappears in the open column with ✓
offered on it, and the sidebar counts them all as open.** The board looks entirely
plausible and is wrong, with the only signal sitting in a field no code consumes.
Left in Task 9, that state ships through three tasks.

`BoardState` gains `boardError: string | null`, filled from `caps.boardError` in
`refreshBoard`. `BoardView.render` shows it above the columns as
`p.tk-board-error`: `board.json could not be used: <error>. The default two-step
board is shown instead, so cards may appear in the wrong column. The file was left
alone.` The board still draws underneath it.

The second sentence is not padding: it is the part that stops a person trusting
the columns while the fallback is active.

Add two `board.test.ts` cases: the message renders when `boardError` is set, and
the columns still render alongside it.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: 34 files, all passing (the `boardColumns` block replaces its predecessor, so the count moves rather than only growing).

Run: `npx tsc --noEmit` — no errors.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.ts src/board.ts src/styles.css tests/tasks.test.ts tests/board.test.ts
git commit -m "feat(board): a column per configured step, and cards of one height"
```

---

## Task 7: The opened card

**Files:**
- Create: `src/card-modal.ts`
- Create: `tests/card-modal.test.ts`
- Modify: `src/board.ts` (the card becomes clickable)
- Modify: `src/main.ts` (wire it to `updateTask`)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `openDialog` (`src/dialog-shell.ts`), `updateTask`, `TaskPatch` (Task 5), `BoardConfig` helpers (Task 4).
- Produces:

```ts
export interface CardFormValues { title: string; kind: KindId; status: StepId; body: string }
export function computePatch(original: Task, edited: CardFormValues): TaskPatch
export function openCardModal(task: Task, cfg: BoardConfig, canWrite: boolean): Promise<CardFormValues | null>
```

**`computePatch` is separate and pure** because it carries the rule that matters — only what changed is sent — and that rule must be testable without a DOM.

- [ ] **Step 1: Write the failing tests**

Create `tests/card-modal.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computePatch, type CardFormValues } from "../src/card-modal";
import type { Task } from "../src/ipc";

const original: Task = {
  id: "1", title: "Original", kind: "task", status: "todo", project: "p",
  created: "2026-07-01T00:00:00Z", resolved: null, origin: "human", session: null,
  body: "Body.\n", path: "/t/1.md", damaged: null, conflict: false,
};
const same = (): CardFormValues =>
  ({ title: "Original", kind: "task", status: "todo", body: "Body.\n" });

describe("computePatch", () => {
  it("is empty when nothing was touched", () => {
    expect(computePatch(original, same())).toEqual({});
  });

  it("carries only the field that changed", () => {
    expect(computePatch(original, { ...same(), title: "Renamed" })).toEqual({ title: "Renamed" });
    expect(computePatch(original, { ...same(), status: "done" })).toEqual({ status: "done" });
  });

  it("carries several changes together", () => {
    expect(computePatch(original, { ...same(), kind: "bug", body: "New.\n" }))
      .toEqual({ kind: "bug", body: "New.\n" });
  });

  it("does not send a step the person never touched", () => {
    // The point of the whole exercise: an agent may have moved the card while
    // the modal was open, and sending the step back would undo that.
    const patch = computePatch(original, { ...same(), title: "Renamed" });
    expect(patch.status).toBeUndefined();
  });

  it("treats a trimmed-to-identical title as untouched", () => {
    expect(computePatch(original, { ...same(), title: "  Original  " })).toEqual({});
  });

  it("sends an emptied body as an empty string, not as untouched", () => {
    expect(computePatch(original, { ...same(), body: "" })).toEqual({ body: "" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/card-modal.test.ts`
Expected: FAIL — cannot resolve `../src/card-modal`.

- [ ] **Step 3: Write `computePatch`**

```ts
import type { BoardConfig, KindId, StepId, Task, TaskPatch } from "./ipc";

export interface CardFormValues { title: string; kind: KindId; status: StepId; body: string }

/** Only what changed. The card's file may have moved on under the modal — an
 *  agent running `cowork_task status`, a sync from another machine — and a patch
 *  carrying every field would quietly undo it. */
export function computePatch(original: Task, edited: CardFormValues): TaskPatch {
  const patch: TaskPatch = {};
  const title = edited.title.trim();
  if (title !== original.title.trim()) patch.title = title;
  if (edited.kind !== original.kind) patch.kind = edited.kind;
  if (edited.status !== original.status) patch.status = edited.status;
  // Compared as written: an emptied body is a change, and `!edited.body` would
  // read it as untouched.
  if (edited.body !== original.body) patch.body = edited.body;
  return patch;
}
```

- [ ] **Step 4: Build the modal**

Add `openCardModal` to the same file, on `openDialog` exactly as `taskForm` uses it. Structure, top to bottom:

- `input.tk-c-title` carrying the title, focused on open.
- Two `select`s side by side: `select.tk-c-kind` with one `option` per `cfg.kinds`, and `select.tk-c-step` with one per `cfg.steps`. When the card's current step or kind is not in the configuration, prepend an `option` for it, selected, labelled `<id> (not in board.json)` — otherwise opening a card and saving an unrelated edit would move it somewhere nobody asked for.
- `textarea.tk-c-body` carrying the body.
- `div.tk-c-facts`: `id`, `created`, `resolved`, `origin`, `session`, `path`, each as a `<span>` with the value in `textContent` — never `innerHTML`, for the reason `board.ts:41` gives.
- When `task.damaged` or `task.conflict`: `p.tk-c-broken` with the full message and the path.
- `Cancel` and `Save`. When `canWrite` is false — a damaged or conflicting card — every input is `disabled`, `Save` is absent, and `p.tk-c-broken` explains that the file has to be repaired by hand.

Resolve with the form's values on Save and `null` on Cancel or Escape.

- [ ] **Step 5: Wire it up**

In `src/board.ts`, the card's title becomes a `button.tk-card-open` spanning the title area so it is reachable by keyboard, with `aria-label` `Open card: <title>`. It calls a new handler `onOpen(task)` added to `BoardHandlers`. Clicks on the action buttons must not also open the card — call `stopPropagation` in the action handlers, or keep the actions outside the opening button's subtree, which the fixed-height grid already does.

In `src/main.ts`:

```ts
async function openCard(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps) return;
  const canWrite = !t.damaged && !t.conflict;
  const edited = await openCardModal(t, caps.board, canWrite);
  if (!edited) return;
  const patch = computePatch(t, edited);
  if (Object.keys(patch).length === 0) return;
  try { await updateTask(ws.id, t.id, patch); }
  catch (e) { await alertModal(`Could not save the card: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}
```

- [ ] **Step 6: Add the modal's styles**

Reuse the form styling already in `styles.css` for `.tk-f-*`; add `.tk-c-facts { color: var(--fg-subtle); font-size: var(--fs-xs); }`, `.tk-c-broken { color: var(--st-error); font-size: var(--fs-xs); }`, and a `.tk-c-body { min-height: 12rem; width: 100%; }`.

- [ ] **Step 7: Add DOM tests to `tests/card-modal.test.ts`**

```ts
  it("offers a card's unknown step as the selected option", () => {
    // Rendered, not resolved: the modal is how an unknown-step card gets out,
    // and it must not silently pick a different step on the way.
    const p = openCardModal({ ...original, status: "legacy" }, CFG, true);
    const step = document.querySelector<HTMLSelectElement>(".tk-c-step")!;
    expect(step.value).toBe("legacy");
    expect(step.options[0].textContent).toContain("not in board.json");
    document.querySelector<HTMLButtonElement>(".dialog-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });

  it("disables everything and offers no Save for a damaged card", () => {
    const p = openCardModal({ ...original, damaged: "no created field" }, CFG, false);
    expect(document.querySelector<HTMLInputElement>(".tk-c-title")!.disabled).toBe(true);
    expect(document.querySelector(".tk-c-broken")!.textContent).toContain("no created field");
    expect(document.querySelector(".dialog-accept")).toBeNull();
    document.querySelector<HTMLButtonElement>(".dialog-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });
```

Use the cancel and accept button selectors `dialog-shell.ts` actually produces; check it before writing these two tests and adjust the selectors rather than adding classes to the shell.

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run` and `npx tsc --noEmit`.

```bash
git add src/card-modal.ts tests/card-modal.test.ts src/board.ts src/main.ts src/styles.css
git commit -m "feat(board): open a card to read it, and save only what changed"
```

---

## Task 8: Dragging, and the keyboard equivalent

**Files:**
- Modify: `src/board.ts`
- Create: `tests/board-drag.test.ts`
- Modify: `src/styles.css`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `stepBefore`, `stepAfter` (Task 4), `updateTask` (Task 5), `BoardHandlers`.
- Produces: `onMove: (task: Task, step: StepId) => void` on `BoardHandlers`.

**The arrows are not a fallback, they are the contract.** xterm eats Tab inside a tile, `F6` cycling exists because of it, and every action button on a card already carries an `aria-label`. A board reachable only by pointer would be the first part of this app that is not.

- [ ] **Step 1: Write the failing tests**

Create `tests/board-drag.test.ts` with a mounted `BoardView` and the four-step `CFG` from Task 6:

```ts
  it("gives a card in a known step both arrows in the middle of the board", () => {
    render([card({ id: "a", status: "todo" })]);
    expect(btn("a", ".tk-prev")!.getAttribute("aria-label")).toBe("Move to the previous step");
    expect(btn("a", ".tk-next")!.getAttribute("aria-label")).toBe("Move to the next step");
  });

  it("omits the back arrow in the first step and the forward arrow in the last", () => {
    render([card({ id: "a", status: "backlog" }), card({ id: "z", status: "done" })]);
    expect(btn("a", ".tk-prev")).toBeNull();
    expect(btn("a", ".tk-next")).not.toBeNull();
    expect(btn("z", ".tk-next")).toBeNull();
    expect(btn("z", ".tk-prev")).not.toBeNull();
  });

  it("gives a card in an unknown step no arrows at all", () => {
    // It has no neighbours: the modal's select is how it moves.
    render([card({ id: "x", status: "legacy" })]);
    expect(btn("x", ".tk-prev")).toBeNull();
    expect(btn("x", ".tk-next")).toBeNull();
  });

  it("asks for the neighbouring step when an arrow is pressed", () => {
    render([card({ id: "a", status: "todo" })]);
    btn("a", ".tk-next")!.click();
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "doing");
    btn("a", ".tk-prev")!.click();
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "backlog");
  });

  it("makes cards draggable and columns drop targets carrying their step", () => {
    render([card({ id: "a", status: "todo" })]);
    expect(cardEl("a").draggable).toBe(true);
    const cols = [...view.mount.querySelectorAll<HTMLElement>(".tk-col[data-step]")];
    expect(cols.map((c) => c.dataset.step)).toEqual(["backlog", "todo", "doing", "done"]);
  });

  it("moves the card on a drop into another column", () => {
    render([card({ id: "a", status: "todo" })]);
    dragCardTo("a", "done");
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "done");
  });

  it("ignores a drop into the column the card is already in", () => {
    render([card({ id: "a", status: "todo" })]);
    dragCardTo("a", "todo");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("does not accept a drop into the unknown column", () => {
    render([card({ id: "a", status: "todo" }), card({ id: "x", status: "legacy" })]);
    const unknown = view.mount.querySelector<HTMLElement>(".tk-col-unknown")!;
    expect(unknown.dataset.step).toBeUndefined();
    dragCardToElement("a", unknown);
    expect(onMove).not.toHaveBeenCalled();
  });
```

`dragCardTo(id, step)` dispatches `dragstart` on the card with a real `DataTransfer`, then `dragover` and `drop` on `.tk-col[data-step="<step>"]`. jsdom does not implement `DataTransfer`, so the helper supplies a stub object with `setData`/`getData` backed by a `Map` and passes it as `dataTransfer` on the events it constructs.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/board-drag.test.ts`
Expected: FAIL — no `.tk-prev`, no `data-step`.

- [ ] **Step 3: Implement in `board.ts`**

- `BoardHandlers` gains `onMove: (task: Task, step: StepId) => void`.
- `column` sets `data-step` on the column element for a configured step and **not** for the unknown column, so "is this a drop target" is one check: `col.dataset.step !== undefined`.
- `card` sets `draggable = true` and on `dragstart` puts the card id into `dataTransfer` under `text/plain`, adding class `tk-dragging` for the duration.
- Each column with a `data-step` gets `dragover` calling `preventDefault` (without it there is no drop) and toggling `tk-col-over`, and `drop` reading the id, finding the task, and calling `onMove` unless the step is the one it already has.
- Arrows: `‹` as `button.tk-prev` and `›` as `button.tk-next`, prepended and appended around `▶` and `✓` in `tk-acts`, rendered only when `stepBefore` / `stepAfter` return non-null, with `title` and `aria-label` `Move to the previous step` / `Move to the next step`.

- [ ] **Step 4: Wire the write in `main.ts`**

```ts
async function moveTask(t: Task, step: StepId) {
  const ws = workspaces.active;
  if (!ws) return;
  try { await updateTask(ws.id, t.id, { status: step }); }
  catch (e) {
    // The optimistic move has to be explained: without this the card just
    // springs back on the next poll and the board looks broken.
    await alertModal(`Could not move the card: ${String(e)}`);
  }
  await refreshBoard();
  await refreshCounts();
}
```

- [ ] **Step 5: Style the drag states**

```css
.tk-card.tk-dragging { opacity: 0.5; }
.tk-col-over { outline: 1px dashed var(--accent); outline-offset: var(--sp-1); }
```

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run` and `npx tsc --noEmit`.

```bash
git add src/board.ts src/main.ts src/styles.css tests/board-drag.test.ts
git commit -m "feat(board): drag a card between steps, and move it with the keyboard"
```

---

## Task 9: The `⚙` editor

**Files:**
- Create: `src/board-editor.ts`
- Create: `tests/board-editor.test.ts`
- Modify: `src-tauri/src/tasks_cmd.rs`, `src-tauri/src/main.rs`, `src/ipc.ts`, `src/board.ts`, `src/main.ts`, `src/styles.css`
- Test: `src-tauri/src/tasks_cmd.rs`

**Interfaces:**
- Consumes: `BoardConfig`, `save`, `load_or_create` (Tasks 2–3), `TaskPatch`, `update` (Task 5).
- Produces:

```rust
#[tauri::command] pub fn board_config_save(state: State<AppState>, workspace_id: String, config: BoardConfig) -> Result<(), String>
#[tauri::command] pub fn board_step_rewrite(state: State<AppState>, workspace_id: String, from: StepId, to: StepId) -> Result<RewriteReport, String>
pub struct RewriteReport { pub rewritten: usize, pub skipped: Vec<RewriteSkip> }
pub struct RewriteSkip { pub file_name: String, pub reason: String }
#[tauri::command] pub fn board_step_usage(state: State<AppState>, workspace_id: String) -> Result<Vec<StepUsage>, String>
pub struct StepUsage { pub step: StepId, pub count: usize }
```

```ts
export function validateDraft(cfg: BoardConfig): string | null
export function openBoardEditor(cfg: BoardConfig, usage: StepUsage[]): Promise<BoardEditorResult | null>
export interface BoardEditorResult { config: BoardConfig; rewrites: { from: StepId; to: StepId }[] }
```

**Why the id/label split earns its keep.** Editing a `label` touches no card, which makes renaming a column an ordinary action. Editing an `id` is the case that rewrites cards, and `board_step_usage` is what lets the editor say how many before asking.

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/tasks_cmd.rs`'s test module, following its existing fixture style for a workspace with a root:

```rust
    #[test]
    fn rewriting_a_step_touches_only_this_project_s_cards() {
        // A shared vault root holds other projects' cards, and fs.rs::resolve
        // already refuses to write those.
        let (root, ws) = workspace_with_root();
        write_card(&root, "mine.md", "01A", "proj", "todo");
        write_card(&root, "theirs.md", "01B", "other-proj", "todo");
        let report = rewrite_step(&ws, &StepId("todo".into()), &StepId("next".into())).unwrap();
        assert_eq!(report.rewritten, 1);
        assert!(std::fs::read_to_string(root.join("mine.md")).unwrap().contains("status: next"));
        assert!(std::fs::read_to_string(root.join("theirs.md")).unwrap().contains("status: todo"));
    }

    #[test]
    fn rewriting_a_step_skips_a_damaged_card_and_says_which() {
        let (root, ws) = workspace_with_root();
        std::fs::write(root.join("note.md"), "---\nid: 01C\nstatus: todo\n---\nA note.\n").unwrap();
        let report = rewrite_step(&ws, &StepId("todo".into()), &StepId("next".into())).unwrap();
        assert_eq!(report.rewritten, 0);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].file_name, "note.md");
    }

    #[test]
    fn rewriting_preserves_unknown_frontmatter_keys() {
        let (root, ws) = workspace_with_root();
        write_card_with_extra(&root, "mine.md", "01A", "proj", "todo", "tags: [inbox]");
        rewrite_step(&ws, &StepId("todo".into()), &StepId("next".into())).unwrap();
        assert!(std::fs::read_to_string(root.join("mine.md")).unwrap().contains("tags: [inbox]"));
    }

    #[test]
    fn step_usage_counts_this_project_s_cards_per_step() {
        let (root, ws) = workspace_with_root();
        write_card(&root, "a.md", "01A", "proj", "todo");
        write_card(&root, "b.md", "01B", "proj", "todo");
        write_card(&root, "c.md", "01C", "proj", "done");
        let usage = step_usage(&ws).unwrap();
        let count = |id: &str| usage.iter().find(|u| u.step.as_str() == id).map(|u| u.count);
        assert_eq!(count("todo"), Some(2));
        assert_eq!(count("done"), Some(1));
    }

    #[test]
    fn saving_a_configuration_refuses_an_invalid_one_and_leaves_the_file_alone() {
        let (root, ws) = workspace_with_root();
        let before = std::fs::read(root.join(BOARD_FILE)).unwrap();
        let bad = BoardConfig { v: 1,
            steps: vec![Step { id: StepId("a".into()), label: "A".into(), terminal: false, working: false }],
            kinds: vec![Kind { id: KindId("k".into()), label: "K".into() }] };
        assert!(save_config(&ws, bad).is_err());
        assert_eq!(std::fs::read(root.join(BOARD_FILE)).unwrap(), before);
    }
```

Name the private helpers `rewrite_step`, `step_usage` and `save_config` and let the three `#[tauri::command]` functions be thin wrappers over them — the commands cannot be called from a unit test, and the previous plan's `root_preview` / `tracker_root_preview` split is the pattern to follow.

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `cd src-tauri && cargo test tasks_cmd::`
Expected: FAIL to compile.

`rewrite_step` walks `FsTaskProvider::scan`, keeps cards whose `project` matches the workspace name, `damaged.is_none()`, `!conflict` and `status == from`, and calls `provider.update(&card.id, TaskPatch { status: Some(to.clone()), ..Default::default() })` on each, collecting failures into `skipped` with the file name and the error's `to_string()`. Damaged and conflicting cards are skipped and reported, never written.

`step_usage` counts by `status` over the same project-matched set, including steps the configuration no longer lists — the editor needs to know a step is occupied even when it is about to disappear.

`save_config` validates before writing and returns the `BoardConfigError`'s `Display` on failure, so an invalid configuration never reaches the file.

- [ ] **Step 3: Write the failing TypeScript tests**

Create `tests/board-editor.test.ts` for the pure half:

```ts
describe("validateDraft", () => {
  it("accepts a good draft", () => expect(validateDraft(CFG)).toBeNull());
  it("rejects a draft with no terminal step", () =>
    expect(validateDraft({ ...CFG, steps: CFG.steps.map((s) => ({ ...s, terminal: false })) }))
      .toMatch(/terminal/));
  it("rejects two working steps", () =>
    expect(validateDraft({ ...CFG, steps: CFG.steps.map((s) => ({ ...s, working: true })) }))
      .toMatch(/working/));
  it("rejects a duplicate id", () =>
    expect(validateDraft({ ...CFG, steps: [...CFG.steps, CFG.steps[0]] })).toMatch(/todo|backlog/));
  it("rejects whitespace in an id", () =>
    expect(validateDraft({ ...CFG, steps: [{ id: "in progress", label: "X", terminal: true }] }))
      .toMatch(/whitespace/));
  it("rejects an empty step list and an empty kind list", () => {
    expect(validateDraft({ ...CFG, steps: [] })).toMatch(/step/);
    expect(validateDraft({ ...CFG, kinds: [] })).toMatch(/kind/);
  });
});
```

`validateDraft` mirrors `BoardConfig::validate` so the editor can refuse before saving; the backend still validates, because a configuration can also arrive by hand.

- [ ] **Step 4: Build the editor modal**

`openBoardEditor` on `openDialog`. For steps, a list of rows, each with: a `label` input, an `id` input, a `terminal` checkbox, a `working` checkbox (radio-like — checking one clears the others, which is how the "no more than one" rule reads to a person), `↑`/`↓` buttons, and a `✕` remove. Then the same for kinds without the flags. `+ step` and `+ kind` append a row. Every button carries an `aria-label`.

Three rules the editor enforces in the dialog rather than at save time:

- Changing an `id` on a row whose original id has cards records a rewrite in `BoardEditorResult.rewrites` and shows inline: `n card(s) will be updated to say "<new id>"`.
- Removing a step whose id has cards demands a destination: a `select` of the remaining steps appears in the row, and Save stays disabled until one is chosen. That choice becomes a rewrite entry. There is no plain remove, because it would deliberately manufacture the unknown-step column.
- `validateDraft` runs on every change; its message shows above the buttons and disables Save.

- [ ] **Step 5: Wire it in `main.ts`**

`⚙` sits beside `+ task` in `BoardView`'s head as `button.tk-configure-board` with `aria-label` `Configure the board`, calling a new `onEditBoard` handler:

```ts
async function editBoard() {
  const ws = workspaces.active;
  if (!ws) return;
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps) return;
  const usage = await boardStepUsage(ws.id).catch(() => []);
  const result = await openBoardEditor(caps.board, usage);
  if (!result) return;
  // Rewrites first: a card must never point at a step the saved configuration
  // no longer has, and saving first would leave exactly that window open.
  for (const r of result.rewrites) {
    try {
      const report = await boardStepRewrite(ws.id, r.from, r.to);
      if (report.skipped.length) {
        await alertModal(
          `Moved ${report.rewritten} card(s) to "${r.to}". ${report.skipped.length} could not be moved:\n` +
          report.skipped.map((s) => `${s.fileName}: ${s.reason}`).join("\n"));
      }
    } catch (e) {
      await alertModal(`Could not update the cards in "${r.from}": ${String(e)}`);
      return; // Leave the configuration alone: it still matches what is on disk.
    }
  }
  try { await boardConfigSave(ws.id, result.config); }
  catch (e) { await alertModal(`Could not save the board configuration: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}
```

Add `boardConfigSave`, `boardStepRewrite` and `boardStepUsage` wrappers to `src/ipc.ts` with a test each in `tests/ipc.test.ts`.

- [ ] **Step 6: (moved to Task 6 — see the note there)**

The configuration-error banner was originally specified here. Task 4's review
established that leaving it this late ships three tasks with a board that looks
plausible and is wrong, so it moved to Task 6, which rewrites this rendering
anyway. Nothing to do in this step; it is kept as a marker so the move is
traceable.

- [ ] **Step 7: Verify and commit**

Run: `cd src-tauri && cargo test`, `cargo clippy --all-targets` (6 warnings), `npx vitest run`, `npx tsc --noEmit`.

```bash
git add src-tauri/src src/board-editor.ts src/ipc.ts src/board.ts src/main.ts src/styles.css tests
git commit -m "feat(board): configure the steps and kinds, and move the cards a rename leaves behind"
```

---

## Task 10: `COWORK_TASK_ID`, `cowork_task status` and `steps`

**Files:**
- Modify: `src-tauri/src/commands.rs:55-70, 202-240`
- Modify: `src-tauri/src/bin/cowork_task.rs`
- Modify: `src/ipc.ts`, `src/sessions.ts`
- Test: `src-tauri/src/commands.rs`, `src-tauri/tests/cowork_task.rs`

**Interfaces:**
- Consumes: `BoardConfig`, `update`, `TaskPatch` (Tasks 4–5).
- Produces: `COWORK_TASK_ID` in the session environment; `Cmd::Status { id, step }` and `Cmd::Steps` in the CLI; `start_session`'s new `task_id: Option<String>` parameter.

**Why the environment variable is not optional plumbing.** Task 11's two hooks find the card through it. Without it on the `--resume` path, a restored session loses its card and all three layers of reminding switch off with no sign that they did.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/commands.rs`'s test module, beside the existing tracker-env tests (`get("COWORK_TASKS_DIR")` around line 379):

```rust
    #[test]
    fn a_session_launched_from_a_card_carries_its_id() {
        let env = tracker_env(Some("/vault/tasks"), "proj", Some("01K1CARD"));
        assert_eq!(get_from(&env, "COWORK_TASK_ID"), Some("01K1CARD"));
    }

    #[test]
    fn a_session_launched_without_a_card_carries_no_card_id() {
        // The guard reads its absence as "nothing to demand" and allows.
        let env = tracker_env(Some("/vault/tasks"), "proj", None);
        assert!(env.iter().all(|(n, _)| n != "COWORK_TASK_ID"));
    }
```

Adapt to the helper the existing tests use to build the env vector; extend that helper with the card id rather than adding a second one.

In `src-tauri/tests/cowork_task.rs`:

```rust
#[test]
fn status_moves_a_card_to_a_configured_step() {
    let dir = tempdir_with_board(r#"{"steps":[{"id":"todo","label":"To do"},
        {"id":"done","label":"Done","terminal":true}],"kinds":[{"id":"task","label":"Task"}]}"#);
    let id = create_card(&dir, "task", "A title");
    let out = run(&dir, &["status", &id, "done"]).expect("moved");
    assert!(out.contains(&id));
    assert!(card_text(&dir, &id).contains("status: done"));
}

#[test]
fn status_refuses_an_unknown_step_and_lists_the_configured_ones() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let err = run(&dir, &["status", &id, "invented"]).unwrap_err();
    // Listing them is what lets the agent correct itself instead of guessing.
    assert!(err.contains("invented"), "{err}");
    assert!(err.contains("open") && err.contains("done"), "{err}");
}

#[test]
fn status_refuses_a_damaged_card() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    std::fs::write(dir.path().join("note.md"), "---\nid: 01NOTE\n---\nA note.\n").unwrap();
    assert!(run(&dir, &["status", "01NOTE", "done"]).is_err());
}

#[test]
fn steps_prints_one_id_per_line_in_board_order_marking_the_terminal_ones() {
    let dir = tempdir_with_board(r#"{"steps":[{"id":"todo","label":"To do"},
        {"id":"done","label":"Done","terminal":true},
        {"id":"cancelled","label":"Cancelled","terminal":true}],
        "kinds":[{"id":"task","label":"Task"}]}"#);
    let out = run(&dir, &["steps"]).expect("listed");
    assert_eq!(out.lines().collect::<Vec<_>>(), vec!["todo", "done (terminal)", "cancelled (terminal)"]);
}

#[test]
fn status_needs_both_an_id_and_a_step() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    assert!(run(&dir, &["status"]).is_err());
    assert!(run(&dir, &["status", "01ABC"]).is_err());
}
```

Reuse the harness this file already has for setting the three environment variables and invoking `run`; add `tempdir_with_board` beside it and a `DEFAULT_BOARD` constant matching `BoardConfig::default_config()`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test`
Expected: FAIL — `unknown subcommand: status`, `COWORK_TASK_ID` absent.

- [ ] **Step 3: Extend the CLI**

```rust
pub enum Cmd {
    New { kind: String, title: String },
    Done { id: String },
    Status { id: String, step: String },
    Steps,
}
```

In `parse_args`, add:

```rust
        "status" => {
            let id = argv.get(2).ok_or("a card id is required")?.clone();
            let step = argv.get(3).ok_or("a step is required")?.clone();
            Ok(Cmd::Status { id, step })
        }
        "steps" => Ok(Cmd::Steps),
```

and extend the `""` arm's message to `a subcommand is required: new | done | status | steps`.

In `run`, add the two arms:

```rust
        Cmd::Status { id, step } => {
            let step = StepId(step);
            if !provider.board().has_step(&step) {
                return Err(format!(
                    "unknown step: {} (configured: {})",
                    step.as_str(),
                    provider.board().step_ids().join(", ")
                ));
            }
            let card = provider
                .update(&id, TaskPatch { status: Some(step), ..Default::default() })
                .map_err(|e| e.to_string())?;
            Ok(format!("card {} is now in {}", card.id, card.status.as_str()))
        }
        Cmd::Steps => Ok(provider
            .board()
            .steps
            .iter()
            .map(|s| if s.terminal { format!("{} (terminal)", s.id.as_str()) } else { s.id.0.clone() })
            .collect::<Vec<_>>()
            .join("\n")),
```

Extend `USAGE` with both, and say that `done` moves the card to the first terminal step.

- [ ] **Step 4: Plumb the card id into the environment**

In `src-tauri/src/commands.rs`, `start_session` gains a `task_id: Option<String>` parameter after `initial_prompt`, and the tracker-env block gains:

```rust
        // The hooks in hooks.rs find the card through this. Set on resume too:
        // a restored session that lost it would silently stop being reminded.
        if let Some(id) = &task_id {
            env.push(("COWORK_TASK_ID".to_string(), id.clone()));
        }
```

In `src/ipc.ts`, add `taskId?: string` to the `startSession` wrapper's arguments. In `src/sessions.ts`, `launchFromTask` passes the card's id, and the restore path passes `entry.taskId`, which `SessionEntry` already carries.

- [ ] **Step 5: Move the card to the working step on launch**

In `src/sessions.ts`'s `launchFromTask`, after the launch guard decides a session will actually start and before the PTY is spawned:

```ts
// ▶ writes the step itself, so the card moves whether or not the agent
// remembers to. A failure must not block the launch: the work matters more
// than the bookkeeping, and the board's stale marker will show the mismatch.
const step = workingStep(cfg);
if (step !== null && task.status !== step) {
  await updateTask(ws.id, task.id, { status: step }).catch((e) =>
    console.warn("could not move the card to the working step:", e));
}
```

Add a test to `tests/sessions.test.ts` asserting that a launch from a card calls `updateTask` with the working step, and that a configuration without one calls it not at all.

- [ ] **Step 6: Verify and commit**

Run: `cd src-tauri && cargo test`, `cargo clippy --all-targets` (6 warnings), `npx vitest run`, `npx tsc --noEmit`.

```bash
git add src-tauri/src src/ipc.ts src/sessions.ts tests
git commit -m "feat(session): hand the card id to the session, and let it move the card itself"
```

---

## Task 11: `cowork_task guard`, the two hooks, the prompt and the skill

**Files:**
- Modify: `src-tauri/src/bin/cowork_task.rs`
- Modify: `src-tauri/src/hooks.rs`
- Modify: `src/tasks.ts` (`taskPrompt`)
- Modify: `.claude/skills/file-a-task/SKILL.md`
- Modify: `README.md`
- Test: `src-tauri/tests/cowork_task.rs`, `src-tauri/src/hooks.rs`, `tests/tasks.test.ts`

**Interfaces:**
- Consumes: `COWORK_TASK_ID` (Task 10), `BoardConfig`, `FsTaskProvider` (Task 4).
- Produces: `Cmd::Guard` reading a hook payload on stdin and printing a hook reply.

**The decision table this task exists to get right.** Exactly one row blocks:

| State | Reply |
| --- | --- |
| `COWORK_TASK_ID` unset | allow, print nothing |
| payload's `hook_event_name` is `UserPromptSubmit` | allow, print the one-line context |
| `Stop`, card in a non-terminal step, `stop_hook_active` false | **block**, with the reason |
| `Stop`, card in a non-terminal step, `stop_hook_active` true | allow — a second block is a loop with no exit |
| `Stop`, card in a terminal step | allow |
| card not found, damaged, conflicting | allow |
| `board.json` unusable, root unreachable, read fails | allow |

- [ ] **Step 1: Write the failing tests**

In `src-tauri/tests/cowork_task.rs`:

```rust
fn guard(dir: &TempDir, card: Option<&str>, payload: &str) -> (i32, String);

#[test]
fn guard_allows_and_says_nothing_without_a_card_id() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, out) = guard(&dir, None, r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), "");
}

#[test]
fn guard_blocks_the_first_stop_while_the_card_is_open() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, out) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    assert_ne!(code, 0, "a blocking Stop hook has to exit non-zero");
    assert!(out.contains(&id), "the reason must name the card: {out}");
    assert!(out.contains("cowork_task"), "and the command that moves it: {out}");
}

#[test]
fn guard_allows_the_second_stop() {
    // stop_hook_active means we already blocked once. Blocking again is a loop
    // the session cannot leave.
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":true}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_a_stop_once_the_card_is_in_a_terminal_step() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    run(&dir, &["done", &id]).unwrap();
    let (code, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_when_the_card_is_gone() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, _) = guard(&dir, Some("01NOSUCHCARD"), r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_when_the_card_is_damaged() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    std::fs::write(dir.path().join("note.md"), "---\nid: 01NOTE\n---\nA note.\n").unwrap();
    let (code, _) = guard(&dir, Some("01NOTE"), r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_when_board_json_is_unusable() {
    let dir = tempdir_with_board("{ broken");
    let id = create_card(&dir, "task", "A title");
    // A tracker problem must not take the work hostage — the same principle by
    // which a failing watcher degrades into a delay.
    let (code, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_on_a_malformed_payload() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, _) = guard(&dir, Some(&id), "not json at all");
    assert_eq!(code, 0);
}

#[test]
fn guard_prints_the_card_and_its_step_on_a_user_prompt() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, out) = guard(&dir, Some(&id), r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains(&id) && ctx.contains("open") && ctx.contains("cowork_task"), "{ctx}");
}
```

In `src-tauri/src/hooks.rs`'s test module:

```rust
    #[test]
    fn the_reporter_stays_first_on_every_event() {
        let v: serde_json::Value = serde_json::from_str(&build_settings_json("/r", 1, "s", "/t")).unwrap();
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop",
                   "PermissionRequest", "Notification", "SessionEnd"] {
            let first = v["hooks"][ev][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(first.contains("/r"), "{ev}: {first}");
        }
    }

    #[test]
    fn the_guard_is_added_to_user_prompt_submit_and_stop_and_nowhere_else() {
        let v: serde_json::Value = serde_json::from_str(&build_settings_json("/r", 1, "s", "/t")).unwrap();
        let count = |ev: &str| v["hooks"][ev][0]["hooks"].as_array().unwrap().len();
        assert_eq!(count("UserPromptSubmit"), 2);
        assert_eq!(count("Stop"), 2);
        for ev in ["SessionStart", "PreToolUse", "PermissionRequest", "Notification", "SessionEnd"] {
            assert_eq!(count(ev), 1, "{ev}");
        }
    }

    #[test]
    fn the_guard_is_attached_even_without_a_card_because_it_allows_on_its_own() {
        // One branch instead of two when building the settings, and one less
        // thing to forget on the --resume path.
        let v: serde_json::Value = serde_json::from_str(&build_settings_json("/r", 1, "s", "/t")).unwrap();
        let cmd = v["hooks"]["Stop"][0]["hooks"][1]["command"].as_str().unwrap();
        assert!(cmd.contains("/t") && cmd.contains("guard"), "{cmd}");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test`
Expected: FAIL — `build_settings_json` takes 3 arguments, `unknown subcommand: guard`.

- [ ] **Step 3: Implement `guard`**

Add `Guard` to `Cmd` and `"guard" => Ok(Cmd::Guard)` to `parse_args`. `guard` is the one subcommand that reads its own environment and never fails, so it runs before the shared env resolution in `run`:

```rust
/// Reads a hook payload on stdin and prints what that hook expects.
///
/// Every failure path allows. A tracker problem — unreadable board.json, a
/// missing card, a failing disk — must not hold a session hostage, the same way
/// a failing watcher degrades into a delay rather than a breakage.
fn guard() -> i32 {
    let Ok(id) = std::env::var("COWORK_TASK_ID") else { return 0 };
    if id.trim().is_empty() { return 0 }
    let Ok(dir) = std::env::var("COWORK_TASKS_DIR") else { return 0 };

    let mut payload = String::new();
    let _ = std::io::stdin().read_to_string(&mut payload);
    let event = serde_json::from_str::<serde_json::Value>(&payload).ok();
    let event_name = event.as_ref()
        .and_then(|v| v["hook_event_name"].as_str())
        .unwrap_or("")
        .to_string();
    let already_blocked = event.as_ref()
        .and_then(|v| v["stop_hook_active"].as_bool())
        .unwrap_or(false);

    let provider = FsTaskProvider::new(std::path::PathBuf::from(&dir), FsRootCreation::Never);
    if provider.board_error().is_some() { return 0 }
    let Ok(cards) = provider.scan() else { return 0 };
    let mine: Vec<&Task> = cards.iter().filter(|c| c.id == id).collect();
    // Not exactly one, or one we would not write into: nothing to demand.
    if mine.len() != 1 { return 0 }
    let card = mine[0];
    if card.damaged.is_some() { return 0 }
    let open = !provider.board().is_terminal(&card.status);

    match event_name.as_str() {
        "UserPromptSubmit" => {
            let ctx = format!(
                "Tracker card {} (\"{}\") is in step \"{}\". Move it with \
                 \"$COWORK_TASK_BIN\" status {} <step>; \"$COWORK_TASK_BIN\" steps lists them.",
                card.id, card.title, card.status.as_str(), card.id);
            println!("{}", serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": ctx,
                }
            }));
            0
        }
        "Stop" if open && !already_blocked => {
            println!(
                "Card {} is still in step \"{}\". Move it before finishing: \
                 \"$COWORK_TASK_BIN\" status {} <step> — or \"$COWORK_TASK_BIN\" done {} if it \
                 is finished. If it should stay where it is, say so and stop again.",
                card.id, card.status.as_str(), card.id, card.id);
            2
        }
        _ => 0,
    }
}
```

In `main`, dispatch it before the ordinary path so it can never surface an error:

```rust
fn main() {
    if std::env::args().nth(1).as_deref() == Some("guard") {
        std::process::exit(guard());
    }
    // … existing match on run() …
}
```

- [ ] **Step 4: Attach the guard to the two hooks**

In `src-tauri/src/hooks.rs`, `build_settings_json` gains a fourth parameter, `task_bin: &str`, and the loop becomes:

```rust
    for (event, kind) in mapping {
        let report = format!("\"{}\" {} {} {}", reporter_path, kind, port, session);
        let mut commands = vec![json!({ "type": "command", "command": report })];
        // The reporter stays first: its job is unchanged, and the guard's reply
        // is what the hook returns, so it goes last.
        if event == "UserPromptSubmit" || event == "Stop" {
            commands.push(json!({ "type": "command",
                                  "command": format!("\"{}\" guard", task_bin) }));
        }
        hooks.insert(event.to_string(), json!([ { "hooks": commands } ]));
    }
```

Update the call in `commands.rs:215` to pass `&state.task_bin_path`.

- [ ] **Step 5: Tell the prompt and the skill**

In `src/tasks.ts`, `taskPrompt(task, cfg)` gains, before the closing line:

```ts
  const steps = cfg.steps.map((s) => s.id).join(", ");
  lines.push(
    "",
    `This card is in step "${task.status}". The board's steps are: ${steps}.`,
    `Move it as the work progresses: "$COWORK_TASK_BIN" status ${task.id} <step>`,
  );
```

Keep the existing closing `done` line — it still works and now means the first terminal step.

Add a test to `tests/tasks.test.ts` asserting the prompt names the card's current step, lists the configured ids, and still carries the `done` line.

In `.claude/skills/file-a-task/SKILL.md`, add a section documenting `status` and `steps`, saying explicitly that the steps differ per project and must be read with `cowork_task steps` rather than assumed. Do not list `open`/`done` as though they were universal.

In `README.md`, extend the tracker section with `board.json`: where it lives, the two flags, that a broken one falls back without being rewritten, and that the steps reach a session through `cowork_task steps`.

- [ ] **Step 6: Verify and commit**

Run: `cd src-tauri && cargo test`, `cargo clippy --all-targets` (6 warnings), `npx vitest run`, `npx tsc --noEmit`.

```bash
git add src-tauri/src src/tasks.ts .claude/skills/file-a-task/SKILL.md README.md tests
git commit -m "feat(session): keep the agent honest about the card it is working on"
```

---

## Self-Review

**Spec coverage.** Walking the spec section by section:

| Spec section | Task |
| --- | --- |
| The view switch; the sidebar | 1 |
| `board.json`: shape, flags, validation, broken-file fallback, creation | 2, 3 |
| The configuration follows the cards | 3 |
| `StepId`/`KindId`; the parser stops judging values | 4 |
| `ProviderCapabilities.statuses`; capabilities carry the configuration | 4, 9 (`boardError` surfacing) |
| The unknown-step column; no arrows on it; the modal's select | 6, 7, 8 |
| Rewriting cards, project-matched, reported | 9 |
| Columns from the configuration; the cap on terminal steps only | 6 |
| Cards of one size; damage as a glyph; the stale marker | 6 |
| Dragging; the keyboard equivalent; the unknown column is not a target | 8 |
| The opened card; the file keeps its name; damaged refused; only changed fields | 5, 7 |
| Three writers of the step | 5 (`update`), 8 (drag/arrows), 10 (▶ and the CLI) |
| `COWORK_TASK_ID` including on resume; `status`; `steps` | 10 |
| `guard`; the two hooks; never holds a session | 11 |
| The `⚙` editor; label vs id; removal demands a destination | 9 |
| Error handling: isolated calls, re-read from disk, partial reports | 5, 7, 8, 9 |
| Expectations that invert on purpose | 4 |

No gaps.

**Corrections found on review, fixed above:**

- Tasks 4 and 5 of the first draft were merged. Deleting `TaskStatus` forces `resolve` to name its target through `first_terminal()`, so a version where the provider has no configuration would have to write the literal `"done"` — which the global constraints forbid. They are one compile.
- `initial_step()` was placed in Task 4 rather than Task 2, where its first caller is.
- Task 4's file list said `src-tauri/tests/cowread_task.rs`. The file is `src-tauri/tests/cowork_task.rs`.
- `set_step` takes `Option<&str>` rather than always stamping `resolved`, because a card dragged back out of `done` must not keep showing when it was closed.
- `update` needed `set_fields` from outside `frontmatter.rs`. The first draft added a `set_fields_pub` wrapper to keep the private helper private; that is one more name for the same function, and a reviewer would rightly call it out. `set_fields` becomes `pub` in place, and the caller's obligation — values must be single-line — is written into the doc comment it already has.
- **A real gap, not a tidy-up:** Task 4 changed `ProviderCapabilities` on the TypeScript side to carry `board` and `boardError`, and had no step sending them from Rust. `BoardCapabilities` with `#[serde(flatten)]` is now Task 4's Step 8. Without it every board would have rendered against `undefined`.
- Task 4 created `src/board-config.ts` with no tests of its own. `tests/board-config.test.ts` is now Steps 10–11, and it is where the rule "an unknown step has no neighbours" — the reason a card in the unknown column shows no arrows — is pinned down.

**Type consistency.** `StepId`/`KindId` are newtypes in Rust and plain aliases in TypeScript, and the boundary is `serde(transparent)`, so the JSON on both sides is a bare string. `BoardConfig` is spelled the same in both. `TaskPatch`'s four optional fields match `CardFormValues`'s four required ones through `computePatch`. `boardColumns` returns `{ columns, unknown, foreign }` in Task 6 and every later reader uses those three names. `build_settings_json` takes four parameters from Task 11 onward, and its one caller is updated in the same task.

**Ordering.** Task 1 stands alone and can ship first. Tasks 2–3 add code nothing calls yet. Task 4 is the only task that cannot be split without violating a global constraint, and it is where the suite is most likely to go red — its gate is `cargo test`, `cargo clippy`, `vitest` and `tsc` together. Tasks 6–9 each leave the board working. Tasks 10–11 touch the session and are last because the guard's decision table is easier to reason about once the steps are real.
