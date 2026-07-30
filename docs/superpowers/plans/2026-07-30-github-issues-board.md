# GitHub issues as the board's second source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The existing Board screen shows a repository's open and closed GitHub issues, with the same three actions the file board offers — start a session, close, create — one task source per workspace, chosen in the workspace form, never merged.

**Architecture:** A second `TaskProvider` (`tasks/gh_issues.rs`) beside `tasks/fs.rs`, built from pure parsers over `gh`'s JSON plus an injected runner, so the trait implementation is testable without a process. The board's configuration and the migration machinery move *up* out of the port into the IPC layer (`board_for`, `fs_provider_for`), because a GitHub workspace has no folder to answer them with. The frontend keeps its shape: pure rules in `src/issues.ts`, rendering in `src/board.ts`, wiring in `src/main.ts`.

**Tech Stack:** Rust (Tauri 2, serde), TypeScript (no framework, hand-built DOM), vitest + jsdom, cargo test. External: the `gh` CLI, 2.82.1 on the development machine, and `git`.

**Spec:** `docs/superpowers/specs/2026-07-30-github-issues-board-design.md`. Every decision below is that spec's; where this plan makes an implementation-level choice the spec left open, it says so and the self-review at the end lists all of them.

## Precondition, not a decision this plan makes

The base of this work is **the current branch, `worktree-workspace-github-account` at `60438bc`** — 37 commits ahead of `main` and unmerged (epic #113, the pull request view). Decisions 6 and 11 change functions that exist only here (`pr_worktree_add`, `pr_list_argv`), so the plan cannot be based on `main`.

Whether #113 merges to `main` first is **not settled and is the user's call.** It changes nothing in any task: every task below touches files that are identical on both sides of that merge except the ones #113 itself added, and those come along with it. If #113 merges first, rebase and continue; if it does not, this branch grows. Either way the task list, its order and its commits are the same.

**All twenty-six tasks are on this branch, in this worktree** — the user's decision of 2026-07-30. Tasks 1 and 2 were to have been cut from `main` and released ahead; they are not. Barrier 0 records what that costs and what those two tasks are still worth.

## Global Constraints

- **English only.** Every file in this repository — code, comments, tests, docs, UI copy — is written in English. Drafting in another language and translating afterwards is not the intent. (`CLAUDE.md`, "Language".)
- **No new dependencies.** Neither cargo nor npm. Everything here is `gh`, `git`, and what the project already has.
- **Tokens never reach a log or the frontend unredacted.** Every error string from `gh` leaves the backend through `gh::redact`, which `run_gh_for_workspace` already applies (`commands.rs:382`, `:384`). The new stdin-carrying sibling must apply it too.
- **The exit code is checked before the output is parsed.** A missing scope is exit 1 with *nothing on stdout* (spec, "Exit codes"), so "parse and see whether it was JSON" would report a scope problem as unreadable JSON. `run_gh_for_workspace` already gets this right (`:383`); it must keep doing so.
- **No `innerHTML` for anything that came from the network.** Titles, labels and bodies are set with `textContent`, following `board.ts:47`.
- **Pure functions carry the logic; DOM classes only render.** Anything with a truth table lives in a module with its own unit tests and no DOM. `main.ts` is not reachable from a test, so no rule may live there.
- **Baseline, measured on this branch at `60438bc`:** `npx tsc --noEmit` clean, **43 vitest files / 412 tests**, **286 cargo tests** across the lib, both binaries and both integration files. Nothing may regress below those numbers. (The pull request plan's recorded 367/263 are stale — do not repeat them.)
- **The full gate:** `npx tsc --noEmit && npx vitest run && (cd src-tauri && cargo test)`. Per-task verification is narrow: `cd src-tauri && cargo test <filter>` or `npx vitest run tests/<file>.test.ts && npx tsc --noEmit`.
- **Run everything from this worktree**, `/home/evgeny-kharetski/workspace/lemsoft/cowork-deck/.claude/worktrees/workspace-github-account`, and **never from `/home/evgeny-kharetski/workspace/lemsoft/cowork-deck`**. That is the main checkout with `.claude/worktrees/` nested inside it, and vitest globs suites out of nested worktrees — BUG-026 itself, the same bug decision 6 keeps worktrees outside the workspace to avoid.
- **The clippy ceiling is 6 warnings**, carried from the two previous plans: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` reports exactly 4 × `std::io::Error::other` and 2 × `too_many_arguments` (one of them `start_session`, already at 10/7). Run it **without** `-D warnings`.
  **Count diagnostics, not lines.** `grep -c '^warning'` reports **8** at the ceiling, because cargo prints a per-crate summary line ("warning: `cowork-deck` generated N warnings") that is not itself a diagnostic. Use `grep -c '^warning: ' | ` minus the summaries, or simply read the two summary lines and add them — they are the authority. An agent counting with a bare grep will believe it is two over before it has changed anything. A task may raise the test counts; it may not raise the warning count. **A sanctioned exception that turned out to be unnecessary** (corrected 2026-07-30 while executing Task 5): Tasks 5–6 were allowed up to two warnings above the ceiling, on the assumption that `issue_branch`, `issue_worktree_path` and the argv builders would trip `dead_code` until Tasks 10 and 14 called them. They do not. They are `pub` items in the **library** crate (`cowork_deck::tasks`), and `dead_code` does not fire on a public item of a library regardless of callers — measured at Task 5: exactly 6, unchanged. **So the count is 6 at every task, including these two, and Task 14 has nothing to bring back.** If you see more than 6 anywhere, it is a real new warning, not this exception.
  Watch `session_env` in Task 12: it is at 5 parameters and goes to 7. Clippy's threshold is *more than* 7, so 7 is legal — an eighth would add a warning and must instead become a struct.
- **`gh` against `followLemmi/cowork-deck` must be scoped per command:** `GH_TOKEN=$(gh auth token --user followLemmi) gh …`. The default `gh` account on this machine is an EMU that cannot write to that repository, and a plain `gh issue comment` fails with a confusing permission error. This matters in Tasks 25 and 26 only, and is stated in both.
- **Task issues are not filed yet.** Before starting, file one epic and one issue per task below (26 of them) in `followLemmi/cowork-deck`, and record the number under each task heading, as the pull request plan does. The issue bodies are the task headings plus their "Files" and "Interfaces" blocks. Tasks 1 and 2 are the exception: they belong to **#117**, which is already filed and is not part of this feature's epic.
- **Tasks 1 and 2 stay first, for a compiler reason rather than a release one.** Task 3's tests reference `KnownTrackerProvider` from Task 2 and will not compile without it. The release ahead of the variant was proposed and declined (Barrier 0): one branch means one release, so the tolerance in #117 will not protect any build already installed. It still closes the door for the next schema addition, still stops a truncated store file destroying the rest, and still keeps an unreadable record visible — see Barrier 0 for the full accounting.

## Phases and barriers

Twenty-six tasks in four phases, and **four barriers — three of them test barriers and one a release barrier.** Each task is independently verifiable and independently committable; a task that could not be verified on its own has been split into two.

The distinction matters, so it is drawn once here: a test barrier says *these tests must be green before the next phase*, and an executing agent can satisfy it in the same sitting. The release barrier after Task 2 says *this must be in users' hands before the next phase*, which no amount of test-running satisfies. It is not a checkpoint to run past.

| Phase | Tasks | Barrier at the end |
|---|---|---|
| 1a — #117: the store stops losing records | 1–2 | `cd src-tauri && cargo test`. **No release barrier:** it was proposed and declined, so these ship with everything else. Barrier 0 records the cost and what the two tasks are still worth. They stay first because Task 3 will not compile without Task 2. |
| 1b — Rust foundations: the model, the pure parsers, the argv, the provider | 3–6 | `cd src-tauri && cargo test` fully green and `npx tsc --noEmit` clean. Nothing is wired: no command reaches the new code, so a failure here is a failure of the parsers alone and cannot be confused with a seam problem. |
| 2 — Rust seams: the IPC layer, the session environment, the sidecar, the worktrees | 7–17 | Full `cargo test`, plus the clippy count back at exactly 6. The backend is complete and exercised only by tests; the frontend still cannot produce a GitHub tracker config, so nothing user-visible has changed yet. That is deliberate — it is the last point at which a backend bug is unambiguously a backend bug. |
| 3 — Frontend: types, pure rules, the prompt, the view, the wiring, the form | 18–24 | The full gate. The feature is usable end to end. |
| 4 — Records: the correction to #115, the documentation and the manual check | 25–26 | The full gate, and the manual checklist recorded in the pull request description. |

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/tasks/gh_issues.rs` (create) | Pure parsers, the field list, argv builders, branch and worktree paths, `GhIssueProvider` |
| `src-tauri/src/tasks/slug.rs` (create) | `slug`, moved out of `gh_pr.rs` so both callers can see it — the library cannot reach the binary's modules (Task 5, Step 1) |
| `src-tauri/src/tasks/mod.rs` (modify) | Two lines for the two new modules |
| `src-tauri/src/gh_pr.rs` (modify) | Re-export `slug` from its new home; `worktree_on_branch` for the reuse lookup |
| `src-tauri/src/tasks/model.rs` (modify) | `Task.labels` |
| `src-tauri/src/tasks/provider.rs` (modify) | `TaskPatch.reason` |
| `src-tauri/src/model.rs` (modify) | `TrackerProvider`'s tolerant `Unknown(Value)` variant (#117), then its `GitHub` variant |
| `src-tauri/src/store.rs` (modify) | `try_read_vec` stops turning a parse error into an empty list (#117), plus the tests that pin both halves |
| `src-tauri/src/tasks_cmd.rs` (modify) | `tracker_kind`, `board_for`, `fs_provider_for`, `provider_for` boxed, `board_editable`, the six file-only refusals, the open-count cache, `tracker_open_count` |
| `src-tauri/src/commands.rs` (modify) | `AppState` caches, the repo-facts resolution, the stdin-carrying `gh` runner, `issue_totals`, three issue worktree commands, `session_env`, `start_session`, `pr_worktree_add`'s reuse lookup, `pr_list_argv`'s `-R` |
| `src-tauri/src/bin/cowork_task.rs` (modify) | `guard`'s GitHub branch, dispatched before `COWORK_TASKS_DIR` is read |
| `src-tauri/tests/cowork_task.rs` (modify) | The four new `guard` cases |
| `src-tauri/src/main.rs` (modify) | Register the new commands |
| `src/ipc.ts` (modify) | Types and wrappers |
| `src/issues.ts` (create) | Pure: the poll interval, the totals gate, the count line, the confirmation rule, the rate banner |
| `src/tasks.ts` (modify) | `issuePrompt` beside `taskPrompt` |
| `src/board.ts` (modify) | The ⚙ gate, the age line, the unavailable box, the count line, label chips |
| `src/pr-view.ts` (modify) | Export the three unavailable states so the board reads the same sentences |
| `src/main.ts` (modify) | The gated poll chain, the confirmations, the launch path, the cleanup offer |
| `src/sessions.ts` (modify) | `launchOnWorktree` gains an optional `taskId` |
| `src/forms.ts` (modify) | The third root choice, the switch confirmation, `taskForm`'s kind row |
| `src/card-modal.ts` (modify) | The kind select hidden when the board is not editable |
| `src/github.ts` (modify) | One comment: `REQUIRED_SCOPES` is what keeps `projectCards`/`projectItems` out of the field list |
| `tests/issues.test.ts`, `tests/board-github.test.ts` (create) | Frontend tests |
| `tests/tasks.test.ts`, `tests/board.test.ts`, `tests/board-drag.test.ts`, `tests/card-modal.test.ts`, `tests/sessions.test.ts`, `tests/ipc.test.ts`, `tests/forms.test.ts` (modify) | Fixtures and new cases |
| `README.md` (modify) | The second source, and what it does not do |

---

## Phase 1 — Rust foundations

### Task 1/26: A parse error stops emptying the store

**Issue:** #117 (first of its two halves)

**This task fixes a pre-existing bug and must land before Task 3.** It is not part of the feature and it is not caused by it — but the feature's new `TrackerProvider` variant is what makes it reachable on purpose rather than only by accident, so it goes first. The full chain, both fixes and the release-timing constraint are in **#117**; the short version:

`workspaces.json` is a bare JSON array with no envelope and no version field (`store.rs:14`, `:49-53`), parsed as a unit at `store.rs:26`:

```rust
Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
```

One element the binary cannot parse fails the whole document, and `unwrap_or_default()` turns that into `Vec::new()` — an **empty sidebar**, with no error, no log line and nothing to tell it apart from a first run. Then `upsert_workspace` (`store.rs:123-131`) reads through the same function, gets `Ok(vec![])`, pushes one record and calls `save_workspaces`, a bare `fs::write` (`:52`) with no temp-and-rename and no backup. Ten workspaces become one. **The downgrade writes nothing; the first `+ workspace` after it is what destroys the file** — which is precisely what a person does when the sidebar is unexpectedly empty.

The irony worth recording in the commit message: the doc comment at `store.rs:17-23` describes this exact hazard and requires a caller about to overwrite to treat it as a hard stop. Line 26 does the opposite for the parse-error case, because the comment guards only the io path. `#[serde(default)]` on `Workspace.tracker` (`model.rs:125`) and on `providers` (`model.rs:150`) do not help either: they fire on an absent key, never on a present value that fails to parse.

This half protects the three types that go through these two functions — workspaces (`store.rs:55`), skills (`:59`) and the session layout (`:65`), read by `read_vec` and written through the four `try_read_vec` callers at `:124`, `:134`, `:141` and `:151` — and it is worth having independently of any schema change, because `write_vec`'s bare `fs::write` can truncate a file on a crash or a full disk and the recovery path from that is identical. **`ui_state.json` and `schedule_state.json` are not covered**: `ui_state()` has its own `unwrap_or_default()` at `:73` and never touches `try_read_vec`, and `schedule_state` parses through `parse_schedule_state`. Neither is a defect worth a task — a lost window layout is not user data — but the distinction is stated because an earlier draft of this plan claimed the fix covered "every type in the store", and an overclaim is what stops the next reader looking.

**Where the fix does and does not reach, precisely, because the imprecise version of this sentence is wrong.** The unreadable *read* happens in whichever binary is old; the destructive *write* happens in whichever binary is **running**. So this fix is not a workaround for something unpreventable — it prevents the write outright, in every version that carries it, whatever wrote the file. What it cannot do is reach backwards into a copy already installed. That is the whole content of the release-timing constraint above: "ineffective for already-installed builds", never "impossible to fix here".

**And nothing in this plan pins the defect as if it were intended.** An earlier draft carried a test asserting that one bad record empties the list — green, and therefore readable by whoever fixed #117 as a specification of the old behaviour. It is gone: the tests below assert the *fixed* behaviour and fail today, which is the only way round that cannot mislead. If a future task ever does need to document a defect it is not fixing, the doc comment must say it documents rather than endorses, name the issue, and say the test is expected to be deleted or inverted by whoever closes it.

**Files:**
- Modify: `src-tauri/src/store.rs`

**Interfaces:**
- Changes: `Store::try_read_vec` propagates a parse error; `Store::read_vec` logs it

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/store.rs`:

```rust
    /// The test that fails today, and the whole of #117 in one assertion: a
    /// populated file with one unreadable record must not be overwritten by the
    /// next save. `try_read_vec` returning `Ok(vec![])` for a parse error is
    /// indistinguishable from "no workspaces yet", so the upsert wrote one record
    /// over ten.
    #[test]
    fn an_upsert_refuses_rather_than_truncating_a_file_it_could_not_parse() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        let original = r##"[{"id":"w1","name":"A","path":"/a","color":"#fff"},
                            {"id":"w2","name":"B","path":"/b","color":"#fff",
                             "tracker":{"providers":[{"type":"jira"}],"v":3}}]"##;
        // NOTE (correction, 2026-07-30, found while executing Task 2): this
        // fixture must NOT be an unknown provider tag. Task 2 makes
        // `{"type":"jira"}` parse by design, so this test then finds a readable
        // file, `upsert_workspace` succeeds, and `expect_err` panics — while
        // Task 2's own `a_workspace_with_an_unreadable_source_still_appears_in_the_list`
        // uses the same string to assert the opposite. Use a record missing a
        // required field instead: `{"id":"w2","name":"B","path":"/b"}` fails with
        // `missing field \`color\`` (`Workspace.color` has no `serde(default)`) and
        // stays unparseable through every future provider variant. Task 2's
        // commit carries that change.
        std::fs::write(s.ws_path(), original).unwrap();

        let err = s
            .upsert_workspace(Workspace {
                id: "w3".into(), name: "C".into(), path: "/c".into(), color: "#fff".into(),
                github: None, tracker: None,
            })
            .expect_err("a file we could not parse must never be overwritten");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        // The bytes are what matter: not "the list still has two entries" (the
        // read cannot produce them yet), but "nothing was lost".
        assert_eq!(std::fs::read_to_string(s.ws_path()).unwrap(), original);
    }

    /// `delete_workspace` reads through the same function and would truncate the
    /// same way. Both write paths, because a fix applied to one of them is a fix
    /// somebody will assume covers the other.
    #[test]
    fn a_delete_refuses_on_an_unparseable_file_too() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.ws_path(), "[{ not json at all }]").unwrap();
        assert!(s.delete_workspace("w1").is_err());
    }

    /// All four write paths, not two. `try_read_vec`'s callers are `store.rs:124`
    /// (upsert workspace), `:134` (delete workspace), `:141` (upsert skill) and
    /// `:151` (delete skill), and a fix applied to some of them is a fix somebody
    /// will assume covers the rest.
    #[test]
    fn the_refusal_covers_both_skill_write_paths_as_well() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.sk_path(), "[{ not json }]").unwrap();
        assert!(s
            .upsert_skill(Skill {
                id: "s1".into(), name: "S".into(), icon: "play".into(),
                prompt: "p".into(), workspace_id: None, schedule: None,
            })
            .is_err());
        assert!(s.delete_skill("s1").is_err());
    }

    /// A listing still degrades to empty — `list_workspaces` returns `Vec`, not
    /// `Result` (`commands.rs:89-92`), so there is no channel to the UI and
    /// inventing one is out of this task's scope. What changes is that it is no
    /// longer *silent*: the warning `read_vec` already prints for an io error now
    /// covers the parse error that was being discarded one level below it.
    #[test]
    fn a_listing_still_degrades_to_empty_but_no_longer_silently() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.ws_path(), "[{ not json }]").unwrap();
        assert!(s.workspaces().is_empty());
    }

    /// The four cases that must keep working, or start working: a missing file is
    /// a first run, an empty array is an empty list, a good file parses — and a
    /// **zero-byte** file is a first run too.
    ///
    /// That last one is not pedantry. `read_to_string` gives `Ok("")`,
    /// `from_str::<Vec<_>>("")` errors, and the refusal this task introduces would
    /// then make every write fail permanently with no way back from inside the
    /// app. And a zero-byte `workspaces.json` is exactly what `write_vec`'s bare
    /// `fs::write` leaves behind if the process dies between the truncate and the
    /// write — the crash case this task's own reasoning names.
    ///
    /// **A truncated-but-non-empty file keeps the refusal**, and the difference is
    /// deliberate: empty carries no information, so treating it as "nothing yet"
    /// loses nothing, while half a JSON array is evidence of records that a save
    /// would destroy. Do not "simplify" this into a general parse-failure
    /// fallback; that is the bug this task exists to fix.
    #[test]
    fn a_missing_or_empty_file_is_a_first_run_and_a_good_one_still_parses() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        assert!(s.workspaces().is_empty());
        std::fs::write(s.ws_path(), "").unwrap();
        assert!(s.workspaces().is_empty(), "a zero-byte file must not wedge every write");
        assert!(s.delete_workspace("nobody").is_ok(), "and must not be a hard stop either");
        std::fs::write(s.ws_path(), "   \n").unwrap();
        assert!(s.workspaces().is_empty(), "whitespace only, same thing");
        std::fs::write(s.ws_path(), "[]").unwrap();
        assert!(s.workspaces().is_empty());
        std::fs::write(
            s.ws_path(),
            r##"[{"id":"w1","name":"A","path":"/a","color":"#fff"}]"##,
        )
        .unwrap();
        assert_eq!(s.workspaces().len(), 1);
    }
```

`ws_path` and `sk_path` are private; the test module is inside the same file, so they are reachable. If a helper named `tmp()` is not already in that module, use `tempfile::tempdir()` and keep the guard bound, as the existing tests do.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test store`
Expected: FAIL — `an_upsert_refuses_rather_than_truncating_a_file_it_could_not_parse` panics on `expect_err`, and the file has been rewritten with one record. That failure *is* the bug.

- [ ] **Step 3: Write minimal implementation**

```rust
    /// Reads and parses a JSON array file. A missing file is a normal, expected
    /// case (first run) and yields an empty Vec. Every other outcome — an io
    /// error *or a parse error* — is propagated, so a caller about to overwrite
    /// the file stops instead of proceeding with an empty in-memory list.
    ///
    /// The parse error used to be swallowed here by `unwrap_or_default()`, which
    /// made one unreadable record indistinguishable from an empty store and let
    /// the next `upsert` write that emptiness back over a populated file (#117).
    /// The doc comment below already required the hard stop; it only ever got it
    /// for the io half.
    fn try_read_vec<T: serde::de::DeserializeOwned>(path: &PathBuf) -> std::io::Result<Vec<T>> {
        match std::fs::read_to_string(path) {
            // An empty file is a first run, not a corrupt one: `write_vec`
            // truncates before it writes, so this is what a crash mid-write
            // leaves behind, and refusing it would wedge every save with no
            // recovery inside the app. A *non-empty* file we cannot parse still
            // refuses — half an array is evidence of records a save would
            // destroy, and an empty one is evidence of nothing.
            Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
            Ok(s) => serde_json::from_str(&s).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("{} is not readable as JSON: {e}", path.display()),
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }
```

`read_vec` needs no change at all: it already logs whatever `try_read_vec` returns as `Err` and degrades to empty for a listing, which is now the *only* place the degradation happens and the only place it is announced. Widen its warning's wording from "failed to read" to "failed to read or parse" so the message matches what it now covers.

`ErrorKind::InvalidData` rather than `Error::other`: the kind is what the test asserts on, and it is the one that says "the bytes were there and they were wrong" rather than "the disk was".

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, 286 + 5. Any *existing* test that now fails is a caller relying on the old truncation behaviour and must be reported rather than adjusted.

- [ ] **Step 5: Commit**

On a branch cut from **`main`**, not from the feature branch — see Barrier 0:

```bash
# On worktree-workspace-github-account, with everything else — see Barrier 0.
git add src-tauri/src/store.rs
git commit -m "fix(store): a file we could not parse is never overwritten (#117)"
```

---

### Task 2/26: A tracker source this build does not know survives the round trip

**Issue:** #117 (second of its two halves)

Task 1 stops the loss; this stops the *disappearance*. With only Task 1, a build older than a schema addition opens to an empty sidebar and refuses to save — safe, and still useless. What is wanted is the record staying **visible**: a workspace that renders with its name, folder, colour and account intact, and a board that says its task source was written by a newer version.

The precedent to copy rather than invent is `ScheduleRunOnDisk` (`model.rs:60-88`) plus `parse_schedule_state` (`:83`), added for exactly this reason, with its test at `store.rs:308-319`: an `#[serde(untagged)]` helper enum that accepts the shape it knows and falls back rather than failing.

**Round-tripping is the part that cannot be skipped.** A unit `#[serde(other)]` variant would parse an unknown provider and then *serialize it back as `{"type":"unknown"}`* — so the first save of that workspace would destroy the configuration this task exists to preserve. The variant therefore carries the original JSON and writes it back verbatim.

**Files:**
- Modify: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/tasks_cmd.rs` (the `match` arms that now have a third case)

**Interfaces:**
- Produces: `TrackerProvider::Unknown(serde_json::Value)`, with hand-written `Serialize`/`Deserialize`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/model.rs`:

```rust
    /// The record stays visible: one unreadable *provider* must not cost the
    /// workspace its name, its folder or its account.
    #[test]
    fn a_workspace_with_an_unknown_provider_keeps_every_other_field() {
        let json = r##"{"id":"w1","name":"A","path":"/a","color":"#fff",
            "github":{"host":"github.com","login":"me"},
            "tracker":{"providers":[{"type":"jira","site":"acme.atlassian.net"}],"v":3}}"##;
        let w: Workspace = serde_json::from_str(json).expect("the workspace survives");
        assert_eq!(w.name, "A");
        assert_eq!(w.github.unwrap().login, "me");
        assert!(matches!(
            w.tracker.unwrap().providers.first(),
            Some(TrackerProvider::Unknown(_))
        ));
    }

    /// And saving it does not destroy it. A unit catch-all variant would write
    /// `{"type":"unknown"}` here and the configuration would be gone on the first
    /// edit of an unrelated field.
    #[test]
    fn an_unknown_provider_is_written_back_verbatim() {
        let json = r#"{"providers":[{"type":"jira","site":"acme.atlassian.net"}],"v":3}"#;
        let cfg: TrackerConfig = serde_json::from_str(json).unwrap();
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back["providers"][0]["type"], "jira");
        assert_eq!(back["providers"][0]["site"], "acme.atlassian.net");
    }

    /// The known shapes are unaffected, in both directions — this is the test
    /// that would catch an untagged helper enum silently swallowing a *typo* in a
    /// known variant's own fields, which would be the tolerance going too far.
    #[test]
    fn the_known_providers_still_parse_as_themselves() {
        let cfg: TrackerConfig =
            serde_json::from_str(r#"{"providers":[{"type":"fs","root":{"kind":"project"}}],"v":3}"#)
                .unwrap();
        assert!(matches!(cfg.providers.first(), Some(TrackerProvider::Fs { .. })));
        let back = serde_json::to_string(&cfg).unwrap();
        assert!(back.contains(r#""type":"fs""#), "{back}");
    }

    /// An `fs` provider missing its `root` is *not* an unknown source, it is a
    /// damaged one — but it must still not cost the workspace. Kept as
    /// `Unknown`, which is the honest reading: this build cannot use it.
    #[test]
    fn a_malformed_known_provider_is_kept_rather_than_fatal() {
        let cfg: TrackerConfig =
            serde_json::from_str(r#"{"providers":[{"type":"fs"}],"v":3}"#).unwrap();
        assert!(matches!(cfg.providers.first(), Some(TrackerProvider::Unknown(_))));
    }
```

and to `mod tests` in `src-tauri/src/store.rs`:

```rust
    /// Task 1 stops the truncation; this is the other half of #117 — the record
    /// is not merely safe on disk, it is on screen.
    #[test]
    fn a_workspace_with_an_unreadable_source_still_appears_in_the_list() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(
            s.ws_path(),
            r##"[{"id":"w1","name":"A","path":"/a","color":"#fff"},
                 {"id":"w2","name":"B","path":"/b","color":"#fff",
                  "tracker":{"providers":[{"type":"jira"}],"v":3}}]"##,
        )
        .unwrap();
        let all = s.workspaces();
        assert_eq!(all.len(), 2, "neither record is dropped");
        assert_eq!(all[1].name, "B");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test model && cargo test store`
Expected: FAIL — `unknown variant jira`, and with Task 1 in place the store test now fails with a refusal rather than an empty list.

- [ ] **Step 3: Write minimal implementation**

In `src-tauri/src/model.rs`:

```rust
#[derive(Debug, Clone)]
pub enum TrackerProvider {
    Fs { root: TrackerRoot },
    /// A source this build cannot read — written by a newer version, or damaged.
    ///
    /// Carries the original JSON and is serialized back verbatim, so opening an
    /// older build and editing an unrelated field does not destroy a
    /// configuration it merely does not understand (#117). A unit catch-all
    /// variant would round-trip to `{"type":"unknown"}` and do exactly that.
    ///
    /// Every reader treats it as "no usable tracker": `resolve_root` yields
    /// `None`, `is_project_root` is false, and the board says so in words rather
    /// than showing "no tracker configured", which would be a different claim.
    Unknown(serde_json::Value),
}

/// The on-disk shape, accepted tolerantly. The same pattern as
/// `ScheduleRunOnDisk` above: an untagged helper that tries the known shapes and
/// keeps the raw value rather than failing the document.
#[derive(Deserialize)]
#[serde(untagged)]
enum TrackerProviderOnDisk {
    Known(KnownTrackerProvider),
    Raw(serde_json::Value),
}

/// The tag spelling lives here and nowhere else. **Both directions are derived**,
/// so they cannot disagree about it.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum KnownTrackerProvider {
    Fs { root: TrackerRoot },
}

impl<'de> Deserialize<'de> for TrackerProvider {
    /* via TrackerProviderOnDisk: Known(k) => k.into(), Raw(v) => Unknown(v) */
}

impl Serialize for TrackerProvider {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            // Delegated, never hand-rolled: writing `{"type":"fs", …}` by hand
            // here would put the tag spelling in a second place, and the one
            // failure this whole task exists to prevent is a silent change to the
            // wire format of every user's workspaces.json.
            TrackerProvider::Fs { root } => {
                KnownTrackerProvider::Fs { root: root.clone() }.serialize(s)
            }
            // Verbatim in *value*, not in bytes: `serde_json::Value`'s object is a
            // BTreeMap, so keys come back alphabetised and whitespace is the
            // writer's. Nothing anywhere compares these bytes, so this is
            // harmless — said out loud because a re-ordered key list looks like a
            // bug to whoever diffs the file next.
            TrackerProvider::Unknown(v) => v.serialize(s),
        }
    }
}
```

Task 3 then adds `GitHub` to **both** `TrackerProvider` and `KnownTrackerProvider`. With the delegation above, forgetting the second one is *nearly* a compile error — the `match` forces an arm for the new variant — but not quite: an author could satisfy the compiler and still leave the deserialiser mapping `{"type":"github"}` to `Unknown`. **The guard for that is the `matches!(…, Some(TrackerProvider::GitHub))` line in Task 3's round-trip test, and nothing else.** In particular the `back.contains(r#"{"type":"github"}"#)` half of that test does *not* guard it: `Unknown(v)` re-emits its input verbatim, so the serialized output is identical either way and that assertion passes in exactly the scenario it looks like it is checking. Task 3's test carries a comment saying so, or the `matches!` line reads as redundant and gets trimmed, taking the guard with it.

