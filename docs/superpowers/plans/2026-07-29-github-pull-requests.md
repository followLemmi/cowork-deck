# Pull request view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third view beside the deck and the board that lists the workspace's open pull requests with their check and review state, and supports four actions: a session on the PR's branch in a worktree of its own, merge, close and reopen.

**Architecture:** `gh_pr.rs` beside `gh.rs` — pure parsers over `gh`'s JSON plus thin Tauri commands that run `gh` with the workspace's `cwd` and its resolved account environment. The frontend mirrors the board's shape: a pure helper module (`pr.ts`) and a render-only class (`pr-view.ts`) driven by a state object. No new abstraction port: pull requests have one source.

**Tech Stack:** Rust (Tauri 2, serde), TypeScript (no framework, hand-built DOM), vitest + jsdom, cargo test. External: the `gh` CLI, 2.86.0 on the development machine.

## Global Constraints

- **English only.** Every file in this repository — code, comments, tests, docs, UI copy — is written in English. Drafting in another language and translating afterwards is not the intent. (`CLAUDE.md`, "Language".)
- **No new dependencies.** Neither cargo nor npm. Everything here is `gh`, `git`, and what the project already has.
- **Tokens never reach a log or the frontend unredacted.** Every error string from `gh` passes through `gh::redact` before it leaves the backend.
- **No `innerHTML` for anything that came from the network.** Titles, branch names and author logins are set with `textContent`, following `board.ts`.
- **Pure functions carry the logic; DOM classes only render.** Anything with a truth table lives in a module with its own unit tests and no DOM.
- **Existing tests stay green:** 367 vitest, 263 cargo, and `npx tsc --noEmit` clean.
- **Epic:** #113 — the umbrella issue; task issues #100–#112. Each task carries its own issue number under its heading.

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/gh_pr.rs` (create) | Model, pure parsers, check summary, worktree path, merge options |
| `src-tauri/src/commands.rs` (modify) | Seven Tauri commands; a per-workspace token cache |
| `src-tauri/src/main.rs` (modify) | Register the commands |
| `src-tauri/src/lib.rs` or `main.rs` module list (modify) | `mod gh_pr;` |
| `src/ipc.ts` (modify) | Types mirroring the Rust model, command wrappers |
| `src/pr.ts` (create) | Pure: sorting, age, `canMerge`, `pollInterval` |
| `src/pr-view.ts` (create) | The view: rows, states, merge dialog |
| `src/view.ts` (modify) | Three-way view switch |
| `src/main.ts` (modify) | Wiring, polling, palette entry, hotkey |
| `src/styles.css` (modify) | Styles for the view |
| `tests/pr.test.ts`, `tests/pr-view.test.ts`, `tests/view-switch.test.ts` | Frontend tests |
| `README.md` (modify) | The view, and the worktree layout it creates |

---

### Task 1: The model and the check summary

**Issue:** #100

The whole truth table of CI state, isolated from everything else. `statusCheckRollup` is an array of two different node shapes, and collapsing "no checks" into "passed" would put a green tick on a PR nothing has ever built.

**Files:**
- Create: `src-tauri/src/gh_pr.rs`
- Modify: `src-tauri/src/main.rs` (add `mod gh_pr;` beside `mod gh;`)

**Interfaces:**
- Produces: `gh_pr::ChecksSummary`, `gh_pr::summarise_checks(rollup: &serde_json::Value) -> ChecksSummary`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/gh_pr.rs` with only the test module and the enum it needs:

```rust
use serde::{Deserialize, Serialize};

/// Four distinct facts about a PR's checks. "No checks configured" is not
/// "everything passed": a green tick for it would claim a guarantee nothing
/// ever produced. `running` keeps its counts because the view uses them both
/// for the label and to decide the poll interval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChecksSummary {
    None,
    Running { done: u32, total: u32 },
    Passed { total: u32 },
    Failed { failed: u32, total: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_checks_is_not_success() {
        assert_eq!(summarise_checks(&json!([])), ChecksSummary::None);
        assert_eq!(summarise_checks(&serde_json::Value::Null), ChecksSummary::None);
    }

    #[test]
    fn all_completed_and_successful_is_passed() {
        let rollup = json!([
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
        ]);
        assert_eq!(summarise_checks(&rollup), ChecksSummary::Passed { total: 2 });
    }

    /// SKIPPED and NEUTRAL are not failures — GitHub's own rollup treats them
    /// as non-blocking, and a red badge for a skipped job would send people
    /// hunting for a break that is not there.
    #[test]
    fn skipped_and_neutral_do_not_fail_the_summary() {
        let rollup = json!([
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED" },
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "NEUTRAL" },
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
        ]);
        assert_eq!(summarise_checks(&rollup), ChecksSummary::Passed { total: 3 });
    }

    #[test]
    fn cancelled_timed_out_and_action_required_are_failures() {
        for c in ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"] {
            let rollup = json!([
                { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": c },
                { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
            ]);
            assert_eq!(
                summarise_checks(&rollup),
                ChecksSummary::Failed { failed: 1, total: 2 },
                "conclusion {c} must count as a failure",
            );
        }
    }

    /// Running wins over a failure already recorded: the run is not over, and
    /// "failed" would invite a rerun decision the person cannot yet make.
    #[test]
    fn running_wins_over_an_already_failed_check() {
        let rollup = json!([
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE" },
            { "__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": null },
        ]);
        assert_eq!(summarise_checks(&rollup), ChecksSummary::Running { done: 1, total: 2 });
    }

    #[test]
    fn queued_and_pending_count_as_running() {
        for s in ["QUEUED", "PENDING", "WAITING", "REQUESTED"] {
            let rollup = json!([{ "__typename": "CheckRun", "status": s, "conclusion": null }]);
            assert_eq!(
                summarise_checks(&rollup),
                ChecksSummary::Running { done: 0, total: 1 },
                "status {s} must count as running",
            );
        }
    }

    /// The other node shape: a commit status, which carries `state` and has no
    /// `status`/`conclusion` pair at all.
    #[test]
    fn status_contexts_are_summarised_too() {
        let rollup = json!([
            { "__typename": "StatusContext", "state": "SUCCESS" },
            { "__typename": "StatusContext", "state": "FAILURE" },
        ]);
        assert_eq!(summarise_checks(&rollup), ChecksSummary::Failed { failed: 1, total: 2 });

        let pending = json!([{ "__typename": "StatusContext", "state": "PENDING" }]);
        assert_eq!(summarise_checks(&pending), ChecksSummary::Running { done: 0, total: 1 });
    }

    /// An unknown node must not be silently dropped from the total, or the
    /// count under the badge stops matching what GitHub shows.
    #[test]
    fn unknown_nodes_still_count_towards_the_total() {
        let rollup = json!([
            { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
            { "__typename": "SomethingNew" },
        ]);
        assert_eq!(summarise_checks(&rollup), ChecksSummary::Passed { total: 2 });
    }
}
```

Add to `src-tauri/src/main.rs`, beside the existing `mod gh;`:

```rust
mod gh_pr;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gh_pr`
Expected: FAIL — `cannot find function summarise_checks in this scope`

- [ ] **Step 3: Write minimal implementation**

Above the `#[cfg(test)]` block in `src-tauri/src/gh_pr.rs`:

```rust
/// Conclusions that leave a completed check non-green. SKIPPED and NEUTRAL are
/// absent on purpose: GitHub does not treat them as blocking, and neither do we.
const FAILING_CONCLUSIONS: [&str; 5] =
    ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/// Reduce `statusCheckRollup` to the one fact the row shows.
///
/// The array mixes two node shapes: `CheckRun` (a job — `status` plus, once
/// finished, `conclusion`) and `StatusContext` (a commit status — a single
/// `state`). Anything else counts towards the total but influences nothing:
/// dropping it would make the printed count disagree with GitHub's.
pub fn summarise_checks(rollup: &serde_json::Value) -> ChecksSummary {
    let nodes = match rollup.as_array() {
        Some(n) if !n.is_empty() => n,
        _ => return ChecksSummary::None,
    };
    let total = nodes.len() as u32;
    let (mut running, mut failed) = (0u32, 0u32);

    for node in nodes {
        let field = |k: &str| node.get(k).and_then(|v| v.as_str()).unwrap_or("");
        match node.get("__typename").and_then(|v| v.as_str()).unwrap_or("") {
            "CheckRun" => {
                if field("status") == "COMPLETED" {
                    if FAILING_CONCLUSIONS.contains(&field("conclusion")) {
                        failed += 1;
                    }
                } else {
                    running += 1;
                }
            }
            "StatusContext" => match field("state") {
                "SUCCESS" => {}
                "FAILURE" | "ERROR" => failed += 1,
                _ => running += 1, // PENDING, EXPECTED, and anything new
            },
            _ => {}
        }
    }

    // Running outranks failed: the run is not over, and calling it failed
    // invites a decision that cannot be made yet.
    if running > 0 {
        return ChecksSummary::Running { done: total - running, total };
    }
    if failed > 0 {
        return ChecksSummary::Failed { failed, total };
    }
    ChecksSummary::Passed { total }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_pr`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh_pr.rs src-tauri/src/main.rs
git commit -m "feat(pr): summarise a pull request's checks into one honest fact"
```

---

### Task 2: Parsing the pull request list

**Issue:** #101

**Files:**
- Modify: `src-tauri/src/gh_pr.rs`

**Interfaces:**
- Consumes: `ChecksSummary`, `summarise_checks` (Task 1)
- Produces: `gh_pr::PullRequest { number: u64, title: String, author: String, is_draft: bool, head_ref_name: String, head_ref_oid: String, base_ref_name: String, is_cross_repository: bool, review_decision: Option<String>, checks: ChecksSummary, mergeable: String, merge_state_status: String, updated_at: String, url: String, labels: Vec<String> }`, `gh_pr::parse_pull_requests(json: &str) -> Result<Vec<PullRequest>, String>`, `gh_pr::PR_LIST_FIELDS: &str`

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src-tauri/src/gh_pr.rs`:

```rust
    /// Trimmed from a real `gh pr list --json …` response (gh 2.86.0).
    const SAMPLE: &str = r#"[
      {
        "number": 14007,
        "title": "fix: keep the cache warm",
        "author": { "login": "octocat", "is_bot": false },
        "isDraft": false,
        "headRefName": "fix/cache",
        "headRefOid": "a1b2c3d4e5f6",
        "baseRefName": "trunk",
        "isCrossRepository": false,
        "reviewDecision": "REVIEW_REQUIRED",
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "BLOCKED",
        "updatedAt": "2026-07-29T15:20:56Z",
        "url": "https://github.com/cli/cli/pull/14007",
        "labels": [{ "name": "bug" }, { "name": "core" }],
        "statusCheckRollup": [
          { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" }
        ]
      }
    ]"#;

    #[test]
    fn parses_a_pull_request_row() {
        let prs = parse_pull_requests(SAMPLE).unwrap();
        assert_eq!(prs.len(), 1);
        let pr = &prs[0];
        assert_eq!(pr.number, 14007);
        assert_eq!(pr.title, "fix: keep the cache warm");
        assert_eq!(pr.author, "octocat");
        assert_eq!(pr.head_ref_oid, "a1b2c3d4e5f6");
        assert_eq!(pr.base_ref_name, "trunk");
        assert_eq!(pr.review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(pr.merge_state_status, "BLOCKED");
        assert_eq!(pr.labels, vec!["bug".to_string(), "core".to_string()]);
        assert_eq!(pr.checks, ChecksSummary::Passed { total: 1 });
    }

    #[test]
    fn empty_list_is_not_an_error() {
        assert!(parse_pull_requests("[]").unwrap().is_empty());
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        assert!(parse_pull_requests("not json").is_err());
    }

    /// `reviewDecision` is absent on a PR nobody has been asked to review, and
    /// `author` is null for a deleted account. Neither may take the list down:
    /// one unusual PR must not blank the whole view.
    #[test]
    fn missing_optional_fields_survive() {
        let json = r#"[{
          "number": 1, "title": "t", "author": null, "isDraft": true,
          "headRefName": "h", "headRefOid": "o", "baseRefName": "b",
          "isCrossRepository": true, "reviewDecision": null,
          "mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN",
          "updatedAt": "2026-07-29T15:20:56Z", "url": "u",
          "labels": [], "statusCheckRollup": []
        }]"#;
        let pr = &parse_pull_requests(json).unwrap()[0];
        assert_eq!(pr.author, "");
        assert_eq!(pr.review_decision, None);
        assert_eq!(pr.checks, ChecksSummary::None);
        assert!(pr.is_cross_repository);
    }

    /// The field list and the parser have to agree, or a rename in one of them
    /// silently empties a column.
    #[test]
    fn every_requested_field_is_read() {
        for f in ["number", "title", "author", "isDraft", "headRefName", "headRefOid",
                  "baseRefName", "isCrossRepository", "reviewDecision", "mergeable",
                  "mergeStateStatus", "updatedAt", "url", "labels", "statusCheckRollup"] {
            assert!(PR_LIST_FIELDS.split(',').any(|x| x == f), "{f} missing from PR_LIST_FIELDS");
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gh_pr`
Expected: FAIL — `cannot find function parse_pull_requests`

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/gh_pr.rs`:

```rust
/// Exactly the fields the row needs. `statusCheckRollup` comes back on the list
/// call itself, so check state costs no extra request per pull request.
pub const PR_LIST_FIELDS: &str = "number,title,author,isDraft,headRefName,headRefOid,\
baseRefName,isCrossRepository,reviewDecision,mergeable,mergeStateStatus,updatedAt,url,\
labels,statusCheckRollup";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// Empty when the account was deleted — `gh` sends `author: null`.
    pub author: String,
    pub is_draft: bool,
    pub head_ref_name: String,
    /// The commit merge is pinned to. Never displayed in full, but the merge
    /// confirmation shows its short form and passes it to `--match-head-commit`.
    pub head_ref_oid: String,
    pub base_ref_name: String,
    pub is_cross_repository: bool,
    pub review_decision: Option<String>,
    pub checks: ChecksSummary,
    pub mergeable: String,
    pub merge_state_status: String,
    pub updated_at: String,
    pub url: String,
    pub labels: Vec<String>,
}