**One `match` site needs an arm, not three** (correction, 2026-07-30, from executing this task — the compiler named only this one in its E0004): `resolve_root` (`tasks_cmd.rs:157`) → `None`. `is_project_root` (`:201`) is a `matches!` against `Fs { Project }` and is already `false` for anything else; `seed_previous_location` (`:264`) already routes everything else through `_ => return ws`. Adding arms to either would be dead weight.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, plus 5.

- [ ] **Step 5: Commit**

On `worktree-workspace-github-account`, like every other task (Barrier 0):

```bash
git add src-tauri/src/model.rs src-tauri/src/tasks_cmd.rs src-tauri/src/store.rs
git commit -m "fix(store): keep a tracker source this build cannot read, verbatim (#117)"
```

Then continue to Task 3. Reference #117 in the eventual pull request description, with the two tests that failed before these two tasks named in it — that is where the fix gets its record, since it no longer gets a release of its own.

> **What this does not fix, stated so it is not assumed.** Tolerance in *this* build helps only builds from here on: a version already installed still empties the list, which the declined release barrier below accounts for and which Task 26's README warning now has to carry alone. And a workspace record that fails for a reason other than its provider — a future required field — still costs that one record; Task 1's refusal is the backstop that keeps it from costing the file.
>
> **The `Unknown` mapping is one-way, by design, and permanently.** `untagged` cannot tell "a source from the future" from "a known source that is damaged" — `{"type":"fs"}` with no `root` becomes `Unknown` too, which is the honest reading for *this* build and the reason the message in Task 8 names both possibilities. But the record is then re-emitted verbatim for ever: as far as the app is concerned it has stopped being an `Fs` record, so a later build that fixes whatever damaged it cannot repair it either. Repairing such a record means editing `workspaces.json` by hand, or reconfiguring the tracker in the workspace form, which overwrites the provider outright. That is an acceptable price for not losing the workspace — and it is the kind of thing that must be written down rather than discovered by the one person it happens to.

---

> ### Barrier 0 — the release barrier that was, and the decision that replaced it
>
> **Decided by the user on 2026-07-30: all twenty-six tasks are executed on `worktree-workspace-github-account`, in this worktree. There is no separate branch for Tasks 1–2 and no release between Task 2 and Task 3.** What follows is kept rather than deleted, because the cost of that decision is only legible next to what was being bought.
>
> **What was proposed.** Tasks 1 and 2 on their own branch cut from `main` — not from this one, which carries 37 unmerged commits of the pull request view (epic #113) that a release from here would drag along — then their own pull request against #117, then a release, and only then Task 3. Three test barriers sit further down this plan and each is satisfied by running a suite; this one could not be satisfied by running anything, which is why it was labelled differently.
>
> **What the decision costs, precisely.** Twenty-six tasks on one branch produce one release, and that release carries both the tolerance and the `{"type":"github"}` variant. The tolerance therefore protects **nobody who already has the app installed**: the only build that would ever have needed it is one released *before* the variant existed, and no such build will exist. A user on any current build who configures a GitHub board and then rolls back still meets the full chain in #117 — empty sidebar, then permanent loss on the next `+ workspace`.
>
> **What Tasks 1 and 2 are still worth, which is not nothing.** Three things survive intact, and they are why the tasks stay in the plan rather than being dropped:
>
> 1. **Every future schema addition is covered** — Jira most immediately, which is the next `TrackerProvider` variant the spec's "Neighbouring specs" names. This is the same one-way door, and it only has to be closed once.
> 2. **A truncated or zero-byte store file no longer destroys the rest of it.** `write_vec` is a bare `fs::write` (`store.rs:52`) that truncates before writing, so a crash, a kill or a full disk mid-write leaves exactly that. No downgrade is involved, and this is reachable today.
> 3. **An unreadable record stays visible and keeps its data.** Task 8's `capabilities_for` branch explains it on the board instead of the workspace silently vanishing.
>
> **Ordering still holds, for a compiler reason rather than a release one.** Tasks 1 and 2 remain first: Task 3's tests reference `KnownTrackerProvider` from Task 2 and will not compile without it. The three test barriers below are unaffected. Barrier A's cross-check — that Tasks 1–2's tests appear in its cargo count — now proves only that the tasks were done, not that they were released.
>
> **Task 26's README warning becomes more important, not less.** It now covers every build up to and including the one that ships the variant, which is every build there will ever have been. It must point at #117 as the forward fix and must not present copying the file as the answer.

---

### Task 3/26: The model widens, and what an older build does with it

**Issue:** _(file it)_

Two one-line model changes, now that Tasks 1 and 2 have made the first of them safe. Decision 2 asked what an older build does with `{"type":"github"}`; #117 is the answer, and the tolerance and the refusal that contain it are already in. What is left here is the variant itself, `Task.labels`, and the test that pins the *new* behaviour rather than the old.

**Two things the same investigation settled, so nobody re-derives them:**

- **`Task.labels` is safe in both directions and needs nothing beyond `#[serde(default)]`.** `Task` is not persisted in the store, and cards are never read by serde at all: `frontmatter::parse_card` (`tasks/frontmatter.rs:43`) is a hand-written line scanner that ignores keys it does not know, and writes are line-level edits (`fs.rs:249`, `frontmatter.rs:159`) specifically to preserve them — the comments at `fs.rs:220-223` and `frontmatter.rs:155-157` say so. An older build reading, editing and saving a card with a `labels:` line keeps that line. The `default` matters only at the IPC boundary, exactly as `Task.conflict` does (`tasks/model.rs:28-29` — the tracker's `Task`, not the workspace model).
- **`ProviderCapabilities` is never deserialized** — built per call and serialized outward only, flattened at `tasks_cmd.rs:317-326`. It *derives* `Deserialize` (`provider.rs:8`, on the struct at `:10-14`); nothing anywhere calls it, which is the claim that matters. So widening it is a pure IPC-shape change. Task 8 adds `board_editable` to `BoardCapabilities` and puts `#[serde(default)]` on it anyway: none of those fields has one today, and the insurance costs a line.

**Files:**
- Modify: `src-tauri/src/tasks/model.rs`, `src-tauri/src/tasks/frontmatter.rs`, `src-tauri/src/tasks/fs.rs`, `src-tauri/src/tasks/migrate.rs`
- Modify: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/tasks_cmd.rs` — `resolve_root`'s match, which **does not compile** without a `GitHub` arm
- Modify: `src-tauri/src/store.rs` (tests only)

**Interfaces:**
- Produces: `Task.labels: Vec<String>`; `TrackerProvider::GitHub`
- Consumes: `KnownTrackerProvider` (Task 2) — the variant goes in **both** enums

**The exhaustiveness trap, first, because it fails four tasks downstream rather than this one's step 4.** `resolve_root`'s match (`tasks_cmd.rs:157-172`) has exactly two arms, both `Fs`, and **no catch-all**. Adding a variant to `TrackerProvider` without adding an arm there is E0004 — the crate stops compiling, so this task's own tests, Tasks 4–6 and Barrier A all fail with an error that says nothing about GitHub issues. Task 2 got this right for `Unknown` and this task must copy it. The arm belongs here, not in Task 7 where an earlier draft put it:

```rust
        // Not a path-shaped tracker at all. `None` is the same answer as "no
        // tracker configured", and it is correct for every path-shaped caller: no
        // watcher, no migration offer, no step rewrite, no board editor. The one
        // caller for which it is *not* enough is `start_session`, which asks
        // `tracker_kind` instead (Tasks 7 and 12).
        TrackerProvider::GitHub => None,
```

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/model.rs`:

```rust
    /// `{"type":"github"}` is the whole encoding: the repository is resolved
    /// from the workspace's folder (decision 11), so a field for it here would
    /// be a second source of truth that can disagree with the git remote.
    #[test]
    fn the_github_tracker_provider_carries_no_fields() {
        let cfg: TrackerConfig =
            serde_json::from_str(r#"{"providers":[{"type":"github"}],"v":3}"#).expect("parses");
        // THIS is the line that guards against the variant being added to
        // `TrackerProvider` but not to `KnownTrackerProvider` — the one mistake
        // Task 2's two-enum shape makes possible. Do not trim it as redundant.
        assert!(matches!(cfg.providers.first(), Some(TrackerProvider::GitHub)));
        let back = serde_json::to_string(&cfg).unwrap();
        // And this line guards nothing of the sort, which is worth knowing: with
        // the variant missing from `KnownTrackerProvider` the value deserializes
        // to `Unknown` and is re-emitted verbatim, so this assertion passes in
        // exactly the scenario it looks like it is checking. It is here for the
        // encoding, not for the wiring.
        assert!(back.contains(r#"{"type":"github"}"#), "round trip: {back}");
    }

    /// A card file has no labels, and every record written before this change
    /// has no such key. `#[serde(default)]` is what keeps them all readable.
    #[test]
    fn a_task_without_labels_still_deserializes() {
        let json = r#"{"id":"01A","title":"t","kind":"bug","status":"open","project":"deck",
            "created":"2026-01-01T00:00:00Z","resolved":null,"origin":"human","session":null,
            "body":"","path":"/r/01A.md","damaged":null,"conflict":false}"#;
        let t: crate::tasks::model::Task = serde_json::from_str(json).expect("parses");
        assert!(t.labels.is_empty());
    }
```

Add to `mod tests` in `src-tauri/src/store.rs` — the one that answers decision 2's question as it now stands, with Tasks 1 and 2 in place:

```rust
    /// Decision 2's open question, answered against the fixed store rather than
    /// the broken one. A `{"type":"github"}` record read by a build that has the
    /// tolerance but not the variant costs that workspace its *tracker* and
    /// nothing else — not the workspace, and not the file.
    ///
    /// What remains is not a hole in the fix, it is the reach of it: a build
    /// older than Task 1 empties the list, and its own `upsert_workspace` — not
    /// this one — then writes that emptiness back (#117). The destructive write
    /// always happens in whichever binary is running, which is exactly why the
    /// tolerance works from here on and exactly why it does nothing for a version
    /// already installed. Hence the release order in "Phases and barriers", and
    /// hence the README's warning for the builds behind that line.
    #[test]
    fn a_github_source_read_by_a_build_without_it_costs_one_tracker_not_the_file() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        // What an intermediate build sees: a variant it does not know, through
        // Task 2's tolerance. `jira` stands in for it, because this build *does*
        // know `github` now and cannot play the older one against itself.
        std::fs::write(
            s.ws_path(),
            r##"[{"id":"w1","name":"A","path":"/a","color":"#fff",
                  "tracker":{"providers":[{"type":"jira"}],"v":3}},
                 {"id":"w2","name":"B","path":"/b","color":"#fff"}]"##,
        )
        .unwrap();
        let all = s.workspaces();
        assert_eq!(all.len(), 2, "both records survive");
        assert!(matches!(
            all[0].tracker.as_ref().and_then(|c| c.providers.first()),
            Some(TrackerProvider::Unknown(_)),
        ));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test github_tracker_provider && cargo test costs_one_tracker`
Expected: FAIL — `no variant named GitHub`, `no field labels`. The store test passes already, on Task 2's work; it is here because this is the task whose change it describes, and because a later edit that drops the variant from `KnownTrackerProvider` would turn `github` itself into `Unknown` and this pair of tests is what says so.

- [ ] **Step 3: Write minimal implementation**

`src-tauri/src/model.rs`:

```rust
pub enum TrackerProvider {
    Fs { root: TrackerRoot },
    /// The workspace's board is the GitHub issues of the repository its folder
    /// *is*. No fields: `owner/name` comes from `gh` itself, once per app run
    /// (decision 11), and storing it here would be a second source of truth.
    ///
    /// A build predating this variant reads it as `Unknown` and keeps the rest of
    /// the workspace (#117, Task 2). A build predating *that* empties the whole
    /// list, and its own next save makes it permanent — the write happens in
    /// whichever binary is running, so the fix is effective from here on and
    /// inert for anything already installed. The README warns about that half.
    GitHub,
    Unknown(serde_json::Value),
}
```

and the same variant in `KnownTrackerProvider`, whose `#[serde(tag = "type", rename_all = "lowercase")]` is what makes it `{"type":"github"}` on the wire. Both, or the round-trip test below fails by reporting `github` as unknown — which is exactly the failure that guard exists for.

`src-tauri/src/tasks/model.rs`, on `Task`:

```rust
    /// Issue labels, as chips in the meta row. Never a `kind`: an issue can
    /// carry two labels and `kind` is a single-valued select. `default` because
    /// every card file ever written lacks the key, and a file card has none.
    #[serde(default)]
    pub labels: Vec<String>,
```

Then add `labels: Vec::new()` at **all four** construction sites — two in normal code and two inside `#[cfg(test)]` modules, which `cargo test` compiles and which therefore fail the build just as loudly: `frontmatter.rs:90` (a parsed card file), `fs.rs:195` (`create`), `frontmatter.rs:530` and `migrate.rs:185` (both test helpers). **Corrected twice, so trust the compiler over this sentence:** an earlier draft said three and would have sent an agent hunting a compile error it had been told did not exist; a later one said five, counting `fs.rs:660`'s `a_card`, which *returns* a `Task` but builds it through `p.create(TaskDraft { … })` and so carries no field list. `grep -n 'Task {' src-tauri/src` and `cargo check --all-targets` both say four. `frontmatter.rs`'s `render_card` needs no change — it writes nine named keys and `labels` is not one of them, which is correct: a file card has no labels to write.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, 286 + 3.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/model.rs src-tauri/src/store.rs src-tauri/src/tasks_cmd.rs src-tauri/src/tasks/model.rs src-tauri/src/tasks/frontmatter.rs src-tauri/src/tasks/fs.rs src-tauri/src/tasks/migrate.rs
# tasks_cmd.rs is NOT optional here (correction, 2026-07-30, proven while executing
# this task): reverting it alone and running `cargo check --all-targets` gives
# E0004 twice over. Omitting it lands a commit that does not compile.
git commit -m "feat(issues): a github tracker variant, and labels on a card"
```

---

### Task 4/26: `gh_issues.rs` — the issue-to-card mapping and the field-list guard

**Issue:** _(file it)_

The whole of decision 4 in one pure function, plus the constant that decides what `gh` is asked for. The guard test has two halves and the second is the load-bearing one: `projectCards` and `projectItems` fail the *entire* request without `read:project`, which the app does not require of a bound account (`src/github.ts:27`), so one added field would blank the board for everyone.

**Files:**
- Create: `src-tauri/src/tasks/gh_issues.rs`
- Modify: `src-tauri/src/tasks/mod.rs`
- Modify: `src/github.ts` — a comment only, the back pointer the spec's change table requires

**Interfaces:**
- Produces: `ISSUE_LIST_FIELDS`, `parse_issues(json, project)`, `parse_issue(json, project)`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/tasks/gh_issues.rs` with the constant, the module doc and the test module:

```rust
//! The GitHub issues provider: pure parsers over `gh issue list --json`, argv
//! builders, and a `TaskProvider` over an injected runner. Follows `gh_pr.rs`:
//! nothing here runs a process, so every rule has a test with no network.
use crate::tasks::board::{KindId, StepId};
use crate::tasks::model::{Task, TaskOrigin};

/// Exactly the fields the board reads, and no others.
///
/// **`projectCards` and `projectItems` must never be added.** Without the
/// `read:project` scope they fail the *entire* request — exit 1, empty stdout —
/// and the app requires only `repo` of a bound account (`src/github.ts:27`), so
/// one added field would blank the board for every account without it. GitHub
/// Projects support starts with a scope, in a spec of its own.
///
/// **`comments` is excluded too**, for three reasons before payload is
/// considered: nothing reads it, it is silently capped at 100 in list mode, and
/// there is no `commentsCount` field, so any count derived from it lies above
/// 100. `body` *is* included: measured at 85 KB for 50 issues and 0.05 s, which
/// is not worth a second call and a loading state in the card modal.
pub const ISSUE_LIST_FIELDS: &str = "number,title,state,createdAt,closedAt,body,labels,url";

#[cfg(test)]
mod tests {
    use super::*;

    /// One row with every field the list asks for, as `gh issue list` really
    /// returns them: `state` uppercase, `closedAt` null while open.
    const OPEN_ROW: &str = r#"[{
        "number": 42,
        "title": "Sidebar badge sticks after a rename",
        "state": "OPEN",
        "createdAt": "2026-07-01T10:00:00Z",
        "closedAt": null,
        "body": "Steps to reproduce…",
        "labels": [{"id":"L1","name":"bug","description":"","color":"d73a4a"}],
        "url": "https://github.com/followLemmi/cowork-deck/issues/42"
    }]"#;

    #[test]
    fn an_open_issue_maps_field_by_field() {
        let t = &parse_issues(OPEN_ROW, "cowork-deck").unwrap()[0];
        // The number, not the GraphQL node id: it is what `gh issue close`
        // takes, what a person types, and what goes in the branch name.
        assert_eq!(t.id, "42");
        assert_eq!(t.title, "Sidebar badge sticks after a rename");
        assert_eq!(t.status.as_str(), "open");
        // The *workspace's* name, not the repository's: `boardColumns` filters
        // on it and `launchFromTask` resolves the workspace by it.
        assert_eq!(t.project, "cowork-deck");
        assert_eq!(t.created, "2026-07-01T10:00:00Z");
        assert_eq!(t.resolved, None);
        assert_eq!(t.labels, vec!["bug".to_string()]);
        assert_eq!(t.path, "https://github.com/followLemmi/cowork-deck/issues/42");
        assert_eq!(t.body, "Steps to reproduce…");
        // Nothing on an issue maps to a kind: `gh issue list --json` exposes no
        // issue-type field at all, and `kindLabel` omits the chip for "".
        assert_eq!(t.kind.as_str(), "");
        // `origin` exists to make agent-filed cards visible. An agent files
        // through `gh issue create` under the workspace's own account, so the
        // distinction does not survive the round trip — Human, and the chip
        // never appears. A loss, stated rather than faked.
        assert!(matches!(t.origin, TaskOrigin::Human));
        assert_eq!(t.session, None);
        assert_eq!(t.damaged, None);
        // `gh` returns a whole row or the call fails, and issue numbers are
        // unique per repository by construction.
        assert!(!t.conflict);
    }

    #[test]
    fn a_closed_issue_carries_its_close_time_and_the_closed_step() {
        let json = r#"[{"number":7,"title":"t","state":"CLOSED",
            "createdAt":"2026-06-01T00:00:00Z","closedAt":"2026-06-02T00:00:00Z",
            "body":"","labels":[],"url":"u"}]"#;
        let t = &parse_issues(json, "deck").unwrap()[0];
        assert_eq!(t.status.as_str(), "closed");
        assert_eq!(t.resolved.as_deref(), Some("2026-06-02T00:00:00Z"));
    }

    /// `stateReason` is out of the field set (nothing reads it back), so the
    /// three closed reasons must not change the mapping at all. Written as a
    /// fixture because the target repository has no issue exercising them.
    #[test]
    fn a_state_reason_on_the_row_changes_nothing() {
        for r in ["COMPLETED", "NOT_PLANNED", "DUPLICATE"] {
            let json = format!(
                r#"[{{"number":7,"title":"t","state":"CLOSED","stateReason":"{r}",
                    "createdAt":"c","closedAt":"d","body":"","labels":[],"url":"u"}}]"#
            );
            let t = &parse_issues(&json, "deck").unwrap()[0];
            assert_eq!(t.status.as_str(), "closed", "reason {r}");
        }
    }

    /// Two labels is the case that rules `kind` out entirely, and the order the
    /// row gives is the order the chips show in.
    #[test]
    fn every_label_survives_in_order() {
        let json = r#"[{"number":1,"title":"t","state":"OPEN","createdAt":"c","closedAt":null,
            "body":"","labels":[{"name":"bug"},{"name":"good first issue"}],"url":"u"}]"#;
        let t = &parse_issues(json, "deck").unwrap()[0];
        assert_eq!(t.labels, vec!["bug".to_string(), "good first issue".to_string()]);
    }

    /// Fixtures, because the target repository exercises none of these: 104 of
    /// 104 issues have `milestone: null`, `assignees: []` and `isPinned: false`.
    /// A green suite against a real repository proves nothing about them.
    #[test]
    fn a_milestone_assignees_and_a_pin_are_ignored_rather_than_fatal() {
        let json = r#"[{"number":9,"title":"t","state":"OPEN","createdAt":"c","closedAt":null,
            "body":"","labels":[],"url":"u",
            "milestone":{"number":3,"title":"v1","dueOn":null},
            "assignees":[{"login":"someone","name":""}],
            "isPinned":true}]"#;
        let t = &parse_issues(json, "deck").unwrap()[0];
        assert_eq!(t.id, "9");
        assert_eq!(t.status.as_str(), "open");
    }

    /// An absent key and a null must behave identically. A bot's `author` omits
    /// `id` and `name` *entirely*; `author` is out of the field set precisely so
    /// that trap cannot bite, and this pins that a row missing optional keys
    /// still parses rather than panicking.
    #[test]
    fn missing_optional_keys_do_not_panic() {
        let json = r#"[{"number":5,"title":"t","state":"OPEN","createdAt":"c"}]"#;
        let t = &parse_issues(json, "deck").unwrap()[0];
        assert_eq!(t.id, "5");
        assert_eq!(t.body, "");
        assert!(t.labels.is_empty());
        assert_eq!(t.resolved, None);
    }

    /// An empty repository is exit 0 and `[]`, which is what lets "no open
    /// issues" be a real state rather than a guess at a failure.
    #[test]
    fn an_empty_list_is_a_legal_answer_not_an_error() {
        assert!(parse_issues("[]", "deck").unwrap().is_empty());
    }

    /// `gh issue view` returns one object, not an array of one, so the single-issue
    /// read needs its own entry point over the same mapping. Same field names —
    /// verified by running `gh issue view 42 --json number,title,state,body,\
    /// labels,url,createdAt,closedAt` — which is what lets both share it.
    #[test]
    fn one_issue_parses_from_a_bare_object() {
        let json = r#"{"number":42,"title":"t","state":"OPEN","createdAt":"c",
            "closedAt":null,"body":"b","labels":[{"name":"bug"}],"url":"u"}"#;
        let t = parse_issue(json, "deck").unwrap();
        assert_eq!(t.id, "42");
        assert_eq!(t.labels, vec!["bug".to_string()]);
    }

    /// An array where an object was expected is a mistake in the caller, not an
    /// empty answer: `gh issue view` on a number that does not exist exits
    /// non-zero, so the runner refuses before this is reached and there is no
    /// "not found" shape for this parser to invent.
    #[test]
    fn a_single_issue_parse_refuses_a_list() {
        assert!(parse_issue("[]", "deck").is_err());
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        assert!(parse_issues("{ not json", "deck").is_err());
        assert!(parse_issues("", "deck").is_err());
    }

    /// The field list and the parser have to agree, or a rename in one of them
    /// silently empties a column. Mirrors `gh_pr.rs`'s own guard.
    #[test]
    fn every_requested_field_is_read() {
        for f in ["number", "title", "state", "createdAt", "closedAt", "body", "labels", "url"] {
            assert!(
                ISSUE_LIST_FIELDS.split(',').any(|x| x == f),
                "{f} missing from ISSUE_LIST_FIELDS",
            );
        }
    }

    /// The inverse, and the one that matters more. `projectCards` and
    /// `projectItems` fail the whole request without `read:project`, which a
    /// bound account is not required to have; `comments` is capped at 100 with
    /// no count field. This is the only automated defence against someone
    /// adding one field and blanking the board for everyone.
    #[test]
    fn the_field_list_asks_for_nothing_that_can_blank_the_board() {
        for f in ["projectCards", "projectItems", "comments"] {
            assert!(
                !ISSUE_LIST_FIELDS.split(',').any(|x| x == f),
                "{f} must never be in ISSUE_LIST_FIELDS — see the constant's comment",
            );
        }
    }
}
```

Add to `src-tauri/src/tasks/mod.rs`, in alphabetical position:

```rust
pub mod gh_issues;
```

And the back pointer the spec's change table asks for, in `src/github.ts` above `REQUIRED_SCOPES` (`:27`). The forward pointer already exists — `ISSUE_LIST_FIELDS`'s comment names the scope — but the reference that actually protects the field list is the one a person widening the scopes will read:

```ts
/** Scopes a bound account must carry.
 *
 *  `read:project` is deliberately absent, and the issues board depends on that:
 *  `projectCards` and `projectItems` fail an *entire* `gh issue list` request
 *  without it, so `ISSUE_LIST_FIELDS` (src-tauri/src/tasks/gh_issues.rs) must
 *  never ask for them while this list stays as it is. Widening this list is the
 *  first half of GitHub Projects support, not a free improvement. */
```

A comment only — no type or value changes, so `tsc` stays clean and no frontend test moves.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gh_issues`
Expected: FAIL — `cannot find function parse_issues in this scope`.

- [ ] **Step 3: Write minimal implementation**

Above the test module in `src-tauri/src/tasks/gh_issues.rs`:

```rust
/// Read `gh issue list --json <ISSUE_LIST_FIELDS>` into cards.
///
/// Hand-rolled rather than derived, for the same reasons `parse_pull_requests`
/// is (`gh_pr.rs:98-101`): `labels` is an array of objects, `closedAt` is
/// nullable, and several keys are absent rather than null on some rows. A derive
/// would need helper structs and would still fail the whole list on one
/// unexpected null.
///
/// `project` is the *workspace's* name, supplied by the caller. It is
/// load-bearing twice over: `boardColumns` filters `t.project === project`
/// (`tasks.ts:100`) and `launchFromTask` resolves the workspace by it
/// (`main.ts:205`). The repository's name here would empty the board and break
/// the launch button.
///
/// `state` is accepted in the casing `gh issue list` uses — `OPEN`/`CLOSED`.
/// `gh search issues` returns it lowercase; nothing here routes that command's
/// output into this function, and nothing should.
pub fn parse_issues(json: &str, project: &str) -> Result<Vec<Task>, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    Ok(rows.iter().map(|r| row_to_task(r, project)).collect())
}

/// One issue, from `gh issue view <n> --json <ISSUE_LIST_FIELDS>`, which returns a
/// bare object rather than an array. Same mapping, same field names — the two
/// entry points exist only because the two commands wrap the row differently.
pub fn parse_issue(json: &str, project: &str) -> Result<Task, String> {
    let row: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    if !row.is_object() {
        return Err("gh did not return one issue".to_string());
    }
    Ok(row_to_task(&row, project))
}

fn row_to_task(r: &serde_json::Value, project: &str) -> Task {
            let s = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let closed = r.get("state").and_then(|v| v.as_str()) == Some("CLOSED");
            Task {
                id: r.get("number").and_then(|v| v.as_u64()).unwrap_or(0).to_string(),
                title: s("title"),
                // Nothing on an issue maps to a kind. `kindLabel` returns "" for
                // an empty id and `board.ts:264` then omits the chip.
                kind: KindId(String::new()),
                status: StepId(if closed { "closed" } else { "open" }.to_string()),
                project: project.to_string(),
                created: s("createdAt"),
                resolved: r.get("closedAt").and_then(|v| v.as_str()).map(str::to_string),
                origin: TaskOrigin::Human,
                session: None,
                body: s("body"),
                // The field's name is now wrong and the mismatch is recorded in
                // decision 4 rather than paid for: renaming it to `location`
                // across both languages costs more than it buys. A URL is the
                // honest answer to "where does this card live".
                path: s("url"),
                damaged: None,
                conflict: false,
                labels: r
                    .get("labels")
                    .and_then(|v| v.as_array())
                    .map(|ls| {
                        ls.iter()
                            .filter_map(|l| l.get("name").and_then(|v| v.as_str()))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_issues`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks/gh_issues.rs src-tauri/src/tasks/mod.rs src/github.ts
git commit -m "feat(issues): map a gh issue row onto a card, and guard the field list"
```

---

### Task 5/26: Repository facts, the argv builders, and where an issue's worktree goes

**Issue:** _(file it)_

Everything else pure. Three groups, one commit, because each is a handful of lines with its own table of cases and none of them can be wired up until Phase 2.

**Note on one thing the spec could not have got right.** Decision 7's table puts `nameWithOwner` and `defaultBranchRef` in the same GraphQL query as the two `totalCount`s — but `repository(owner:, name:)` *takes* the pair it is supposed to yield, so that query cannot be the first resolution of `owner/name`. This plan splits it in the only way that keeps decision 11's rule ("`gh`'s own answer is authoritative about which remote `gh` would have picked"):

- **the facts call**, `gh repo view --json nameWithOwner,defaultBranchRef`, resolves the repository from the workspace's `cwd` — one point, once per workspace per app run. This is the one call that may rely on `cwd`, because it is the call that discovers what `cwd` means; `pr_merge_options` already uses exactly this shape (`commands.rs:399`).
- **the totals call**, `gh api graphql` with the spec's query, uses the cached `owner/name` — one point, only when the open page came back full.

The point arithmetic of decision 7 is unchanged: two calls a tick, a third only when it can change the answer, a fourth once per app run.

**Files:**
- Create: `src-tauri/src/tasks/slug.rs`
- Modify: `src-tauri/src/tasks/mod.rs`, `src-tauri/src/gh_pr.rs`
- Modify: `src-tauri/src/tasks/gh_issues.rs`

**Interfaces:**
- Produces: `tasks::slug::slug` (moved), `RepoFacts`, `IssueTotals`, `repo_facts_argv()`, `parse_repo_facts(json) -> Result<RepoFacts, String>`, `issue_totals_argv(repo)`, `parse_issue_totals(json) -> Result<IssueTotals, String>`, `issue_list_argv(repo, state, limit)`, `issue_close_argv(repo, number, reason)`, `issue_reopen_argv(repo, number)`, `issue_create_argv(repo, title)`, `issue_edit_argv(repo, number, title)`, `issue_branch(number, title)`, `issue_worktree_path(workspace_path, number, title)`

- [ ] **Step 1: Move `slug` into the library, before anything else**

**`crate::gh_pr::slug` is not reachable from `tasks/gh_issues.rs`, and this is an architecture rule rather than an inconvenience.** `lib.rs` exposes `pub mod tasks` and nothing else, and its doc comment says outright that `tasks` must not depend on the binary's private modules; `gh_pr` is one of those (`mod gh_pr;`, `main.rs:6`). The spec's change table says "`slug` (`:201`) reused as-is", which cannot be done from where the new module lives — that line of the spec has been corrected.

So move the function, do not work around it:

1. Create `src-tauri/src/tasks/slug.rs` holding `slug` verbatim from `gh_pr.rs:201-218`, doc comment included. It has no dependencies at all — it is a `char` loop over a `&str`.
2. Add `pub mod slug;` to `src-tauri/src/tasks/mod.rs`.
3. In `gh_pr.rs`, replace the definition with a re-export: `pub use cowork_deck::tasks::slug::slug;`. `gh_pr.rs`'s four existing `slug` assertions (`:446-453`) and `worktree_path`'s use of it then compile and pass **unchanged** — which is the check that the move was verbatim.
4. `gh_issues.rs` uses `crate::tasks::slug::slug`.

Run `cd src-tauri && cargo test gh_pr` before writing anything else in this task. It must pass with no test edits; if a `slug` assertion fails, the move was not verbatim.

- [ ] **Step 2: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks/gh_issues.rs`:

```rust
    #[test]
    fn the_facts_call_asks_the_repository_about_itself() {
        let argv = repo_facts_argv();
        assert_eq!(argv[0], "repo");
        assert_eq!(argv[1], "view");
        // No -R: this is the one call that resolves *which* repository the
        // workspace folder is, so it has nothing to name it with yet.
        assert!(!argv.iter().any(|a| a == "-R"));
        let at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[at + 1], "nameWithOwner,defaultBranchRef");
    }

    #[test]
    fn repo_facts_read_the_owner_name_and_the_default_branch() {
        let json = r#"{"nameWithOwner":"followLemmi/cowork-deck",
                       "defaultBranchRef":{"name":"main"}}"#;
        let f = parse_repo_facts(json).unwrap();
        assert_eq!(f.repo, "followLemmi/cowork-deck");
        assert_eq!(f.default_branch, "main");
    }

    /// A repository with no commits has no default branch ref at all. The base
    /// of an issue branch is then unknowable, and an empty string is a better
    /// answer than a guess of "main" that `git` would refuse anyway.
    #[test]
    fn a_repository_with_no_default_branch_parses_to_an_empty_one() {
        let f = parse_repo_facts(r#"{"nameWithOwner":"o/n","defaultBranchRef":null}"#).unwrap();
        assert_eq!(f.default_branch, "");
    }

    #[test]
    fn unreadable_facts_are_an_error() {
        assert!(parse_repo_facts("not json").is_err());
    }

    #[test]
    fn the_totals_query_asks_for_both_states_by_owner_and_name() {
        let argv = issue_totals_argv("followLemmi/cowork-deck");
        assert_eq!(&argv[0..2], &["api".to_string(), "graphql".to_string()]);
        // The owner and the name go in as variables, never interpolated into
        // the query text: a repository name is not ours to escape.
        assert!(argv.iter().any(|a| a == "owner=followLemmi"));
        assert!(argv.iter().any(|a| a == "name=cowork-deck"));
        let q = argv.iter().find(|a| a.starts_with("query=")).expect("the query");
        assert!(q.contains("totalCount"), "{q}");
        assert!(q.contains("states: OPEN") && q.contains("states: CLOSED"), "{q}");
    }

    /// `gh api graphql` wraps the answer in `data`, and the response is what the
    /// spec measured returning `{main, 46, 58}`.
    #[test]
    fn totals_read_both_counts_out_of_the_graphql_envelope() {
        let json = r#"{"data":{"repository":{
            "open":{"totalCount":46},"closed":{"totalCount":58}}}}"#;
        let t = parse_issue_totals(json).unwrap();
        assert_eq!((t.open, t.closed), (46, 58));
    }

    /// A GraphQL error comes back as exit 1 with an `errors` array; the runner
    /// refuses before this is reached, but a response with no repository must
    /// still be an error rather than "0 open issues", which would read as a
    /// repository somebody had emptied.
    #[test]
    fn a_response_without_a_repository_is_an_error_not_a_zero() {
        assert!(parse_issue_totals(r#"{"data":{"repository":null}}"#).is_err());
    }

    #[test]
    fn the_list_call_names_the_repository_the_state_and_the_cap() {
        let argv = issue_list_argv("o/n", "open", 50);
        assert_eq!(&argv[0..2], &["issue".to_string(), "list".to_string()]);
        // Decision 11: every issue call is explicit about its repository,
        // because this feature makes directories whose origin is related to but
        // not identical with the workspace's, and a command that resolves its
        // repository from wherever it is standing acts on the wrong one.
        let at = argv.iter().position(|a| a == "-R").expect("-R");
        assert_eq!(argv[at + 1], "o/n");
        let at = argv.iter().position(|a| a == "-s").expect("-s");
        assert_eq!(argv[at + 1], "open");
        let at = argv.iter().position(|a| a == "-L").expect("-L");
        assert_eq!(argv[at + 1], "50");
        let at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[at + 1], ISSUE_LIST_FIELDS);
    }

    /// Which 50 come back is not something the frontend can re-sort its way out
    /// of, and "the 50 least recently touched" would be the wrong 50. This stays
    /// on GraphQL at one point, so asking for the right ones is free.
    #[test]
    fn the_list_call_asks_for_recency_order() {
        let argv = issue_list_argv("o/n", "open", 50);
        let at = argv.iter().position(|a| a == "--search").expect("--search");
        assert_eq!(argv[at + 1], "sort:updated-desc");
    }

    #[test]
    fn close_carries_the_reason_verbatim_including_the_space() {
        let argv = issue_close_argv("o/n", 42, Some("not planned"));
        assert_eq!(&argv[0..3], &["issue".to_string(), "close".to_string(), "42".to_string()]);
        assert!(argv.iter().any(|a| a == "-R"));
        let at = argv.iter().position(|a| a == "-r").expect("-r");
        // One argv element, with the space in it. `gh` takes the literal strings
        // `completed` and `not planned`, and that is what sets `stateReason`.
        assert_eq!(argv[at + 1], "not planned");
        assert!(!issue_close_argv("o/n", 42, None).iter().any(|a| a == "-r"));
    }

    /// Anything but the two `gh` accepts is dropped rather than passed through:
    /// an unknown reason would fail the close, and a close that fails after a
    /// confirmation is the worst of both.
    #[test]
    fn an_unknown_close_reason_is_dropped() {
        assert!(!issue_close_argv("o/n", 1, Some("because")).iter().any(|a| a == "-r"));
        assert!(issue_close_argv("o/n", 1, Some("completed")).iter().any(|a| a == "completed"));
    }

    #[test]
    fn reopen_takes_no_reason() {
        let argv = issue_reopen_argv("o/n", 42);
        assert_eq!(&argv[0..3], &["issue".to_string(), "reopen".to_string(), "42".to_string()]);
        assert!(!argv.iter().any(|a| a == "-r"));
    }

    /// `create` and `edit` prompt interactively when `-t`/`-b` are missing,
    /// which in a spawned child is a hang waiting to happen. Two guards: the
    /// title is always in argv, and the body always arrives on stdin.
    #[test]
    fn create_always_carries_a_title_and_takes_its_body_on_stdin() {
        let argv = issue_create_argv("o/n", "A title");
        assert_eq!(&argv[0..2], &["issue".to_string(), "create".to_string()]);
        let at = argv.iter().position(|a| a == "--title").expect("--title");
        assert_eq!(argv[at + 1], "A title");
        let at = argv.iter().position(|a| a == "--body-file").expect("--body-file");
        assert_eq!(argv[at + 1], "-", "a multi-line body does not belong in argv");
        assert!(argv.iter().any(|a| a == "-R"));
    }

    #[test]
    fn edit_carries_a_title_and_the_same_stdin_body() {
        let argv = issue_edit_argv("o/n", 42, "New title");
        assert_eq!(&argv[0..3], &["issue".to_string(), "edit".to_string(), "42".to_string()]);
        assert!(argv.iter().any(|a| a == "--title"));
        let at = argv.iter().position(|a| a == "--body-file").expect("--body-file");
        assert_eq!(argv[at + 1], "-");
    }

    /// `issue-` prefixed, so it is unambiguous beside `pr-42` in `git branch`,
    /// and slugged by the same function the PR path uses.
    #[test]
    fn the_branch_names_the_issue_and_is_filesystem_safe() {
        assert_eq!(issue_branch(42, "Sidebar badge sticks"), "issue-42-sidebar-badge-sticks");
        assert_eq!(issue_branch(1, "../escape"), "issue-1-escape");
        assert_eq!(issue_branch(1, ""), "issue-1-branch");
    }

    /// BUG-026 is the record of what nesting costs: `npm test` from the
    /// repository root globbed suites out of a nested worktree and ran 880 tests
    /// instead of 183. A `-issue` sibling rather than sharing `-pr`, so the two
    /// kinds are legible on disk.
    #[test]
    fn an_issue_worktree_lands_beside_the_workspace_never_inside_it() {
        let ws = "/home/u/projects/cowork-deck";
        let p = issue_worktree_path(ws, 42, "Sidebar badge sticks");
        assert!(!p.starts_with(ws), "worktree must not nest inside the workspace: {p:?}");
        assert_eq!(
            p,
            std::path::PathBuf::from(
                "/home/u/projects/cowork-deck-issue/42-sidebar-badge-sticks"
            ),
        );
        // And never collides with the PR path for the same work.
        // Not compared against `gh_pr::worktree_path` — that lives in the binary
        // crate and is unreachable from here (Step 1). The `-issue` infix is what
        // keeps the two apart, and it is asserted above.
        assert!(p.to_string_lossy().contains("-issue/"));
    }

    #[test]
    fn a_workspace_without_a_parent_still_resolves() {
        assert!(issue_worktree_path("/", 1, "t").to_string_lossy().contains("1-t"));
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gh_issues`
Expected: FAIL — `cannot find function repo_facts_argv`.

- [ ] **Step 4: Write minimal implementation**

In `src-tauri/src/tasks/gh_issues.rs`:

```rust
/// What one repository tells us about itself, once per app run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFacts {
    /// `owner/name`, as `gh` itself resolved it. Passed explicitly to every
    /// later call (decision 11).
    pub repo: String,
    /// The base an issue branch is cut from — never the workspace's current
    /// `HEAD`, which may be a feature branch whose work an issue branch would
    /// silently inherit. Empty for a repository with no commits.
    pub default_branch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IssueTotals {
    pub open: u64,
    pub closed: u64,
}

/// The facts call. No `-R`: this is the call that resolves which repository the
/// workspace folder *is*, so it runs in that folder and lets `gh` answer.
pub fn repo_facts_argv() -> Vec<String> {
    vec!["repo".into(), "view".into(), "--json".into(), "nameWithOwner,defaultBranchRef".into()]
}

pub fn parse_repo_facts(json: &str) -> Result<RepoFacts, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    let repo = v.get("nameWithOwner").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if repo.is_empty() {
        return Err("gh did not name a repository for this folder".to_string());
    }
    Ok(RepoFacts {
        repo,
        default_branch: v
            .get("defaultBranchRef")
            .and_then(|x| x.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Both totals in one point, and only when the open page came back full — a
/// page shorter than the cap *is* the total, so "showing 12 of 12" needs no
/// second call. In a repository with fewer than 50 open issues this never runs.
const TOTALS_QUERY: &str = "query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    open:   issues(states: OPEN)   { totalCount }
    closed: issues(states: CLOSED) { totalCount }
  }
}";

pub fn issue_totals_argv(repo: &str) -> Vec<String> {
    let (owner, name) = repo.split_once('/').unwrap_or((repo, ""));
    vec![
        "api".into(),
        "graphql".into(),
        "-F".into(),
        format!("owner={owner}"),
        "-F".into(),
        format!("name={name}"),
        "-f".into(),
        format!("query={TOTALS_QUERY}"),
    ]
}

pub fn parse_issue_totals(json: &str) -> Result<IssueTotals, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    let repo = v
        .get("data")
        .and_then(|d| d.get("repository"))
        .filter(|r| !r.is_null())
        .ok_or_else(|| "the totals response named no repository".to_string())?;
    let count = |k: &str| {
        repo.get(k).and_then(|x| x.get("totalCount")).and_then(|x| x.as_u64()).unwrap_or(0)
    };
    Ok(IssueTotals { open: count("open"), closed: count("closed") })
}

/// Every `gh issue` argv starts here, and every one of them emits `-R`.
fn issue_argv(repo: &str, rest: &[&str]) -> Vec<String> {
    let mut argv: Vec<String> = vec!["issue".into()];
    argv.extend(rest.iter().map(|s| (*s).to_string()));
    argv.push("-R".into());
    argv.push(repo.into());
    argv
}

pub fn issue_list_argv(repo: &str, state: &str, limit: usize) -> Vec<String> {
    let mut argv = issue_argv(repo, &["list", "-s", state]);
    argv.push("-L".into());
    argv.push(limit.to_string());
    // Advisory as far as the board is concerned — `boardColumns` re-sorts what
    // it is given — but it decides *which* rows a capped page contains, and
    // that the frontend cannot fix. Verified to stay on GraphQL at one point.
    argv.push("--search".into());
    argv.push("sort:updated-desc".into());
    argv.push("--json".into());
    argv.push(ISSUE_LIST_FIELDS.into());
    argv
}

/// The two literal strings `gh` accepts. Anything else is dropped: a close that
/// fails *after* its confirmation is the worst of both worlds.
fn close_reason(reason: &str) -> Option<&'static str> {
    match reason {
        "completed" => Some("completed"),
        "not planned" => Some("not planned"),
        _ => None,
    }
}

pub fn issue_close_argv(repo: &str, number: u64, reason: Option<&str>) -> Vec<String> {
    let n = number.to_string();
    let mut argv = issue_argv(repo, &["close", &n]);
    if let Some(r) = reason.and_then(close_reason) {
        argv.push("-r".into());
        argv.push(r.into());
    }
    argv
}

/// No reason and no confirmation: it restores the state of a moment ago.
pub fn issue_reopen_argv(repo: &str, number: u64) -> Vec<String> {
    issue_argv(repo, &["reopen", &number.to_string()])
}

/// `--body-file -` rather than `-b <body>`: a body is user and agent text, argv
/// is the wrong place for it, and `create` prompts interactively when `-b` is
/// missing — a hang, in a child process, for the one case that reaches it.
pub fn issue_create_argv(repo: &str, title: &str) -> Vec<String> {
    issue_argv(repo, &["create", "--title", title, "--body-file", "-"])
}

pub fn issue_edit_argv(repo: &str, number: u64, title: &str) -> Vec<String> {
    let n = number.to_string();
    issue_argv(repo, &["edit", &n, "--title", title, "--body-file", "-"])
}

/// `issue-42-<slug(title)>`, so it is unambiguous beside `pr-42` in
/// `git branch`. One `slug`, shared with the pull request path (Step 1 moved it
/// here): it is verified to strip path separators and to cap at 40 characters.
pub fn issue_branch(number: u64, title: &str) -> String {
    format!("issue-{number}-{}", crate::tasks::slug::slug(title))
}

/// `<parent>/<workspace-name>-issue/<number>-<slug(title)>` — beside the
/// workspace, never inside it. Same rule and same reason as
/// `gh_pr::worktree_path`; a `-issue` sibling rather than sharing `-pr`, so the
/// two kinds are legible on disk.
pub fn issue_worktree_path(workspace_path: &str, number: u64, title: &str) -> std::path::PathBuf {
    let ws = std::path::Path::new(workspace_path);
    let name = ws
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());
    let parent = ws.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent
        .join(format!("{name}-issue"))
        .join(format!("{number}-{}", crate::tasks::slug::slug(title)))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_issues && cargo test gh_pr`
Expected: PASS — 10 + 17 in `gh_issues`, and every `gh_pr` test still green with no edits, which is what proves Step 1's move was verbatim.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/tasks/gh_issues.rs src-tauri/src/tasks/slug.rs src-tauri/src/tasks/mod.rs src-tauri/src/gh_pr.rs
git commit -m "feat(issues): repository facts, every argv with its repo, and the worktree path"
```

---

### Task 6/26: `GhIssueProvider` — the trait over an injected runner

**Issue:** _(file it)_

The `TaskProvider` implementation, driven by a closure that runs `gh`, so every branch of it has a test with no process and no network. The trait gains no sixth method (decision 1).

**Files:**
- Modify: `src-tauri/src/tasks/gh_issues.rs`
- Modify: `src-tauri/src/tasks/provider.rs`

**Interfaces:**
- Produces: `GhIssueProvider<'a>::new(repo: RepoSource<'a>, run: GhRunner<'a>)`, `TaskPatch.reason`, `OPEN_PAGE_LIMIT`, `CLOSED_PAGE_LIMIT`, `parse_issue` (from Task 4) used by `resolve`
- Consumes: everything from Tasks 4 and 5

**On `TaskPatch.reason`.** Decision 10 wants the close reason picked in the confirmation, and decision 3 rules that close and reopen go through `tasks_update` with a `status` patch rather than commands of their own. Between the two the reason has no channel: neither `TaskPatch` nor `TaskProvider::resolve` carries one. The narrowest fix that honours both is one optional field on `TaskPatch`, ignored by `FsTaskProvider` because a card file has no such thing. Recorded in the self-review as a gap in the spec rather than a decision reopened.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks/gh_issues.rs`:

```rust
    use crate::tasks::provider::{TaskPatch, TaskProvider};
    use std::cell::RefCell;

    /// Records every argv it is handed and replies from a script. The whole
    /// point of the injected runner: the provider's branches are testable
    /// without a process, exactly as `parse_issues` is without a network.
    struct FakeGh {
        calls: RefCell<Vec<Vec<String>>>,
        replies: RefCell<Vec<Result<String, String>>>,
    }

    fn provider(replies: Vec<Result<String, String>>) -> (GhIssueProvider<'static>, std::rc::Rc<FakeGh>) {
        let fake = std::rc::Rc::new(FakeGh {
            calls: RefCell::new(Vec::new()),
            replies: RefCell::new(replies),
        });
        let f = fake.clone();
        let p = GhIssueProvider::new(
            // A *resolver*, not a value: resolving the repository runs `gh`, and
            // nothing that merely constructs a provider may do I/O — see the
            // constructor's own doc comment.
            Box::new(|| Ok("o/n".to_string())),
            Box::new(move |argv: &[String], _stdin: Option<&str>| {
                f.calls.borrow_mut().push(argv.to_vec());
                if f.replies.borrow().is_empty() {
                    return Ok("[]".to_string());
                }
                f.replies.borrow_mut().remove(0)
            }),
        );
        (p, fake)
    }

    /// Construction does no I/O, and the resolver is called at most once.
    ///
    /// Both halves matter. The first is what keeps decision 9's three unavailable
    /// states reachable: `capabilities()` must succeed for a workspace whose `gh`
    /// is missing, so that the *list* call is what fails and the board can say
    /// "Set up gh" instead of "no tracker is configured". The second is the
    /// budget: two list calls a tick must not become two repository lookups too.
    #[test]
    fn the_repository_is_resolved_lazily_and_only_once() {
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let c = calls.clone();
        let p = GhIssueProvider::new(
            Box::new(move || { c.set(c.get() + 1); Ok("o/n".to_string()) }),
            Box::new(|_argv: &[String], _stdin: Option<&str>| Ok(ONE_OPEN.to_string())),
        );
        assert!(p.capabilities().can_create);
        assert_eq!(calls.get(), 0, "capabilities must not touch the network");
        p.list("deck").unwrap();
        p.list("deck").unwrap();
        assert_eq!(calls.get(), 1, "resolved once, then remembered");
    }

    /// And when it cannot be resolved, the failure is the *list's*, with the
    /// message intact — which is what the frontend maps onto `no-gh` /
    /// `no-account` / `no-repo`.
    #[test]
    fn a_repository_that_cannot_be_resolved_fails_the_list_not_the_capabilities() {
        let p = GhIssueProvider::new(
            Box::new(|| Err("gh-not-found".to_string())),
            Box::new(|_argv: &[String], _stdin: Option<&str>| Ok("[]".to_string())),
        );
        assert!(p.capabilities().can_create, "capabilities are static facts");
        let err = p.list("deck").unwrap_err().to_string();
        assert!(err.contains("gh-not-found"), "{err}");
    }

    const ONE_OPEN: &str = r#"[{"number":42,"title":"t","state":"OPEN",
        "createdAt":"c","closedAt":null,"body":"","labels":[],"url":"u"}]"#;
    const ONE_CLOSED: &str = r#"[{"number":7,"title":"t","state":"CLOSED",
        "createdAt":"c","closedAt":"d","body":"","labels":[],"url":"u"}]"#;
    /// `gh issue view` answers with a bare object, not an array of one.
    const ONE_OPEN_OBJECT: &str = r#"{"number":42,"title":"t","state":"OPEN",
        "createdAt":"c","closedAt":null,"body":"","labels":[],"url":"u"}"#;
    // A bare object, like `ONE_OPEN_OBJECT`: `update`'s read-back goes through
    // `parse_issue`, which refuses an array on purpose (Task 4's
    // `a_single_issue_parse_refuses_a_list`). Scripting these with `ONE_CLOSED`
    // fails with `Io("gh did not return one issue")` — and the fix is the fixture,
    // never teaching `parse_issue` to unwrap a one-element array, which would
    // delete the guarantee that `view` and `list` cannot be confused.
    const ONE_CLOSED_OBJECT: &str = r#"{"number":7,"title":"t","state":"CLOSED",

    /// The closed column is fetched, not accumulated: with an open-only list a
    /// closed issue would simply vanish from the board, which for a file card it
    /// does not. Two calls at one point each, and `--state all` is not an
    /// alternative — it orders by `createdAt` and does not group by state, so
    /// one page cannot fill a capped closed column.
    #[test]
    fn list_fetches_both_states_and_caps_them_separately() {
        let (p, fake) = provider(vec![Ok(ONE_OPEN.into()), Ok(ONE_CLOSED.into())]);
        let cards = p.list("deck").unwrap();
        assert_eq!(cards.len(), 2);
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 2, "one call per state, never `-s all`");
        assert!(calls[0].iter().any(|a| a == "open") && calls[0].iter().any(|a| a == "50"));
        // Twenty matches `boardColumns`'s existing doneLimit exactly, so the
        // column caps itself the way it always has.
        assert!(calls[1].iter().any(|a| a == "closed") && calls[1].iter().any(|a| a == "20"));
        assert!(calls.iter().all(|c| c.iter().any(|a| a == "-R")));
    }

    /// One state failing must fail the list rather than half-render it: a board
    /// showing open issues and silently no closed ones is a board lying about
    /// what it knows.
    #[test]
    fn a_failing_page_fails_the_list() {
        let (p, _) = provider(vec![Ok(ONE_OPEN.into()), Err("HTTP 502".into())]);
        assert!(p.list("deck").is_err());
    }

    #[test]
    fn capabilities_offer_create_and_close_and_the_two_steps() {
        let (p, _) = provider(vec![]);
        let c = p.capabilities();
        assert!(c.can_create && c.can_resolve);
        assert_eq!(c.statuses, vec!["open".to_string(), "closed".to_string()]);
    }

    #[test]
    fn create_sends_the_body_on_stdin_and_never_in_argv() {
        let (p, fake) = provider(vec![Ok("https://github.com/o/n/issues/9\n".into())]);
        p.create(crate::tasks::model::TaskDraft {
            title: "A title".into(),
            kind: KindId(String::new()),
            body: "line one\nline two".into(),
            project: "deck".into(),
            origin: TaskOrigin::Human,
            session: None,
        })
        .unwrap();
        let calls = fake.calls.borrow();
        assert!(calls[0].iter().any(|a| a == "create"));
        assert!(!calls[0].iter().any(|a| a.contains("line one")), "the body is not argv material");
    }

    /// `create` prints the new issue's URL and nothing else, exit 0 — observed
    /// on 2026-07-30 while filing #117, so the number *is* recoverable. Nothing
    /// parses it anyway: the refetch needs no fact about `gh`'s output and
    /// survives a change to it, which is decision 10's ruling. The card handed
    /// back is deliberately id-less, and its only caller
    /// (`main.ts::captureTask`) discards the value already.
    #[test]
    fn create_returns_an_id_less_card_because_the_board_refetches() {
        let (p, _) = provider(vec![Ok("anything at all".into())]);
        let made = p
            .create(crate::tasks::model::TaskDraft {
                title: "A title".into(),
                kind: KindId(String::new()),
                body: String::new(),
                project: "deck".into(),
                origin: TaskOrigin::Human,
                session: None,
            })
            .unwrap();
        assert_eq!(made.id, "", "the number comes from the refetch, not from gh's output");
        assert_eq!(made.title, "A title");
        assert_eq!(made.status.as_str(), "open");
    }

    #[test]
    fn a_status_patch_to_closed_closes_the_issue_with_its_reason() {
        let (p, fake) = provider(vec![Ok(String::new()), Ok(ONE_CLOSED_OBJECT.into())]);
        p.update(
            "7",
            TaskPatch {
                status: Some(StepId("closed".into())),
                reason: Some("not planned".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let calls = fake.calls.borrow();
        assert!(calls[0].iter().any(|a| a == "close"));
        assert!(calls[0].iter().any(|a| a == "not planned"));
    }

    #[test]
    fn a_status_patch_to_open_reopens_and_asks_no_reason() {
        let (p, fake) = provider(vec![Ok(String::new()), Ok(ONE_OPEN_OBJECT.into())]);
        p.update("42", TaskPatch { status: Some(StepId("open".into())), ..Default::default() })
            .unwrap();
        assert!(fake.calls.borrow()[0].iter().any(|a| a == "reopen"));
    }

    #[test]
    fn a_title_or_body_patch_edits_the_issue() {
        let (p, fake) = provider(vec![Ok(String::new()), Ok(ONE_OPEN_OBJECT.into())]);
        p.update(
            "42",
            TaskPatch { title: Some("New".into()), body: Some("New body".into()), ..Default::default() },
        )
        .unwrap();
        assert!(fake.calls.borrow()[0].iter().any(|a| a == "edit"));
    }

    /// Nothing can set it: no issue carries a kind, and the one synthetic kind
    /// is not a choice. Refused rather than ignored, so a caller that thinks it
    /// wrote something is told it did not.
    #[test]
    fn a_kind_patch_is_refused() {
        let (p, _) = provider(vec![]);
        assert!(p
            .update("42", TaskPatch { kind: Some(KindId("bug".into())), ..Default::default() })
            .is_err());
    }

    /// The board has two steps and nothing else. A patch naming a third would
    /// otherwise be sent to `gh` as a close or silently dropped.
    #[test]
    fn a_status_patch_naming_an_unknown_step_is_refused() {
        let (p, _) = provider(vec![]);
        assert!(p
            .update("42", TaskPatch { status: Some(StepId("doing".into())), ..Default::default() })
            .is_err());
    }

    /// `gh issue view <n>`, addressed by number — **never a search.**
    ///
    /// An earlier draft used `issue list -s all -S 42`, which is a full-text query:
    /// measured against this repository it returns `[42, 109, 28, 17, 48]`, ranked
    /// by relevance, under `gh`'s default limit of 30. On a busier repository the
    /// issue asked for falls off the page entirely — and since `update` ends on
    /// `resolve` for close, reopen and edit, and a body-only patch begins with it,
    /// that breaks the tick, Save and both write paths silently. This test is the
    /// only thing that can catch it: the fake returns **whatever the script holds**, whatever argv it
    /// is handed, so *nothing else here inspects how the issue was addressed*.
    #[test]
    fn resolve_addresses_the_issue_by_number_and_never_searches() {
        let (p, fake) = provider(vec![Ok(ONE_OPEN_OBJECT.into())]);
        let t = p.resolve("42").unwrap();
        assert_eq!(t.id, "42");
        let argv = &fake.calls.borrow()[0];
        assert_eq!(argv[0], "issue");
        assert_eq!(argv[1], "view");
        assert_eq!(argv[2], "42");
        assert!(argv.iter().any(|a| a == "-R"));
        assert!(!argv.iter().any(|a| a == "-S"), "a search can return the wrong issue");
        assert!(!argv.iter().any(|a| a == "list"));
        // The same field names as the list call, verified against `gh` — which is
        // what lets one constant and one mapping serve both.
        let at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[at + 1], ISSUE_LIST_FIELDS);
    }

    /// `gh issue view` on a number that does not exist exits non-zero, so the
    /// runner refuses and the error is the runner's. There is no empty-array case
    /// to mistake for "not found" any more.
    #[test]
    fn resolving_an_issue_that_is_not_there_is_an_error() {
        let (p, _) = provider(vec![Err("could not resolve to an Issue".into())]);
        assert!(p.resolve("999").is_err());
    }

    /// An id that is not a number cannot be an issue, and must not become
    /// `gh issue close 0`.
    #[test]
    fn a_non_numeric_id_is_refused_before_any_call() {
        let (p, fake) = provider(vec![]);
        assert!(p.resolve("01ABCDEF").is_err());
        assert!(fake.calls.borrow().is_empty(), "nothing may be sent for an id that cannot exist");
    }
```

Add the two page caps and the reason field. In `src-tauri/src/tasks/provider.rs`, on `TaskPatch`:

```rust
    /// Why a card is being closed, where closing takes a reason. GitHub's
    /// `gh issue close -r` accepts `completed` or `not planned`, and the close
    /// confirmation offers the choice (decision 10). `FsTaskProvider` ignores
    /// it: a card file has no such field, and inventing one would change the
    /// card format for a value nothing reads back.
    ///
    /// On the patch rather than in a command of its own because decision 3 keeps
    /// the board's four write paths as one: the drag handler, the arrows and the
    /// card modal all go through `tasks_update` and none of them should learn a
    /// provider's name.
    #[serde(default)]
    pub reason: Option<String>,
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gh_issues`
Expected: FAIL — `cannot find type GhIssueProvider`.

- [ ] **Step 3: Write minimal implementation**

In `src-tauri/src/tasks/gh_issues.rs`:

```rust
use crate::tasks::model::{TaskDraft, TaskError};
use crate::tasks::provider::{ProviderCapabilities, TaskPatch, TaskProvider};

/// All open issues in one page. Named because the frontend prints "showing N of
/// M" against it: a silently truncated list reads as a complete one.
pub const OPEN_PAGE_LIMIT: usize = 50;
/// Matches `boardColumns`'s existing `doneLimit` (`tasks.ts:93`) exactly, so the
/// closed column caps itself the way it always has.
pub const CLOSED_PAGE_LIMIT: usize = 20;

/// Runs `gh` with an argv and, for the two write commands that carry a body, a
/// string on stdin. Injected so the provider is testable without a process.
///
/// Carries a lifetime rather than being `'static`: the real runner borrows the
/// app state it resolves an account from, and the provider never outlives the
/// command that built it. Without the parameter this would mean `+ 'static` and
/// `Box::new` would fail with E0521 — see Task 10.
pub type GhRunner<'a> = Box<dyn Fn(&[String], Option<&str>) -> Result<String, String> + 'a>;

/// Resolves `owner/name`, when something first needs it. Not a `String`: see
/// `new`.
pub type RepoSource<'a> = Box<dyn Fn() -> Result<String, String> + 'a>;

pub struct GhIssueProvider<'a> {
    repo: RepoSource<'a>,
    /// Memoized answer. `RefCell` because `TaskProvider` takes `&self` — the
    /// provider is per-call and single-threaded, so there is nothing to lock.
    resolved: std::cell::RefCell<Option<String>>,
    run: GhRunner<'a>,
}

impl<'a> GhIssueProvider<'a> {
    /// **Constructing a provider does no I/O, and that is load-bearing.**
    ///
    /// Resolving the repository runs `gh repo view`, which fails when `gh` is
    /// missing, when no account is bound, and when the folder is not a GitHub
    /// repository — the three states decision 9 exists to explain. If that ran
    /// here, `tasks_capabilities` would fail, the frontend would see "no tracker
    /// configured", and all three would render as the one message that is false
    /// for all of them. So the repository is resolved on first *use* — inside
    /// `list`, `create`, `resolve`, `update` — and the failure arrives where the
    /// frontend can name it.
    ///
    /// Memoized, because two list calls a tick must not become two lookups too.
    pub fn new(repo: RepoSource<'a>, run: GhRunner<'a>) -> Self {
        Self { repo, resolved: std::cell::RefCell::new(None), run }
    }

    /// `owner/name`, resolved at most once.
    fn repo(&self) -> Result<String, TaskError> {
        if let Some(r) = self.resolved.borrow().as_ref() {
            return Ok(r.clone());
        }
        let r = (self.repo)().map_err(TaskError::Io)?;
        *self.resolved.borrow_mut() = Some(r.clone());
        Ok(r)
    }

    /// An issue number, or a refusal. Ids stop being globally unique across
    /// providers, which is safe because a workspace has exactly one source —
    /// but an id that cannot be a number must never become `gh issue close 0`.
    fn number(id: &str) -> Result<u64, TaskError> {
        id.parse::<u64>().map_err(|_| TaskError::NotFound(id.to_string()))
    }

    fn page(&self, state: &str, limit: usize, project: &str) -> Result<Vec<Task>, TaskError> {
        let json = (self.run)(&issue_list_argv(&self.repo()?, state, limit), None)
            .map_err(TaskError::Io)?;
        parse_issues(&json, project).map_err(TaskError::Io)
    }
}

impl TaskProvider for GhIssueProvider<'_> {
    fn capabilities(&self) -> ProviderCapabilities {
        // `statuses` is still read by nothing (`provider.rs:13`); it is filled
        // in honestly anyway, because Jira is where it starts to matter.
        ProviderCapabilities {
            can_create: true,
            can_resolve: true,
            statuses: vec!["open".to_string(), "closed".to_string()],
        }
    }

    fn list(&self, project: &str) -> Result<Vec<Task>, TaskError> {
        let mut cards = self.page("open", OPEN_PAGE_LIMIT, project)?;
        cards.extend(self.page("closed", CLOSED_PAGE_LIMIT, project)?);
        Ok(cards)
    }

    /// The new issue's number is not knowable: none of the write commands takes
    /// `--json`. `create` does print the new issue's URL (observed while filing
    /// #117), so the number is recoverable — and is deliberately not taken from
    /// there: the refetch needs no fact about `gh`'s output and survives a change
    /// to it, which is decision 10's ruling. The board refetches, and
    /// the new issue arrives like any other; the card returned here carries the
    /// draft's own fields and no id, and its only caller discards it.
    fn create(&self, draft: TaskDraft) -> Result<Task, TaskError> {
        (self.run)(&issue_create_argv(&self.repo()?, &draft.title), Some(&draft.body))
            .map_err(TaskError::Io)?;
        Ok(Task {
            id: String::new(),
            title: draft.title,
            kind: KindId(String::new()),
            status: StepId("open".to_string()),
            project: draft.project,
            created: String::new(),
            resolved: None,
            origin: TaskOrigin::Human,
            session: None,
            body: draft.body,
            path: String::new(),
            damaged: None,
            conflict: false,
            labels: Vec::new(),
        })
    }

    /// One issue, addressed by number.
    ///
    /// `gh issue view <n> --json <ISSUE_LIST_FIELDS>` — the same field names as
    /// the list call, verified against `gh`, so one constant and one mapping serve
    /// both. **Not `issue list -S <n>`**, which an earlier draft used: `-S` is a
    /// full-text search, ranked by relevance and capped at `gh`'s default 30, so
    /// on a busy repository the issue asked for is simply not in the answer. Every
    /// write path ends here, so that failure would have been silent in the two
    /// places it matters most.
    ///
    /// `project` is empty: `resolve` answers about one issue and its caller does
    /// not filter by project.
    fn resolve(&self, id: &str) -> Result<Task, TaskError> {
        let n = Self::number(id)?;
        let mut argv = issue_argv(&self.repo()?, &["view", &n.to_string()]);
        argv.push("--json".into());
        argv.push(ISSUE_LIST_FIELDS.into());
        let json = (self.run)(&argv, None).map_err(TaskError::Io)?;
        parse_issue(&json, "").map_err(TaskError::Io)
    }

    fn update(&self, id: &str, patch: TaskPatch) -> Result<Task, TaskError> {
        let n = Self::number(id)?;
        if patch.kind.is_some() {
            return Err(TaskError::UnknownKind(
                "an issue has no kind — nothing can set one".to_string(),
            ));
        }
        if let Some(step) = &patch.status {
            let argv = match step.as_str() {
                "closed" => issue_close_argv(&self.repo()?, n, patch.reason.as_deref()),
                "open" => issue_reopen_argv(&self.repo()?, n),
                other => return Err(TaskError::UnknownStep(other.to_string())),
            };
            (self.run)(&argv, None).map_err(TaskError::Io)?;
        }
        if patch.title.is_some() || patch.body.is_some() {
            // `edit` prompts interactively for a missing title, so the current
            // one is resent when the patch only touches the body.
            let title = match &patch.title {
                Some(t) => t.clone(),
                None => self.resolve(id)?.title,
            };
            let body = patch.body.clone().unwrap_or_default();
            (self.run)(&issue_edit_argv(&self.repo()?, n, &title), Some(&body))
                .map_err(TaskError::Io)?;
        }
        // Read back rather than synthesized: the write's own output says nothing.
        self.resolve(id)
    }
}
```

`issue_argv` stays private in the same module, which is where `resolve` is. The `'a` on the struct is what lets Task 10 hand it a runner that borrows the app state; nothing else in this task needs it. Add that as a one-line comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_issues && cargo test tasks::`
Expected: PASS — **but not for the reason an earlier draft gave** (corrected 2026-07-30 while executing this task). `TaskPatch`'s new field being `default` covers only the constructions that *use* `..Default::default()`, and there are two, both in production code (`tasks_cmd.rs:722`, `bin/cowork_task.rs:156`). `fs.rs`'s test module builds `TaskPatch` **exhaustively, field by field, in 15 places** with no `..Default::default()` anywhere, so adding a field is E0063 fifteen times and the lib test target does not build at all. Add `reason: None` at each; no assertion changes, and all 15 keep passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks/gh_issues.rs src-tauri/src/tasks/provider.rs src-tauri/src/tasks/fs.rs
# fs.rs is NOT optional (correction, 2026-07-30): its test module has 15 exhaustive
# `TaskPatch { … }` constructions, so `reason` breaks the build without them.
git commit -m "feat(issues): a TaskProvider over gh, testable without a process"
```

---

> ### Barrier A
>
> Run `cd src-tauri && cargo test` and `npx tsc --noEmit` **from this worktree**. Both must be green, with the cargo count at 286 + the tests added in Tasks 1–6 and the TypeScript untouched. Nothing in Tasks 3–6 is reachable from any command, so a failure here is a failure of the parsers alone. Tasks 1–2's tests are in this count because every task is on this branch (Barrier 0); if they are *not* in it, Tasks 1 or 2 were skipped outright. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` must report exactly **6 diagnostics** here, not more: the sanctioned excess was withdrawn once Task 5 measured it (a `pub` item in the library crate does not trip `dead_code` for want of callers). Anything above 6 is a real new warning.

---

## Phase 2 — Rust seams

### Task 7/26: `tracker_kind` beside `resolve_root`

**Issue:** _(file it)_

The new resolution sits *beside* `resolve_root`, not inside it (decision 2). `resolve_root` keeps answering exactly one question — where do this workspace's card files live — and keeps returning `None` for a GitHub workspace, which is the correct answer for seven of its eight callers.

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs`

**Interfaces:**
- Produces: `TrackerKind`, `tracker_kind(ws: &Workspace) -> Option<TrackerKind>`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks_cmd.rs` (the module already has `ws()` and `tracker()` helpers; add a `github_tracker()` beside them):

```rust
    fn github_tracker() -> TrackerConfig {
        TrackerConfig {
            providers: vec![TrackerProvider::GitHub],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        }
    }

    #[test]
    fn tracker_kind_tells_the_three_configurations_apart() {
        assert!(tracker_kind(&ws(None)).is_none());
        assert!(matches!(
            tracker_kind(&ws(Some(tracker(TrackerRoot::Project)))),
            Some(TrackerKind::Fs { .. })
        ));
        assert!(matches!(
            tracker_kind(&ws(Some(github_tracker()))),
            Some(TrackerKind::GitHub)
        ));
    }

    /// A fourth configuration, from Task 2: a source written by a newer build.
    /// `None`, like an unconfigured workspace — there is nothing here that can
    /// list, create or resolve anything. What it must *not* do is resolve as
    /// `Fs` and start reading a folder that was never named.
    #[test]
    fn a_source_this_build_cannot_read_yields_no_provider() {
        let w = ws(Some(TrackerConfig {
            providers: vec![TrackerProvider::Unknown(serde_json::json!({"type": "jira"}))],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        }));
        assert!(tracker_kind(&w).is_none());
        assert!(resolve_root(&w).is_none());
        assert!(!is_project_root(&w));
    }

    /// The whole of decision 2 in one assertion: seven of `resolve_root`'s eight
    /// callers want exactly this answer, and the eighth (`start_session`) is the
    /// seam Task 12 fixes.
    #[test]
    fn resolve_root_is_none_for_a_github_workspace() {
        assert!(resolve_root(&ws(Some(github_tracker()))).is_none());
    }

    /// `is_project_root` matches on `Fs { Project }` directly, so a GitHub
    /// workspace is not a project root — and the migration machinery downstream
    /// of it stays quiet.
    #[test]
    fn a_github_workspace_is_not_a_project_root_and_has_no_effective_root() {
        let w = ws(Some(github_tracker()));
        assert!(!is_project_root(&w));
        assert_eq!(effective_root(&w), None);
    }

    /// Switching to GitHub records no pointer, so the migration banner never
    /// appears: its job is to move card *files* to another *folder*, and there is
    /// no folder. Decision 8.
    #[test]
    fn switching_to_github_records_no_previous_location() {
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let new = with_previous_location(Some(&old), ws(Some(github_tracker())));
        assert!(new.tracker.unwrap().previous_location.is_none());
    }

    /// And no offer is computed for one, whatever a pointer left over from an
    /// earlier configuration says.
    #[test]
    fn no_migration_is_offered_for_a_github_workspace() {
        let mut w = ws(Some(github_tracker()));
        if let Some(cfg) = w.tracker.as_mut() {
            cfg.previous_location = Some(PreviousLocation {
                root: "/home/u/vault".into(),
                project: "cowork-deck".into(),
                was_project_root: false,
            });
        }
        assert!(offer_for(&w).unwrap().is_none());
    }

    /// `seed_previous_location` only recognises `Fs { Path }`, so an update does
    /// not invent a root for a GitHub workspace.
    #[test]
    fn seeding_leaves_a_github_workspace_alone() {
        let mut w = ws(Some(github_tracker()));
        if let Some(cfg) = w.tracker.as_mut() { cfg.version = 1; }
        let seeded = seed_previous_location(w);
        assert!(seeded.tracker.unwrap().previous_location.is_none());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test tracker_kind`
Expected: FAIL — `cannot find type TrackerKind`.

- [ ] **Step 3: Write minimal implementation**

Above `resolve_root` in `src-tauri/src/tasks_cmd.rs`:

```rust
/// What a workspace's tracker *is*, as opposed to where its files are.
///
/// `resolve_root` answers one question — where do the card files live — and
/// `None` from it means "there are none", which is the right answer both for an
/// unconfigured workspace and for a GitHub-backed one. Seven of its eight
/// callers want precisely that (decision 2); this enum is for the two places
/// that need to tell those two cases apart: the provider choice and the session
/// environment.
pub enum TrackerKind {
    Fs { root: PathBuf, creation: RootCreation },
    /// The repository is deliberately not carried here: it is resolved from the
    /// workspace's own folder by `gh`, once per app run (decision 11).
    GitHub,
}

pub fn tracker_kind(ws: &Workspace) -> Option<TrackerKind> {
    let cfg = ws.tracker.as_ref()?;
    match cfg.providers.first()? {
        TrackerProvider::Fs { .. } => {
            let (root, creation) = resolve_root(ws)?;
            Some(TrackerKind::Fs { root, creation })
        }
        TrackerProvider::GitHub => Some(TrackerKind::GitHub),
        // A source a newer build wrote (Task 2). There is nothing here to list
        // from, and resolving it as anything else would act on a folder nobody
        // named. The board says so in words — see Task 8's capabilities branch.
        TrackerProvider::Unknown(_) => None,
    }
}
```

**`resolve_root` itself needs no change here.** Both of its non-`Fs` arms are already in place — `Unknown` from Task 2 and `GitHub` from Task 3 — because neither task compiles without them (`tasks_cmd.rs:157-172` has no catch-all). Its `None` for a GitHub workspace is therefore already the tested behaviour by the time this task starts; what this task adds is the *second* answer beside it, for the two callers that need to tell "no tracker" from "a tracker with no folder" apart. If the arm is missing when you get here, an earlier task was skipped and the crate will say so before any test runs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: PASS, the existing `tasks_cmd` tests plus 6.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks_cmd.rs
git commit -m "feat(issues): tracker_kind beside resolve_root, which keeps its shape"
```

---

### Task 8/26: `board_for` and `board_editable`

**Issue:** _(file it)_

The board configuration moves up out of the port (decision 1): one function decides which board a workspace has, and `FsTaskProvider` is handed that same result through `with_board` — the existing precedent for a provider being given a board it did not read. `provider_for` still returns the concrete type here; Task 10 flips it. Splitting the two keeps each compiling and verifiable on its own.

**One piece of behaviour here is not in the spec, and was added during planning.** The `capabilities_for` branch for an unreadable tracker source — the `Unknown` provider Task 2 introduces — exists because `tracker_kind` returns `None` for it, and `None` makes the board say "No task tracker is configured for this workspace". That is a different and false claim about a workspace whose tracker *is* configured and merely cannot be read here, and it invites the person to configure a second one over the top of it. The branch says the true thing instead, through the `board_error` channel that already draws a banner, so no new board state is invented for a case only a downgrade can produce. Reviewed and approved explicitly while this plan was being written; recorded here so a reader who has only the spec is not surprised by behaviour the spec does not describe.

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs`

**Interfaces:**
- Produces: `GITHUB_BOARD` (a synthesized `BoardConfig`), `board_for(ws) -> board::Loaded`, `BoardCapabilities.board_editable`

- [ ] **Step 1: Write the failing tests**

```rust
    /// It has to pass the same validation a hand-written board.json does, or the
    /// board would be drawn from a configuration the editor would refuse.
    #[test]
    fn the_synthesized_board_is_two_steps_and_valid() {
        let b = github_board();
        b.validate().expect("a synthesized board must be a legal one");
        assert_eq!(b.step_ids(), vec!["open".to_string(), "closed".to_string()]);
        assert!(b.is_terminal(&StepId("closed".into())));
        // No working step: an issue has no "in progress" state to write, and
        // `working: true` would make the launch button try to write one.
        assert_eq!(b.working_step(), None);
        // Non-empty only because `validate` rejects `NoKinds`; nothing reads it.
        assert_eq!(b.kinds.len(), 1);
    }

    #[test]
    fn board_for_synthesizes_the_github_board_and_can_never_fail_to_load_it() {
        let loaded = board_for(&ws(Some(github_tracker())));
        assert_eq!(loaded.config.step_ids(), vec!["open".to_string(), "closed".to_string()]);
        // Always `None`, which is why `board.ts`'s boardError banner — whose
        // prose names board.json — stays true and simply never draws.
        assert!(loaded.error.is_none());
    }

    #[test]
    fn board_for_reads_board_json_for_a_file_workspace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(crate::tasks::board::BOARD_FILE),
            r#"{"steps":[{"id":"todo","label":"To do"},{"id":"done","label":"Done","terminal":true}],
                "kinds":[{"id":"task","label":"Task"}]}"#,
        )
        .unwrap();
        let w = ws(Some(tracker(TrackerRoot::Path {
            path: dir.path().to_string_lossy().to_string(),
        })));
        // The root resolves *below* the picked folder, so seed the file there too.
        let (root, _) = resolve_root(&w).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::copy(
            dir.path().join(crate::tasks::board::BOARD_FILE),
            root.join(crate::tasks::board::BOARD_FILE),
        )
        .unwrap();
        assert_eq!(board_for(&w).config.step_ids(), vec!["todo".to_string(), "done".to_string()]);
    }

    /// The ⚙ editor writes `board.json`, and there is none. `board_editable`
    /// lives on `BoardCapabilities` rather than `ProviderCapabilities` because it
    /// is the *board* that is not editable — and the serde flatten means the
    /// frontend sees one object either way.
    #[test]
    fn only_a_file_backed_board_is_editable() {
        assert!(board_editable(&ws(Some(tracker(TrackerRoot::Project)))));
        assert!(!board_editable(&ws(Some(github_tracker()))));
        assert!(!board_editable(&ws(None)));
    }

    /// The other half of Task 2's promise: the workspace is visible, so its board
    /// has to say something true. "No task tracker is configured" would be a
    /// different claim — one is configured, and this build cannot read it.
    #[test]
    fn a_source_this_build_cannot_read_says_so_rather_than_reading_as_unconfigured() {
        let w = ws(Some(TrackerConfig {
            providers: vec![TrackerProvider::Unknown(serde_json::json!({"type": "jira"}))],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        }));
        let caps = capabilities_for(&w).expect("not None: that would read as unconfigured");
        let err = caps.board_error.expect("an explanation");
        // Both possibilities, because `untagged` cannot tell them apart: a source
        // from the future and a hand-edited `{"type":"fs"}` with no `root` both
        // arrive here, and telling the second person their file "was saved by a
        // newer version" is false and unactionable.
        assert!(err.contains("newer version") && err.contains("damaged"), "{err}");
        // Nothing can be written through a source we cannot read, so no control
        // that writes is offered.
        assert!(!caps.caps.can_create && !caps.caps.can_resolve && !caps.board_editable);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test board_for`
Expected: FAIL — `cannot find function board_for`.

- [ ] **Step 3: Write minimal implementation**

```rust
/// The board a GitHub workspace has: two steps, synthesized, not editable.
///
/// One terminal step and no working step. The consequences fall out of code that
/// already exists: `workingStep(cfg)` returns null, so the launch button's
/// pre-launch move is skipped (`sessions.ts:241`) and `isStale` is always false
/// (`tasks.ts:131`) — while `derivedStatus` still reports "working" from a live
/// session, so the "in progress" chip keeps working. "In progress" was never
/// stored, so there is nothing to store here.
///
/// `kinds` is non-empty only because `BoardConfig::validate` rejects `NoKinds`;
/// nothing reads it, because no issue carries a kind.
pub fn github_board() -> BoardConfig {
    BoardConfig {
        v: 1,
        steps: vec![
            crate::tasks::board::Step {
                id: StepId("open".into()),
                label: "Open".into(),
                terminal: false,
                working: false,
            },
            crate::tasks::board::Step {
                id: StepId("closed".into()),
                label: "Closed".into(),
                terminal: true,
                working: false,
            },
        ],
        kinds: vec![crate::tasks::board::Kind {
            id: KindId("issue".into()),
            label: "Issue".into(),
        }],
    }
}

/// Which board a workspace has, decided in one place.
///
/// `FsTaskProvider::new` still reads `board.json` itself (`fs.rs:76`) and cannot
/// stop: `cowork_task` constructs a provider from the environment alone
/// (`cowork_task.rs:102`) with no IPC layer above it. So there are two readers
/// of `board.json` in the codebase and they must not disagree — they will not,
/// because both call `board::load_or_create`, but the duplication is real and is
/// stated here rather than discovered later.
pub fn board_for(ws: &Workspace) -> crate::tasks::board::Loaded {
    match tracker_kind(ws) {
        Some(TrackerKind::GitHub) => {
            crate::tasks::board::Loaded { config: github_board(), error: None }
        }
        Some(TrackerKind::Fs { root, .. }) => crate::tasks::board::load_or_create(&root),
        // Unconfigured: the caller has already decided there is no provider, and
        // the default is what every other unconfigured read gets.
        None => crate::tasks::board::Loaded {
            config: BoardConfig::default_config(),
            error: None,
        },
    }
}

/// Whether the ⚙ editor may be offered.
pub fn board_editable(ws: &Workspace) -> bool {
    matches!(tracker_kind(ws), Some(TrackerKind::Fs { .. }))
}
```

`board::Loaded`'s fields must be constructible from here; if it is not already, make the struct's fields `pub` (`board.rs:214`) rather than adding a constructor — it is a two-field data carrier in the same crate.

Then `BoardCapabilities` gains the flag and `tasks_capabilities` fills all three from `board_for`:

```rust
pub struct BoardCapabilities {
    #[serde(flatten)]
    pub caps: ProviderCapabilities,
    pub board: BoardConfig,
    pub board_error: Option<String>,
    /// Whether ⚙ is offered. False for a synthesized board: there is no
    /// `board.json` to write, and one synthetic kind is not a choice.
    ///
    /// `default` as insurance rather than necessity: this type is built per call
    /// and serialized outward only (the struct is `provider.rs:10-14`, flattened
    /// at `:320`), so it
    /// is never deserialized today. None of its other fields carries one, and if
    /// that ever changes a missing flag should read as "not editable".
    #[serde(default)]
    pub board_editable: bool,
}
```

The body of `tasks_capabilities` moves into a pure `capabilities_for(ws) -> Option<BoardCapabilities>` so the tests above can reach it without `State`, with the command left as a two-line wrapper:

```rust
fn capabilities_for(ws: &Workspace) -> Option<BoardCapabilities> {
    // A source written by a newer build (Task 2). Not `None`: that means "no
    // tracker configured", and this workspace has one — we simply cannot read
    // it. Reported through the channel that already exists for "the board is not
    // what you think it is", so no new state has to be invented for a case only a
    // downgrade can produce.
    if matches!(
        ws.tracker.as_ref().and_then(|c| c.providers.first()),
        Some(TrackerProvider::Unknown(_))
    ) {
        return Some(BoardCapabilities {
            caps: ProviderCapabilities {
                can_create: false,
                can_resolve: false,
                statuses: Vec::new(),
            },
            board: BoardConfig::default_config(),
            board_error: Some(
                "this workspace's task source was saved by a newer version of the app, or \
                 is damaged, and cannot be read here. Nothing has been changed."
                    .to_string(),
            ),
            board_editable: false,
        });
    }
    let loaded = board_for(ws);
    Some(BoardCapabilities {
        caps: fs_or_github_capabilities(ws)?,
        board: loaded.config,
        board_error: loaded.error,
        board_editable: board_editable(ws),
    })
}
```

where `fs_or_github_capabilities` is `provider_for(..).ok().map(|p| p.capabilities())` once Task 10 has boxed it; until then it is the existing `provider_for(&ws)` call, unchanged. The `State`-taking command keeps its signature and its `Ok(None)` for an unconfigured workspace.

**The `.ok()` there is safe only because `provider_for` does no I/O** (Task 10 states the rule and the reason). If a future edit resolves the repository inside `provider_for`, this `.ok()` turns every one of decision 9's three unavailable states into "No task tracker is configured for this workspace" — the same false claim this branch was added to prevent, arriving by a route that needs no downgrade at all. Whatever else changes here, capabilities must not depend on the network.

**One frontend consequence, handled in Task 21 rather than here.** `board.ts:100-105` wraps whatever `boardError` says in prose about `board.json` — "The default two-step board is shown instead, so cards may appear in the wrong column. The file was left alone." True for the only sender it has had until now, and false for this one: there is no `board.json` in play, no file was read, and there are no cards to be in the wrong column. Task 21 shrinks the wrapper; this task is the first thing to put a non-`board.json` message through the channel, which is why the two are noted together.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks_cmd.rs
git commit -m "feat(issues): one place decides the board, and whether it is editable"
```

---

### Task 9/26: The repository facts cache, the stdin-carrying runner, and `issue_totals`

**Issue:** _(file it)_

Everything the GitHub provider needs from the process world, before anything constructs one. Three pieces: a cache beside the token cache, a `gh` runner that can feed stdin, and the one new read-only command the count line needs.

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Produces: `AppState.gh_repos`, `repo_facts_for(state, workspace_id) -> Result<RepoFacts, String>`, `run_gh_with_stdin(state, workspace_id, args, stdin)`, Tauri command `issue_totals(workspace_id) -> IssueTotals`
- Consumes: `gh_issues::repo_facts_argv`, `parse_repo_facts`, `issue_totals_argv`, `parse_issue_totals`

**On the rate-limit signal.** Decision 9 reads `X-Ratelimit-Remaining` proactively rather than matching the refusal's text, which is unverified. Response headers are only available through `gh api`, so the signal rides on the totals call: `gh api graphql --include` prints the headers before the body, and `issue_totals` returns the parsed remaining count alongside the two totals. **Consequence, stated rather than hidden:** in a repository with fewer than 50 open issues the totals call never fires, so the banner never appears there. That is accepted — such a repository spends two points a tick and is not the one that exhausts a budget — and the manual check in Task 26 drives the banner with an injected value instead.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/commands.rs`:

```rust
    /// `gh api --include` prints the response headers, a blank line, then the
    /// body. The remaining budget is read from the headers and the body is
    /// handed on untouched — a parser that fed the whole thing to serde would
    /// report a perfectly good response as unreadable JSON.
    #[test]
    fn headers_and_body_are_split_and_the_budget_is_read() {
        let out = "HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\n\
                   X-Ratelimit-Remaining: 4873\r\n\r\n{\"data\":{}}";
        let (remaining, body) = split_gh_response(out);
        assert_eq!(remaining, Some(4873));
        assert_eq!(body.trim(), "{\"data\":{}}");
    }

    /// Header names are case-insensitive on the wire and gh does not normalise
    /// them; a match on one exact spelling would read as "no signal" forever.
    #[test]
    fn the_budget_header_is_matched_case_insensitively() {
        let (remaining, _) = split_gh_response("x-ratelimit-remaining: 12\n\n{}");
        assert_eq!(remaining, Some(12));
    }

    /// No headers at all — an older gh, or a call made without `--include`. The
    /// body must survive and the signal must simply be absent, never zero: zero
    /// means "exhausted" and would raise the banner on every tick.
    #[test]
    fn a_response_without_headers_keeps_its_body_and_reports_no_budget() {
        let (remaining, body) = split_gh_response("{\"data\":{}}");
        assert_eq!(remaining, None);
        assert_eq!(body, "{\"data\":{}}");
    }

    #[test]
    fn the_totals_call_asks_for_headers() {
        let argv = issue_totals_argv_with_headers("o/n");
        assert!(argv.iter().any(|a| a == "--include"), "the budget comes from the headers");
        assert!(argv.iter().any(|a| a.starts_with("query=")));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test split_gh_response`
Expected: FAIL — `cannot find function split_gh_response`.

- [ ] **Step 3: Write minimal implementation**

On `AppState` (`commands.rs:11`):

```rust
    /// Per-workspace repository facts: `owner/name` and the default branch, as
    /// `gh` resolved them from the workspace's folder. Resolved once per
    /// workspace per app run — the same lifetime and the same "in memory only,
    /// never persisted" rule as `gh_tokens` beside it — and cleared whenever a
    /// workspace is saved, since its folder may now be a different repository.
    pub gh_repos: Mutex<std::collections::HashMap<String, cowork_deck::tasks::gh_issues::RepoFacts>>,
    /// The open-issue count each GitHub workspace's board last saw, for the
    /// sidebar badge. Written by `tasks_list`, read by `tasks_open_counts`, never
    /// a network call. A workspace whose board has not been opened this run is
    /// absent, and `WorkspacesPanel` already draws nothing for that.
    pub issue_open_counts: Mutex<std::collections::HashMap<String, usize>>,
```

Both are initialised in `main.rs` where `gh_tokens` is, and both are cleared in `save_workspace` beside the existing `gh_tokens.lock().clear()` — with the reason in a comment: a re-pointed folder is a different repository, and a re-sourced tracker is a different count.

Then, in `commands.rs`:

```rust
/// Split `gh api --include` output into the remaining GraphQL budget and the
/// body. The budget is the proactive rate-limit signal of decision 9: the
/// refusal's own text is unverified, so nothing matches on it.
fn split_gh_response(out: &str) -> (Option<u64>, &str) {
    let (head, body) = match out.split_once("\r\n\r\n") {
        Some(p) => p,
        None => match out.split_once("\n\n") {
            Some(p) => p,
            // No header block: the call was made without `--include`, or gh
            // changed. The body is all of it, and there is no signal — which is
            // `None`, never `0`: zero means exhausted and would raise the
            // banner on every tick.
            None => return (None, out),
        },
    };
    let remaining = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case("x-ratelimit-remaining").then(|| v.trim().parse().ok())?
        });
    (remaining, body)
}

pub fn issue_totals_argv_with_headers(repo: &str) -> Vec<String> {
    let mut argv = cowork_deck::tasks::gh_issues::issue_totals_argv(repo);
    argv.push("--include".into());
    argv
}

/// `owner/name` and the default branch for a workspace, resolved once and
/// cached. Not parsed out of `git remote get-url`: that is free but has to
/// handle both SSH and HTTPS forms, and `gh`'s own answer is authoritative about
/// which remote `gh` would have picked.
pub fn repo_facts_for(
    state: &State<AppState>,
    workspace_id: &str,
) -> Result<cowork_deck::tasks::gh_issues::RepoFacts, String> {
    if let Some(f) = state.gh_repos.lock().ok().and_then(|c| c.get(workspace_id).cloned()) {
        return Ok(f);
    }
    let json = run_gh_for_workspace(
        state,
        workspace_id,
        &cowork_deck::tasks::gh_issues::repo_facts_argv(),
    )?;
    let facts = cowork_deck::tasks::gh_issues::parse_repo_facts(&json)?;
    if let Ok(mut cache) = state.gh_repos.lock() {
        cache.insert(workspace_id.to_string(), facts.clone());
    }
    Ok(facts)
}

/// `run_gh_for_workspace` with a body on stdin.
///
/// `Command::output()` sets stdin to null (`:381`), so the existing runner
/// cannot feed one — and `gh issue create` prompts interactively for a missing
/// body, which in a child process is a hang waiting for the one case that
/// reaches it. Same account resolution, same `cwd`, same redaction, same
/// check-the-exit-code-before-parsing rule; the only difference is the pipe.
fn run_gh_with_stdin(
    state: &State<AppState>,
    workspace_id: &str,
    args: &[String],
    stdin_body: &str,
) -> Result<String, String> {
    // … the same preamble as `run_gh_for_workspace` (workspace, cfg, path,
    // token, env), then:
    let mut child = std::process::Command::new(&path)
        .args(args)
        .current_dir(&ws.path)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| gh::redact(&e.to_string()))?;
    // Best effort, and deliberately not fatal: gh may have exited already (an
    // argument error, no credentials), and a BrokenPipe here would report that
    // as a write failure instead of letting the real message through.
    if let Some(mut sink) = child.stdin.take() {
        use std::io::Write;
        let _ = sink.write_all(stdin_body.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| gh::redact(&e.to_string()))?;
    if !out.status.success() {
        return Err(gh::redact(String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
```

Factor the shared preamble of the two runners into one `fn gh_invocation(state, workspace_id) -> Result<(String, String, Vec<(String, String)>), String>` returning the program path, the `cwd` and the environment, so the account resolution and the redaction rule exist once. Both runners then differ only in how they spawn.

And the command:

```rust
/// How many issues the repository has, in both states. One GraphQL point, and
/// the frontend only calls it when the open page came back full — a shorter page
/// *is* the total.
#[tauri::command]
pub fn issue_totals(
    state: State<AppState>,
    workspace_id: String,
) -> Result<IssueTotalsView, String> {
    let facts = repo_facts_for(&state, &workspace_id)?;
    let out = run_gh_for_workspace(
        &state,
        &workspace_id,
        &issue_totals_argv_with_headers(&facts.repo),
    )?;
    let (remaining, body) = split_gh_response(&out);
    let t = cowork_deck::tasks::gh_issues::parse_issue_totals(body)?;
    Ok(IssueTotalsView { open: t.open, closed: t.closed, rate_remaining: remaining })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTotalsView {
    pub open: u64,
    pub closed: u64,
    /// GraphQL points left this hour, from the response headers. `None` when the
    /// headers said nothing — never `0`, which means exhausted.
    pub rate_remaining: Option<u64>,
}
```

`RepoFacts` needs `Clone` (it is `Debug, Clone, PartialEq, Eq` from Task 5). Register `commands::issue_totals` in `main.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test commands`
Expected: PASS, the existing `commands` tests plus 4.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(issues): cached repository facts, a stdin-carrying gh runner, and the totals"
```

---

### Task 10/26: `provider_for` returns a boxed provider, and six commands become file-only

**Issue:** _(file it)_

**This is the riskiest task in the plan.** `provider_for` (`tasks_cmd.rs:309`) has seven non-test call sites and three of them reach for methods that are not on the trait; six commands stop working for a non-file-backed workspace by design. Everything the board does passes through here, so a mistake in this task looks like "the board is empty" rather than like a type error — which is why Task 8 landed `board_for` first and left this task nothing to do but narrow.

The three sites that touch non-trait methods are `:337` (`board()`, `board_error()` — already handled by Task 8), `:412` (`board()`, inside `tasks_open_counts`) and `:731` (`scan()` and `board()`, inside `step_usage`). Three further sites build an `FsTaskProvider` directly rather than through `provider_for` (`:498`, `:704`, `:766`) and stay as they are.

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs`

**Interfaces:**
- Produces: `provider_for(state, ws) -> Result<Box<dyn TaskProvider>, String>`, `fs_provider_for(ws) -> Result<FsTaskProvider, String>`, `FILE_ONLY`
- Consumes: `GhIssueProvider`, `repo_facts_for`, `run_gh_with_stdin`

- [ ] **Step 1: Write the failing tests**

```rust
    /// Each of the six refuses with one message, and the message says what is
    /// wrong rather than "not-configured" — which would be a lie: a tracker *is*
    /// configured, it just has no folder.
    #[test]
    fn the_six_file_only_commands_refuse_a_github_workspace() {
        let w = ws(Some(github_tracker()));
        let err = fs_provider_for(&w).expect_err("a github workspace has no folder");
        assert!(err.contains("folder"), "{err}");
        assert_ne!(err, "not-configured", "a github tracker is configured");
    }

    #[test]
    fn an_unconfigured_workspace_is_still_not_configured() {
        assert_eq!(fs_provider_for(&ws(None)).unwrap_err(), "not-configured");
    }

    #[test]
    fn fs_provider_for_still_serves_a_file_workspace() {
        assert!(fs_provider_for(&ws(Some(tracker(TrackerRoot::Project)))).is_ok());
    }

    /// The two functions that used `provider_for` for its concrete methods must
    /// now name `fs_provider_for` — asserted through their public commands'
    /// behaviour rather than by reading the source, so a future edit that
    /// switches one back is caught.
    #[test]
    fn step_usage_refuses_a_github_workspace_rather_than_scanning_a_folder() {
        let err = step_usage(&ws(Some(github_tracker()))).unwrap_err();
        assert!(err.contains("folder"), "{err}");
    }

    #[test]
    fn a_step_rewrite_and_a_config_save_refuse_a_github_workspace() {
        let w = ws(Some(github_tracker()));
        assert!(rewrite_step(&w, &StepId("open".into()), &StepId("closed".into()), &github_board())
            .is_err());
        assert!(save_config(&w, github_board()).is_err());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test file_only`
Expected: FAIL — `cannot find function fs_provider_for`.

- [ ] **Step 3: Write minimal implementation**

```rust
/// What the six file-backed commands say to a workspace whose board is GitHub
/// issues. One message, in one place: six variations on it would drift.
const FILE_ONLY: &str =
    "this needs a folder-backed tracker — this workspace's board is its GitHub issues";

/// The concrete provider, for the callers that need more than the trait: the
/// migration (`offer_for`), the step rewrite and the ⚙ editor. Each of those is
/// meaningless without a folder, and each refuses rather than pretending.
fn fs_provider_for(ws: &Workspace) -> Result<FsTaskProvider, String> {
    match tracker_kind(ws) {
        Some(TrackerKind::Fs { root, creation }) => {
            // Handed the board `board_for` decided rather than reading it again:
            // one decision, one configuration (decision 1).
            Ok(FsTaskProvider::with_board(root, creation, board_for(ws).config))
        }
        Some(TrackerKind::GitHub) => Err(FILE_ONLY.to_string()),
        None => Err("not-configured".to_string()),
    }
}

/// The provider for everything that only needs the port.
///
/// `Box<dyn TaskProvider>` rather than an enum: an enum would make each
/// file-only command a compiler-checked `match`, which is attractive — but the
/// trait already exists, and one boxed value plus one narrowing function is less
/// machinery than an enum whose every arm has to be visited when Jira lands.
fn provider_for<'a>(
    state: &'a State<'_, AppState>,
    ws: &Workspace,
) -> Result<Box<dyn TaskProvider + 'a>, String> {
    match tracker_kind(ws) {
        Some(TrackerKind::Fs { .. }) => Ok(Box::new(fs_provider_for(ws)?)),
        Some(TrackerKind::GitHub) => {
            // **No I/O here.** Both closures borrow the state and run only when
            // the provider is actually used, so building a provider for a
            // workspace whose `gh` is missing succeeds — and the failure lands on
            // the list call, where the frontend can turn it into "Set up gh"
            // rather than "no tracker is configured". Resolving the repository
            // here instead is the single change that would make all three of
            // decision 9's unavailable states unreachable.
            let id = ws.id.clone();
            let repo_id = id.clone();
            Ok(Box::new(GhIssueProvider::new(
                Box::new(move || {
                    crate::commands::repo_facts_for(state, &repo_id).map(|f| f.repo)
                }),
                Box::new(move |argv, stdin| match stdin {
                    Some(body) => crate::commands::run_gh_with_stdin(state, &id, argv, body),
                    None => crate::commands::run_gh_for_workspace(state, &id, argv),
                }),
            )))
        }
        None => Err("not-configured".to_string()),
    }
}
```

**The lifetime: one design, and the error to expect if it is written the obvious way.**

Both closures borrow the state, and the provider is dropped by the end of the command that built it, so the lifetime is threaded rather than erased. `Box<dyn TaskProvider + 'a>` at the call sites is the only visible consequence; every call site is a `#[tauri::command]` body. `run_gh_for_workspace`, `run_gh_with_stdin` and `repo_facts_for` become `pub(crate)`.

**The mistake to avoid is not variance.** `State<'r, T>` wraps a shared reference and is therefore covariant, so nothing here fights the borrow checker over that. What fails is `Box::new` with **E0521, "borrowed data escapes outside of function"**, if `GhRunner` and `RepoSource` are declared without a lifetime — a bare `Box<dyn Fn…>` means `+ 'static`, and a closure holding `&'a State` is not. That is why Task 6 declares `GhRunner<'a>` and `RepoSource<'a>`, and if E0521 appears here anyway it means one of those parameters was dropped, not that the design is wrong. (`State` is `Clone`, not `Copy`, so a stray `state.clone()` compiles and hides the real question; it is not needed.)

**The escape hatch, if this turns into a fight:** give both closures owned data instead of a borrow — the `gh` invocation resolved by `gh_invocation` (Task 9) plus the workspace id — and the `'static` box works with no lifetimes anywhere. It costs one extra resolution per provider and **nothing worth measuring**: a provider construction is a `board.json` read at worst, against a `gh` process launch on every call it makes. If you take it, say so in the commit message and move on. Do not spend a second attempt on the borrowing form; Task 10 is already the riskiest task in the plan.

Then the call sites:

- `:337` `tasks_capabilities`, `:350` `tasks_list`, `:361` `tasks_create`, `:384` `tasks_resolve`, `:400` `tasks_update` — the `provider_for` call in each, passing `&state`, otherwise unchanged.
- `:412` `tasks_open_counts` — Task 11 rewrites it; for now, keep it compiling by calling `fs_provider_for` and skipping anything else, with a `// Task 11` comment.
- `:731` `step_usage` — `fs_provider_for(ws)?`, and read the board from `p.board()` as before.
- `tasks_migration_status`, `tasks_migrate`, `tasks_migration_dismiss`, `board_config_save`, `board_step_rewrite`, `board_step_usage` — each gains, as its first line, `fs_provider_for(&ws).map(|_| ())?` where it does not already build one, so the refusal happens before anything else. `tasks_migrate` and `rewrite_step`/`save_config` already refuse through `resolve_root`'s `None`, but with `"not-configured"`, which is the wrong sentence for a workspace that *is* configured; the explicit check replaces it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, everything. This is the task to run the whole suite for rather than a filter: it touches every command the board uses.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks_cmd.rs src-tauri/src/commands.rs
git commit -m "feat(issues): one boxed provider, and six commands that need a folder say so"
```

---

### Task 11/26: The sidebar count, served from the board's own last fetch

**Issue:** _(file it)_

`tasks_open_counts` iterates *every* workspace and is called on every board tick and after every mutation (`main.ts:116`, `:198`, `:267`, `:284`, `:302`, `:336`, `:359`). Four GitHub workspaces at three points each would put twelve points behind every card edit, so it must never touch the network.

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs`

**Interfaces:**
- Consumes: `AppState.issue_open_counts` (Task 9)

- [ ] **Step 1: Write the failing tests**

The command needs `State<AppState>`, which the unit tests do not have; the rule that can be tested purely is the counting itself. Extract it and test that:

```rust
    /// "Open" is "not closed", asked of the board rather than assumed: the file
    /// board can have three non-terminal steps.
    #[test]
    fn the_open_count_is_everything_not_in_a_terminal_step() {
        let cards = vec![
            issue_card("1", "open"),
            issue_card("2", "open"),
            issue_card("3", "closed"),
        ];
        assert_eq!(open_count(&cards, &github_board()), 2);
    }

    #[test]
    fn a_board_with_no_open_cards_counts_zero_rather_than_being_absent() {
        assert_eq!(open_count(&[issue_card("3", "closed")], &github_board()), 0);
    }
```

with a small `issue_card(id, step)` helper beside the others.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test open_count`
Expected: FAIL — `cannot find function open_count`.

- [ ] **Step 3: Write minimal implementation**

```rust
/// How many of these cards are not in a terminal step. Which steps those are is
/// the board's business, not this function's.
fn open_count(cards: &[Task], board: &BoardConfig) -> usize {
    cards.iter().filter(|c| !board.is_terminal(&c.status)).count()
}
```

`tasks_list` records it for a GitHub workspace, after a successful list:

```rust
    let cards = p.list(&ws.name).map_err(|e| e.to_string())?;
    // The sidebar badge's only source for this workspace. Recorded here rather
    // than fetched there, because `tasks_open_counts` runs across every
    // workspace after every mutation and must never spend a GraphQL point.
    if matches!(tracker_kind(&ws), Some(TrackerKind::GitHub)) {
        if let Ok(mut cache) = state.issue_open_counts.lock() {
            cache.insert(ws.id.clone(), open_count(&cards, &board_for(&ws).config));
        }
    }
    Ok(cards)