/// Read `gh pr list --json <PR_LIST_FIELDS>`.
///
/// Deliberately hand-rolled rather than `#[derive(Deserialize)]` over the wire
/// shape: `author` is an object that may be null, `labels` is an array of
/// objects, and `statusCheckRollup` needs reducing. A derive would need three
/// helper structs and would still fail the whole list on one unexpected null.
pub fn parse_pull_requests(json: &str) -> Result<Vec<PullRequest>, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| {
            let s = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            PullRequest {
                number: r.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
                title: s("title"),
                author: r
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                is_draft: r.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
                head_ref_name: s("headRefName"),
                head_ref_oid: s("headRefOid"),
                base_ref_name: s("baseRefName"),
                is_cross_repository: r
                    .get("isCrossRepository")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                review_decision: r
                    .get("reviewDecision")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
                checks: summarise_checks(
                    r.get("statusCheckRollup").unwrap_or(&serde_json::Value::Null),
                ),
                mergeable: s("mergeable"),
                merge_state_status: s("mergeStateStatus"),
                updated_at: s("updatedAt"),
                url: s("url"),
                labels: r
                    .get("labels")
                    .and_then(|v| v.as_array())
                    .map(|ls| {
                        ls.iter()
                            .filter_map(|l| l.get("name").and_then(|v| v.as_str()))
                            .map(|s| s.to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_pr`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh_pr.rs
git commit -m "feat(pr): parse the pull request list"
```

---

### Task 3: Merge options and the worktree path

**Issue:** #102

Two more pure functions. The worktree path is the one place where a mistake writes into a repository, so it gets an explicit test that the result lands outside the workspace.

**Files:**
- Modify: `src-tauri/src/gh_pr.rs`

**Interfaces:**
- Produces: `gh_pr::MergeOptions { strategies: Vec<String>, default: String, repo_deletes_branch: bool }`, `gh_pr::parse_merge_options(json: &str) -> Result<MergeOptions, String>`, `gh_pr::worktree_path(workspace_path: &str, number: u64, branch: &str) -> std::path::PathBuf`, `gh_pr::slug(s: &str) -> String`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/gh_pr.rs`:

```rust
    #[test]
    fn merge_options_list_only_what_the_repo_allows() {
        let json = r#"{ "mergeCommitAllowed": false, "squashMergeAllowed": true,
                        "rebaseMergeAllowed": true, "viewerDefaultMergeMethod": "SQUASH",
                        "deleteBranchOnMerge": true }"#;
        let o = parse_merge_options(json).unwrap();
        assert_eq!(o.strategies, vec!["squash".to_string(), "rebase".to_string()]);
        assert_eq!(o.default, "squash");
        assert!(o.repo_deletes_branch);
    }

    /// A default the repository forbids would preselect a button that fails.
    #[test]
    fn a_forbidden_default_falls_back_to_an_allowed_one() {
        let json = r#"{ "mergeCommitAllowed": false, "squashMergeAllowed": true,
                        "rebaseMergeAllowed": false, "viewerDefaultMergeMethod": "MERGE",
                        "deleteBranchOnMerge": false }"#;
        let o = parse_merge_options(json).unwrap();
        assert_eq!(o.default, "squash");
    }

    #[test]
    fn worktree_lands_beside_the_workspace_never_inside_it() {
        let ws = "/home/u/projects/cowork-deck";
        let p = worktree_path(ws, 42, "feat/nice-thing");
        assert!(!p.starts_with(ws), "worktree must not nest inside the workspace: {p:?}");
        assert_eq!(
            p,
            std::path::PathBuf::from("/home/u/projects/cowork-deck-pr/42-feat-nice-thing"),
        );
    }

    /// Branch names carry slashes and worse; the directory name must not.
    #[test]
    fn branch_names_are_slugged_for_the_filesystem() {
        assert_eq!(slug("feat/nice-thing"), "feat-nice-thing");
        assert_eq!(slug("user's branch!"), "user-s-branch");
        assert_eq!(slug("../escape"), "escape");
        assert_eq!(slug(""), "branch");
        assert_eq!(slug(&"x".repeat(80)).len(), 40);
    }

    /// A workspace at the filesystem root has no parent to sit beside; the
    /// worktree must still land somewhere legal rather than panicking.
    #[test]
    fn a_workspace_without_a_parent_still_resolves() {
        let p = worktree_path("/", 1, "b");
        assert!(p.to_string_lossy().contains("1-b"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gh_pr`
Expected: FAIL — `cannot find function parse_merge_options`

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/gh_pr.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOptions {
    /// Only what this repository permits, in a stable order.
    pub strategies: Vec<String>,
    pub default: String,
    /// When true the repository deletes the branch itself, and the dialog says
    /// so instead of offering a checkbox that does not describe what happens.
    pub repo_deletes_branch: bool,
}

/// Read `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,\
/// viewerDefaultMergeMethod,deleteBranchOnMerge`.
pub fn parse_merge_options(json: &str) -> Result<MergeOptions, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    let flag = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
    let mut strategies = Vec::new();
    if flag("mergeCommitAllowed") { strategies.push("merge".to_string()); }
    if flag("squashMergeAllowed") { strategies.push("squash".to_string()); }
    if flag("rebaseMergeAllowed") { strategies.push("rebase".to_string()); }

    let preferred = v
        .get("viewerDefaultMergeMethod")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Preselecting a strategy the repository forbids would arm a button that
    // can only fail.
    let default = if strategies.iter().any(|s| *s == preferred) {
        preferred
    } else {
        strategies.first().cloned().unwrap_or_default()
    };

    Ok(MergeOptions { strategies, default, repo_deletes_branch: flag("deleteBranchOnMerge") })
}

/// A filesystem-safe fragment of a branch name: lowercase, single dashes, and
/// short enough to keep the path within sane limits. Path separators and dots
/// are stripped rather than escaped, so nothing here can climb out of the
/// directory it is joined to.
pub fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let cut = trimmed.char_indices().nth(40).map_or(trimmed.len(), |(i, _)| i);
    let cut = trimmed[..cut].trim_end_matches('-');
    if cut.is_empty() { "branch".to_string() } else { cut.to_string() }
}

/// Where the worktree for a pull request lives: beside the workspace, never
/// inside it.
///
/// Nesting is not a matter of taste. BUG-026 is the record of what it costs:
/// `npm test` from the repository root globbed suites out of nested worktrees
/// and ran 880 tests instead of 183. A nested worktree would equally show up in
/// `git status` and under the task watcher.
pub fn worktree_path(workspace_path: &str, number: u64, branch: &str) -> std::path::PathBuf {
    let ws = std::path::Path::new(workspace_path);
    let name = ws.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "workspace".to_string());
    let parent = ws.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join(format!("{name}-pr")).join(format!("{number}-{}", slug(branch)))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gh_pr`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh_pr.rs
git commit -m "feat(pr): merge options and the worktree path"
```

---

### Task 4: Running `gh` under the workspace's account

**Issue:** #103

The commands that reach the network. One helper does the running, so the token cache and the redaction live in exactly one place.

**Note on the token cache.** The account spec states that the app holds no token: it resolves one at session start and it lives only in the child's memory. Polling changes the arithmetic — resolving on every tick would run `gh auth token` every few seconds, and a locked keyring is exactly the case that spec added a timeout for. So a cache is introduced here, deliberately and narrowly: in memory only, keyed by host and login, cleared whenever a workspace's binding changes, and never written to disk or into a log. This is a real deviation from the earlier document and is recorded in the README in Task 12.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `gh_pr::{PR_LIST_FIELDS, parse_pull_requests, parse_merge_options}` (Tasks 2–3), `resolve_session_auth` and `noauth_dir` (existing in `commands.rs`), `gh::redact`
- Produces: Tauri commands `pr_list(workspace_id: String) -> Result<Vec<PullRequest>, String>` and `pr_merge_options(workspace_id: String) -> Result<MergeOptions, String>`; `commands::AppState.gh_tokens`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/commands.rs`:

```rust
    /// The argv is what decides which account and which repository answer, so
    /// it is worth pinning even though the call itself needs the network.
    #[test]
    fn pr_list_argv_asks_for_open_prs_with_every_field() {
        let argv = pr_list_argv(50);
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "list");
        assert!(argv.contains(&"--state".to_string()));
        assert!(argv.contains(&"open".to_string()));
        assert!(argv.contains(&"--limit".to_string()));
        assert!(argv.contains(&"50".to_string()));
        let json_at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[json_at + 1], crate::gh_pr::PR_LIST_FIELDS);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test pr_list_argv`
Expected: FAIL — `cannot find function pr_list_argv`

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/commands.rs`:

```rust
/// Cap on one page of pull requests. Named rather than inlined because the
/// frontend prints "showing N of M" against it: a silently truncated list reads
/// as a complete one.
pub const PR_PAGE_LIMIT: usize = 50;

pub fn pr_list_argv(limit: usize) -> Vec<String> {
    vec![
        "pr".into(), "list".into(),
        "--state".into(), "open".into(),
        "--limit".into(), limit.to_string(),
        "--json".into(), crate::gh_pr::PR_LIST_FIELDS.into(),
    ]
}

/// Resolve the workspace's account token, caching it in memory.
///
/// See the note in the plan: the account spec deliberately kept tokens out of
/// the app, and polling is why this exists. Never logged, never persisted,
/// dropped when the binding changes.
fn workspace_token(state: &State<AppState>, cfg: &WorkspaceGithub) -> Option<String> {
    let key = (cfg.host.clone(), cfg.login.clone());
    if let Some(t) = state.gh_tokens.lock().ok()?.get(&key) {
        return Some(t.clone());
    }
    let t = gh::token(&cfg.host, &cfg.login, std::time::Duration::from_secs(5)).ok()?;
    if let Ok(mut cache) = state.gh_tokens.lock() {
        cache.insert(key, t.clone());
    }
    Some(t)
}

/// Run `gh` in the workspace's folder, under the workspace's account.
///
/// Every path out of here is redacted: `gh` is capable of echoing a token back
/// in an error, and this is the only place that decides what the frontend sees.
fn run_gh_for_workspace(
    state: &State<AppState>, workspace_id: &str, args: &[String],
) -> Result<String, String> {
    let ws = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces().into_iter().find(|w| w.id == workspace_id)
    }
    .ok_or_else(|| "no such workspace".to_string())?;
    let cfg = ws.github.clone().ok_or_else(|| "no-account".to_string())?;
    let path = gh::which_gh().ok_or_else(|| "gh-not-found".to_string())?;
    let token = workspace_token(state, &cfg);

    let dir = noauth_dir(state);
    let env = gh::session_env(&cfg, token.as_deref(), &dir.to_string_lossy());

    let out = std::process::Command::new(&path)
        .args(args)
        .current_dir(&ws.path)
        .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
        .output()
        .map_err(|e| gh::redact(&e.to_string()))?;
    if !out.status.success() {
        return Err(gh::redact(String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub fn pr_list(
    state: State<AppState>, workspace_id: String,
) -> Result<Vec<crate::gh_pr::PullRequest>, String> {
    let json = run_gh_for_workspace(&state, &workspace_id, &pr_list_argv(PR_PAGE_LIMIT))?;
    crate::gh_pr::parse_pull_requests(&json)
}

#[tauri::command]
pub fn pr_merge_options(
    state: State<AppState>, workspace_id: String,
) -> Result<crate::gh_pr::MergeOptions, String> {
    let args: Vec<String> = vec![
        "repo".into(), "view".into(), "--json".into(),
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,\
viewerDefaultMergeMethod,deleteBranchOnMerge"
            .into(),
    ];
    let json = run_gh_for_workspace(&state, &workspace_id, &args)?;
    crate::gh_pr::parse_merge_options(&json)
}
```

Add the cache field to `AppState` in `src-tauri/src/commands.rs`:

```rust
    /// In-memory account tokens, keyed by (host, login). See `workspace_token`.
    pub gh_tokens: Mutex<std::collections::HashMap<(String, String), String>>,
```

Initialise it wherever `AppState` is constructed in `src-tauri/src/main.rs`:

```rust
            gh_tokens: Mutex::new(std::collections::HashMap::new()),
```

Register both commands in the `invoke_handler` list in `src-tauri/src/main.rs`, beside `commands::gh_status`:

```rust
            commands::pr_list,
            commands::pr_merge_options,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — the new test plus every existing one

- [ ] **Step 5: Clear the cache when a binding changes**

The workspace form already notifies the frontend that a binding changed. The backend must drop the token too, or a re-bound workspace keeps talking as the old account. In `save_workspace` in `src-tauri/src/commands.rs` (line 92), before saving, clear the whole map — it holds at most a handful of entries and precision buys nothing:

```rust
    if let Ok(mut cache) = state.gh_tokens.lock() {
        cache.clear();
    }
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(pr): list pull requests under the workspace account"
```

---

### Task 5: Merge, close and reopen

**Issue:** #104

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `run_gh_for_workspace` (Task 4)
- Produces: `pr_merge_argv(number, strategy, head_oid, delete_branch) -> Vec<String>`; Tauri commands `pr_merge(workspace_id, number, strategy, head_oid, delete_branch) -> Result<(), String>`, `pr_close(workspace_id, number)`, `pr_reopen(workspace_id, number)`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/commands.rs`:

```rust
    /// --match-head-commit is the whole safety story of this button: without it
    /// the merge takes whatever is at the head now, not what was on screen.
    #[test]
    fn merge_argv_pins_the_head_commit() {
        let argv = pr_merge_argv(7, "squash", "abc123", false);
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "merge");
        assert_eq!(argv[2], "7");
        assert!(argv.contains(&"--squash".to_string()));
        let at = argv.iter().position(|a| a == "--match-head-commit").expect("pin");
        assert_eq!(argv[at + 1], "abc123");
        assert!(!argv.contains(&"--delete-branch".to_string()));
    }

    #[test]
    fn merge_argv_maps_every_strategy_and_can_delete_the_branch() {
        assert!(pr_merge_argv(1, "merge", "a", true).contains(&"--merge".to_string()));
        assert!(pr_merge_argv(1, "rebase", "a", true).contains(&"--rebase".to_string()));
        assert!(pr_merge_argv(1, "merge", "a", true).contains(&"--delete-branch".to_string()));
    }

    /// An unknown strategy must not silently become a merge commit.
    #[test]
    fn an_unknown_strategy_is_rejected() {
        assert!(merge_strategy_flag("cherry-pick").is_none());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test merge_argv`
Expected: FAIL — `cannot find function pr_merge_argv`

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/commands.rs`:

```rust
fn merge_strategy_flag(strategy: &str) -> Option<&'static str> {
    match strategy {
        "merge" => Some("--merge"),
        "squash" => Some("--squash"),
        "rebase" => Some("--rebase"),
        _ => None,
    }
}

pub fn pr_merge_argv(
    number: u64, strategy: &str, head_oid: &str, delete_branch: bool,
) -> Vec<String> {
    let mut argv: Vec<String> = vec!["pr".into(), "merge".into(), number.to_string()];
    if let Some(flag) = merge_strategy_flag(strategy) {
        argv.push(flag.into());
    }
    // Pins the merge to the commit the person actually read. gh fails if the
    // head has moved, which is the outcome we want.
    argv.push("--match-head-commit".into());
    argv.push(head_oid.into());
    if delete_branch {
        argv.push("--delete-branch".into());
    }
    argv
}

#[tauri::command]
pub fn pr_merge(
    state: State<AppState>, workspace_id: String, number: u64, strategy: String,
    head_oid: String, delete_branch: bool,
) -> Result<(), String> {
    if merge_strategy_flag(&strategy).is_none() {
        return Err(format!("unknown merge strategy: {strategy}"));
    }
    run_gh_for_workspace(
        &state, &workspace_id, &pr_merge_argv(number, &strategy, &head_oid, delete_branch),
    )
    .map(|_| ())
}

#[tauri::command]
pub fn pr_close(state: State<AppState>, workspace_id: String, number: u64) -> Result<(), String> {
    let args: Vec<String> = vec!["pr".into(), "close".into(), number.to_string()];
    run_gh_for_workspace(&state, &workspace_id, &args).map(|_| ())
}

#[tauri::command]
pub fn pr_reopen(state: State<AppState>, workspace_id: String, number: u64) -> Result<(), String> {
    let args: Vec<String> = vec!["pr".into(), "reopen".into(), number.to_string()];
    run_gh_for_workspace(&state, &workspace_id, &args).map(|_| ())
}
```

Register in `src-tauri/src/main.rs`:

```rust
            commands::pr_merge,
            commands::pr_close,
            commands::pr_reopen,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(pr): merge pinned to the reviewed commit, close and reopen"
```

---

### Task 6: The worktree

**Issue:** #105

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `gh_pr::worktree_path` (Task 3), `run_gh_for_workspace` (Task 4)
- Produces: Tauri commands `pr_worktree_add(workspace_id, number, branch) -> Result<String, String>` (returns the path) and `pr_worktree_remove(workspace_id, number, branch) -> Result<(), String>`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/commands.rs`:

```rust
    #[test]
    fn a_dirty_worktree_is_never_removed() {
        let dir = std::env::temp_dir().join(format!("cowork-wt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // Not a git repository at all: `git status` fails, which must read as
        // "refuse", never as "clean, go ahead and delete".
        assert!(worktree_is_clean(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test worktree`
Expected: FAIL — `cannot find function worktree_is_clean`

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/commands.rs`:

```rust
/// Whether a worktree holds no uncommitted work.
///
/// An error is not "clean": if `git status` cannot answer, the only safe
/// reading is that we do not know, and we do not delete what we cannot inspect.
fn worktree_is_clean(path: &std::path::Path) -> Result<bool, String> {
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

#[tauri::command]
pub fn pr_worktree_add(
    state: State<AppState>, workspace_id: String, number: u64, branch: String,
) -> Result<String, String> {
    let ws_path = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces().into_iter().find(|w| w.id == workspace_id).map(|w| w.path)
    }
    .ok_or_else(|| "no such workspace".to_string())?;

    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    // Already there from an earlier launch: hand it back rather than failing.
    // The session that opens in it will see whatever state it was left in.
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;

    // Fetch the head into a local branch first, then attach a worktree to it.
    // `gh pr checkout` is not used: it would move the branch inside the
    // workspace's own working copy, under every live session there.
    let local = format!("pr-{number}");
    let refspec = format!("pull/{number}/head:{local}");
    let fetch: Vec<String> =
        vec!["fetch".into(), "origin".into(), refspec, "--force".into()];
    let out = std::process::Command::new("git")
        .args(&fetch)
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let out = std::process::Command::new("git")
        .args(["worktree", "add", &path.to_string_lossy(), &local])
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pr_worktree_remove(
    state: State<AppState>, workspace_id: String, number: u64, branch: String,
) -> Result<(), String> {
    let ws_path = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces().into_iter().find(|w| w.id == workspace_id).map(|w| w.path)
    }
    .ok_or_else(|| "no such workspace".to_string())?;
    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    if !path.exists() {
        return Ok(());
    }
    match worktree_is_clean(&path) {
        Ok(true) => {}
        Ok(false) => {
            return Err(format!(
                "{} has uncommitted changes — nothing was removed",
                path.to_string_lossy()
            ))
        }
        Err(e) => {
            return Err(format!(
                "cannot tell whether {} is clean, so it was left alone: {e}",
                path.to_string_lossy()
            ))
        }
    }
    let out = std::process::Command::new("git")
        .args(["worktree", "remove", &path.to_string_lossy()])
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}
```

Register in `src-tauri/src/main.rs`:

```rust
            commands::pr_worktree_add,
            commands::pr_worktree_remove,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(pr): a worktree per pull request, never removed while dirty"
```

---

### Task 7: Frontend types and IPC wrappers

**Issue:** #106

**Files:**
- Modify: `src/ipc.ts`
- Modify: `tests/ipc.test.ts`

**Interfaces:**
- Produces: `ChecksSummary`, `PullRequest`, `MergeOptions` types; `prList`, `prMergeOptions`, `prMerge`, `prClose`, `prReopen`, `prWorktreeAdd`, `prWorktreeRemove`

- [ ] **Step 1: Write the failing test**

Add to `tests/ipc.test.ts`:

```ts
  it("prMerge forwards the pinned head commit", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await prMerge("w1", 7, "squash", "abc123", false);
    expect(invoke).toHaveBeenCalledWith("pr_merge", {
      workspaceId: "w1", number: 7, strategy: "squash",
      headOid: "abc123", deleteBranch: false,
    });
  });

  it("prList asks for one workspace", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await prList("w1");
    expect(invoke).toHaveBeenCalledWith("pr_list", { workspaceId: "w1" });
  });
```

Add `prList, prMerge` to the import from `../src/ipc` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ipc.test.ts`
Expected: FAIL — `prMerge is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/ipc.ts`, beside the existing `ghStatus`:

```ts
/** Four distinct check states. `none` is not `passed`: nothing has built this. */
export type ChecksSummary =
  | { kind: "none" }
  | { kind: "running"; done: number; total: number }
  | { kind: "passed"; total: number }
  | { kind: "failed"; failed: number; total: number };

export interface PullRequest {
  number: number;
  title: string;
  /** Empty when the author's account is gone. */
  author: string;
  isDraft: boolean;
  headRefName: string;
  /** What a merge is pinned to — see `prMerge`. */
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  reviewDecision: string | null;
  checks: ChecksSummary;
  mergeable: string;
  mergeStateStatus: string;
  updatedAt: string;
  url: string;
  labels: string[];
}

export interface MergeOptions {
  strategies: ("merge" | "squash" | "rebase")[];
  default: "merge" | "squash" | "rebase";
  /** The repository deletes merged branches itself; the dialog says so rather
   *  than offering a checkbox that misdescribes what happens. */
  repoDeletesBranch: boolean;
}

export const prList = (workspaceId: string) =>
  invoke<PullRequest[]>("pr_list", { workspaceId });
export const prMergeOptions = (workspaceId: string) =>
  invoke<MergeOptions>("pr_merge_options", { workspaceId });
export const prMerge = (
  workspaceId: string, number: number, strategy: string, headOid: string, deleteBranch: boolean,
) => invoke<void>("pr_merge", { workspaceId, number, strategy, headOid, deleteBranch });
export const prClose = (workspaceId: string, number: number) =>
  invoke<void>("pr_close", { workspaceId, number });
export const prReopen = (workspaceId: string, number: number) =>
  invoke<void>("pr_reopen", { workspaceId, number });
export const prWorktreeAdd = (workspaceId: string, number: number, branch: string) =>
  invoke<string>("pr_worktree_add", { workspaceId, number, branch });
export const prWorktreeRemove = (workspaceId: string, number: number, branch: string) =>
  invoke<void>("pr_worktree_remove", { workspaceId, number, branch });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ipc.test.ts && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts tests/ipc.test.ts
git commit -m "feat(pr): frontend types and IPC wrappers"
```

---

### Task 8: Pure frontend logic

**Issue:** #107

Everything with a rule in it, away from the DOM: what may be merged and why not, how old the data is, how fast to poll.

**Files:**
- Create: `src/pr.ts`
- Create: `tests/pr.test.ts`

**Interfaces:**
- Consumes: `PullRequest`, `ChecksSummary` (Task 7)
- Produces: `canMerge(pr) -> { ok: true } | { ok: false; reason: string }`, `checksLabel(c: ChecksSummary) -> string`, `reviewLabel(d: string | null) -> string`, `sortPrs(prs) -> PullRequest[]`, `ago(iso: string, now: number) -> string`, `pollIntervalMs(prs) -> number`, `POLL_FAST_MS`, `POLL_SLOW_MS`

- [ ] **Step 1: Write the failing tests**

Create `tests/pr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ago, canMerge, checksLabel, pollIntervalMs, reviewLabel, sortPrs,
  POLL_FAST_MS, POLL_SLOW_MS,
} from "../src/pr";
import type { PullRequest } from "../src/ipc";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1, title: "t", author: "a", isDraft: false,
  headRefName: "h", headRefOid: "oid", baseRefName: "main",
  isCrossRepository: false, reviewDecision: null,
  checks: { kind: "passed", total: 1 },
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  updatedAt: "2026-07-29T12:00:00Z", url: "u", labels: [],
  ...over,
});

describe("canMerge", () => {
  it("allows a clean, mergeable pull request", () => {
    expect(canMerge(pr())).toEqual({ ok: true });
  });

  // Each refusal names its own cause: "cannot merge" without a reason sends
  // people to the browser to find out why.
  it("refuses a draft", () => {
    const r = canMerge(pr({ isDraft: true }));
    expect(r).toEqual({ ok: false, reason: "This pull request is still a draft." });
  });

  it("refuses on conflicts", () => {
    const r = canMerge(pr({ mergeable: "CONFLICTING" }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("conflict");
  });

  it("refuses while the branch protection blocks it", () => {
    const r = canMerge(pr({ mergeStateStatus: "BLOCKED" }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("blocked");
  });

  it("refuses while checks are still running", () => {
    const r = canMerge(pr({ checks: { kind: "running", done: 1, total: 3 } }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("running");
  });

  // Not a refusal: a repository with no required checks is a normal repository,
  // and GitHub itself allows the merge.
  it("allows a pull request with no checks at all", () => {
    expect(canMerge(pr({ checks: { kind: "none" } }))).toEqual({ ok: true });
  });

  it("refuses when mergeability is still unknown", () => {
    const r = canMerge(pr({ mergeable: "UNKNOWN" }));
    expect(r.ok).toBe(false);
  });
});

describe("checksLabel", () => {
  it("never calls an unchecked pull request green", () => {
    expect(checksLabel({ kind: "none" })).toBe("no checks");
    expect(checksLabel({ kind: "passed", total: 3 })).toBe("3 passed");
    expect(checksLabel({ kind: "running", done: 1, total: 3 })).toBe("1/3 running");
    expect(checksLabel({ kind: "failed", failed: 2, total: 5 })).toBe("2 of 5 failed");
  });
});

describe("reviewLabel", () => {
  it("renders each verdict, and says nothing when there is none", () => {
    expect(reviewLabel("APPROVED")).toBe("approved");
    expect(reviewLabel("CHANGES_REQUESTED")).toBe("changes requested");
    expect(reviewLabel("REVIEW_REQUIRED")).toBe("review required");
    expect(reviewLabel(null)).toBe("");
  });
});

describe("sortPrs", () => {
  // Whatever needs a decision comes first; drafts are nobody's next action.
  it("puts failures first and drafts last", () => {
    const failed = pr({ number: 1, checks: { kind: "failed", failed: 1, total: 1 } });
    const plain = pr({ number: 2 });
    const draft = pr({ number: 3, isDraft: true });
    expect(sortPrs([draft, plain, failed]).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("breaks ties by most recently updated", () => {
    const older = pr({ number: 1, updatedAt: "2026-07-01T00:00:00Z" });
    const newer = pr({ number: 2, updatedAt: "2026-07-28T00:00:00Z" });
    expect(sortPrs([older, newer]).map((p) => p.number)).toEqual([2, 1]);
  });
});

describe("ago", () => {
  const now = Date.parse("2026-07-29T12:00:00Z");
  it("reads as a person would say it", () => {
    expect(ago("2026-07-29T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-07-29T11:45:00Z", now)).toBe("15 min ago");
    expect(ago("2026-07-29T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-07-26T12:00:00Z", now)).toBe("3 d ago");
  });

  it("does not invent a time from an unparseable stamp", () => {
    expect(ago("nonsense", now)).toBe("unknown");
  });
});

describe("pollIntervalMs", () => {
  it("polls fast while any job is running", () => {
    expect(pollIntervalMs([pr({ checks: { kind: "running", done: 0, total: 2 } })]))
      .toBe(POLL_FAST_MS);
  });

  it("slows down once everything has settled", () => {
    expect(pollIntervalMs([pr(), pr({ checks: { kind: "failed", failed: 1, total: 1 } })]))
      .toBe(POLL_SLOW_MS);
  });

  it("slows down on an empty list rather than hammering an idle repository", () => {
    expect(pollIntervalMs([])).toBe(POLL_SLOW_MS);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pr.test.ts`