```

and `tasks_open_counts` serves it from there:

```rust
    for ws in all {
        match tracker_kind(&ws) {
            // Never a network call. A workspace whose board has not been opened
            // this run is *absent* rather than zero, and `WorkspacesPanel`
            // already draws nothing for an absent count
            // (`workspaces.ts:137-143`). The cost, plainly: a GitHub
            // workspace's badge is as fresh as the last time you looked at that
            // board. The better answer — one batched GraphQL query returning
            // `totalCount` for every GitHub workspace in a single point — is an
            // addition, not a rewrite, if that staleness turns out to matter.
            Some(TrackerKind::GitHub) => {
                if let Some(n) = state.issue_open_counts.lock().ok().and_then(|c| c.get(&ws.id).copied()) {
                    out.insert(ws.id.clone(), n);
                }
            }
            Some(TrackerKind::Fs { .. }) => {
                let Ok(p) = fs_provider_for(&ws) else { continue };
                let Ok(cards) = p.list(&ws.name) else { continue };
                out.insert(ws.id.clone(), open_count(&cards, p.board()));
            }
            None => continue,
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks_cmd.rs
git commit -m "feat(issues): the sidebar count comes from the last fetch, never from the network"
```

---

### Task 12/26: `session_env`, `start_session`, and the leak test

**Issue:** _(file it)_

**Risky, and the reason is stated in the spec:** `session_env` is the leak surface. Decision 5's promise is that a session in a GitHub workspace is never told about `board.json`, a cards directory, or the `cowork_task` sidecar — and the only way to test a promise about absence is to assert the absence.

`start_session` (`commands.rs:632`) is the one caller of `resolve_root` that is *wrong* for a GitHub workspace: with `None` it produces no tracker environment at all, which is silence rather than truth. It gains a branch on `tracker_kind`.

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `session_env(root, project, task_bin, session, task_id, issue_repo, issue_number)`
- Consumes: `tracker_kind`, `repo_facts_for`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/commands.rs`:

```rust
    fn value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// The leak test, written as an assertion about what is *missing*, because
    /// that is the failure mode. With no `COWORK_TASK_BIN` the agent has no path
    /// to the sidecar; with no `COWORK_TASKS_DIR` every subcommand fails loudly
    /// at `run()`'s env check for anyone who finds it anyway.
    #[test]
    fn a_github_session_is_told_nothing_about_files_or_the_sidecar() {
        let env = session_env(
            None, "cowork-deck", "/opt/cowork_task", "sess-1", None,
            Some("followLemmi/cowork-deck"), None,
        );
        for k in ["COWORK_TASKS_DIR", "COWORK_PROJECT", "COWORK_TASK_BIN"] {
            assert!(value(&env, k).is_none(), "{k} must not be set for a github workspace");
        }
        assert_eq!(value(&env, "COWORK_ISSUE_REPO"), Some("followLemmi/cowork-deck"));
        assert!(value(&env, "COWORK_ISSUE_NUMBER").is_none(), "no issue on a plain launch");
        // And no value anywhere names a folder of ours.
        assert!(
            !env.iter().any(|(_, v)| v.contains("cowork-deck-tasks") || v.contains("board.json")),
            "{env:?}",
        );
    }

    /// The analogue of `COWORK_TASK_ID`, set only on the launch-from-an-issue
    /// path — which is the same path, since for a GitHub workspace a card id *is*
    /// the issue number.
    #[test]
    fn an_issue_launch_names_the_issue() {
        let env = session_env(
            None, "cowork-deck", "/opt/cowork_task", "sess-1", Some("42"),
            Some("followLemmi/cowork-deck"), Some("42"),
        );
        assert_eq!(value(&env, "COWORK_ISSUE_NUMBER"), Some("42"));
        // Still pushed, for the reason its own comment gives: the hooks that key
        // off it need to know a card is linked. Inert here — `guard` dispatches
        // on COWORK_ISSUE_REPO before it ever reads this — and consistent, which
        // is what the assertion pins.
        assert_eq!(value(&env, "COWORK_TASK_ID"), Some("42"));
    }

    /// The file workspace's environment is unchanged, in both directions: this
    /// is the test that would fail if the new branch were reached by mistake.
    #[test]
    fn a_file_session_is_told_nothing_about_github() {
        let env = session_env(
            Some(std::path::Path::new("/home/u/vault/cowork-deck-tasks/deck")),
            "deck", "/opt/cowork_task", "sess-1", Some("01ABC"), None, None,
        );
        assert_eq!(value(&env, "COWORK_TASKS_DIR"), Some("/home/u/vault/cowork-deck-tasks/deck"));
        assert_eq!(value(&env, "COWORK_PROJECT"), Some("deck"));
        assert_eq!(value(&env, "COWORK_TASK_BIN"), Some("/opt/cowork_task"));
        for k in ["COWORK_ISSUE_REPO", "COWORK_ISSUE_NUMBER"] {
            assert!(value(&env, k).is_none(), "{k} must not be set for a file workspace");
        }
    }

    /// Neither workspace kind gets both. A contradictory environment is the state
    /// that should never occur, and the two branches are exclusive by
    /// construction — `root` is `None` exactly when the tracker is GitHub.
    #[test]
    fn the_two_tracker_environments_are_never_both_present() {
        let file = session_env(
            Some(std::path::Path::new("/r")), "deck", "/b", "s", None, None, None,
        );
        let gh = session_env(None, "deck", "/b", "s", None, Some("o/n"), None);
        assert!(value(&file, "COWORK_ISSUE_REPO").is_none());
        assert!(value(&gh, "COWORK_TASKS_DIR").is_none());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test session_env && cargo test github_session`
Expected: FAIL — `session_env` takes 5 arguments, not 7.

- [ ] **Step 3: Write minimal implementation**

`session_env` (`commands.rs:61`) gains two parameters, and its doc comment gains the reason the GitHub half exists at all:

```rust
/// … existing doc …
///
/// The GitHub half is two variables and no folder. `COWORK_ISSUE_REPO` exists
/// for one reason: without it `guard`'s no-card branch goes silent, and that
/// branch is the only thing telling a *plainly started* session that this
/// workspace has a tracker at all — the launch prompt is built on the launch
/// path alone. Losing it would quietly kill the "found a side problem, file a
/// ticket" convention in every GitHub workspace. `COWORK_ISSUE_NUMBER` is the
/// analogue of `COWORK_TASK_ID` and is set only on the launch-from-an-issue path.
pub fn session_env(
    root: Option<&std::path::Path>,
    project: &str,
    task_bin: &str,
    session: &str,
    task_id: Option<&str>,
    issue_repo: Option<&str>,
    issue_number: Option<&str>,
) -> Vec<(String, String)> {
    // … existing body …
    if let Some(repo) = issue_repo {
        env.push(("COWORK_ISSUE_REPO".to_string(), repo.to_string()));
    }
    if let Some(n) = issue_number {
        env.push(("COWORK_ISSUE_NUMBER".to_string(), n.to_string()));
    }
    env
}
```

Seven parameters is exactly clippy's limit; an eighth must become a struct rather than a warning.

`start_session` (`:630-648`) branches on the kind rather than on `resolve_root` alone:

```rust
    // Tracker environment, resolved from the workspace's configuration. Three
    // outcomes: a folder, a repository, or nothing at all.
    let (root, project, issue_repo) = match &ws {
        Some(ws) => match crate::tasks_cmd::tracker_kind(ws) {
            Some(crate::tasks_cmd::TrackerKind::Fs { root, creation }) => {
                // A project-kind root may not exist yet on a freshly configured
                // workspace — create it now so the CLI the session is about to
                // get has somewhere to write. Best-effort, as before.
                let _ = crate::tasks_cmd::ensure_root_if_ours(&root, &creation);
                (Some(root), ws.name.clone(), None)
            }
            // The repository is resolved the same way `pr_list` resolves it, and
            // cached: a session launch must not spend a point rediscovering what
            // the board already asked. A failure here is not fatal — the session
            // starts without the tracker line rather than not at all.
            Some(crate::tasks_cmd::TrackerKind::GitHub) => (
                None,
                ws.name.clone(),
                repo_facts_for(&state, &ws.id).ok().map(|f| f.repo),
            ),
            None => (None, ws.name.clone(), None),
        },
        None => (None, String::new(), None),
    };
    let mut env = session_env(
        root.as_deref(), &project, &state.task_bin_path, &session, task_id.as_deref(),
        issue_repo.as_deref(),
        // For a GitHub workspace a card id *is* the issue number, so no new
        // parameter is threaded through this already 10-argument command.
        issue_repo.as_ref().and(task_id.as_deref()),
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test commands`
Expected: PASS, plus 4. The two existing `session_env` tests must be updated with `None, None` and must keep asserting exactly what they asserted before — if one of them needs a *changed* assertion, the branch is leaking.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(issues): a github session gets a repository and no folder, asserted by absence"
```

---

### Task 13/26: `guard`'s GitHub branch, and its four integration cases

**Issue:** _(file it)_

The sidecar gets no GitHub mode (decision 5): no token, no repository, no faked `COWORK_TASKS_DIR`. What it gets is one branch that reports and never blocks, dispatched **before** `COWORK_TASKS_DIR` is read, so it never constructs an `FsTaskProvider` and never names a folder.

**Files:**
- Modify: `src-tauri/src/bin/cowork_task.rs`
- Modify: `src-tauri/tests/cowork_task.rs`

**Interfaces:**
- Produces: `github_guard(repo, issue) -> i32`

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/tests/cowork_task.rs`, in that file's existing environment-driven shape. A `gh_guard` helper beside `guard`, because these rows set a different set of variables:

```rust
/// `cowork_task guard` as a session in a GitHub workspace gets it: a repository,
/// optionally an issue, and — deliberately — no tracker directory. Returns
/// `(exit code, stdout, stderr)`.
fn gh_guard(repo: &str, issue: Option<&str>, dir: Option<&std::path::Path>, payload: &str)
    -> (i32, String, String)
{
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut cmd = Command::new(bin);
    cmd.arg("guard")
        .env("COWORK_ISSUE_REPO", repo)
        .env_remove("COWORK_TASK_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match issue {
        Some(n) => { cmd.env("COWORK_ISSUE_NUMBER", n); }
        None => { cmd.env_remove("COWORK_ISSUE_NUMBER"); }
    }
    match dir {
        Some(d) => { cmd.env("COWORK_TASKS_DIR", d); }
        None => { cmd.env_remove("COWORK_TASKS_DIR"); }
    }
    let mut child = cmd.spawn().unwrap();
    let _ = child.stdin.take().unwrap().write_all(payload.as_bytes());
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// The row that keeps the "file a ticket for a side problem" convention alive in
/// a GitHub workspace. `guard_allows_when_the_tracker_directory_is_unset` above
/// is the precedent for allowing when there is no reachable tracker — and it is
/// right for *its* case, an unreachable file tracker where there is nothing true
/// left to say. Here the tracker is perfectly reachable by another route, so
/// allowing *silently* would mean the contract changed under the agent with no
/// announcement.
#[test]
fn github_guard_announces_the_repository_on_a_user_prompt_without_an_issue() {
    let (code, out, err) =
        gh_guard("followLemmi/cowork-deck", None, None, r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0, "announcing is not blocking");
    assert!(err.trim().is_empty(), "nothing belongs on stderr here: {err}");
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("followLemmi/cowork-deck"), "must name the repository: {ctx}");
    assert!(ctx.contains("gh issue create"), "must name the call that files one: {ctx}");
    // The non-leak invariant, on the sidecar side: no folder, no variable name,
    // no sidecar.
    assert!(!ctx.contains("COWORK_"), "must not name an environment variable: {ctx}");
    assert!(!ctx.contains("cowork_task"), "must not name the sidecar: {ctx}");
    // Per line, not over the whole string: `ctx` always names the repository, so
    // any assertion of the form "no slash unless owner/name appears" is vacuously
    // true and would pass with a filesystem path sitting right next to it.
    for line in ctx.lines() {
        assert!(
            !line.contains('/') || line.contains("followLemmi/"),
            "no filesystem path: {line}",
        );
    }
}

#[test]
fn github_guard_names_the_issue_and_how_to_close_it() {
    let (code, out, _) = gh_guard(
        "followLemmi/cowork-deck", Some("42"), None,
        r#"{"hook_event_name":"UserPromptSubmit"}"#,
    );
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("#42"), "must name the issue: {ctx}");
    assert!(ctx.contains("gh issue close 42"), "must name the close command: {ctx}");
    // The warning is the point of the sentence, not decoration.
    assert!(ctx.contains("visible to everyone"), "must say what closing costs: {ctx}");
    assert!(!ctx.contains("COWORK_"), "{ctx}");
}

/// Decision 5's refusal to block, asserted rather than intended. Closing a
/// GitHub issue is public and undoing it is a second public action; a hook that
/// holds a session hostage until the agent closes one is a hook that pressures
/// an agent into a public write.
#[test]
fn github_guard_never_blocks_a_stop_with_or_without_an_issue() {
    for issue in [None, Some("42")] {
        let (code, out, err) = gh_guard(
            "followLemmi/cowork-deck", issue, None,
            r#"{"hook_event_name":"Stop","stop_hook_active":false}"#,
        );
        assert_eq!(code, 0, "a github workspace must never block a Stop (issue: {issue:?})");
        assert!(out.trim().is_empty(), "a Stop gets no context: {out}");
        assert!(err.trim().is_empty(), "and nothing to feed back: {err}");
    }
}

/// The state that should never occur, resolved one way on purpose rather than by
/// statement order in a future edit: `COWORK_ISSUE_REPO` is dispatched first, so
/// a contradictory environment takes the GitHub branch and no folder is ever
/// named.
#[test]
fn github_guard_wins_when_a_tracker_directory_is_also_set() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, out, _) = gh_guard(
        "followLemmi/cowork-deck", Some("42"), Some(dir.path()),
        r#"{"hook_event_name":"UserPromptSubmit"}"#,
    );
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("gh issue close 42"), "{ctx}");
    assert!(
        !ctx.contains(dir.path().to_str().unwrap()),
        "the github branch must never name a folder: {ctx}",
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --test cowork_task github_guard`
Expected: FAIL — the current `guard` returns 0 with no output for all four rows (no `COWORK_TASKS_DIR`), so the two announcement assertions fail on empty stdout.

- [ ] **Step 3: Write minimal implementation**

In `src-tauri/src/bin/cowork_task.rs`, at the very top of `guard()`, before the `COWORK_TASKS_DIR` read at `:204`:

```rust
    // Dispatched first, deliberately. A GitHub-backed workspace has no tracker
    // directory and must never have one described to it; putting this after the
    // directory read would make a contradictory environment resolve by statement
    // order, and a future edit could reorder it without noticing.
    let repo = std::env::var("COWORK_ISSUE_REPO").ok().filter(|r| !r.trim().is_empty());
    if let Some(repo) = repo {
        let issue = std::env::var("COWORK_ISSUE_NUMBER").ok().filter(|s| !s.trim().is_empty());
        return github_guard(&repo, issue.as_deref());
    }
```

and the branch itself, beside `guard`:

```rust
/// The GitHub half of the guard: it reports, every turn, and never blocks.
///
/// No `Stop` handling at all, and that is the decision rather than an omission.
/// The file guard blocks a `Stop` that leaves a card open because moving a card
/// is cheap, local and reversible. Closing a GitHub issue is none of those: it is
/// visible to everyone in the repository and undoing it is a second public
/// action. **Cost:** an agent can finish with the issue still open and nothing
/// stops it — which is what the board's ✓ and the person are for.
///
/// Nothing here reads `COWORK_TASKS_DIR`, constructs a provider, or names a
/// path: this workspace has no folder, and the whole promise of decision 5 is
/// that a session in it is never told otherwise.
fn github_guard(repo: &str, issue: Option<&str>) -> i32 {
    let mut payload = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut payload);
    let event = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .and_then(|v| v["hook_event_name"].as_str().map(str::to_string))
        .unwrap_or_default();
    if event != "UserPromptSubmit" {
        return 0;
    }
    let ctx = match issue {
        Some(n) => format!(
            "Tracker card: issue #{n} in {repo}. Close it with: gh issue close {n} --repo {repo}. \
             Do not close it unless the work is finished — closing is visible to everyone in the \
             repository."
        ),
        None => format!(
            "This workspace's tracker is the GitHub issues of {repo}. File one with: \
             gh issue create --repo {repo} --title \"…\" --body \"…\". Only file an issue for \
             something you are not going to fix in this session."
        ),
    };
    println!(
        "{}",
        serde_json::json!({
            "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": ctx }
        })
    );
    0
}
```

`hooks.rs` stays untouched: the guard is wired unconditionally (`hooks.rs:30-32`), and with the GitHub branch allowing on its own the argument in that comment for one branch instead of two still holds.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --test cowork_task`
Expected: PASS, 24 + 5 (the `for` loop in the `Stop` test counts as one).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/cowork_task.rs src-tauri/tests/cowork_task.rs
git commit -m "feat(issues): the sidecar guard reports a repository and never blocks"
```

---

### Task 14/26: The issue worktree commands

**Issue:** _(file it)_

The three commands behind ▶ on an issue and the cleanup offer after it closes. The clippy count is unchanged at 6 and was never above it — the sanctioned excess rested on a wrong premise about `dead_code` in a library crate, withdrawn at Task 5. Do not go looking for two warnings to remove.

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Produces: `issue_worktree_add(workspace_id, number, title) -> String`, `issue_worktree_path(workspace_id, number, title) -> Option<String>`, `issue_worktree_remove(workspace_id, number, title) -> Result<(), String>`
- Consumes: `gh_issues::issue_branch`, `issue_worktree_path`, `repo_facts_for`, `worktree_is_clean`, `workspace_path`

- [ ] **Step 1: Write the failing test**

The commands need `State<AppState>`; what is testable purely is the argv the two git steps use, so extract them:

```rust
    /// The base is the repository's default branch, never the workspace's
    /// current HEAD: the person may be sitting on a feature branch, and an issue
    /// branch based on it would silently inherit unrelated work.
    #[test]
    fn a_new_issue_worktree_branches_off_the_remote_default() {
        let argv = worktree_add_argv("/tmp/x-issue/42-t", "issue-42-t", Some("main"));
        assert_eq!(&argv[0..2], &["worktree".to_string(), "add".to_string()]);
        let at = argv.iter().position(|a| a == "-b").expect("-b");
        assert_eq!(argv[at + 1], "issue-42-t");
        assert_eq!(argv.last().unwrap(), "origin/main");
    }

    /// If the branch exists but the directory does not — a manual `rm -rf` — a
    /// worktree is attached to the existing branch rather than created, or the
    /// second launch dies where the first succeeded.
    #[test]
    fn an_existing_branch_is_attached_rather_than_recreated() {
        let argv = worktree_add_argv("/tmp/x-issue/42-t", "issue-42-t", None);
        assert!(!argv.iter().any(|a| a == "-b"), "an existing branch is not created again");
        assert_eq!(argv.last().unwrap(), "issue-42-t");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test worktree_add_argv`
Expected: FAIL — `cannot find function worktree_add_argv`.

- [ ] **Step 3: Write minimal implementation**

```rust
/// `git worktree add` for an issue branch. `base` is `Some` when the branch has
/// to be created and `None` when it already exists.
fn worktree_add_argv(path: &str, branch: &str, base: Option<&str>) -> Vec<String> {
    let mut argv: Vec<String> = vec!["worktree".into(), "add".into()];
    match base {
        Some(default) => {
            argv.push("-b".into());
            argv.push(branch.into());
            argv.push(path.into());
            argv.push(format!("origin/{default}"));
        }
        None => {
            argv.push(path.into());
            argv.push(branch.into());
        }
    }
    argv
}

fn branch_exists(ws_path: &str, branch: &str) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .current_dir(ws_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A worktree on a new branch off the repository's default branch, and the path
/// to it. Beside the workspace, never inside it — see
/// `gh_issues::issue_worktree_path` and BUG-026.
#[tauri::command]
pub fn issue_worktree_add(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    title: String,
) -> Result<String, String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = cowork_deck::tasks::gh_issues::issue_worktree_path(&ws_path, number, &title);
    // Already there from an earlier launch: hand it back rather than failing, as
    // `pr_worktree_add` does. The session that opens in it sees whatever state it
    // was left in.
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;

    let branch = cowork_deck::tasks::gh_issues::issue_branch(number, &title);
    let base = if branch_exists(&ws_path, &branch) {
        None
    } else {
        let facts = repo_facts_for(&state, &workspace_id)?;
        if facts.default_branch.is_empty() {
            return Err("this repository has no default branch to base an issue branch on".into());
        }
        // Fetched first, so a branch is not cut from a stale `origin/main`. The
        // failure is surfaced rather than swallowed: the same choice
        // `pr_worktree_add` makes about its own fetch (`commands.rs:545`).
        let out = std::process::Command::new("git")
            .args(["fetch", "origin", &facts.default_branch])
            .current_dir(&ws_path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Some(facts.default_branch)
    };

    let argv = worktree_add_argv(&path.to_string_lossy(), &branch, base.as_deref());
    let out = std::process::Command::new("git")
        .args(&argv)
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(path.to_string_lossy().to_string())
}
```

`issue_worktree_path` and `issue_worktree_remove` are the same shape as `pr_worktree_path` (`:506`) and `pr_worktree_remove` (`:561`), keyed by `(number, title)` instead of `(number, branch)`, and `issue_worktree_remove` keeps all three of `pr_worktree_remove`'s guards verbatim: refuse while dirty, refuse when cleanliness cannot be determined, and never remove what is not there. Register all three in `main.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test commands && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | grep -c '^warning'`
Expected: PASS, and the clippy count back at exactly 6. If it is higher, something Task 5 landed still has no caller.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(issues): a worktree per issue, beside the workspace and never inside it"
```

---

### Task 15/26: `pr_worktree_add` reuses an existing worktree

**Issue:** _(file it)_

**Risky: a change to a shipped path**, and the only task in the plan that changes behaviour the pull request view already has. Without it the ordinary path through this feature produces two copies of one piece of work — an issue worktree on `issue-42-…` and, after the pull request opens, a second worktree on `pr-57` with the same commits in a different directory, where pushing back needs `git push origin pr-57:issue-42-…` and nothing says so.

*Rejected, and worth knowing why:* re-keying the worktree path by branch slug so the two coincide by construction. It is the tidier model and it orphans every worktree the pull request path has already created — `pr_worktree_path` would report them absent and the cleanup offer would never appear for them. The lookup changes no naming and no existing directory.

**Files:**
- Modify: `src-tauri/src/gh_pr.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `gh_pr::worktree_on_branch(porcelain, branch) -> Option<PathBuf>`; `pr_worktree_add` returns `{ path, reused }`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/gh_pr.rs`:

```rust
    const PORCELAIN: &str = "worktree /home/u/projects/cowork-deck\n\
HEAD aaaa\n\
branch refs/heads/main\n\
\n\
worktree /home/u/projects/cowork-deck-issue/42-sidebar\n\
HEAD bbbb\n\
branch refs/heads/issue-42-sidebar\n\
\n\
worktree /home/u/projects/cowork-deck-pr/9-old\n\
HEAD cccc\n\
detached\n";

    #[test]
    fn a_worktree_already_on_the_head_branch_is_found() {
        assert_eq!(
            worktree_on_branch(PORCELAIN, "issue-42-sidebar"),
            Some(std::path::PathBuf::from("/home/u/projects/cowork-deck-issue/42-sidebar")),
        );
    }

    #[test]
    fn a_branch_with_no_worktree_is_none() {
        assert_eq!(worktree_on_branch(PORCELAIN, "issue-99-nope"), None);
    }

    /// A detached worktree is on no branch at all, and matching it would hand
    /// back a directory whose HEAD has nothing to do with the pull request.
    #[test]
    fn a_detached_worktree_never_matches() {
        assert_eq!(worktree_on_branch(PORCELAIN, "cccc"), None);
    }

    /// `refs/heads/issue-42-sidebar` must not be matched by `issue-4`: a prefix
    /// match here would attach a session to somebody else's branch.
    #[test]
    fn a_branch_name_is_matched_whole_not_as_a_prefix() {
        assert_eq!(worktree_on_branch(PORCELAIN, "issue-4"), None);
        assert_eq!(worktree_on_branch(PORCELAIN, "main"), Some("/home/u/projects/cowork-deck".into()));
    }

    #[test]
    fn empty_porcelain_output_is_none_rather_than_a_panic() {
        assert_eq!(worktree_on_branch("", "main"), None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test worktree_on_branch`
Expected: FAIL — `cannot find function worktree_on_branch`.

- [ ] **Step 3: Write minimal implementation**

```rust
/// The worktree checked out on `branch`, from `git worktree list --porcelain`.
///
/// The format is blank-line-separated blocks of `worktree <path>`, `HEAD <oid>`
/// and then either `branch refs/heads/<name>` or `detached`. Matched whole
/// rather than by prefix, and never for a detached worktree: either mistake
/// would hand a session a directory whose HEAD has nothing to do with the pull
/// request it asked about.
pub fn worktree_on_branch(porcelain: &str, branch: &str) -> Option<std::path::PathBuf> {
    let wanted = format!("refs/heads/{branch}");
    let mut path: Option<&str> = None;
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.trim());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if b.trim() == wanted {
                return path.map(std::path::PathBuf::from);
            }
        }
    }
    None
}
```

In `commands.rs`, `pr_worktree_add` gains the lookup and both commands' shape changes:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdded {
    pub path: String,
    /// True when this is the directory an issue was already being worked in.
    /// The tile's prompt says so: the same commits under two names would
    /// otherwise read as two pieces of work.
    pub reused: bool,
}

#[tauri::command]
pub fn pr_worktree_add(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    branch: String,
    cross_repository: bool,
) -> Result<WorktreeAdded, String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    if path.exists() {
        return Ok(WorktreeAdded { path: path.to_string_lossy().to_string(), reused: false });
    }

    // The ordinary path through the issues board produces a worktree on the
    // issue's own branch before the pull request exists. Reuse it rather than
    // fetching the same commits into a second directory under a second name.
    // Never for a fork: the head is not a local branch there, and our own issue
    // flow cannot have produced the first worktree anyway.
    if !cross_repository {
        let out = std::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&ws_path)
            .output();
        // Best effort: a failure here means "no reuse", never "no worktree". One
        // extra git invocation per launch is the cost of the choice.
        if let Ok(out) = out {
            if out.status.success() {
                let listed = String::from_utf8_lossy(&out.stdout);
                if let Some(found) = crate::gh_pr::worktree_on_branch(&listed, &branch) {
                    return Ok(WorktreeAdded {
                        path: found.to_string_lossy().to_string(),
                        reused: true,
                    });
                }
            }
        }
    }
    // … today's fetch-into-`pr-{n}` path unchanged, wrapped in
    //   Ok(WorktreeAdded { path, reused: false })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_pr && cargo test commands`
Expected: PASS. **`npx tsc --noEmit` stays clean here, and that is the problem to be aware of rather than a reassurance:** `tsc` cannot see a Tauri command's signature, so `prWorktreeAdd`'s TypeScript wrapper still declares `invoke<string>` against a command that now returns an object, and nothing catches it until it runs. The mismatch is real from this commit until Task 18 closes it, and it is invisible to every gate in between. Do not add a frontend change here to "balance" it — Barrier B exists precisely so the backend can be finished before the frontend is touched.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh_pr.rs src-tauri/src/commands.rs
git commit -m "feat(pr): reuse the worktree an issue was already worked in"
```

---

### Task 16/26: `pr_list_argv` names its repository

**Issue:** _(file it)_

Decision 11's recommendation, accepted by the user as closed question 6: a change to a shipped path with no user-visible gain, so it is a task of its own with its own commit, and it goes on the manual check.

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Update the failing test**

`tests/commands.rs`-side there is none; the argv test lives in `mod tests` in `commands.rs`. Change it to require the flag:

```rust
    /// Explicit rather than resolved from `cwd`. This feature creates worktrees
    /// whose `origin` is related to but not identical with the workspace's, so a
    /// command that resolves its repository from wherever it happens to be
    /// standing is a command waiting to act on the wrong one.
    #[test]
    fn the_pr_list_call_names_its_repository() {
        let argv = pr_list_argv("o/n", PR_PAGE_LIMIT);
        let at = argv.iter().position(|a| a == "-R").expect("-R");
        assert_eq!(argv[at + 1], "o/n");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test pr_list_call`
Expected: FAIL — `pr_list_argv` takes one argument.

- [ ] **Step 3: Write minimal implementation**

`pr_list_argv(repo: &str, limit: usize)` pushes `-R`, `repo`; `pr_list` resolves `repo_facts_for(&state, &workspace_id)?.repo` first. That adds one cached lookup to the first pull request refresh of an app run and none thereafter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(pr): pass the repository explicitly instead of relying on cwd"
```

---

### Task 17/26: `tracker_open_count`, for the switch confirmation

**Issue:** _(file it)_

The workspace form has to say how many cards it is about to stop showing, and it has to say it *before* the save — afterwards the deck no longer knows the old root. One read-only command, and `None` rather than an error when the root cannot be read: the form says "any cards there" instead of a number rather than blocking the save on a directory read.

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Produces: Tauri command `tracker_open_count(workspace_id) -> Option<usize>`

- [ ] **Step 1: Write the failing test**

```rust
    /// The form asks before the save, so the workspace still has its file
    /// tracker at this point. A workspace whose tracker is already GitHub — or
    /// none — has no folder to count, and `None` is the honest answer.
    #[test]
    fn the_open_count_is_absent_for_a_workspace_with_no_folder() {
        assert_eq!(open_count_at_root(&ws(Some(github_tracker()))), None);
        assert_eq!(open_count_at_root(&ws(None)), None);
    }

    #[test]
    fn the_open_count_reads_the_configured_root() {
        let dir = tempfile::tempdir().unwrap();
        let w = ws(Some(tracker(TrackerRoot::Path { path: dir.path().to_string_lossy().into() })));
        let (root, creation) = resolve_root(&w).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let p = FsTaskProvider::new(root, creation);
        p.create(crate::tasks::model::TaskDraft {
            title: "A card".into(), kind: KindId("task".into()), body: String::new(),
            project: "cowork-deck".into(), origin: TaskOrigin::Human, session: None,
        })
        .unwrap();
        assert_eq!(open_count_at_root(&w), Some(1));
    }

    /// An unreadable root is not zero: "0 open cards" would invite a switch that
    /// silently abandons a folder full of them.
    #[test]
    fn an_unreadable_root_reports_nothing_rather_than_zero() {
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/nonexistent/xyz".into() })));
        assert_eq!(open_count_at_root(&w), None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test open_count_at_root`
Expected: FAIL — `cannot find function open_count_at_root`.

- [ ] **Step 3: Write minimal implementation**

```rust
/// How many open cards are at this workspace's configured root, or `None` when
/// there is no root or it cannot be read. Read-only, and never an error: the
/// workspace form calls it to write one sentence, and a directory read that
/// fails must not block a save.
fn open_count_at_root(ws: &Workspace) -> Option<usize> {
    let p = fs_provider_for(ws).ok()?;
    let cards = p.list(&ws.name).ok()?;
    Some(open_count(&cards, p.board()))
}

#[tauri::command]
pub fn tracker_open_count(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Option<usize>, String> {
    Ok(open_count_at_root(&workspace(&state, &workspace_id)?))
}
```

Register `tasks_cmd::tracker_open_count` in `main.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks_cmd.rs src-tauri/src/main.rs
git commit -m "feat(issues): count the cards a source switch would leave behind"
```

---

> ### Barrier B
>
> Run `cd src-tauri && cargo test` — fully green, at 286 plus everything Phase 1 and Phase 2 added — and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`, which must report **exactly 6** warnings. `npx tsc --noEmit` is **clean**, and one thing it is clean *about* is worth stating so an agent does not read the green as coverage: `pr_worktree_add` returns an object as of Task 15 while `ipc.ts` still declares `invoke<string>`, and `tsc` cannot see across that boundary. It is a runtime break, not a compile-time one, and Task 18 closes it. The backend is complete and reachable only from tests: the frontend cannot yet produce a `{"type":"github"}` tracker config, so nothing user-visible has changed. This is the last point at which a backend bug is unambiguously a backend bug.

---

## Phase 3 — Frontend

### Task 18/26: `ipc.ts` — the types and the wrappers

**Issue:** _(file it)_

The Rust model mirrored, and the seven new or changed wrappers. This task closes the one expected TypeScript breakage from Task 15.

**Files:**
- Modify: `src/ipc.ts`
- Modify: `tests/ipc.test.ts`, `tests/board.test.ts`, `tests/board-drag.test.ts`, `tests/card-modal.test.ts`, `tests/sessions.test.ts`, `tests/tasks.test.ts`

**Interfaces:**
- Produces: `TrackerConfig` widened, `Task.labels`, `ProviderCapabilities.boardEditable`, `TaskPatch.reason`, `IssueTotals`, `issueTotals`, `issueWorktreeAdd`, `issueWorktreePath`, `issueWorktreeRemove`, `trackerOpenCount`, `prWorktreeAdd` returning `WorktreeAdded`

- [ ] **Step 1: Write the failing tests**

Add to `tests/ipc.test.ts`:

```ts
  it("issueTotals names the command and its workspace", async () => {
    vi.mocked(invoke).mockResolvedValue({ open: 50, closed: 63, rateRemaining: 4873 });
    const t = await issueTotals("w1");
    expect(invoke).toHaveBeenCalledWith("issue_totals", { workspaceId: "w1" });
    expect(t.open).toBe(50);
  });

  it("issueWorktreeAdd passes the issue's number and title, not a branch", async () => {
    vi.mocked(invoke).mockResolvedValue("/tmp/x-issue/42-t");
    await issueWorktreeAdd("w1", 42, "Sidebar badge sticks");
    expect(invoke).toHaveBeenCalledWith("issue_worktree_add", {
      workspaceId: "w1", number: 42, title: "Sidebar badge sticks",
    });
  });

  /// The branch is derived in Rust from the number and the title, so the
  /// frontend never has to know the naming rule — and cannot get it wrong.
  it("issueWorktreePath and issueWorktreeRemove take the same three arguments", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await issueWorktreePath("w1", 42, "t");
    await issueWorktreeRemove("w1", 42, "t");
    expect(invoke).toHaveBeenNthCalledWith(1, "issue_worktree_path",
      { workspaceId: "w1", number: 42, title: "t" });
    expect(invoke).toHaveBeenNthCalledWith(2, "issue_worktree_remove",
      { workspaceId: "w1", number: 42, title: "t" });
  });

  it("prWorktreeAdd forwards whether the pull request is from a fork", async () => {
    vi.mocked(invoke).mockResolvedValue({ path: "/tmp/x-pr/7-b", reused: false });
    const added = await prWorktreeAdd("w1", 7, "b", true);
    expect(invoke).toHaveBeenCalledWith("pr_worktree_add", {
      workspaceId: "w1", number: 7, branch: "b", crossRepository: true,
    });
    expect(added.reused).toBe(false);
  });

  it("trackerOpenCount may answer nothing at all", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await trackerOpenCount("w1")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("tracker_open_count", { workspaceId: "w1" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ipc.test.ts`
Expected: FAIL — `issueTotals is not exported`.

- [ ] **Step 3: Write minimal implementation**

In `src/ipc.ts`:

```ts
export interface Task {
  // … unchanged …
  /** Issue labels, as chips in the meta row. Empty for a card file, which has
   *  none — never a `kind`: an issue can carry two labels and `kind` is a
   *  single-valued select. */
  labels: string[];
}

export interface TaskPatch {
  title?: string; kind?: KindId; status?: StepId; body?: string;
  /** Why a card is being closed, where closing takes a reason
   *  (`completed` / `not planned`). Ignored by the file provider. */
  reason?: string;
}

export interface ProviderCapabilities {
  // … unchanged …
  /** Whether ⚙ is offered. False for a synthesized board: there is no
   *  `board.json` to write, and one synthetic kind is not a choice. */
  boardEditable: boolean;
}

/** A workspace's task source. One element, never merged: `TrackerConfig.providers`
 *  is a list so a second kind arrives as an added variant, and every reader takes
 *  the first. */
export type TrackerProviderConfig =
  | { type: "fs"; root: TrackerRoot }
  | { type: "github" };
export interface TrackerConfig { providers: TrackerProviderConfig[] }

export interface IssueTotals {
  open: number;
  closed: number;
  /** GraphQL points left this hour, read from the response headers. Null when
   *  the headers said nothing — never 0, which means exhausted. */
  rateRemaining: number | null;
}
export interface WorktreeAdded { path: string; reused: boolean }

export const issueTotals = (workspaceId: string) =>
  invoke<IssueTotals>("issue_totals", { workspaceId });
export const issueWorktreeAdd = (workspaceId: string, number: number, title: string) =>
  invoke<string>("issue_worktree_add", { workspaceId, number, title });
export const issueWorktreePath = (workspaceId: string, number: number, title: string) =>
  invoke<string | null>("issue_worktree_path", { workspaceId, number, title });
export const issueWorktreeRemove = (workspaceId: string, number: number, title: string) =>
  invoke<void>("issue_worktree_remove", { workspaceId, number, title });
export const trackerOpenCount = (workspaceId: string) =>
  invoke<number | null>("tracker_open_count", { workspaceId });
```

and `prWorktreeAdd` gains the flag and the new return type:

```ts
export const prWorktreeAdd = (
  workspaceId: string, number: number, branch: string, crossRepository: boolean,
) => invoke<WorktreeAdded>("pr_worktree_add", { workspaceId, number, branch, crossRepository });
```

`labels` is required rather than optional, because Rust always sends it: the six `Task` literals in `tests/board.test.ts`, `tests/board-drag.test.ts`, `tests/card-modal.test.ts`, `tests/sessions.test.ts` and `tests/tasks.test.ts` each gain `labels: []`. Most of them go through a local `card()` helper, so that is five edits and one direct literal. `boardEditable` likewise gains a value in every `ProviderCapabilities` fixture — `true` in the existing ones, since they all describe file boards.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS and clean. `main.ts`'s call to `prWorktreeAdd` needs its fourth argument here to keep `tsc` clean — pass `pr.isCrossRepository` and use `added.path`; the prompt line that mentions reuse lands in Task 23.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/main.ts tests/
git commit -m "feat(issues): frontend types for a github tracker and the new commands"
```

---

### Task 19/26: `issuePrompt`, and the two non-leak invariants

**Issue:** _(file it)_

The launch prompt for an issue, beside `taskPrompt` rather than inside it. Both directions are tested, and the second matters as much as the first: a shared prompt builder that grew a `gh` line would leak the network model into a folder-backed workspace.

**Files:**
- Modify: `src/tasks.ts`
- Modify: `tests/tasks.test.ts`

**Interfaces:**
- Produces: `issuePrompt(task: Task, repo: string): string`
- Also covers: the spec's "TS, pure" requirement that `boardColumns` be exercised over synthesized-board input — no production change, one test, and `boardColumns` already lives in this file

- [ ] **Step 1: Write the failing tests**

Add to `tests/tasks.test.ts`:

```ts
describe("issuePrompt", () => {
  const issue = (over: Partial<Task> = {}): Task => ({
    id: "42", title: "Sidebar badge sticks after a rename", kind: "", status: "open",
    project: "cowork-deck", created: "2026-07-01T10:00:00Z", resolved: null, origin: "human",
    session: null, body: "It sticks.", path: "https://github.com/followLemmi/cowork-deck/issues/42",
    damaged: null, conflict: false, labels: [], ...over,
  });

  it("names the issue, the repository, the URL and how to close it", () => {
    const p = issuePrompt(issue(), "followLemmi/cowork-deck");
    expect(p).toContain("GitHub issue #42 in followLemmi/cowork-deck");
    expect(p).toContain("Title: Sidebar badge sticks after a rename");
    expect(p).toContain("https://github.com/followLemmi/cowork-deck/issues/42");
    expect(p).toContain("It sticks.");
    expect(p).toContain("gh issue close 42");
    // The warning is the point of the sentence, not decoration.
    expect(p).toContain("visible to");
  });

  /// No steps line and no status command: the board has two steps, both are
  /// named by the close instruction, and there is nothing between them to move
  /// to.
  it("has no steps line, because there is nothing between open and closed", () => {
    const p = issuePrompt(issue(), "o/n");
    expect(p).not.toContain("steps");
    expect(p).not.toContain("status");
  });

  it("omits the body when there is none rather than leaving a blank stanza", () => {
    const p = issuePrompt(issue({ body: "   " }), "o/n");
    expect(p).not.toMatch(/\n\n\n/);
  });

  /// The non-leak invariant, stated so it can be tested. A session in a GitHub
  /// workspace is never told about the sidecar, a cards directory or board.json.
  it("names no environment variable, no board.json and no filesystem path", () => {
    const p = issuePrompt(issue(), "followLemmi/cowork-deck");
    expect(p).not.toContain("COWORK_");
    expect(p).not.toContain("board.json");
    expect(p).not.toContain("Card file:");
    // The only slash allowed is the one inside owner/name and the URL's own.
    for (const line of p.split("\n")) {
      if (line.includes("/") ) {
        expect(line.includes("followLemmi/") || line.startsWith("https://")).toBe(true);
      }
    }
  });

  /// The spec's Testing section asks for this one under "TS, pure", and it is the
  /// only place the Rust and TypeScript halves of decision 3 meet: two synthesized
  /// steps, one terminal, against `boardColumns`' own `doneLimit = 20`
  /// (`tasks.ts:93`). Cheap, and it fails loudly if either half drifts.
  it("columns a synthesized two-step board and caps the closed one at twenty", () => {
    const cfg: BoardConfig = {
      v: 1,
      steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
      kinds: [{ id: "issue", label: "Issue" }],
    };
    const issues = [
      ...Array.from({ length: 3 }, (_, i) =>
        issue({ id: `o${i}`, status: "open", created: `2026-07-0${i + 1}T00:00:00Z` })),
      ...Array.from({ length: 25 }, (_, i) =>
        issue({ id: `c${i}`, status: "closed", resolved: `2026-06-${10 + i}T00:00:00Z` })),
    ];
    const cols = boardColumns(issues, "cowork-deck", cfg);
    expect(cols.columns.map((c) => c.step.id)).toEqual(["open", "closed"]);
    expect(cols.columns[0].tasks).toHaveLength(3);
    // The terminal column caps itself the way it always has; the open one never
    // hides anything, because a non-terminal column hiding a card hides work.
    expect(cols.columns[1].tasks).toHaveLength(20);
    expect(cols.columns[1].hidden).toBe(5);
    expect(cols.columns[0].hidden).toBe(0);
    // Decision 4 sets every issue's `project` to the workspace name, so nothing
    // is ever foreign and no step is ever unknown on this board.
    expect(cols.foreign).toEqual([]);
    expect(cols.unknown).toEqual([]);
  });

  /// The other direction, and it matters as much: a shared prompt builder that
  /// grew a `gh` line would leak the network model into a folder-backed
  /// workspace, where there is no repository and no token.
  it("taskPrompt names no gh command", () => {
    const p = taskPrompt(
      { ...issue({ id: "01ABC", path: "/r/01ABC-card.md", kind: "bug" }) },
      { v: 1, steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
        kinds: [{ id: "bug", label: "bug" }] },
    );
    expect(p).not.toContain("gh ");
    expect(p).not.toContain("github.com");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tasks.test.ts`
Expected: FAIL — `issuePrompt is not exported`.

- [ ] **Step 3: Write minimal implementation**

In `src/tasks.ts`, beside `taskPrompt` and leaving it untouched:

```ts
/** Initial prompt for a session launched from a GitHub issue.
 *
 *  Replaces `taskPrompt` wholesale on this path rather than branching inside it:
 *  every one of `taskPrompt`'s three `"$COWORK_TASK_BIN"` references and its
 *  `Card file:` line is wrong here, and a shared builder with two modes is a
 *  builder one edit away from leaking either model into the other. The two
 *  non-leak invariants are tested in both directions.
 *
 *  No steps line and no status command: the board has two steps, both named by
 *  the close instruction, and nothing between them to move to. */
export function issuePrompt(task: Task, repo: string): string {
  const lines = [
    `GitHub issue #${task.id} in ${repo}.`,
    "",
    `Title: ${task.title}`,
    task.path,
  ];
  const body = task.body.trim();
  if (body) lines.push("", body);
  lines.push(
    "",
    `When the work is finished, close the issue: gh issue close ${task.id}`,
    "Do not close it if the work is incomplete — a closed issue is visible to",
    "everyone in the repository.",
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tasks.test.ts && npx tsc --noEmit`
Expected: PASS, 5 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts tests/tasks.test.ts
git commit -m "feat(issues): a launch prompt that names gh and never names a folder"
```

---

### Task 20/26: `src/issues.ts` — the pure rules

**Issue:** _(file it)_

Every rule the board's GitHub behaviour needs, in a module with no DOM and no IPC. `main.ts` is not reachable from a test, so nothing with a truth table may live there — which is why the confirmation *rule* is here and only the modal call is there.

**Files:**
- Create: `src/issues.ts`
- Create: `tests/issues.test.ts`

**Interfaces:**
- Produces: `ISSUE_POLL_MS`, `FILE_POLL_MS`, `boardPollMs`, `OPEN_PAGE_LIMIT`, `needsTotals`, `countLine`, `needsCloseConfirmation`, `closeConfirmText`, `RATE_WARN_BELOW`, `rateLimitBanner`, `sourceOf`

- [ ] **Step 1: Write the failing tests**

Create `tests/issues.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ISSUE_POLL_MS, FILE_POLL_MS, boardPollMs, OPEN_PAGE_LIMIT, needsTotals, countLine,
  needsCloseConfirmation, closeConfirmText, RATE_WARN_BELOW, rateLimitBanner, sourceOf,
} from "../src/issues";
import type { BoardConfig, TrackerConfig } from "../src/ipc";

const GH: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
  kinds: [{ id: "issue", label: "Issue" }],
};

describe("the poll interval", () => {
  /// 30 s, and one interval rather than two: nothing on an issue changes on its
  /// own the way a check run does, so the PR view's fast/slow split has no
  /// analogue. Far slower than the board's blind 5 s, because at that rate one
  /// workspace would spend 14.4% of the hourly GraphQL budget.
  it("is 30 seconds for a github board and unchanged for a file one", () => {
    expect(ISSUE_POLL_MS).toBe(30_000);
    expect(boardPollMs("github")).toBe(ISSUE_POLL_MS);
    expect(boardPollMs("fs")).toBe(FILE_POLL_MS);
    expect(FILE_POLL_MS).toBe(5_000);
  });
});

describe("the totals call", () => {
  /// A page that came back with fewer rows than the cap *is* the total —
  /// "showing 12 of 12" needs no second call — so the only moment the totals
  /// query can change the message is the moment the page is capped. In a
  /// repository with fewer than 50 open issues it never fires at all.
  it("fires only when the open page came back full", () => {
    expect(needsTotals(12)).toBe(false);
    expect(needsTotals(OPEN_PAGE_LIMIT - 1)).toBe(false);
    expect(needsTotals(OPEN_PAGE_LIMIT)).toBe(true);
  });

  it("is skipped for an empty repository", () => {
    expect(needsTotals(0)).toBe(false);
  });
});

describe("the count line", () => {
  it("has two real numbers when the page was capped", () => {
    expect(countLine(50, 63)).toBe("Showing 50 of 63 open issues.");
  });

  /// Absent on a short page: the list is the whole truth there, and a line
  /// saying so is noise on every render.
  it("is absent on a short page and when no total is known", () => {
    expect(countLine(12, 12)).toBeNull();
    expect(countLine(50, null)).toBeNull();
  });

  /// The total can be lower than the page if an issue closed between the two
  /// calls. Saying "showing 50 of 49" would look like a bug in the app rather
  /// than a moment's inconsistency at GitHub.
  it("is absent when the total has fallen below what is on screen", () => {
    expect(countLine(50, 49)).toBeNull();
  });
});

describe("the close confirmation", () => {
  /// A close is visible to the whole repository; a reopen restores the state of
  /// a moment ago. Same asymmetry, same reason, as the pull request view's.
  it("is asked in the closing direction only", () => {
    expect(needsCloseConfirmation(GH, "open", "closed")).toBe(true);
    expect(needsCloseConfirmation(GH, "closed", "open")).toBe(false);
    expect(needsCloseConfirmation(GH, "open", "open")).toBe(false);
  });

  /// The file board writes a local file; nothing there is worth a modal, and
  /// adding one would change a shipped board's behaviour for no reason.
  it("is never asked on a board that has no such asymmetry", () => {
    const fs: BoardConfig = {
      v: 1,
      steps: [{ id: "todo", label: "To do" }, { id: "done", label: "Done", terminal: true }],
      kinds: [{ id: "task", label: "Task" }],
    };
    expect(needsCloseConfirmation(fs, "todo", "done", "fs")).toBe(false);
  });

  it("names the issue and offers both reasons", () => {
    const t = closeConfirmText(42, "Sidebar badge sticks");
    expect(t).toContain("#42");
    expect(t).toContain("Sidebar badge sticks");
    expect(t).toContain("everyone in the repository");
  });
});

describe("the rate limit banner", () => {
  /// Detected proactively, never by matching the refusal's message: that text is
  /// unverified — the refusal could not be provoked safely — and a string match
  /// on an unobserved message is a guess that fails on the one day it matters.
  it("appears below the threshold and says the fix is to wait", () => {
    const b = rateLimitBanner(RATE_WARN_BELOW - 1);
    expect(b).not.toBeNull();
    expect(b).toContain("stop refreshing");
  });

  it("is absent with a healthy budget and absent when nothing is known", () => {
    expect(rateLimitBanner(RATE_WARN_BELOW)).toBeNull();
    expect(rateLimitBanner(4873)).toBeNull();
    // Null, not zero: an absent header must never read as exhausted.
    expect(rateLimitBanner(null)).toBeNull();
  });
});

describe("sourceOf", () => {
  it("reads the workspace's one configured source", () => {
    expect(sourceOf({ providers: [{ type: "github" }] })).toBe("github");
    expect(sourceOf({ providers: [{ type: "fs", root: { kind: "project" } }] })).toBe("fs");
    expect(sourceOf(null)).toBe("fs");
    // A record from a future build, or an empty list: treated as file-backed,
    // which is the conservative answer — it polls slowly and asks for no token.
    expect(sourceOf({ providers: [] } as TrackerConfig)).toBe("fs");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/issues.test.ts`
Expected: FAIL — cannot resolve `../src/issues`.

- [ ] **Step 3: Write minimal implementation**

Create `src/issues.ts`:

```ts
import type { BoardConfig, StepId, TrackerConfig } from "./ipc";
import { isTerminal } from "./board-config";

/** Which source a workspace's board reads. */
export type TaskSource = "fs" | "github";

/** One interval, not two. Nothing on an issue changes on its own the way a check
 *  run does, so the PR view's two-speed poll has no analogue here. Faster than
 *  that view's settled 60 s because a board is the screen you sit on while
 *  triaging; far slower than the board's current blind 5 s, which at 720 calls an
 *  hour is 14.4% of the GraphQL budget for one workspace. */
export const ISSUE_POLL_MS = 30_000;
/** The file board's own cadence, unchanged. It reads a directory, so it costs
 *  nothing but a stat — what changes in Task 22 is that it is finally gated. */
export const FILE_POLL_MS = 5_000;

export function boardPollMs(source: TaskSource): number {
  return source === "github" ? ISSUE_POLL_MS : FILE_POLL_MS;
}

/** All open issues in one page, and the number the count line is measured
 *  against. Mirrors `gh_issues::OPEN_PAGE_LIMIT`. */
export const OPEN_PAGE_LIMIT = 50;

/** Whether the totals query can still change the answer. A page shorter than the
 *  cap *is* the total, so the only moment worth a second call is a capped page —
 *  which is what makes the count both honest and free. */
export function needsTotals(openOnPage: number, limit = OPEN_PAGE_LIMIT): boolean {
  return openOnPage >= limit;
}

/** "Showing 50 of 63 open issues.", or nothing at all.
 *
 *  Absent on a short page, absent with no total, and absent when the total has
 *  fallen below what is on screen — an issue closed between the two calls is a
 *  moment's inconsistency at GitHub, and "showing 50 of 49" would read as a bug
 *  in the app. */
export function countLine(shown: number, total: number | null): string | null {
  if (total === null || total <= shown) return null;
  return `Showing ${shown} of ${total} open issues.`;
}

/** Whether a move needs confirming before it is sent.
 *
 *  Only for a GitHub board, and only in the closing direction. A close is visible
 *  to the whole repository and undoing it is a second public action; a reopen
 *  restores the state of a moment ago. The same asymmetry, for the same reason,
 *  as the pull request view's merge confirmation. */
export function needsCloseConfirmation(
  cfg: BoardConfig, from: StepId, to: StepId, source: TaskSource = "github",
): boolean {
  if (source !== "github") return false;
  return from !== to && isTerminal(cfg, to) && !isTerminal(cfg, from);
}

export function closeConfirmText(number: number | string, title: string): string {
  return `Close issue #${number}, “${title}”? A closed issue is visible to everyone in the `
    + "repository.";
}

/** GraphQL points below which the board says so. At the worst steady rate — a
 *  capped page, so three points every 30 s — the board spends 360 points an hour,
 *  so this is under an hour of headroom: late enough not to be permanent noise on
 *  a shared token, early enough that "wait" is still actionable. */
export const RATE_WARN_BELOW = 250;

/** One sentence, because the fix is "wait", not "retry".
 *
 *  Driven by `X-Ratelimit-Remaining` from the totals call's own response headers,
 *  never by matching the refusal's text: that text is unverified, and a handler
 *  keyed on it would be a guess dressed as a check. `null` means the headers said
 *  nothing and must never read as exhausted. */
export function rateLimitBanner(remaining: number | null): string | null {
  if (remaining === null || remaining >= RATE_WARN_BELOW) return null;
  return "GitHub's hourly API budget is nearly used up — the board will stop refreshing shortly.";
}

/** A workspace's one task source. `TrackerConfig.providers` is a list so a second
 *  kind arrives as an added variant, and every reader — here and in Rust — takes
 *  the first. Anything unrecognised reads as file-backed: the conservative
 *  answer, since that path polls slowly and asks for no token. */
export function sourceOf(tracker: TrackerConfig | null | undefined): TaskSource {
  return tracker?.providers[0]?.type === "github" ? "github" : "fs";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/issues.test.ts && npx tsc --noEmit`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/issues.ts tests/issues.test.ts
git commit -m "feat(issues): the poll gate, the count line and the confirmation rule, all pure"
```

---

### Task 21/26: The board view — the ⚙ gate, the age, the unavailable box, the count, the chips

**Issue:** _(file it)_

Everything decision 9 says the board grows, plus decision 3's hidden ⚙ and decision 4's label chips. Render-only: every rule it applies was decided in Task 20 or in `board-config.ts`.

The three unavailable states are reused *in mechanism*, not copied in prose: `pr-view.ts`'s map is exported and the board imports it, so the three sentences exist once. Renaming nothing there keeps the pull request view untouched.

**Files:**
- Modify: `src/board.ts`, `src/pr-view.ts`
- Create: `tests/board-github.test.ts`

**Interfaces:**
- Produces: `BoardState.fetchedAt`, `.unavailable`, `.total`, `.rateRemaining`, `.source`; `BoardHandlers.onFixUnavailable`
- Consumes: `src/issues.ts`, `ago` from `src/pr.ts`, `GH_UNAVAILABLE` from `src/pr-view.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/board-github.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { BoardView } from "../src/board";
import type { BoardState } from "../src/board";
import type { ProviderCapabilities, Task } from "../src/ipc";

const GH_CAPS: ProviderCapabilities = {
  canCreate: true, canResolve: true, statuses: ["open", "closed"],
  boardEditable: false, boardError: null,
  board: {
    v: 1,
    steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
    kinds: [{ id: "issue", label: "Issue" }],
  },
};

const handlers = () => ({
  onLaunch: vi.fn(), onResolve: vi.fn(), onNew: vi.fn(), onConfigure: vi.fn(),
  onMigrate: vi.fn(), onDismissMigration: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(),
  onEditBoard: vi.fn(), onFixUnavailable: vi.fn(),
});

const issue = (over: Partial<Task> = {}): Task => ({
  id: "42", title: "Sidebar badge sticks", kind: "", status: "open", project: "deck",
  created: "2026-07-01T10:00:00Z", resolved: null, origin: "human", session: null,
  body: "", path: "https://github.com/o/n/issues/42", damaged: null, conflict: false,
  labels: [], ...over,
});

const state = (over: Partial<BoardState> = {}): BoardState => ({
  project: "deck", caps: GH_CAPS, error: null, tasks: [issue()], links: [],
  source: "github", fetchedAt: Date.parse("2026-07-30T12:00:00Z"), unavailable: null,
  total: null, rateRemaining: null, ...over,
});

const NOW = Date.parse("2026-07-30T12:01:00Z");

describe("the board's github states", () => {
  /// It is currently drawn whenever a tracker is configured. There is no
  /// board.json for a synthesized board, and one synthetic kind is not a choice.
  it("hides ⚙ when the board is not editable and shows it when it is", () => {
    const gone = new BoardView(handlers());
    gone.render(state(), NOW);
    expect(gone.mount.querySelector(".tk-board-edit")).toBeNull();

    const there = new BoardView(handlers());
    there.render(state({ caps: { ...GH_CAPS, boardEditable: true } }), NOW);
    expect(there.mount.querySelector(".tk-board-edit")).not.toBeNull();
  });

  /// On every render, not only on failure: data that can be stale has to say how
  /// stale. The board has had no data age at all until now.
  it("shows the data's age on every render, and says so before the first fetch", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-age")?.textContent).toContain("1 min ago");
    v.render(state({ fetchedAt: null }), NOW);
    expect(v.mount.querySelector(".tk-age")?.textContent).toBe("never loaded");
  });

  /// Never rendered as an empty list: from one it is impossible to tell whether
  /// something broke.
  it.each([
    ["no-gh", "Set up gh"],
    ["no-account", "Bind an account"],
  ] as const)("explains %s and offers its next step", (u, action) => {
    const h = handlers();
    const v = new BoardView(h);
    v.render(state({ unavailable: u, tasks: [] }), NOW);
    expect(v.mount.querySelector(".tk-cols")).toBeNull();
    const fix = v.mount.querySelector<HTMLButtonElement>(".tk-fix");
    expect(fix?.textContent).toBe(action);
    fix?.click();
    expect(h.onFixUnavailable).toHaveBeenCalledWith(u);
  });

  /// Nothing in the app can fix it, so no button is offered — a dead button is
  /// worse than none.
  it("explains no-repo and offers nothing", () => {
    const v = new BoardView(handlers());
    v.render(state({ unavailable: "no-repo", tasks: [] }), NOW);
    expect(v.mount.querySelector(".tk-unavailable")).not.toBeNull();
    expect(v.mount.querySelector(".tk-fix")).toBeNull();
  });

  /// The last good list stays on screen with its age and the error text, exactly
  /// as the pull request view does: offline and rate-limited are not their own
  /// screens.
  it("keeps the cards on screen beside a failure", () => {
    const v = new BoardView(handlers());
    v.render(state({ error: "HTTP 502" }), NOW);
    expect(v.mount.textContent).toContain("HTTP 502");
    expect(v.mount.querySelectorAll(".tk-card").length).toBe(1);
  });

  it("shows the count line with two real numbers, and nothing on a short page", () => {
    const v = new BoardView(handlers());
    v.render(state({ total: 63, tasks: Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })) }), NOW);
    expect(v.mount.querySelector(".tk-count")?.textContent).toBe("Showing 50 of 63 open issues.");
    v.render(state({ total: 1 }), NOW);
    expect(v.mount.querySelector(".tk-count")).toBeNull();
  });

  it("warns before the refusal, not after it", () => {
    const v = new BoardView(handlers());
    v.render(state({ rateRemaining: 40 }), NOW);
    expect(v.mount.querySelector(".tk-rate")?.textContent).toContain("nearly used up");
    v.render(state({ rateRemaining: 4873 }), NOW);
    expect(v.mount.querySelector(".tk-rate")).toBeNull();
  });

  /// Labels are chips in the meta row, exactly as a pull request's are — and
  /// never a kind, which is why no kind chip appears for an issue at all.
  it("renders every label as a chip and no kind chip", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue({ labels: ["bug", "good first issue"] })] }), NOW);
    expect([...v.mount.querySelectorAll(".tk-label")].map((n) => n.textContent))
      .toEqual(["bug", "good first issue"]);
    expect(v.mount.querySelector(".tk-kind")).toBeNull();
  });

  /// The arrows stay: they are the keyboard path, not a fallback for the drag —
  /// xterm eats Tab inside a tile. With two steps each card gets exactly one.
  it("gives an open issue one arrow and a closed one the other", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-next")).not.toBeNull();
    expect(v.mount.querySelector(".tk-prev")).toBeNull();
    v.render(state({ tasks: [issue({ status: "closed", resolved: "2026-07-02T00:00:00Z" })] }), NOW);
    expect(v.mount.querySelector(".tk-prev")).not.toBeNull();
  });

  /// Every card is draggable and both actions are always offered: `damaged` and
  /// `conflict` are false by construction for an issue, so `canWrite` is always
  /// true. Correct rather than accidental, which is why it is pinned.
  it("offers ▶ and ✓ on every open issue", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-run")).not.toBeNull();
    expect(v.mount.querySelector(".tk-done")).not.toBeNull();
    expect(v.mount.querySelector<HTMLElement>(".tk-card")?.draggable).toBe(true);
  });
});
```

Add to `tests/board-drag.test.ts`, where the drop machinery is already exercised:

```ts
  /// The board hands the move up; whether it needs confirming is
  /// `needsCloseConfirmation`'s decision and main.ts's modal. The view must not
  /// grow a modal of its own — a confirmation raised inside the renderer is a
  /// confirmation no test of the rule can see.
  it("reports a drop onto closed as an ordinary move", () => { /* … */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/board-github.test.ts`
Expected: FAIL — `render` takes one argument; `.tk-age` is null.

- [ ] **Step 3: Write minimal implementation**

In `src/pr-view.ts`, export what the board needs and keep the existing names working:

```ts
/** The three states in which a GitHub-backed view cannot work at all. Shared with
 *  the board, so the three sentences exist once: the board's source can be
 *  unavailable for exactly the same three reasons, and two copies of the prose
 *  would drift. */
export type GhUnavailable = "no-gh" | "no-account" | "no-repo";
export type PrUnavailable = GhUnavailable;
export const GH_UNAVAILABLE: Record<GhUnavailable, { text: string; action: string | null }> = {
  // … the existing three entries, moved verbatim …
};
const UNAVAILABLE = GH_UNAVAILABLE;
```

In `src/board.ts`: `BoardState` gains the five fields — **every one of them optional**, for the reason `migration?` is (`board.ts:11-13`): `tests/board.test.ts` and `tests/board-drag.test.ts` build `BoardState` literals in about fifteen places, `tsconfig.json` includes `tests`, and required fields would fail `tsc` in files this task has no reason to touch. The view reads them as `state.fetchedAt ?? null` and so on, which is also the honest default for a file board that has none of them. `render` takes `now: number` as a second argument, defaulted to `Date.now()`, the same accommodation. The head gains the age line, the ⚙ condition becomes `if (caps?.boardEditable)`, and three new blocks are appended:

```ts
    // Before the columns and after the head: an unavailable source is not an
    // empty board, and rendering it as one makes a broken token look like a
    // repository with no issues.
    if (state.unavailable) {
      const spec = GH_UNAVAILABLE[state.unavailable];
      const box = el("div", "tk-unavailable");
      box.append(el("p", "tk-unavailable-text", spec.text));
      if (spec.action) {
        const fix = el("button", "tk-fix", spec.action);
        const u = state.unavailable;
        fix.onclick = () => this.h.onFixUnavailable(u);
        box.append(fix);
      }
      this.mount.append(box);
      return;
    }
```

and, after the columns, the rate banner and the count line, each from its pure rule:

```ts
    const rate = rateLimitBanner(state.rateRemaining ?? null);
    if (rate) this.mount.append(el("p", "tk-rate", rate));
    const open = cols.columns.find((c) => c.step.terminal !== true);
    const count = countLine(open?.tasks.length ?? 0, state.total ?? null);
    if (count) this.mount.append(el("p", "tk-count", count));
```

The error branch changes shape: today `caps === null || error` returns early with an empty state. A GitHub board with a last-good list must keep it, so `error` alone no longer returns — it renders as a line above the columns (`tk-board-error`'s sibling) and the columns draw underneath, exactly as the pull request view does. `caps === null` keeps its early return unchanged: no tracker is configured, and there is nothing to draw.

**And the `boardError` banner's prose shrinks to the message itself.** `board.ts:100-105` currently hardcodes a wrapper around it:

> `board.json could not be used: ${caps.boardError}. The default two-step board is shown instead, so cards may appear in the wrong column. The file was left alone.`

Every clause of that was true of the only sender it has ever had. None of it is true of Task 8's unreadable-source message, which arrives through the same field: there is no `board.json` in play, nothing read a file, there are no cards to be in the wrong column — and since the message is a full sentence, the interpolation lands a second full stop mid-line. The spec's decision 3 relied on this prose staying true, and Task 8 is the first thing to break that assumption, so the fix belongs here:

```ts
    if (caps.boardError) {
      // The message says what is wrong; the wrapper only says what the board did
      // about it, and only the file-backed case has a `board.json` or a fallback
      // board to describe. A second sender arrived in Task 8 and every clause of
      // the old wrapper was false for it.
      const detail = state.source === "github"
        ? caps.boardError
        : `board.json could not be used: ${caps.boardError} The default two-step board is `
          + "shown instead, so cards may appear in the wrong column. The file was left alone.";
      this.mount.append(el("p", "tk-board-error", detail));
    }
```

with a jsdom assertion in `tests/board-github.test.ts` that a GitHub board's banner is exactly the message — no `board.json`, no doubled stop — and one in `tests/board.test.ts`'s existing `boardError` case that the file board's wording is unchanged. `src/board.ts` is already in this task's Files block; the `caps.boardError` sentence in the *fs* branch keeps its trailing space handling, so check the rendered string rather than eyeballing the template.

The card's meta row gains the chips after the kind chip:

```ts
    for (const l of t.labels) meta.append(el("span", "tk-label", l));
```

`src/styles.css` gains `.tk-age`, `.tk-unavailable`, `.tk-fix`, `.tk-rate`, `.tk-count` and `.tk-label`, reusing the `.pr-*` equivalents' values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/board-github.test.ts tests/board.test.ts tests/board-drag.test.ts && npx tsc --noEmit`
Expected: PASS and clean.

`onFixUnavailable` is the one addition that cannot be optional — a box with a button that does nothing is worse than no box — so the `handlers` object in `tests/board.test.ts:12-15` and `tests/board-drag.test.ts` each gain one line. **Those two edits are fixtures only.** No rendering assertion in either file may change: if one needs rewriting, the *file* board's appearance has changed and that was not asked for. That is the check this step is really making, and an earlier draft of this task claimed both files would pass untouched, which was not true of the handler.

- [ ] **Step 5: Commit**

```bash
git add src/board.ts src/pr-view.ts src/styles.css tests/board-github.test.ts tests/board-drag.test.ts
git commit -m "feat(issues): the board grows an age, an unavailable box, a count and label chips"
```

---

### Task 22/26: The board's poll becomes a gated chain

**Issue:** _(file it)_

**Risky, and not for the reason it looks like.** `main.ts:116` is a five-second `setInterval` with no focus gate firing three IPC calls a tick, one of which (`tasks_open_counts`) fans out across every workspace. Replacing it with a gated `setTimeout` chain is what decision 7 requires for the issues board — and it changes the **file** board's behaviour too: it stops polling when the window loses focus. Nothing about the file board was asked for, so that board needs re-checking even though it is not the feature.

The chain shape matters as much as the gates: a new tick is scheduled only after the previous request has returned, so a slow network cannot queue up `gh` processes. `setInterval` cannot give that.

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `boardPollMs`, `sourceOf` (Task 20)

- [ ] **Step 1: Write the failing test**

`main.ts` is not reachable from a test, so the assertions live where the rule does. `tests/issues.test.ts` already pins `boardPollMs`; add the one thing that is not yet covered — that the two views' gates are the same shape — to `tests/pr-polling.test.ts`, which already exercises the pull request chain:

```ts
  /// The board's poll and the pull request view's poll now have the same three
  /// gates and the same chain shape. Kept as one assertion over the exported
  /// rule rather than two copies of a timer test: the interval is the only thing
  /// that differs between them.
  it("the board polls slower than a five-second tick for a github source", () => {
    expect(boardPollMs("github")).toBeGreaterThan(boardPollMs("fs"));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pr-polling.test.ts`
Expected: FAIL — `boardPollMs` is not imported there yet.

- [ ] **Step 3: Replace the interval with the chain**

In `src/main.ts`, `boardTimer` changes type and gains the two functions the pull request view already has:

```ts
let boardTimer: ReturnType<typeof setTimeout> | null = null;

function stopBoardPolling() {
  if (boardTimer !== null) { clearTimeout(boardTimer); boardTimer = null; }
}

/** Poll only while the board is on screen and the window is focused, and only
 *  ever one tick ahead.
 *
 *  Replaces a five-second `setInterval` with no focus gate. Two reasons, and the
 *  second applies to the file board as much as to the GitHub one: a GitHub board
 *  at five seconds would spend 14.4% of the hourly GraphQL budget on one
 *  workspace, and `setInterval` schedules the next tick whether or not the
 *  previous one came back — which for a slow network means queued `gh`
 *  processes. The interval is the source's, from `boardPollMs`. */
function scheduleBoardPoll() {
  stopBoardPolling();
  if (currentView !== "board" || !document.hasFocus()) return;
  const source = sourceOf(workspaces.active?.tracker ?? null);
  boardTimer = setTimeout(() => {
    void (async () => {
      await refreshBoard();
      await refreshCounts();
      scheduleBoardPoll();
    })();
  }, boardPollMs(source));
}
```

`setView` loses the interval and calls `refreshBoard()` then `scheduleBoardPoll()`; the `else` branch calls `stopBoardPolling()`. The focus and blur listeners already installed for the pull request view gain the board:

```ts
window.addEventListener("focus", () => {
  if (currentView === "pr") void refreshPrs();
  // Coming back refreshes at once rather than at the next tick, which is the
  // whole point of pausing on blur.
  if (currentView === "board") { void refreshBoard(); void refreshCounts(); }
});
window.addEventListener("blur", () => { stopPrPolling(); stopBoardPolling(); });
```

Every existing caller that ended with `await refreshBoard(); await refreshCounts();` keeps doing exactly that and does **not** reschedule: the chain is owned by `scheduleBoardPoll` and by the tick itself, so a mutation refreshing the board must not also arm a timer. The one exception is `refreshBoard`'s own tail, which does not schedule either — the tick does, after both calls, so a slow `tasks_open_counts` cannot overlap the next `tasks_list`.

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS and clean. Then, by hand, the file-board re-check this task earns: open a file-backed board, edit a card in the folder from outside the app, and confirm it appears within five seconds; click away to another window and back, and confirm the board refreshes on return rather than staying stale. Both are on Task 26's list as well, and they are there because of this task.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/pr-polling.test.ts
git commit -m "refactor(board): one gated poll chain for both sources, replacing the blind interval"
```

---

### Task 23/26: The wiring — refresh, confirmations, the launch and the cleanup offer

**Issue:** _(file it)_

Everything the board's actions need, source by source. No rule is decided here: each is `src/issues.ts`'s or `board-config.ts`'s, and this task only calls them in the right order.

**Files:**
- Modify: `src/main.ts`, `src/sessions.ts`
- Modify: `tests/sessions-util.test.ts`

**Interfaces:**
- Produces: `Deck.launchOnWorktree(cwd, workspaceId, titleText, prompt, taskId?)`
- Consumes: everything above

- [ ] **Step 1: Give the Deck the link the launch needs**

`launchOnWorktree` (`sessions.ts:271`) sets no `taskId` today, which is right for a pull request and wrong for an issue: an issue session runs in a worktree **and** is linked to a card. Without the link `derivedStatus` cannot show "in progress" and the second ▶ cannot focus the first session instead of raising a duplicate.

```ts
  async launchOnWorktree(
    cwd: string, workspaceId: string, titleText: string, prompt: string,
    /** Set for an issue, absent for a pull request. An issue session is both in a
     *  worktree and linked to a card: without the link `derivedStatus` cannot
     *  show "in progress" and a second ▶ would raise a duplicate session rather
     *  than focus the first. */
    taskId?: string,
  ): Promise<void> {
    await this.spawnTile({
      session: crypto.randomUUID(), cwd, workspaceId, titleText, prompt, resume: false, taskId,
    });
  }
```

Add to `tests/sessions-util.test.ts`:

```ts
  it("a worktree session can carry the card it came from", async () => {
    const { Deck } = await import("../src/sessions");
    const deck = new Deck(document.createElement("div"), document.createElement("div"), () => []);
    // The link is what `taskLinks` reports, and an empty deck reports none.
    expect(deck.taskLinks().some((l) => l.taskId === "42")).toBe(false);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/sessions-util.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire the refresh**

`refreshBoard` gains the GitHub path. The file path is untouched, and that is checked by the file board's own tests continuing to pass:

```ts
/** The last good list per workspace, so a failed tick keeps the screen
 *  populated. In memory only, and keyed by workspace id: a late reply from a
 *  workspace nobody is looking at must not repaint the current one. */
const lastGood = new Map<string, { tasks: Task[]; fetchedAt: number; total: number | null }>();

async function refreshBoard() {
  const ws = workspaces.active;
  if (!ws) { board.render({ /* … the empty state, source: "fs" … */ }); return; }
  const wsId = ws.id;
  const source = sourceOf(ws.tracker ?? null);
  let caps = null;
  try { caps = await taskCapabilities(wsId); } catch (e) { console.debug("caps failed", e); }

  let tasks: Task[] = [];
  let error: string | null = null;
  let unavailable: GhUnavailable | null = null;
  let total: number | null = null;
  let rateRemaining: number | null = null;
  let fetchedAt: number | null = null;

  if (caps) {
    try {
      tasks = await listTasks(wsId);
      fetchedAt = Date.now();
      const open = tasks.filter((t) => !isTerminal(caps.board, t.status)).length;
      // Only when it can change the answer: a page shorter than the cap is the
      // total, and in a repository under fifty open issues this never fires.
      if (source === "github" && needsTotals(open)) {
        const t = await issueTotals(wsId).catch(() => null);
        if (t) { total = t.open; rateRemaining = t.rateRemaining; }
      }
      lastGood.set(wsId, { tasks, fetchedAt, total });
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      // The same three known unavailabilities as the pull request view, detected
      // the same way — and for GitHub the exit code makes one of them reliable:
      // `gh` returns 4 for "authentication required".
      const known = source === "github" ? unavailableFrom(msg) : null;
      if (known !== null) unavailable = known;
      else error = msg;
      // Offline and rate-limited are not their own screens: the last good list
      // stays on screen with its age and the error text.
      const kept = lastGood.get(wsId);
      if (kept) { tasks = kept.tasks; fetchedAt = kept.fetchedAt; total = kept.total; }
    }
  }
  let migration: MigrationOffer | null = null;
  // Asked only where it can be answered: a GitHub workspace has no previous
  // folder, and the backend refuses the command rather than inventing one.
  if (source === "fs") {
    try { migration = await taskMigrationStatus(wsId); }
    catch (e) { console.debug("migration status failed", e); }
  }
  if (workspaces.active?.id !== wsId) return;
  board.render({
    project: ws.name, caps, error, tasks, links: deck.taskLinks(), migration,
    source, unavailable, fetchedAt, total, rateRemaining,
  }, Date.now());
}
```

`unavailableFrom(msg)` is the string-and-exit-code mapping, lifted out of `refreshPrs` into `src/issues.ts` so both views read one table, with `gh`'s exit 4 added:

```ts
/** Which unavailability an error names, or null for everything else.
 *
 *  Exit 4 is `gh`'s own "authentication required" and is a reliable signal that
 *  string matching cannot get. A missing *scope* is exit 1 with nothing on
 *  stdout, which stays an ordinary error: the exit code is checked before the
 *  output is looked at, so it never becomes "gh returned unreadable JSON". */
export function unavailableFrom(message: string): GhUnavailable | null { /* … */ }
```

with its own tests in `tests/issues.test.ts`, including one asserting that an unrecognised message maps to `null` rather than to a screen.

- [ ] **Step 4: Wire the actions**

- **`closeTask`** — for a GitHub source, confirm with `closeConfirmText` and offer the two reasons, then `updateTask(ws.id, t.id, { status: firstTerminal(caps.board), reason })`. For a file source, `resolveTask` exactly as today. The reason control is a two-way choice inside the confirmation, defaulting to "Completed"; `confirmModal` cannot carry it, so this uses a small `closeIssueModal(number, title)` in `src/forms.ts` returning `"completed" | "not planned" | null`. No comment field: a comment is a conversation, and conversations are the next spec.
- **`moveTask`** — `if (needsCloseConfirmation(caps.board, t.status, step, source))` ask first, with the same modal, and pass the reason through the same patch. A drop onto `open` and a `‹` are unconfirmed.
- **`launchFromTask`** — after resolving the target workspace as today, branch on its source:

```ts
  if (sourceOf(target.tracker ?? null) === "github") {
    // A worktree of its own, on a new branch off the repository's default branch,
    // and the session linked to the issue.
    const facts = await issueRepo(target.id).catch(() => null);
    const cwd = await issueWorktreeAdd(target.id, Number(t.id), t.title)
      .catch((e) => { void alertModal(`Could not prepare a worktree for #${t.id}: ${e}`); return null; });
    if (cwd === null) return;
    await deck.launchOnWorktree(cwd, target.id, `☑ #${t.id}`, issuePrompt(t, facts ?? ""), t.id);
    setView("deck");
    return;
  }
```

  `issueRepo(workspaceId)` is a thin wrapper over `issue_totals`' sibling — or, simpler and without a new command, `owner/name` is already on screen in `t.path` (the issue's URL), from which it can be read without any IPC at all. **Take that route:** a pure `repoFromIssueUrl(url)` in `src/issues.ts`, with tests for an enterprise host and for a malformed URL falling back to `""`. One less command, one less failure mode, and the value comes from the same row the prompt is built from.
- **`captureTask`** — unchanged. `+ task` appears through the existing `caps.canCreate` condition and `taskForm` collects title, kind and body; the kind row is hidden in Task 24.
- **The cleanup offer** — after a successful close, `offerIssueWorktreeCleanup(t)`, the same three guards as `offerWorktreeCleanup` (`main.ts:511`): a live session in it stops the offer, the backend refuses while dirty, and the person still says yes. Offered when the issue closes, never automatic.
- **`launchFromPr`** — uses `added.reused` from Task 15: when the worktree was reused, the prompt says which issue's directory it is, so the same commits under two names do not read as two pieces of work.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/sessions.ts src/issues.ts src/forms.ts tests/
git commit -m "feat(issues): wire the board's actions, the confirmations and the issue worktree"
```

---

### Task 24/26: The workspace form's third source, and the kind controls

**Issue:** _(file it)_

The only place a GitHub tracker can be configured, and the warning decision 8 requires — raised **before** the save, because afterwards the deck no longer knows the old root.

**Files:**
- Modify: `src/forms.ts`, `src/card-modal.ts`
- Modify: `tests/forms.test.ts`, `tests/card-modal.test.ts`

**Interfaces:**
- Consumes: `trackerOpenCount`, `sourceOf`

- [ ] **Step 1: Write the failing tests**

Add to `tests/forms.test.ts`:

```ts
  it("offers a third source and saves it as a github provider", async () => { /* … */ });

  /// Prefill, so editing a workspace's name does not silently drop its source.
  it("preselects github for a workspace already using it", async () => { /* … */ });

  /// The path row and its preview belong to the folder choice alone: a GitHub
  /// tracker has no folder, and a picker for one would be a control that does
  /// nothing.
  it("hides the folder picker and the preview when github is chosen", async () => { /* … */ });

  /// Raised before the save. Afterwards the deck no longer knows the old root,
  /// and the sentence could not name it.
  it("warns with the card count and the full old path before switching away from a folder", async () => { /* … */ });

  /// "any cards there" rather than a number: the count needs a directory read,
  /// and a read that fails must not block the save.
  it("says 'any cards there' when the old root cannot be read", async () => { /* … */ });

  /// Switching the other way needs no warning: there is nothing on GitHub that a
  /// folder-backed board could abandon.
  it("does not warn when switching from github to a folder", async () => { /* … */ });

  /// Cancelling the confirmation leaves the form open with the source still
  /// selected, so the person can change their mind about the radio rather than
  /// starting over.
  it("keeps the form open when the confirmation is declined", async () => { /* … */ });
```

Add to `tests/card-modal.test.ts`:

```ts
  /// One synthetic kind is not a choice, and an issue's kind is always empty.
  it("hides the kind select when the board is not editable", async () => { /* … */ });
  it("keeps the kind select for a file-backed board", async () => { /* … */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/forms.test.ts tests/card-modal.test.ts`
Expected: FAIL — there is no third radio.

- [ ] **Step 3: Write minimal implementation**

In `src/forms.ts`'s tracker block (`:188-324`), `mkRadio` gains a third value and `syncTracker` hides the path row and the preview unless `pathRadio.checked`:

```ts
    const githubRadio = mkRadio("github", "the repository's GitHub issues");
```

Prefill reads the provider's `type` rather than its `root`, since a GitHub provider has none:

```ts
    const initialProvider = initial?.tracker?.providers[0] ?? null;
    if (initialProvider?.type === "github") { onInput.checked = true; githubRadio.checked = true; }
    else if (initialProvider?.root.kind === "path") { /* … as today … */ }
```

`submit` becomes `async` — it already resolves through `close`, so the change is contained — and asks first when the source is moving away from a folder:

```ts
      if (onInput.checked && githubRadio.checked && initialProvider?.type === "fs") {
        // Fully reversible, and the last sentence says so: no file is touched,
        // and switching the radio back yields the same root. The full path is
        // named because renaming the workspace in the same save loses the
        // pointer — the old root's folder is named after the slug of the old
        // name — and then only this sentence says where the cards are.
        const n = initial ? await trackerOpenCount(initialId).catch(() => null) : null;
        const what = n === null ? "any cards there" : `${n} open card${n === 1 ? "" : "s"}`;
        const where = previewedRoot ?? "its previous folder";
        const ok = await confirmModal(
          `This workspace has ${what} in ${where}. Switching to GitHub issues leaves every one of `
          + "them on disk, untouched — this board will stop showing them, and nothing will copy "
          + "them to GitHub. Switching back later brings them back.");
        if (!ok) return;   // the form stays open, the radio stays where it is
      }
      tracker = { providers: [{ type: "github" }] };
```

`previewedRoot` is the root the preview already resolved for the *old* configuration; if the form does not keep it, resolve it once through `trackerRootPreview(initial.name, oldPickedPath)` before the confirmation. Naming the full path is the whole reason the sentence exists.

`taskForm(cfg, showKind = true)` hides its kind row when told to, and `main.ts::captureTask` passes `caps.boardEditable`. `card-modal.ts` hides its kind select on the same flag, which it receives beside `canWrite`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add src/forms.ts src/card-modal.ts src/main.ts tests/
git commit -m "feat(issues): choose the source in the workspace form, and say what switching costs"
```

---

> ### Barrier C
>
> The full gate, from this worktree: `npx tsc --noEmit && npx vitest run && (cd src-tauri && cargo test)`. Everything green, both counts above the baseline (43 files / 412 tests, 286 cargo), clippy at exactly 6. The feature is usable end to end at this point — which is the precondition for Task 26's manual checklist, and why the checklist is not attempted before this barrier.

---

## Phase 4 — Records

### Task 25/26: Correct issue #115

**Issue:** #115 itself.

The spec establishes that #115's recorded recommendation — the REST route `/search/issues?…&advanced_search=true` for the open-issue total — is worse than GraphQL `repository.issues.totalCount` on both counts that comment weighed, and that two of its caveats therefore do not apply at all. A plan that silently does the opposite of a recorded recommendation leaves the disagreement for the next reader to find.

**Files:** none. This task writes no code and touches no file in the repository.

- [ ] **Step 1: Post the comment**

`gh` must be scoped to the account that can write there — the default account on this machine is an EMU that cannot:

```bash
GH_TOKEN=$(gh auth token --user followLemmi) gh issue comment 115 \
  --repo followLemmi/cowork-deck --body-file - <<'EOF'
The issues-board design (`docs/superpowers/specs/2026-07-30-github-issues-board-design.md`,
decisions 7 and 9) takes the other route, and this is the correction rather than a
silent contradiction.

The recommendation here is the REST search route,
`/search/issues?…&advanced_search=true`. GraphQL `repository.issues.totalCount` is
strictly better on both counts this issue weighed:

- **Budget.** It costs 1 GraphQL point out of 5000 an hour. The search bucket is
  30 requests *per minute*, so a 5 s poll on a single workspace eats 40% of that
  window. Measured, not inferred: ten `gh issue list --json` calls moved the
  GraphQL counter by exactly ten, with `core` unmoved.
- **Freshness.** It reads the repository object directly, so it has **no
  eventual-consistency lag.** The search index does.

Two things recorded here therefore do not apply:

- the "show *about* M" hedge — the number is exact, so the board says
  "Showing 50 of 63 open issues.";
- the "suppress the count during a mutation" caveat — there is no index to lag,
  and the board refetches after every write anyway.

One footnote worth carrying wherever this comes up again: `gh api rate_limit`
reported `search: used 0` immediately after real search calls, so the
`X-Ratelimit-*` response headers are the source of truth and that endpoint is not.

The board also only asks for the total when the open page came back full — a
shorter page *is* the total — so in a repository with fewer than 50 open issues
the call never fires at all.
EOF
```

- [ ] **Step 2: Verify it landed**

Run: `GH_TOKEN=$(gh auth token --user followLemmi) gh issue view 115 --repo followLemmi/cowork-deck --comments | tail -30`
Expected: the comment, under the right account.

- [ ] **Step 3: Nothing to commit**

Record the comment's URL in the pull request description instead. If #115 turns out to be closed, post the comment anyway — a closed issue with a wrong recommendation is exactly the one a future reader finds by search.

---

### Task 26/26: Documentation, and the manual check

**Issue:** _(file it)_

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the second source**

Add to `README.md`, after the tracker section:

```markdown
### The board's second source: GitHub issues

A workspace's board reads either a folder of markdown cards or **the GitHub
issues of the repository its folder is** — one source, chosen in the workspace
settings (✎), never both at once. The GitHub source needs `gh` on the PATH, an
account bound to the workspace, and a folder that is a clone of the repository;
each missing piece says so on the board and points at the fix.

The board is then two columns, `Open` and `Closed`, and they are not editable:
there is no `board.json` to edit, so ⚙ is not offered. Labels show as chips.
Closed issues are fetched rather than accumulated, twenty at a time, so an issue
you close stays visible where you closed it.

**▶ opens a session on a new branch in a worktree of its own**, at
`<parent>/<workspace>-issue/<number>-<title>` — beside the workspace, never
inside it, so the workspace's own working copy and the sessions running in it are
untouched. The branch is cut from the repository's default branch, not from
whatever you happen to have checked out. When the issue closes, the app offers to
remove the worktree; it never removes one that is dirty or that has a session in
it. If you later open a pull request from that branch, ▶ on the pull request
reuses the same directory rather than making a second copy of the same commits.

**✓ closes the issue, and asks first** — unlike the file board's ✓, which writes a
local file. A close is visible to everyone in the repository, so the confirmation
offers the reason GitHub records: "Completed" or "Not planned". Reopening does not
ask: it restores the state of a moment ago. A drag onto `Closed` asks the same
question; a drag onto `Open` does not.

**+ task files an issue** under the workspace's own account.

The list refreshes every 30 seconds, and only while the board is on screen and
the window is focused. The age of the data is always on screen, and the count line
says "Showing 50 of 63 open issues." when a page is capped — both numbers real.
When the hourly API budget runs low the board says so before it stops refreshing.

A session in a GitHub workspace is told the repository and, if it was launched
from an issue, that issue — and nothing about folders, `board.json` or the
`cowork_task` CLI, none of which exist there. It files an issue with `gh issue
create` and closes one with `gh issue close`. Nothing holds a session open until
an issue is closed: closing one is a public action, and a hook that demanded it
would be pressuring an agent into a public write.

The sidebar badge for a GitHub workspace shows what its board last saw, and
nothing at all before you have opened it once this run. That is deliberate: the
badge is drawn for every workspace after every card edit, and making it accurate
would mean spending API budget on screens nobody is looking at.

**One warning about downgrading.** A workspace configured for GitHub issues is
stored as `{"type":"github"}`. A build from this release onwards that does not
know that source keeps the workspace and says so on its board — its name, folder,
account and colour are all intact, and saving it does not destroy the
configuration. That is the fix for #117, and it is why this warning is about one
specific span of versions rather than about downgrading in general.

**Builds older than that fix read the whole workspace file as unreadable, show an
empty sidebar, and overwrite the file the next time you add a workspace.** Nothing
a newer build does can change what an older one does to that file, so for those
versions the only safeguard is a copy of `workspaces.json` — an interim measure
for a bug that is already fixed forward, not the answer to it.
```

- [ ] **Step 2: The manual check**

None of the following is covered by an automated test. Run it and record the result in the pull request description. `gh` against `followLemmi/cowork-deck` needs `GH_TOKEN=$(gh auth token --user followLemmi)` — the default account here is an EMU that cannot write there, and a plain call fails with a confusing permission error.

1. A workspace whose folder is a clone with a bound account, switched to GitHub issues — the board lists the repository's open and closed issues. Compare the open count and the titles against the same repository in a browser.
2. **The count line**, against a repository with more than 50 open issues: "Showing 50 of 63 open issues." with both numbers matching what the browser says. Then a repository with fewer than 50 — no count line at all, and (watching the process list, or with a temporary log) **no totals call**.
3. **The 30-second refresh and its gates.** Close an issue from the browser and confirm it moves column within 30 s. Switch to the deck and confirm the polling stops; click to another window and back and confirm it refreshes on return rather than at the next tick.
4. **The file board, re-checked** — this is the check Task 22 earns, and nothing about the file board was asked for. Edit a card on disk from outside the app and confirm the board picks it up within five seconds; blur and refocus the window and confirm the board refreshes on return; confirm the sidebar counts still update after a card edit.
5. **▶ on an issue** — a worktree appears at the documented path, the session starts in it, `git branch --show-current` inside it names `issue-<n>-<slug>`, and `git merge-base --is-ancestor origin/<default> HEAD` succeeds (the branch was cut from the default branch, not from whatever was checked out). `git status` in the workspace itself: untouched.
6. **The second ▶ on the same issue** focuses the first session rather than raising a duplicate, and the card reads "in progress" while it runs. This is what the `taskId` on `launchOnWorktree` is for.
7. **The issue → pull request worktree reuse, end to end, including the push.** Commit in the issue worktree, `git push -u origin HEAD`, open a pull request from it, then ▶ on that pull request in the PR view: it must open **the same directory**, and the tile's prompt must say so. Then confirm a push from it lands on the issue's branch with no refspec gymnastics.
8. **✓ with each reason.** Close one issue as "Completed" and one as "Not planned", and confirm on GitHub that the timeline shows the right one for each. Then reopen one from the `Closed` column's `‹` and confirm it is not confirmed.
9. **A drag onto `Closed` asks; a drag onto `Open` does not.**
10. **+ task** files an issue under the workspace's own account, and the board shows it on the next refresh — with a **multi-line body containing a quote, a backtick and a `$`**, which is the case `--body-file -` exists for.
11. **One throwaway `gh issue close` against a scratch repository**, from a terminal, and **record what its success output actually is**. Nothing in this feature parses it — the board refetches — but nobody has seen it, and that should stop being true before the write path ships. Paste the output verbatim into the pull request description. The `create` half of this check is **done**: filing #117 on 2026-07-30 used the exact argv shape this feature builds (`--repo`, `--title`, `--body-file`) and printed the new issue's URL on stdout and nothing else, exit 0. So `--body-file` is confirmed to carry a multi-line body, and the number is recoverable from the output — which changes nothing, because the board still refetches.
12. **The rate-limit banner, driven by an injected low `X-Ratelimit-Remaining`** — not by provoking a real refusal, whose own text is unverified and which nothing matches on. Temporarily return a low value from `split_gh_response`, or point `COWORK_GH_PATH` at a wrapper script that rewrites the header, and confirm the banner appears and the board keeps its list.
13. **The switch confirmation against a root that really holds cards.** Configure a folder tracker, file two cards, switch the workspace to GitHub issues: the confirmation must name the count and the **full old path**. Decline it — the form stays open. Accept it — the board switches, and the two card files are still on disk, untouched. Switch back and confirm both cards return.
14. **A private repository.** Everything measured for the spec was measured against a public one, so nothing so far demonstrates that the per-workspace token is what makes the read path work. Bind an account with access, confirm the board lists the issues, then unbind it and confirm the board says `no-account` rather than showing a stale or empty list.
15. **The three unavailable states**, each showing its own screen with its own next step: a workspace with no bound account, a folder that is not a git repository, and (by pointing `COWORK_GH_PATH` at a nonexistent file) no `gh` at all.
16. **The pull request list still works** after Task 16's `-R` change — the one check that task earns. Compare it against the browser, then run ▶, merge, close and reopen once each.
17. **A session in a GitHub workspace, checked from the inside.** Start one plainly (no issue) and ask it to print its environment: no `COWORK_TASKS_DIR`, no `COWORK_PROJECT`, no `COWORK_TASK_BIN`, and `COWORK_ISSUE_REPO` set. Confirm the `UserPromptSubmit` context names the repository and `gh issue create`. Then let it finish — the `Stop` must not be blocked.

- [ ] **Step 3: Verify everything**

Run: `npx tsc --noEmit && npx vitest run && (cd src-tauri && cargo test)`
Expected: clean; vitest and cargo both fully green, above the 43/412 and 286 baselines.
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`
Expected: exactly 6 warnings.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(issues): the board's second source, and what switching away from it costs"
```

---

## Self-review

**The eleven key decisions, each to the tasks that implement it.**

1. *The port gains nothing; the board moves out of it, and `scan` stays out.* — Task 8 (`board_for`, `board_editable`), Task 10 (`provider_for` boxed, `fs_provider_for`, the six file-only refusals; `scan` stays a concrete method with `step_usage` and `rewrite_step` narrowed to it). The trait is untouched in Task 6 except through `TaskPatch`, which is a data type rather than a method.
2. *`resolve_root` keeps its shape; seven of its eight callers are already right.* — Task 7 (`tracker_kind` beside it, the GitHub arm returning `None`, and the six tests covering the callers that need nothing), Task 12 (the eighth caller, `start_session`). Decision 2's own instruction to check `store.rs` is Tasks 1–2, and its forward-compatibility cost is now bounded rather than merely named — see gap 1.
3. *The board is two steps, synthesized, and not editable.* — Task 8 (`github_board`, validated), Task 6 (`update` honouring a status patch as close/reopen), Task 20 (`needsCloseConfirmation`, the asymmetry), Task 21 (⚙ hidden, the arrows kept), Task 23 (the confirmation raised in the frontend, never in Rust).
4. *The `Task` mapping, field by field.* — Task 4, one assertion per row of the table, plus the three fixture-only paths and the `labels`-not-`kind` rule; Task 3 for `Task.labels` itself.
5. *The agent is handed `gh`, and the sidecar is removed from the workspace.* — Task 12 (`session_env`, the leak test written as absence), Task 13 (`guard`'s branch dispatched first, the four integration cases, never blocking a `Stop`), Task 19 (`issuePrompt` and both non-leak invariants).
6. *▶ builds a worktree beside the workspace, and refuses to duplicate a PR's.* — Task 5 (`issue_branch`, `issue_worktree_path`, the outside-the-workspace assertion), Task 14 (the three commands, the default-branch base, both idempotency cases), Task 15 (`pr_worktree_add`'s reuse lookup), Task 23 (the cleanup offer's three guards).
7. *One 30-second interval, gated in one place, and counts that never fetch.* — Task 20 (`ISSUE_POLL_MS`, `needsTotals`), Task 22 (the gated chain, replacing the blind interval), Task 11 (`tasks_open_counts` from cache, absent rather than zero), Task 9 (the totals command, called only when it can change the answer).
8. *Switching a workspace's source warns in the form, and touches nothing on disk.* — Task 7 (the four tests proving the path machinery goes quiet by itself), Task 17 (`tracker_open_count`), Task 24 (the confirmation, before the save, naming the full path).
9. *Three unavailable states, plus a cache and a visible age.* — Task 21 (the age line, the unavailable box, the count line, the rate banner), Task 23 (`unavailableFrom` including `gh`'s exit 4, and the last-good cache), Task 20 (`rateLimitBanner`, proactive and never matching the refusal's text), Task 25 (the correction to #115 that the honest count depends on).
10. *`+ task` creates, ✓ closes with a reason, reopen does not ask.* — Task 5 (`issue_create_argv` with `--body-file -`, the reason quoting, the unknown reason dropped), Task 9 (the stdin-carrying runner, because `.output()` cannot feed one), Task 6 (`create` returning an id-less card because the board refetches), Task 23 (the close modal with its two-way reason), Task 24 (the kind controls hidden).
11. *Every `gh issue` call carries `--repo`, resolved once and cached.* — Task 5 (`-R` on every builder, asserted), Task 9 (`repo_facts_for` and its cache), Task 16 (`pr_list_argv` brought into line, closed question 6).

**The seven closed questions, each honoured.** (1) A GitHub workspace must be a clone: no form field for `owner/name` anywhere in Task 24, and `no-repo` is the honest screen (Task 21). (2) No author: `author` is absent from `ISSUE_LIST_FIELDS` and from the parser (Task 4), which keeps all three measured author traps out of the code. (3) The badge is cached, never batched (Task 11). (4) One terminal column, with the reason offered inside the confirmation (Tasks 8, 23). (5) The closed page is fetched every tick, one code path (Task 6). (6) `pr_list_argv` gains `-R` as its own task with its own commit and its own manual check (Task 16, check 16). (7) `body` stays in the poll and decision 4's fallback is **not** built — no task fetches a body on demand, and `GhIssueProvider::resolve` exists only for a single-issue read.

**Five gaps found in the spec while planning against it.** None is a decision reopened; each is a place the spec left a mechanism unspecified or specified one that cannot work as written.

1. **`store.rs` answers decision 2's open question, and the answer is data loss, not annoyance — so two tasks were added ahead of the feature.** Decision 2 asks the plan to check what the store does with a workspace that fails to deserialize. It is `store.rs:26`: the file is parsed as one array with `unwrap_or_default()`, so one record naming an unknown provider empties the **entire** list, and the next `upsert_workspace` (`:123-131`) — reading through the same function and getting `Ok(vec![])` — writes that emptiness back through a bare `fs::write`. The downgrade writes nothing; the first `+ workspace` after it destroys the file, which is exactly what a person does when the sidebar is unexpectedly empty. Filed as **#117**, with the chain, both fixes and the release constraint.
   Tasks 1 and 2 close it: the parse error stops becoming an empty list (so no write path can truncate a file it could not read, for *any* type in the store), and an unreadable tracker source is kept verbatim and round-tripped, so the workspace stays visible and saving it does not destroy a configuration this build merely does not understand. **The residual was given a mechanism — a release barrier — and the user declined it on 2026-07-30, choosing one branch for all twenty-six tasks.** That is recorded in Barrier 0 with its cost stated rather than softened: one branch is one release, the release carries the fix and the variant together, and so the tolerance protects nobody already installed. What survives is real and is why these two tasks stayed in the plan — the next schema addition (Jira) is covered, a truncated or zero-byte store file no longer destroys the rest, and an unreadable record stays visible and keeps its data. Task 26's README warning now covers every build there will ever have been, points at #117 as the forward fix, and must not offer copying the file as the answer.
   **One correction to how an earlier draft of this section reasoned**, because the wrong version of it would have justified doing nothing: the unreadable read happens in whichever binary is old, but the destructive write happens in whichever binary is *running*, so the fix is fully effective wherever it ships and merely cannot reach a copy already installed. "Ineffective backwards", not "impossible here". The same draft pinned the defect with a passing test; that test is gone, replaced by tests of the fixed behaviour that fail today, so nobody closing #117 finds a green assertion telling them the old behaviour was intended.
   Two smaller results from the same investigation, so nobody re-derives them: `Task.labels` is safe in both directions because cards are line-scanned rather than deserialized and writes preserve unknown keys by design (`frontmatter.rs:43`, `fs.rs:249`); and `ProviderCapabilities` is never deserialized at all, so widening it is a pure IPC change — `board_editable` gets `#[serde(default)]` as insurance, not necessity.
2. **Decision 7's repository-facts query cannot be the first resolution of `owner/name`.** `repository(owner:, name:)` takes the pair it is supposed to return. Task 5 splits it into a `gh repo view --json nameWithOwner,defaultBranchRef` facts call — cwd-based, one point, `gh`'s own answer, the same shape `pr_merge_options` already uses — and the GraphQL query for the totals, which has the pair by then. The point arithmetic of decision 7 is unchanged.
3. **The close reason had no channel.** Decision 10 wants it chosen in the confirmation; decision 3 rules that close and reopen go through `tasks_update` rather than commands of their own. Neither `TaskPatch` nor `TaskProvider::resolve` carries a reason. Task 6 adds one optional field to `TaskPatch`, ignored by the file provider — the narrowest thing that honours both decisions. A GitHub-specific `issue_close` command would have been the alternative and is what decision 3 rules out.
4. **The rate-limit signal has only one source, and it is conditional.** Decision 9 reads `X-Ratelimit-Remaining` from the response, but only `gh api` exposes headers — `gh issue list` does not. So the signal rides on the totals call (Task 9), which by decision 7 fires only on a capped page: **in a repository with fewer than 50 open issues the banner never appears.** Accepted rather than worked around, because such a repository spends two points a tick and is not the one that exhausts a budget, and because the alternative — a probe every tick — would raise 240 points an hour to 360 and change decision 7's arithmetic. Named here so nobody reads its absence as a bug.
5. **`create` must return a `Task` it cannot know.** The trait requires one and none of the write commands accepts `--json`. Task 6 returns a card built from the draft with an empty `id`, pins that with a test, and says in the doc comment that the board refetches — which is decision 10's own ruling, given a shape. *Since this plan was first written, `create`'s output has been observed* (the new issue's URL on stdout, exit 0, from filing #117), so the number is in fact recoverable — and the decision does not change: the refetch needs no fact about `gh`'s output and survives a change to it. The test's name and comments were updated so they no longer claim the output is unverified. `gh issue close`'s output is still unobserved, and check 11 of the manual list keeps that half.

**What the independent review changed, recorded because a plan that hides its corrections invites the same ones twice.** Four things stopped execution and are fixed: `resolve_root`'s match has no catch-all, so Task 3 must add the `GitHub` arm or the crate stops compiling for four tasks (an earlier draft deferred it to Task 7); `crate::gh_pr::slug` is unreachable from the library — `lib.rs` exposes only `pub mod tasks` and says so — so Task 5 now *moves* `slug` into `tasks/slug.rs` and `gh_pr` re-exports it, and the spec's change table has been corrected to match; Task 2's `Serialize` is now a delegation to a derived `KnownTrackerProvider` rather than a hand-rolled tag, so the wire format exists in one place; and `provider_for` **does no I/O**, because resolving the repository there made all three of decision 9's unavailable states arrive as "No task tracker is configured". Two of those were mine to have caught: the crate boundary is stated in the file I cited, and the I/O one I introduced while fixing something else. Smaller fixes worth naming because each would have shipped something wrong: five raw strings that do not compile (`"#fff"` closes `r#"`); a zero-byte `workspaces.json` wedging every write; `resolve` addressing issues by full-text search, which returns the wrong issue on a busy repository and breaks every write path silently; and `board.ts`'s `boardError` banner asserting things about `board.json` that are false for the new sender.

**One piece of behaviour in this plan that the spec does not describe.** Task 8's `capabilities_for` branch for an unreadable tracker source: without it, a workspace whose source only a newer build can read would have its board say "No task tracker is configured", which is false and invites configuring a second source over the top of the first. It uses the `board_error` channel that already exists, invents no board state, and is unreachable except by downgrade. Flagged when it was written and approved explicitly; noted in the task itself so a reader coming from the spec alone is not surprised by it. Everything else in the plan traces to a spec decision, a closed question, or #117.

**One thing the spec is right about that this plan makes worse before it makes better.** Task 22 changes the *file* board: it stops polling on blur. That is a behaviour change to a shipped screen, made for a decision about a different screen, and no test can see it. It is why check 4 of the manual list exists and why Task 22 carries the re-check in its own verification step rather than deferring all of it to Task 26.