Expected: FAIL — cannot resolve `../src/pr`

- [ ] **Step 3: Write minimal implementation**

Create `src/pr.ts`:

```ts
import type { ChecksSummary, PullRequest } from "./ipc";

/** While something is building, the answer changes in under a minute. */
export const POLL_FAST_MS = 15_000;
/** Once it has settled, only a human action changes anything. */
export const POLL_SLOW_MS = 60_000;

export type MergeVerdict = { ok: true } | { ok: false; reason: string };

/** Whether merge may be offered, and if not, why — the reason is shown on the
 *  disabled button, so a refusal never arrives after the click. */
export function canMerge(pr: PullRequest): MergeVerdict {
  if (pr.isDraft) return { ok: false, reason: "This pull request is still a draft." };
  if (pr.mergeable === "CONFLICTING") {
    return { ok: false, reason: "The branch has conflicts with its base." };
  }
  if (pr.mergeable !== "MERGEABLE") {
    return { ok: false, reason: "GitHub has not finished working out whether this can merge." };
  }
  if (pr.checks.kind === "running") {
    return { ok: false, reason: "Checks are still running." };
  }
  // BEHIND and DIRTY are covered by `mergeable` above; BLOCKED is the branch
  // protection case, which `mergeable` reports as MERGEABLE.
  if (pr.mergeStateStatus === "BLOCKED") {
    return { ok: false, reason: "Merging is blocked — a required review or check is missing." };
  }
  return { ok: true };
}

export function checksLabel(c: ChecksSummary): string {
  switch (c.kind) {
    case "none": return "no checks";
    case "running": return `${c.done}/${c.total} running`;
    case "passed": return `${c.total} passed`;
    case "failed": return `${c.failed} of ${c.total} failed`;
  }
}

export function reviewLabel(d: string | null): string {
  switch (d) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "REVIEW_REQUIRED": return "review required";
    default: return "";
  }
}

/** Rank: what needs a decision first, drafts last. */
function rank(pr: PullRequest): number {
  if (pr.isDraft) return 3;
  if (pr.checks.kind === "failed") return 0;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return 0;
  return 1;
}

export function sortPrs(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function pollIntervalMs(prs: PullRequest[]): number {
  return prs.some((p) => p.checks.kind === "running") ? POLL_FAST_MS : POLL_SLOW_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pr.test.ts`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add src/pr.ts tests/pr.test.ts
git commit -m "feat(pr): pure logic for merge eligibility, labels, sorting and pacing"
```

---

### Task 9: The three-way view switch

**Issue:** #108

**Files:**
- Modify: `src/view.ts`
- Modify: `tests/view-switch.test.ts`

**Interfaces:**
- Produces: `type ViewName = "deck" | "board" | "pr"`, `applyView(el: ViewElements, view: ViewName): void`, `ViewElements` gaining `pr: HTMLElement` and `prBtn: HTMLElement`

- [ ] **Step 1: Write the failing tests**

Rewrite the `mount()` helper in `tests/view-switch.test.ts` to include the new elements, and replace the boolean calls:

```ts
function mount(): ViewElements {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  document.body.innerHTML =
    '<div id="app"><aside id="sidebar"><div id="ws"></div><div id="sk"></div>' +
    '<button id="new"></button><div id="list"></div></aside>' +
    '<main id="deck"></main><div id="board" class="hidden"></div>' +
    '<div id="pr" class="hidden"></div></div>';
  const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  return {
    deck: pick("#deck"),
    board: pick("#board"),
    pr: pick("#pr"),
    termBtn: document.createElement("button"),
    boardBtn: document.createElement("button"),
    prBtn: document.createElement("button"),
    terminalsOnly: [pick("#sk"), pick("#new"), pick("#list")],
  };
}
```

Add these tests:

```ts
  it("shows exactly one screen at a time", () => {
    for (const view of ["deck", "board", "pr"] as const) {
      applyView(el, view);
      const visible = [el.deck, el.board, el.pr].filter(shown);
      expect(visible).toHaveLength(1);
    }
  });

  it("hides the deck on the PR screen, against the real stylesheet", () => {
    applyView(el, "pr");
    // Same trap as the board: #deck { display: grid } is an id selector and
    // outweighs .tk-hidden, so asserting the class would pass while the
    // terminals stayed on screen.
    expect(getComputedStyle(el.deck).display).toBe("none");
    expect(shown(el.pr)).toBe(true);
  });

  it("marks exactly one button active", () => {
    applyView(el, "pr");
    expect(el.prBtn.classList.contains("active")).toBe(true);
    expect(el.boardBtn.classList.contains("active")).toBe(false);
    expect(el.termBtn.classList.contains("active")).toBe(false);
  });

  it("hides the terminals-only sidebar blocks on the PR screen too", () => {
    applyView(el, "pr");
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(false);
  });
```

Update the existing tests to pass `"board"` / `"deck"` instead of `true` / `false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/view-switch.test.ts`
Expected: FAIL — the `pr` property does not exist on `ViewElements`

- [ ] **Step 3: Write minimal implementation**

Replace `src/view.ts`:

```ts
/** The three screens: terminals, the task board, and pull requests. Which
 *  sidebar blocks belong to the terminals screen is the caller's business —
 *  this module only hides them. */
export type ViewName = "deck" | "board" | "pr";

export interface ViewElements {
  deck: HTMLElement;
  board: HTMLElement;
  pr: HTMLElement;
  termBtn: HTMLElement;
  boardBtn: HTMLElement;
  prBtn: HTMLElement;
  /** Sidebar blocks that lead nowhere off the terminals screen: the scenario
   *  list, "+ session", and the session list. Workspaces stay — every screen
   *  shows one workspace at a time and switching between them is the point. */
  terminalsOnly: HTMLElement[];
}

/** Show one screen. DOM only: no IPC and no timers, so it can be tested against
 *  the real stylesheet, which is where the bug this replaces lived — `#deck`
 *  is an id selector and outweighs a class, so the deck needs `tk-hidden`
 *  rather than the plain `hidden` the others use. */
export function applyView(el: ViewElements, view: ViewName): void {
  el.deck.classList.toggle("tk-hidden", view !== "deck");
  el.board.classList.toggle("hidden", view !== "board");
  el.pr.classList.toggle("hidden", view !== "pr");
  el.termBtn.classList.toggle("active", view === "deck");
  el.boardBtn.classList.toggle("active", view === "board");
  el.prBtn.classList.toggle("active", view === "pr");
  for (const node of el.terminalsOnly) node.classList.toggle("tk-hidden", view !== "deck");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/view-switch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/view.ts tests/view-switch.test.ts
git commit -m "feat(pr): a three-way view switch"
```

---

### Task 10: The pull request view

**Issue:** #109

**Files:**
- Create: `src/pr-view.ts`
- Create: `tests/pr-view.test.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `pr.ts` (Task 8), `PullRequest`, `MergeOptions` (Task 7)
- Produces: `PrState { workspace: string | null; unavailable: PrUnavailable | null; prs: PullRequest[]; error: string | null; fetchedAt: number | null; total: number | null }`, `PrUnavailable = "no-gh" | "no-account" | "no-repo"`, `PrHandlers { onLaunch, onMerge, onClose, onReopen, onRefresh, onFixUnavailable }`, `class PrView { mount; render(state, now) }`

- [ ] **Step 1: Write the failing tests**

Create `tests/pr-view.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrView, type PrHandlers, type PrState } from "../src/pr-view";
import type { PullRequest } from "../src/ipc";

const NOW = Date.parse("2026-07-29T12:00:00Z");

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "fix the thing", author: "octocat", isDraft: false,
  headRefName: "fix/thing", headRefOid: "abc1234", baseRefName: "main",
  isCrossRepository: false, reviewDecision: null,
  checks: { kind: "passed", total: 2 },
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  updatedAt: "2026-07-29T11:45:00Z", url: "https://example.test/pr/7", labels: [],
  ...over,
});

const state = (over: Partial<PrState> = {}): PrState => ({
  workspace: "cowork-deck", unavailable: null, prs: [pr()],
  error: null, fetchedAt: NOW, total: 1, ...over,
});

function mk(): { view: PrView; h: PrHandlers } {
  const h: PrHandlers = {
    onLaunch: vi.fn(), onMerge: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(),
    onRefresh: vi.fn(), onFixUnavailable: vi.fn(),
  };
  const view = new PrView(h);
  document.body.replaceChildren(view.mount);
  return { view, h };
}

beforeEach(() => { document.body.replaceChildren(); });

describe("PrView", () => {
  it("renders number, title, author and the branch pair", () => {
    const { view } = mk();
    view.render(state(), NOW);
    const row = document.querySelector(".pr-row")!;
    expect(row.textContent).toContain("#7");
    expect(row.textContent).toContain("fix the thing");
    expect(row.textContent).toContain("octocat");
    expect(row.textContent).toContain("fix/thing → main");
  });

  // The regression this guards: a title arriving from the network must never
  // be parsed as markup.
  it("never renders a title as HTML", () => {
    const { view } = mk();
    view.render(state({ prs: [pr({ title: "<img src=x onerror=alert(1)>" })] }), NOW);
    expect(document.querySelector(".pr-row img")).toBeNull();
    expect(document.querySelector(".pr-title")!.textContent)
      .toBe("<img src=x onerror=alert(1)>");
  });

  it("distinguishes all four check states", () => {
    const { view } = mk();
    const seen = new Set<string>();
    for (const checks of [
      { kind: "none" }, { kind: "passed", total: 1 },
      { kind: "running", done: 1, total: 2 }, { kind: "failed", failed: 1, total: 2 },
    ] as PullRequest["checks"][]) {
      view.render(state({ prs: [pr({ checks })] }), NOW);
      const badge = document.querySelector(".pr-checks")!;
      seen.add(badge.className + "|" + badge.textContent);
    }
    expect(seen.size).toBe(4);
  });

  it("disables merge and names the reason", () => {
    const { view, h } = mk();
    view.render(state({ prs: [pr({ isDraft: true })] }), NOW);
    const btn = document.querySelector<HTMLButtonElement>(".pr-merge")!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("draft");
    btn.click();
    expect(h.onMerge).not.toHaveBeenCalled();
  });

  it("hands merge the pull request when it is allowed", () => {
    const { view, h } = mk();
    view.render(state(), NOW);
    document.querySelector<HTMLButtonElement>(".pr-merge")!.click();
    expect(h.onMerge).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }));
  });

  it("shows how old the data is, always", () => {
    const { view } = mk();
    view.render(state({ fetchedAt: NOW - 120_000 }), NOW);
    expect(document.querySelector(".pr-age")!.textContent).toContain("2 min ago");
  });

  // Serving a stale list silently is the failure mode this guards against.
  it("keeps the list and explains itself when a refresh fails", () => {
    const { view } = mk();
    view.render(state({ error: "rate limit exceeded", fetchedAt: NOW - 300_000 }), NOW);
    expect(document.querySelectorAll(".pr-row")).toHaveLength(1);
    const err = document.querySelector(".pr-error")!;
    expect(err.textContent).toContain("rate limit exceeded");
    expect(document.querySelector(".pr-age")!.textContent).toContain("5 min ago");
  });

  it("says how many were left out rather than truncating in silence", () => {
    const { view } = mk();
    view.render(state({ total: 50 }), NOW);
    expect(document.querySelector(".pr-capped")!.textContent).toContain("50");
  });

  it("offers the next step for each unavailable state", () => {
    const { view, h } = mk();
    for (const u of ["no-gh", "no-account", "no-repo"] as const) {
      view.render(state({ unavailable: u, prs: [] }), NOW);
      const btn = document.querySelector<HTMLButtonElement>(".pr-fix");
      expect(document.querySelector(".pr-unavailable")!.textContent!.length)
        .toBeGreaterThan(10);
      if (u !== "no-repo") {
        btn!.click();
        expect(h.onFixUnavailable).toHaveBeenCalledWith(u);
      }
    }
  });

  it("says nothing is open, distinctly from being unavailable", () => {
    const { view } = mk();
    view.render(state({ prs: [], total: 0 }), NOW);
    expect(document.querySelector(".pr-empty")).not.toBeNull();
    expect(document.querySelector(".pr-unavailable")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pr-view.test.ts`
Expected: FAIL — cannot resolve `../src/pr-view`

- [ ] **Step 3: Write minimal implementation**

Create `src/pr-view.ts`:

```ts
import type { PullRequest } from "./ipc";
import { ago, canMerge, checksLabel, reviewLabel, sortPrs } from "./pr";

export type PrUnavailable = "no-gh" | "no-account" | "no-repo";

export interface PrState {
  workspace: string | null;
  /** Non-null when the view cannot work at all — never rendered as an empty list. */
  unavailable: PrUnavailable | null;
  prs: PullRequest[];
  /** Last failure. The list stays on screen beside it. */
  error: string | null;
  /** When `prs` was fetched. Null before the first successful fetch. */
  fetchedAt: number | null;
  /** How many came back, so a capped page can say so. */
  total: number | null;
}

export interface PrHandlers {
  onLaunch: (pr: PullRequest) => void;
  onMerge: (pr: PullRequest) => void;
  onClose: (pr: PullRequest) => void;
  onReopen: (pr: PullRequest) => void;
  onRefresh: () => void;
  onFixUnavailable: (u: PrUnavailable) => void;
}

const UNAVAILABLE: Record<PrUnavailable, { text: string; action: string | null }> = {
  "no-gh": {
    text: "The gh command-line tool is not installed, so pull requests cannot be read.",
    action: "Set up gh",
  },
  "no-account": {
    text: "This workspace has no GitHub account bound, so there is no account to read as.",
    action: "Bind an account",
  },
  "no-repo": {
    text: "This workspace is not a git repository with a GitHub remote.",
    action: null,
  },
};

const PAGE_LIMIT = 50;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always textContent: titles, branches and logins come from the network.
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PrView {
  readonly mount = el("div", "pr-view");
  constructor(private h: PrHandlers) {}

  render(state: PrState, now: number) {
    this.mount.replaceChildren();

    const head = el("div", "pr-head");
    head.append(el("h3", "pr-title-head", "Pull requests"));
    const refresh = el("button", "pr-refresh", "↻");
    refresh.title = "Refresh";
    refresh.onclick = () => this.h.onRefresh();
    head.append(refresh);
    // Shown on every render, not only on failure: data that can be stale has
    // to say how stale.
    head.append(el("span", "pr-age",
      state.fetchedAt === null ? "never loaded" : `updated ${ago(new Date(state.fetchedAt).toISOString(), now)}`));
    this.mount.append(head);

    if (state.unavailable) {
      const spec = UNAVAILABLE[state.unavailable];
      const box = el("div", "pr-unavailable");
      box.append(el("p", "pr-unavailable-text", spec.text));
      if (spec.action) {
        const fix = el("button", "pr-fix", spec.action);
        const u = state.unavailable;
        fix.onclick = () => this.h.onFixUnavailable(u);
        box.append(fix);
      }
      this.mount.append(box);
      return;
    }

    if (state.error) this.mount.append(el("p", "pr-error", state.error));

    if (state.prs.length === 0) {
      this.mount.append(el("div", "pr-empty", "No open pull requests."));
      return;
    }

    for (const pr of sortPrs(state.prs)) this.mount.append(this.row(pr, now));

    if (state.total !== null && state.total >= PAGE_LIMIT) {
      this.mount.append(el("p", "pr-capped",
        `Showing the first ${PAGE_LIMIT} — the repository has more open.`));
    }
  }

  private row(pr: PullRequest, now: number): HTMLElement {
    const row = el("div", "pr-row");

    const main = el("div", "pr-main");
    main.append(el("span", "pr-number", `#${pr.number}`));
    main.append(el("span", "pr-title", pr.title));
    if (pr.isDraft) main.append(el("span", "pr-draft", "draft"));
    row.append(main);

    const meta = el("div", "pr-meta");
    meta.append(el("span", "pr-author", pr.author || "unknown author"));
    meta.append(el("span", "pr-branches", `${pr.headRefName} → ${pr.baseRefName}`));
    meta.append(el("span", `pr-checks pr-checks--${pr.checks.kind}`, checksLabel(pr.checks)));
    const review = reviewLabel(pr.reviewDecision);
    if (review) meta.append(el("span", "pr-review", review));
    meta.append(el("span", "pr-updated", ago(pr.updatedAt, now)));
    for (const l of pr.labels) meta.append(el("span", "pr-label", l));
    row.append(meta);

    const actions = el("div", "pr-actions");

    const launch = el("button", "pr-launch", "▶");
    launch.title = "Start a session on this branch, in a worktree of its own";
    launch.onclick = () => this.h.onLaunch(pr);
    actions.append(launch);

    const verdict = canMerge(pr);
    const merge = el("button", "pr-merge", "Merge");
    merge.disabled = !verdict.ok;
    // The reason travels with the disabled button, so the refusal is readable
    // before the click rather than after it.
    merge.title = verdict.ok ? "Merge this pull request" : verdict.reason;
    merge.onclick = () => { if (verdict.ok) this.h.onMerge(pr); };
    actions.append(merge);

    const close = el("button", "pr-close", "Close");
    close.onclick = () => this.h.onClose(pr);
    actions.append(close);

    // An anchor, not a button with a handler: the project has no URL-opening
    // plugin, and `github-screen.ts` already links out exactly this way.
    // Whether Tauri routes target=_blank to the system browser is unverified
    // there too — it is on the manual checklist in Task 13.
    const open = el("a", "pr-open", "Open in browser");
    open.href = pr.url;
    open.target = "_blank";
    open.rel = "noreferrer";
    actions.append(open);

    row.append(actions);
    return row;
  }
}
```

Append to `src/styles.css`:

```css
/* --- Pull requests ------------------------------------------------------ */
.pr-view { flex: 1; min-width: 0; overflow: auto; padding: var(--sp-3); }
.pr-view.hidden { display: none; }
.pr-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.pr-title-head { margin: 0; flex: 1; }
.pr-age { color: var(--fg-subtle); font-size: var(--fs-xs); }
.pr-refresh { background: none; border: 0; color: var(--fg-muted); cursor: pointer; }
.pr-row {
  display: flex; flex-direction: column; gap: 4px;
  padding: var(--sp-2); margin-bottom: var(--sp-2);
  background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--r-sm);
}
.pr-main { display: flex; align-items: baseline; gap: var(--sp-2); }
.pr-number { color: var(--fg-subtle); font-size: var(--fs-sm); }
.pr-title { color: var(--fg); font-weight: var(--fw-medium); }
.pr-draft, .pr-label {
  color: var(--fg-subtle); font-size: var(--fs-xs);
  border: 1px solid var(--border); border-radius: var(--r-sm); padding: 0 4px;
}
.pr-meta {
  display: flex; flex-wrap: wrap; gap: var(--sp-2);
  color: var(--fg-muted); font-size: var(--fs-xs);
}
/* Four states, four appearances: "no checks" must not read as "passed". */
.pr-checks--none { color: var(--fg-subtle); }
.pr-checks--running { color: var(--st-waiting); }
.pr-checks--passed { color: var(--st-done, var(--accent)); }
.pr-checks--failed { color: var(--st-error); }
.pr-actions { display: flex; gap: var(--sp-2); margin-top: 4px; }
.pr-actions button {
  background: none; border: 1px solid var(--border); border-radius: var(--r-sm);
  color: var(--fg-muted); padding: 2px 8px; cursor: pointer; font-size: var(--fs-xs);
}
.pr-actions button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.pr-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.pr-error { color: var(--st-error); font-size: var(--fs-sm); margin: 0 0 var(--sp-2); }
.pr-empty, .pr-capped, .pr-unavailable { color: var(--fg-muted); font-size: var(--fs-sm); }
.pr-unavailable { display: flex; flex-direction: column; gap: var(--sp-2); align-items: flex-start; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pr-view.test.ts && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Commit**

```bash
git add src/pr-view.ts tests/pr-view.test.ts src/styles.css
git commit -m "feat(pr): the pull request view"
```

---

### Task 11: Wiring — polling, actions and the worktree session

**Issue:** #110

**Files:**
- Modify: `src/main.ts`
- Modify: `src/sessions.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `Deck.launchOnWorktree(cwd, workspaceId, titleText, prompt)`

- [ ] **Step 1: Add the launch path to the Deck**

`spawnTile` is private; the view needs a session in a directory that is not the workspace's. Add beside `launchFromTask` in `src/sessions.ts`:

```ts
  /** A session for a pull request, in the worktree prepared for it.
   *
   *  `cwd` is deliberately not the workspace path: the worktree keeps the
   *  branch out of the workspace's own working copy, where other sessions are
   *  running. `workspaceId` still points at the workspace, so the tile groups,
   *  filters and inherits its account exactly like any other. */
  async launchOnWorktree(
    cwd: string, workspaceId: string, titleText: string, prompt: string,
  ): Promise<void> {
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd,
      workspaceId,
      titleText,
      prompt,
      resume: false,
    });
  }

  /** Whether any live tile is running inside `path`. Removal of a worktree
   *  asks first: a session whose directory disappears comes back on the next
   *  restore pointing at nothing. */
  hasSessionIn(path: string): boolean {
    return [...this.tiles.values()].some((t) => t.workspacePath === path);
  }
```

- [ ] **Step 2: Write the failing test**

Add to `tests/sessions-util.test.ts`:

```ts
  it("reports a live session inside a worktree path", async () => {
    const { Deck } = await import("../src/sessions");
    const deck = new Deck(document.createElement("div"), document.createElement("div"), () => []);
    expect(deck.hasSessionIn("/tmp/x-pr/7-branch")).toBe(false);
  });
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/sessions-util.test.ts`
Expected: PASS

- [ ] **Step 4: Wire the view into `main.ts`**

Add the third button beside the existing two:

```ts
const prBtn = document.createElement("button");
prBtn.textContent = "Pull requests";
views.append(termBtn, boardBtn, prBtn);
```

Create the container beside `boardEl`, and the view:

```ts
const prEl = document.createElement("div");
prEl.id = "pr";
prEl.className = "hidden";
boardEl.after(prEl);

const prView = new PrView({
  onLaunch: (pr) => void launchFromPr(pr),
  onMerge: (pr) => void mergePr(pr),
  onClose: (pr) => void closePr(pr),
  onReopen: (pr) => void reopenPr(pr),
  onRefresh: () => void refreshPrs(),
  onFixUnavailable: (u) => {
    if (u === "no-gh") void openGithubScreen(deck, workspaces.active?.path ?? ".");
    else void alertModal("Bind a GitHub account in the workspace settings (✎).");
  },
});
prEl.append(prView.mount);
```

Replace the `setView` boolean with the view name, keeping the board's timer as it is and adding the PR one:

```ts
let currentView: ViewName = "deck";
let prTimer: ReturnType<typeof setTimeout> | null = null;
let prState: PrState = {
  workspace: null, unavailable: null, prs: [], error: null, fetchedAt: null, total: null,
};

function setView(view: ViewName) {
  currentView = view;
  boardVisible = view === "board";
  applyView({ deck: deckEl, board: boardEl, pr: prEl, termBtn, boardBtn, prBtn,
              terminalsOnly: [skMount, newBtn, listMount] }, view);
  if (view === "board") {
    void refreshBoard();
    if (boardTimer === null) {
      boardTimer = setInterval(() => { void refreshBoard(); void refreshCounts(); }, 5000);
    }
  } else if (boardTimer !== null) {
    clearInterval(boardTimer); boardTimer = null;
  }
  if (view === "pr") void refreshPrs();
  else stopPrPolling();
}
termBtn.onclick = () => setView("deck");
boardBtn.onclick = () => setView("board");
prBtn.onclick = () => setView("pr");
```

Add the refresh cycle. The single-timer-chain shape matters: a new tick is scheduled only after the previous request has returned, so a slow network cannot queue up `gh` processes.

```ts
function stopPrPolling() {
  if (prTimer !== null) { clearTimeout(prTimer); prTimer = null; }
}

/** Poll only while the PR view is on screen and the window is focused. */
function schedulePrPoll() {
  stopPrPolling();
  if (currentView !== "pr" || !document.hasFocus()) return;
  prTimer = setTimeout(() => void refreshPrs(), pollIntervalMs(prState.prs));
}

async function refreshPrs() {
  const ws = workspaces.active;
  if (!ws) {
    prState = { ...prState, unavailable: "no-account", prs: [] };
    prView.render(prState, Date.now());
    return;
  }
  if (!ws.github) {
    prState = { ...prState, workspace: ws.name, unavailable: "no-account", prs: [] };
    prView.render(prState, Date.now());
    return;
  }
  try {
    const prs = await prList(ws.id);
    prState = {
      workspace: ws.name, unavailable: null, prs,
      error: null, fetchedAt: Date.now(), total: prs.length,
    };
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    // Known unavailabilities become their own screen; everything else keeps
    // the last good list on screen beside the error.
    if (msg.includes("gh-not-found")) prState = { ...prState, unavailable: "no-gh" };
    else if (msg.includes("no-account")) prState = { ...prState, unavailable: "no-account" };
    else if (msg.includes("no git remotes") || msg.includes("not a git repository")) {
      prState = { ...prState, unavailable: "no-repo" };
    } else {
      prState = { ...prState, error: msg };
    }
  }
  prView.render(prState, Date.now());
  schedulePrPoll();
}

// Focus is the other half of "only while watched": a minimised window polls
// nothing, and coming back refreshes at once rather than at the next tick.
window.addEventListener("focus", () => { if (currentView === "pr") void refreshPrs(); });
window.addEventListener("blur", () => stopPrPolling());
```

The actions:

```ts
async function launchFromPr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  try {
    const cwd = await prWorktreeAdd(ws.id, pr.number, pr.headRefName);
    await deck.launchOnWorktree(
      cwd, ws.id, `⑂ #${pr.number}`,
      `You are working on pull request #${pr.number}: ${pr.title}\n`
      + `Branch ${pr.headRefName} → ${pr.baseRefName}, checked out in ${cwd}.`,
    );
    setView("deck");
  } catch (e) {
    await alertModal(`Could not prepare a worktree for #${pr.number}: ${String(e)}`);
  }
}

async function mergePr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  const opts = await prMergeOptions(ws.id).catch(() => null);
  if (!opts || opts.strategies.length === 0) {
    await alertModal("Could not read which merge strategies this repository allows.");
    return;
  }
  const choice = await mergeForm(pr, opts);
  if (!choice) return;
  try {
    await prMerge(ws.id, pr.number, choice.strategy, pr.headRefOid, choice.deleteBranch);
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    // gh refuses when the head has moved — which is the guarantee working, not
    // a failure to apologise for.
    await alertModal(
      msg.includes("match-head-commit") || msg.includes("head commit")
        ? `#${pr.number} changed since you looked at it. Refresh and read it again.`
        : `Could not merge #${pr.number}: ${msg}`,
    );
  }
  await refreshPrs();
}

async function closePr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  if (!(await confirmModal(`Close #${pr.number} “${pr.title}” without merging?`))) return;
  await prClose(ws.id, pr.number).catch((e) => void alertModal(String(e)));
  await refreshPrs();
}

// Reopen restores the state of a moment ago, so it does not ask.
async function reopenPr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  await prReopen(ws.id, pr.number).catch((e) => void alertModal(String(e)));
  await refreshPrs();
}
```

Add the palette entry and the command, beside the board ones:

```ts
    { id: "prs", title: "Open pull requests", run: () => setView("pr") },
```

```ts
  "prs": () => setView("pr"),
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all green

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/sessions.ts tests/sessions-util.test.ts
git commit -m "feat(pr): wire the view, its polling and its actions"
```

---

### Task 12: The merge dialog

**Issue:** #111

Split from Task 11 because it is the one irreversible action in the feature and deserves its own review.

**Files:**
- Modify: `src/forms.ts`
- Modify: `tests/forms.test.ts`

**Interfaces:**
- Consumes: `MergeOptions`, `PullRequest` (Task 7)
- Produces: `mergeForm(pr, opts) -> Promise<{ strategy: string; deleteBranch: boolean } | null>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/forms.test.ts`:

```ts
describe("mergeForm", () => {
  const pr = {
    number: 7, title: "fix the thing", headRefName: "fix/thing",
    baseRefName: "main", headRefOid: "abc1234def",
  } as never;

  it("offers only the strategies the repository allows", () => {
    void mergeForm(pr, {
      strategies: ["squash", "rebase"], default: "squash", repoDeletesBranch: false,
    });
    const values = [...document.querySelectorAll<HTMLInputElement>(".mg-strategy")]
      .map((i) => i.value);
    expect(values).toEqual(["squash", "rebase"]);
  });

  // What is being merged has to be identifiable from the dialog alone.
  it("shows the branch pair and the pinned commit", () => {
    void mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: false });
    const text = document.querySelector(".modal-box")!.textContent!;
    expect(text).toContain("fix/thing → main");
    expect(text).toContain("abc1234");
  });

  it("states the repository's behaviour instead of offering a box that lies", () => {
    void mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: true });
    expect(document.querySelector(".mg-delete")).toBeNull();
    expect(document.querySelector(".mg-delete-note")!.textContent).toContain("deletes");
  });

  it("resolves the chosen strategy on OK", async () => {
    const p = mergeForm(pr, {
      strategies: ["merge", "squash"], default: "merge", repoDeletesBranch: false,
    });
    document.querySelectorAll<HTMLInputElement>(".mg-strategy")[1].checked = true;
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toEqual({ strategy: "squash", deleteBranch: false });
  });

  it("resolves null on cancel", async () => {
    const p = mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: false });
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/forms.test.ts`
Expected: FAIL — `mergeForm is not exported`

- [ ] **Step 3: Write minimal implementation**

Add to `src/forms.ts`:

```ts
/** Confirmation for the one irreversible action in the feature.
 *
 *  Shows what is being merged, into what, and at which commit — the same commit
 *  the caller pins with `--match-head-commit`, so the dialog and the merge can
 *  never disagree. */
export function mergeForm(
  pr: { number: number; title: string; headRefName: string; baseRefName: string; headRefOid: string },
  opts: MergeOptions,
): Promise<{ strategy: string; deleteBranch: boolean } | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    box.classList.add("modal-box--form");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = `Merge #${pr.number}`;

    const what = document.createElement("p");
    what.className = "form-hint";
    what.textContent =
      `${pr.title}\n${pr.headRefName} → ${pr.baseRefName}, at ${pr.headRefOid.slice(0, 7)}`;

    const strategyRow = document.createElement("div");
    strategyRow.className = "form-row";
    const radios: HTMLInputElement[] = [];
    for (const s of opts.strategies) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio"; input.name = "mergeStrategy";
      input.className = "mg-strategy"; input.value = s;
      input.checked = s === opts.default;
      label.append(input, document.createTextNode(` ${s}`));
      strategyRow.append(label);
      radios.push(input);
    }

    const deleteBox = document.createElement("input");
    deleteBox.type = "checkbox";
    deleteBox.className = "mg-delete";
    const deleteRow = opts.repoDeletesBranch
      ? (() => {
          const p = document.createElement("p");
          p.className = "form-hint mg-delete-note";
          p.textContent = "This repository deletes merged branches itself.";
          return p;
        })()
      : labeledCheck("Delete the branch after merging", deleteBox);

    const { row, ok, cancel } = actions();
    box.append(title, what, strategyRow, deleteRow, row);

    const close = (v: { strategy: string; deleteBranch: boolean } | null) => {
      closeDialog(); resolve(v);
    };
    const submit = () => {
      const picked = radios.find((r) => r.checked)?.value ?? opts.default;
      close({
        strategy: picked,
        deleteBranch: opts.repoDeletesBranch ? false : deleteBox.checked,
      });
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
  });
}
```

Add `MergeOptions` to the type import from `./ipc` at the top of `src/forms.ts`, and `mergeForm` to the imports in `src/main.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/forms.test.ts && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Commit**

```bash
git add src/forms.ts tests/forms.test.ts src/main.ts
git commit -m "feat(pr): the merge confirmation"
```

---

### Task 13: Worktree cleanup, documentation and the manual check

**Issue:** #112

**Files:**
- Modify: `src/main.ts`
- Modify: `README.md`

- [ ] **Step 1: Offer to remove a worktree once the pull request is done**

A merged or closed pull request leaves its worktree behind. Offer removal; never take it. In `src/main.ts`, after a successful merge or close in `mergePr` and `closePr`, before `await refreshPrs()`:

```ts
  await offerWorktreeCleanup(pr);
```

```ts
/** A merged or closed pull request leaves a worktree behind.
 *
 *  Three guards, because the directory may hold work nobody else has: a live
 *  session in it stops the offer outright, the backend refuses while it is
 *  dirty, and the person still has to say yes. */
async function offerWorktreeCleanup(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  const path = await prWorktreePath(ws.id, pr.number, pr.headRefName).catch(() => null);
  if (!path) return;
  if (deck.hasSessionIn(path)) return;
  if (!(await confirmModal(`Remove the worktree at ${path}?`))) return;
  await prWorktreeRemove(ws.id, pr.number, pr.headRefName)
    .catch((e) => void alertModal(String(e)));
}
```

This needs one more read-only command. Add to `src-tauri/src/commands.rs`, register it in `main.rs`, and wrap it in `ipc.ts` as `prWorktreePath`:

```rust
/// Where this pull request's worktree would live, and whether it is there.
/// Read-only: the cleanup offer needs the path before it can name it.
#[tauri::command]
pub fn pr_worktree_path(
    state: State<AppState>, workspace_id: String, number: u64, branch: String,
) -> Result<Option<String>, String> {
    let ws_path = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces().into_iter().find(|w| w.id == workspace_id).map(|w| w.path)
    }
    .ok_or_else(|| "no such workspace".to_string())?;
    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    Ok(path.exists().then(|| path.to_string_lossy().to_string()))
}
```

```ts
export const prWorktreePath = (workspaceId: string, number: number, branch: string) =>
  invoke<string | null>("pr_worktree_path", { workspaceId, number, branch });
```

- [ ] **Step 2: Document the view**

Add to `README.md`, after the GitHub accounts section:

```markdown
## Pull requests

The third view lists the open pull requests of the workspace's repository, read
under the workspace's own GitHub account. It needs `gh` on the PATH, an account
bound to the workspace, and a GitHub remote; each missing piece says so and
points at the fix.

Each row shows the checks, the review verdict and how long ago it moved. Four
check states are distinguished, and "no checks" is not shown as success.

**▶ opens a session on the pull request's branch in a worktree of its own**, at
`<parent>/<workspace>-pr/<number>-<branch>` — beside the workspace, never inside
it, so the workspace's own working copy and the sessions running in it are
untouched. When the pull request is merged or closed, the app offers to remove
that worktree; it never removes one that is dirty or that has a session in it.

**Merge is pinned to the commit that was on screen.** If the branch moved
between the last refresh and the click, the merge is refused and you are asked
to look again.

The list refreshes itself only while this view is open and the window is
focused — faster while a job is running, slower once everything has settled.
The age of the data is always on screen.

Note on tokens: to avoid asking `gh` for a token on every poll — a locked
keyring can make that slow — account tokens are held in memory while the app
runs, keyed by host and login, and dropped whenever a workspace's binding
changes. They are never written to disk or into a log.
```

- [ ] **Step 3: The manual check**

None of this is covered by automated tests. Run it and record the result in the pull request description:

1. A workspace with a bound account and a GitHub remote — the view lists its open pull requests.
2. Compare the count and the check badges against the same repository in a browser.
3. A repository with a pull request whose CI is running — the badge updates on its own; switching to the deck stops it (watch the network, or add a temporary log).
4. ▶ on a pull request — a worktree appears at the documented path, the session starts in it, and `git branch --show-current` in that session names the pull request's branch.
5. `git status` in the workspace itself — untouched.
6. Merge a test pull request; push a new commit to it first from elsewhere and confirm the refusal message names the change.
7. Close and reopen a test pull request.
8. Remove the worktree with a dirty file in it — refused, with the path named. Clean it, remove again — gone.
9. A workspace with no bound account, and one that is not a repository — each shows its own screen with its own next step.
10. **A pull request from a fork** (`isCrossRepository: true`) — verify the worktree resolves. This is the known gap from the spec.
11. **"Open in browser"** — confirm it reaches the system browser rather than navigating the app's own webview. The same `<a target="_blank">` is already used on the GitHub screen and has never been verified either; if it turns out not to work, that is one shared fix, not a PR-view fix.

- [ ] **Step 4: Verify everything**

Run: `npx tsc --noEmit && npx vitest run && (cd src-tauri && cargo test)`
Expected: clean; vitest and cargo both fully green

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/ipc.ts src-tauri/src/commands.rs src-tauri/src/main.rs README.md
git commit -m "feat(pr): worktree cleanup, and document the view"
```

---

## Self-review

**Spec coverage.** Each numbered scope item maps to a task: the third view → 9, 11; per-PR state → 1, 2, 10; ▶ in a worktree → 6, 11; merge → 5, 12; close and reopen → 5, 11; open in browser → 10; polling and data age → 8, 10, 11. Each of the ten key decisions is implemented: module not port (1–6), account binding gates the view (11), unmet conditions explain themselves (10, 11), worktree not checkout (6), outside the workspace (3, with the test), never auto-removed (6, 13), asymmetric confirmation (11), pinned merge (5, 12), allowed strategies only (3, 12), data-paced polling (8, 11). Every row of the errors table has a handler in Task 11 or a state in Task 10.

**Two gaps found and closed while reviewing:** the token cache had no invalidation — added as Task 4 Step 5, since a re-bound workspace would otherwise keep talking as the old account; and the cleanup offer needed the worktree's path, which no command returned — added as `pr_worktree_path` in Task 13.

**One deviation from an earlier document,** flagged rather than buried: the account spec states the app holds no tokens. Polling makes per-call resolution impractical, so Task 4 introduces an in-memory cache. It is documented in the README and cleared on any binding change.
