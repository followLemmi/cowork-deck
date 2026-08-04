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
    if flag("mergeCommitAllowed") {
        strategies.push("merge".to_string());
    }
    if flag("squashMergeAllowed") {
        strategies.push("squash".to_string());
    }
    if flag("rebaseMergeAllowed") {
        strategies.push("rebase".to_string());
    }

    let preferred = v
        .get("viewerDefaultMergeMethod")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Preselecting a strategy the repository forbids would arm a button that
    // can only fail.
    let default = if strategies.contains(&preferred) {
        preferred
    } else {
        strategies.first().cloned().unwrap_or_default()
    };

    Ok(MergeOptions { strategies, default, repo_deletes_branch: flag("deleteBranchOnMerge") })
}

/// What a pull request holds, fetched only when a row is opened.
///
/// **Deliberately not part of `PR_LIST_FIELDS`.** A description runs to
/// kilobytes and `files` is one entry per changed path, so folding either into
/// the list call would multiply the payload of a fifty-row page — on a poll that
/// repeats every 15 s while anything is building — to serve a row nobody has
/// opened. One row expanded is one extra request; that is the trade, and it is
/// the same one `ISSUE_LIST_FIELDS` made in the other direction for `body`,
/// where a card's body was measured at 85 KB for fifty issues and the modal
/// would otherwise need a loading state of its own.
pub const PR_DETAIL_FIELDS: &str = "body,additions,deletions,changedFiles,files";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    /// The description as written, Markdown and all. Empty for a pull request
    /// opened without one, which is not an error and reads as "no description".
    pub body: String,
    pub additions: u64,
    pub deletions: u64,
    /// GitHub's own count, kept beside `files` rather than derived from its
    /// length: `files` is itself a page, and a length would quietly disagree with
    /// the repository on a pull request touching hundreds of paths.
    pub changed_files: u64,
    pub files: Vec<ChangedFile>,
}

/// Read `gh pr view <n> --json <PR_DETAIL_FIELDS>`.
///
/// Hand-rolled for the same reason `parse_pull_requests` is: every field here is
/// absent rather than null on some rows — `files` on a pull request with no diff
/// GitHub will admit to, `body` on one opened from a template that was cleared —
/// and a derive would fail the whole request on any of them. An absent field is
/// its empty value, never a refusal: the expanded row's job is to show what is
/// there.
pub fn parse_pr_detail(json: &str) -> Result<PrDetail, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    if !v.is_object() {
        return Err("gh did not return one pull request".to_string());
    }
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Ok(PrDetail {
        body: v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        additions: n("additions"),
        deletions: n("deletions"),
        changed_files: n("changedFiles"),
        files: v
            .get("files")
            .and_then(|x| x.as_array())
            .map(|fs| {
                fs.iter()
                    // A row with no `path` is dropped rather than shown as a
                    // blank line: it names no file, so there is nothing to say
                    // about it. Its numbers stay counted in `changedFiles`,
                    // which comes from GitHub and not from this list.
                    .filter_map(|f| {
                        let path = f.get("path").and_then(|x| x.as_str())?;
                        Some(ChangedFile {
                            path: path.to_string(),
                            additions: f
                                .get("additions")
                                .and_then(|x| x.as_u64())
                                .unwrap_or(0),
                            deletions: f
                                .get("deletions")
                                .and_then(|x| x.as_u64())
                                .unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// How many patch lines of one file may cross IPC.
///
/// Ours, not GitHub's. On this repository's PR #151 it bites exactly one file of
/// 62 — a 2506-line plan — while six are over 1000 and eleven over 500, so it is
/// sensitive enough to matter and rare enough not to nag. No lockfile or
/// generated-code heuristic beside it: the line count catches those anyway, and
/// a `*.lock` rule would immediately have lied about the Markdown plan that
/// tripped it here.
pub const PR_DIFF_LINE_CAP: usize = 2000;

/// Why a file arrived with no lines to show.
///
/// `None` beside an empty `hunks` is the third state and is not a failure:
/// nothing changed — a rename, a mode change — so there is nothing to draw. The
/// three earn different sentences and different escape hatches, which is the
/// whole reason this is a type rather than a flag; collapsing them into "no
/// diff" is exactly what reading an absent `patch` as an empty one would do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Omission {
    /// GitHub sent no usable `patch` for a file it says really changed —
    /// measured on #151, where `docs/superpowers/plans/2026-07-30-github-issues-board.md`
    /// (5290 changes) comes back with the key missing outright. The bytes never
    /// arrived, so an in-app "show anyway" could only fail; `blob_url` is the
    /// only honest way through.
    TooLargeUpstream,
    /// **GitHub sent no patch *and* no line counts, so we do not know what this
    /// file holds.** Not the same as "nothing changed", and the difference is not
    /// theoretical: on #151 `tests/tasks.test.ts` arrives in the 62-file response
    /// as `additions: 0, deletions: 0, changes: 0` with no `patch`, and the same
    /// file requested on a three-file page comes back with **163 additions, 3
    /// deletions and a patch**. The whole response had hit a budget and the counts
    /// were zeroed with the text.
    ///
    /// Three causes produce this identical shape and one response cannot tell them
    /// apart — a binary file, a mode-only change, and the truncation above. So the
    /// honest report is that the diff was not sent, with an offer to ask again:
    /// **a narrower page resolves it definitively**, which is what separates this
    /// from `TooLargeUpstream`, where re-fetching alone still yields nothing
    /// (measured on the same pull request's 5290-change file).
    ///
    /// Reading this as "nothing changed" is the failure the absent-`patch`
    /// discipline was written to prevent, arriving on a second axis: not the patch
    /// missing, but the counts lying about why.
    Unreported,
    /// Over `PR_DIFF_LINE_CAP`. The bytes did arrive and were dropped here, so
    /// unlike the two cases above the count is exact and the refusal is ours to
    /// reverse. Note what that costs, because the design document is ambiguous
    /// on it: the text is not in the payload, so "show anyway" is a second fetch
    /// and not a re-render — the same narrower-page fetch `Unreported` needs, which
    /// is an argument for building one mechanism rather than two.
    TooLargeLocal { lines: u64 },
}

/// One hunk of one file's patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The `@@` line verbatim. Kept because its trailing section context —
    /// `@@ -89,6 +91,9 @@ fn main() {` — is written by git and by nothing else,
    /// and 180 of #151's 217 hunks carry one. It is material for the heading the
    /// view composes ("Hunk 2 of 5, lines 91 to 99"), not a line to print: read
    /// aloud, the raw form is noise.
    pub header: String,
    pub old_start: u64,
    pub new_start: u64,
    /// Patch lines as written, leading `+`, `-`, ` ` or `\` kept.
    ///
    /// **Not one object per line.** `{kind, oldNo, newNo, text}` roughly doubles
    /// the payload against the text it describes and #151 carries 19,854 of
    /// them; the marker is one character the view slices into its own column,
    /// and the running numbers are a fold the view performs once per drawn row
    /// regardless. `\ No newline at end of file` stays for the same reason the
    /// marker does — drop it and a copied selection stops being a patch.
    pub lines: Vec<String>,
}

/// One changed file, as far as GitHub will describe it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    /// Set only on a rename or a copy, where the row names two paths.
    pub previous_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    /// The permalink to the file at this head. The escape hatch for every case
    /// the drawer cannot draw, so it is carried even when `hunks` is full.
    pub blob_url: String,
    pub hunks: Vec<Hunk>,
    pub omitted: Option<Omission>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDiff {
    pub files: Vec<DiffFile>,
    /// How many files the pull request touches, kept beside `files` rather than
    /// derived from its length — for the same reason `changed_files` is on
    /// `PrDetail`: `files` is a capped page, and a length would quietly disagree
    /// with the repository. What fills it is `commands::pr_diff`'s job; a single
    /// response only knows its own rows.
    pub total_files: u64,
}

/// `@@ -12,7 +14,9 @@ optional section context` → the two starting line numbers.
///
/// The counts are deliberately dropped: `lines` is the truth about how many rows
/// there are, and a stored count that disagrees with its own body is a count
/// that lies. The single-number form `@@ -1 +1 @@` is real — git writes it
/// whenever a range covers exactly one line — and #151 contains none of it, so
/// it is covered by a written test rather than by the fixture.
fn hunk_starts(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    // First occurrence each time: the ranges are digits and commas, so the
    // section context that may follow the closing `@@` cannot be mistaken for
    // either separator.
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let start = |r: &str| r.split(',').next()?.parse::<u64>().ok();
    Some((start(old)?, start(new)?))
}

/// Split one file's `patch` into hunks.
pub fn split_hunks(patch: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    // `split('\n')` and not `lines()`, which strips a trailing `\r`. A file with
    // CRLF endings would then reach the view as `+` lines whose content differs
    // from the file they came from, and a copied selection would stop
    // reassembling into a patch — the one thing keeping the lines raw was for.
    // None of #151's 19,854 patch lines carries a CR, so this is a guard against
    // a repository we have not seen rather than a fix for one we have. The
    // trailing newline comes off first for the same reason in reverse: 59 of 59
    // patches end without one, and a `split` on a patch that did end with one
    // would invent a blank final line.
    for line in patch.strip_suffix('\n').unwrap_or(patch).split('\n') {
        match hunk_starts(line) {
            Some((old_start, new_start)) => hunks.push(Hunk {
                header: line.to_string(),
                old_start,
                new_start,
                lines: Vec::new(),
            }),
            // Anything ahead of the first `@@` belongs to no hunk. GitHub's
            // `patch` begins at one, so reaching here is the shape changing
            // under us rather than a case to draw: dropped, not guessed at.
            None => {
                if let Some(h) = hunks.last_mut() {
                    h.lines.push(line.to_string());
                }
            }
        }
    }
    hunks
}

/// Whether a file is too big to hand over, and how big it is.
///
/// Counts hunk bodies, not `@@` headers: a header becomes one heading in the
/// view, not a row of code. Separate from `parse_pr_files` so the threshold can
/// be exercised at a cap small enough to write a fixture around.
pub fn cap_file(file: &DiffFile, cap: usize) -> Option<Omission> {
    let lines: usize = file.hunks.iter().map(|h| h.lines.len()).sum();
    (lines > cap).then_some(Omission::TooLargeLocal { lines: lines as u64 })
}

/// One row of the files endpoint. `None` for a row naming no file: it says
/// nothing about any file, so there is nothing to draw a header for — the rule
/// `parse_pr_detail` already applies to `files`.
fn parse_diff_file(row: &serde_json::Value) -> Option<DiffFile> {
    let path = row.get("filename").and_then(|x| x.as_str())?;
    let s = |k: &str| row.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let n = |k: &str| row.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    // An empty `patch` string is treated as no patch at all. It is the same
    // fact — no bytes — spelled differently, and letting it through would put a
    // file with 5000 changes and nothing to show it with into the "nothing
    // changed" state.
    let patch = row.get("patch").and_then(|x| x.as_str()).filter(|p| !p.is_empty());
    let (additions, deletions) = (n("additions"), n("deletions"));

    let mut file = DiffFile {
        path: path.to_string(),
        previous_path: row.get("previous_filename").and_then(|x| x.as_str()).map(str::to_string),
        status: s("status"),
        additions,
        deletions,
        blob_url: s("blob_url"),
        hunks: patch.map(split_hunks).unwrap_or_default(),
        omitted: None,
    };
    // Decided on what we ended up holding rather than on the key's presence, so a
    // patch we could not split lands here too.
    //
    // The counts are the discriminator, and which way they point is measured rather
    // than assumed. Counts **kept** with no patch is a real refusal: #151's
    // 5290-change plan has no patch even when fetched on a page of one. Counts
    // **zeroed** with no patch is not a refusal at all, it is silence — the same
    // pull request's `tests/tasks.test.ts` reads 0/0/0 in the 62-file response and
    // 163/3 with a patch on a three-file page.
    //
    // A rename is the one zeroed case that explains itself: the row names two paths,
    // which is the whole of what happened to the file, so there is nothing withheld.
    let renamed = file.previous_path.is_some();
    file.omitted = if !file.hunks.is_empty() {
        cap_file(&file, PR_DIFF_LINE_CAP)
    } else if additions + deletions > 0 {
        Some(Omission::TooLargeUpstream)
    } else if renamed {
        None
    } else {
        Some(Omission::Unreported)
    };
    if file.omitted.is_some() {
        // Dropped *here*, before serialisation — the whole reason this parse
        // lives in Rust. #151's 97 KB worst case leaves as a couple of hundred
        // bytes, and ten generated files on a pathological pull request stay a
        // small payload instead of 10 MB the view would refuse to draw.
        file.hunks = Vec::new();
    }
    Some(file)
}

/// Read one page of `gh api repos/{owner}/{repo}/pulls/{n}/files`.
///
/// **An absent `patch` is not an empty diff.** This is the one place where
/// `parse_pr_detail`'s house rule — an absent field is its empty value — is the
/// wrong reflex. GitHub drops the key when the file is too big for it, and
/// reading that as "no changes" would tell a reader that a 5290-line addition is
/// unchanged; measured on #151, where exactly that happens. So the missing key
/// is read against `additions + deletions`, which arrives either way: changes
/// with no lines is an upstream omission, no changes with no lines is a file
/// where nothing happened, and the two get different sentences.
///
/// `total_files` here is this page's own row count, dropped rows included, on
/// the same principle as `changed_files`. Only the caller knows how many pages
/// there were.
pub fn parse_pr_files(json: &str) -> Result<PrDiff, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    Ok(PrDiff {
        total_files: rows.len() as u64,
        files: rows.iter().filter_map(parse_diff_file).collect(),
    })
}

/// Read the `changedFiles` count from the GraphQL query
/// `commands::pr_changed_files_argv` sends.
pub fn parse_pr_changed_files(json: &str) -> Result<u64, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh returned unreadable JSON: {e}"))?;
    v.get("data")
        .and_then(|d| d.get("repository"))
        .and_then(|r| r.get("pullRequest"))
        .and_then(|p| p.get("changedFiles"))
        .and_then(|x| x.as_u64())
        .ok_or_else(|| "the count response named no pull request".to_string())
}

pub use cowork_deck::tasks::slug::slug;

/// Where the worktree for a pull request lives: beside the workspace, never
/// inside it.
///
/// Nesting is not a matter of taste. BUG-026 is the record of what it costs:
/// `npm test` from the repository root globbed suites out of nested worktrees
/// and ran 880 tests instead of 183. A nested worktree would equally show up in
/// `git status` and under the task watcher.
pub fn worktree_path(workspace_path: &str, number: u64, branch: &str) -> std::path::PathBuf {
    let ws = std::path::Path::new(workspace_path);
    let name = ws
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());
    let parent = ws.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join(format!("{name}-pr")).join(format!("{number}-{}", slug(branch)))
}

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

    /// The shape `gh pr view --json body,additions,deletions,changedFiles,files`
    /// really returns: one object, `files` an array of three-key rows.
    #[test]
    fn a_detail_row_becomes_a_description_and_a_diffstat() {
        let json = r#"{"body":"Fixes #1.","additions":12,"deletions":3,"changedFiles":2,
            "files":[{"path":"src/board.ts","additions":10,"deletions":3},
                     {"path":"src/styles.css","additions":2,"deletions":0}]}"#;
        let d = parse_pr_detail(json).unwrap();
        assert_eq!(d.body, "Fixes #1.");
        assert_eq!((d.additions, d.deletions, d.changed_files), (12, 3, 2));
        assert_eq!(d.files.len(), 2);
        assert_eq!(d.files[0], ChangedFile { path: "src/board.ts".into(), additions: 10, deletions: 3 });
    }

    /// A pull request opened without a description is not a failure, and neither
    /// is one whose fields `gh` omits rather than nulls. The expanded row's job is
    /// to show what is there.
    #[test]
    fn missing_detail_fields_are_their_empty_values_not_a_refusal() {
        let d = parse_pr_detail("{}").unwrap();
        assert_eq!(d.body, "");
        assert_eq!((d.additions, d.deletions, d.changed_files), (0, 0, 0));
        assert!(d.files.is_empty());
    }

    /// A file row naming no path says nothing about any file, so it is dropped
    /// rather than drawn as a blank line. `changedFiles` is GitHub's own count and
    /// is deliberately not recomputed from what survived.
    #[test]
    fn a_file_row_with_no_path_is_dropped_and_never_recounted() {
        let json = r#"{"changedFiles":2,"files":[{"additions":1,"deletions":0},
            {"path":"a.ts","additions":1,"deletions":1}]}"#;
        let d = parse_pr_detail(json).unwrap();
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.files[0].path, "a.ts");
        assert_eq!(d.changed_files, 2, "the count comes from GitHub, not from the list");
    }

    /// An array is what the *list* command returns; asking for one pull request
    /// and being handed a page is a mismatch worth naming rather than indexing
    /// into.
    #[test]
    fn a_detail_response_that_is_not_one_object_is_refused() {
        assert!(parse_pr_detail("[]").is_err());
        assert!(parse_pr_detail("not json").is_err());
    }

    /// Six rows lifted verbatim out of the 62 that
    /// `gh api repos/followLemmi/cowork-deck/pulls/151/files?per_page=100`
    /// returned on 2026-08-04, re-indented and not otherwise touched. The other
    /// 56 are ordinary and cost 950 KB.
    ///
    /// A hand-written fixture agrees with the parser's author by construction,
    /// which is the one thing this file cannot afford here: every rule below
    /// about an absent `patch` was written from what GitHub actually sends, and
    /// the six were chosen because between them they are every shape the drawer
    /// has to survive — a patch omitted upstream, a file with no changes at all,
    /// one over the local cap, one hunk per form of `@@` header, and a fresh
    /// file whose old range is `-0,0`.
    ///
    /// Run over the whole 1.06 MB response rather than this slice of it,
    /// `parse_pr_files` reports 62 files, 216 hunks and 17,131 patch lines, one
    /// `TooLargeUpstream`, one `TooLargeLocal { lines: 2506 }` and two files
    /// where nothing changed; the result serialises to 968 KB. Those totals
    /// reconcile with the design document's 19,854 patch lines exactly —
    /// 17,131 + 2506 capped + 217 headers — which is the check that the split
    /// loses nothing. The other 56 rows are not kept because they cost 950 KB
    /// and prove nothing this six does not.
    const PR151: &str = include_str!("../fixtures/pr-151-files.json");

    /// The measured shape of the real response, asserted rather than described:
    /// three of #151's 62 files have no `patch`, and two of them are two
    /// different states that must not share a sentence.
    #[test]
    fn a_real_response_yields_hunks_a_local_cap_and_two_kinds_of_nothing() {
        let d = parse_pr_files(PR151).unwrap();
        assert_eq!(d.total_files, 6);
        let f = |p: &str| d.files.iter().find(|f| f.path == p).expect(p).clone();

        // GitHub dropped the key on this one: 5290 changes, no patch, nothing
        // the app can do about it.
        let upstream = f("docs/superpowers/plans/2026-07-30-github-issues-board.md");
        assert_eq!(upstream.omitted, Some(Omission::TooLargeUpstream));
        assert_eq!((upstream.additions, upstream.deletions), (5290, 0));
        assert!(upstream.hunks.is_empty());
        assert!(upstream.blob_url.starts_with("https://github.com/"));

        // Also no patch, and **this row is lying**. It reads 0/0/0, and the same
        // file requested on a three-file page comes back with 163 additions, 3
        // deletions and a patch: the 62-file response hit a budget and the counts
        // were zeroed along with the text. An earlier version of this test asserted
        // `None` here and called it "a success — nothing changed", which would have
        // had the drawer say exactly that about 166 changes.
        let withheld = f("tests/tasks.test.ts");
        assert_eq!(withheld.omitted, Some(Omission::Unreported));
        assert_eq!((withheld.additions, withheld.deletions), (0, 0));
        assert!(withheld.hunks.is_empty());

        // 2506 lines under one `@@ -0,0 +1,2506 @@`, the only file of the 62
        // over the cap. Its 97 KB of patch text is gone before serialisation.
        let capped = f("docs/superpowers/plans/2026-07-29-github-pull-requests.md");
        assert_eq!(capped.omitted, Some(Omission::TooLargeLocal { lines: 2506 }));
        assert!(capped.hunks.is_empty(), "the text is dropped, not merely flagged");

        // And an ordinary file arrives whole.
        let ordinary = f("src-tauri/src/tasks/frontmatter.rs");
        assert_eq!(ordinary.omitted, None);
        assert_eq!(ordinary.hunks.len(), 2);
        assert_eq!(ordinary.status, "modified");
        assert_eq!(ordinary.previous_path, None);
    }

    /// The three states are three states on the wire too. A view that cannot
    /// tell them apart offers the wrong escape hatch, and offering "show anyway"
    /// for bytes that never arrived is a button that can only fail.
    #[test]
    fn the_three_kinds_of_empty_file_serialise_differently() {
        let d = parse_pr_files(PR151).unwrap();
        let json = |p: &str| {
            let f = d.files.iter().find(|f| f.path == p).expect(p);
            serde_json::to_value(&f.omitted).unwrap()
        };
        assert_eq!(
            json("docs/superpowers/plans/2026-07-30-github-issues-board.md"),
            json!({ "kind": "tooLargeUpstream" }),
        );
        assert_eq!(
            json("docs/superpowers/plans/2026-07-29-github-pull-requests.md"),
            json!({ "kind": "tooLargeLocal", "lines": 2506 }),
        );
        assert_eq!(json("tests/tasks.test.ts"), json!({ "kind": "unreported" }));

        // `null` is reserved for a file that really has nothing to show, and on
        // #151 no such file exists: every empty one here is withheld rather than
        // unchanged. The rename that does produce `null` is in `SHAPES` below,
        // because this pull request contains no renames at all.
        assert!(
            d.files.iter().filter(|f| f.hunks.is_empty()).all(|f| f.omitted.is_some()),
            "an empty file on this response is never simply 'unchanged'",
        );
    }

    /// The frontend is TypeScript and reads `previousPath`, `blobUrl`,
    /// `totalFiles`. A snake_case key here is a field the view silently never
    /// sees.
    #[test]
    fn the_wire_shape_is_camel_case_throughout() {
        let d = parse_pr_files(PR151).unwrap();
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("totalFiles").is_some());
        let file = &v["files"][0];
        for k in ["previousPath", "blobUrl", "additions", "hunks", "omitted", "status"] {
            assert!(file.get(k).is_some(), "{k} missing from the serialised file");
        }
        let hunk = &v["files"][3]["hunks"][0];
        for k in ["header", "oldStart", "newStart", "lines"] {
            assert!(hunk.get(k).is_some(), "{k} missing from the serialised hunk");
        }
    }

    /// Both `@@` forms out of the real file, and the marker characters left on
    /// the front of every line where the view's own column expects to find them.
    #[test]
    fn real_hunks_keep_their_headers_their_starts_and_their_markers() {
        let d = parse_pr_files(PR151).unwrap();
        let main = d.files.iter().find(|f| f.path == "src-tauri/src/main.rs").expect("main.rs");
        assert_eq!(main.hunks.len(), 4);
        assert_eq!(main.hunks[0].header, "@@ -2,6 +2,8 @@");
        assert_eq!((main.hunks[0].old_start, main.hunks[0].new_start), (2, 2));
        // The section context is the part nothing else preserves.
        assert_eq!(main.hunks[1].header, "@@ -89,6 +91,9 @@ fn main() {");
        assert_eq!((main.hunks[1].old_start, main.hunks[1].new_start), (89, 91));
        assert!(main.hunks.iter().flat_map(|h| &h.lines).all(|l| {
            l.starts_with(' ') || l.starts_with('+') || l.starts_with('-') || l.starts_with('\\')
        }));

        // A file added whole starts at `-0,0`, and 0 is a real answer.
        let slug = d.files.iter().find(|f| f.path == "src-tauri/src/tasks/slug.rs").expect("slug");
        assert_eq!(slug.hunks[0].header, "@@ -0,0 +1,26 @@");
        assert_eq!((slug.hunks[0].old_start, slug.hunks[0].new_start), (0, 1));
        assert_eq!(slug.hunks[0].lines.len(), 26);
        assert!(slug.hunks[0].lines.iter().all(|l| l.starts_with('+')));
    }

    /// git writes `@@ -1 +1 @@` whenever a range covers exactly one line. #151
    /// happens to contain none, so this is the one hunk shape the fixture cannot
    /// vouch for and a written case has to.
    #[test]
    fn a_single_line_range_omits_its_count_and_still_parses() {
        let h = split_hunks("@@ -1 +1 @@\n-old\n+new\n");
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].old_start, h[0].new_start), (1, 1));
        assert_eq!(h[0].lines, vec!["-old", "+new"]);
    }

    /// `\ No newline at end of file` is part of the patch. Dropping it would
    /// make a copied selection stop reassembling into one.
    #[test]
    fn the_no_newline_marker_is_a_line_like_any_other() {
        let h = split_hunks("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n");
        assert_eq!(h[0].lines, vec![" a", "-b", "\\ No newline at end of file", "+c"]);
    }

    /// A patch of a CRLF file carries the CR inside the line, and it is content:
    /// strip it and the `+` line no longer matches the file it came from, so the
    /// copied selection the marker column exists to protect stops being a valid
    /// patch. `str::lines()` would strip it silently. #151 has no CR in any of
    /// its 19,854 patch lines, so only a written case can hold this.
    #[test]
    fn a_carriage_return_is_content_and_survives_the_split() {
        let h = split_hunks("@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].header, "@@ -1,2 +1,2 @@\r");
        assert_eq!(h[0].lines, vec!["-old\r", "+new\r"]);
    }

    /// GitHub ends a `patch` without a newline — 59 of 59 in #151 — and a split
    /// on one that did would append a blank line that is in no file.
    #[test]
    fn a_trailing_newline_does_not_become_a_line() {
        assert_eq!(split_hunks("@@ -1,1 +1,1 @@\n a\n")[0].lines, vec![" a"]);
        assert_eq!(split_hunks("@@ -1,1 +1,1 @@\n a")[0].lines, vec![" a"]);
    }

    /// A `@@` inside a line of the diff itself, and a section context that
    /// contains one. Splitting on the last separator instead of the first would
    /// misread both.
    #[test]
    fn an_at_sign_pair_inside_the_content_does_not_start_a_hunk() {
        let h = split_hunks("@@ -1,2 +1,2 @@ fn f() -> @@\n+let s = \"@@ -9 +9 @@\";\n a\n");
        assert_eq!(h.len(), 1, "the content line must not open a second hunk");
        assert_eq!(h[0].header, "@@ -1,2 +1,2 @@ fn f() -> @@");
        assert_eq!((h[0].old_start, h[0].new_start), (1, 1));
        assert_eq!(h[0].lines.len(), 2);
    }

    /// Lines before the first `@@` belong to no hunk, and a patch with no `@@`
    /// at all yields nothing rather than a hunk with invented bounds.
    #[test]
    fn text_outside_any_hunk_is_dropped_rather_than_guessed_at() {
        assert!(split_hunks("").is_empty());
        assert!(split_hunks("diff --git a/x b/x\nindex 1..2 100644\n").is_empty());
        let h = split_hunks("stray\n@@ -1,1 +1,1 @@\n a\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].lines, vec![" a"]);
    }

    /// The cap counts rows of code. A `@@` header becomes one heading in the
    /// view, so counting it towards the cap would make a file of many small
    /// hunks fail earlier than a file of one big one for no reason a reader
    /// could see.
    #[test]
    fn the_cap_counts_hunk_bodies_and_not_their_headers() {
        let d = parse_pr_files(PR151).unwrap();
        let main = d.files.iter().find(|f| f.path == "src-tauri/src/main.rs").expect("main.rs");
        assert_eq!(main.hunks.len(), 4);
        let body: usize = main.hunks.iter().map(|h| h.lines.len()).sum();
        assert_eq!(body, 46, "50 patch lines less its 4 headers");
        assert_eq!(cap_file(main, body), None, "exactly at the cap is not over it");
        assert_eq!(cap_file(main, body - 1), Some(Omission::TooLargeLocal { lines: 46 }));
    }

    /// A file GitHub says changed, with no lines to show it with, is never the
    /// same answer as a file that did not change — however the emptiness is
    /// spelled. `"patch": ""` is the spelling a strict absent-key test misses.
    #[test]
    fn an_empty_patch_string_is_no_patch_and_not_an_empty_diff() {
        let json = r#"[{"filename":"a.md","status":"modified","additions":900,
            "deletions":0,"changes":900,"patch":""},
            {"filename":"b.md","status":"renamed","previous_filename":"c.md",
             "additions":0,"deletions":0,"changes":0}]"#;
        let d = parse_pr_files(json).unwrap();
        assert_eq!(d.files[0].omitted, Some(Omission::TooLargeUpstream));
        assert_eq!(d.files[1].omitted, None);
        assert_eq!(d.files[1].previous_path.as_deref(), Some("c.md"));
        assert_eq!(d.files[1].status, "renamed");
    }

    /// A row naming no file is dropped rather than drawn as a blank header, and
    /// `total_files` is deliberately not recomputed from what survived: it says
    /// how many files the pull request touches, not how many this parse could
    /// use.
    #[test]
    fn a_diff_row_with_no_filename_is_dropped_and_never_recounted() {
        let d = parse_pr_files(r#"[{"additions":1},{"filename":"a.ts","additions":1}]"#).unwrap();
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.total_files, 2);
    }

    /// The files endpoint returns an array. An object is an error body or a
    /// changed API, and indexing into it would be a guess.
    #[test]
    fn a_files_response_that_is_not_an_array_is_refused() {
        assert!(parse_pr_files(r#"{"message":"Not Found"}"#).is_err());
        assert!(parse_pr_files("not json").is_err());
        assert!(parse_pr_files("[]").unwrap().files.is_empty());
    }

    /// The count only ever runs when the page came back full, so a shape it
    /// cannot read must say so rather than answer 0 — "300 of 0" is worse than
    /// falling back to the floor the caller already has.
    #[test]
    fn the_changed_files_count_is_read_or_refused_never_zeroed() {
        let ok = r#"{"data":{"repository":{"pullRequest":{"changedFiles":912}}}}"#;
        assert_eq!(parse_pr_changed_files(ok).unwrap(), 912);
        assert!(parse_pr_changed_files(r#"{"data":{"repository":null}}"#).is_err());
        assert!(parse_pr_changed_files("{}").is_err());
    }

    /// Four rows this repository could not supply, taken from public pull requests.
    ///
    /// PR #151 has 62 files and 19,854 patch lines and contains **none** of these
    /// four shapes, so every rule about them was hand-written and agreed with its
    /// author by construction. These were found by scanning 488 real patches across
    /// `cli/cli`, `rust-lang/rust`, `microsoft/vscode` and `nodejs/node`, and trimmed
    /// to the fields this parser reads:
    ///
    /// | row | what it settles |
    /// |---|---|
    /// | `cli/cli#14034` `acceptance/README.MD` | a real rename |
    /// | `microsoft/vscode#328890` `openai.yaml` | `\ No newline at end of file` |
    /// | `rust-lang/rust#160468` `libgccjit.version` | the `@@ -1 +1 @@` header |
    /// | `rust-lang/rust#160468` `src/gcc` | a submodule bump |
    const SHAPES: &str = include_str!("../fixtures/public-shapes.json");

    /// The four shapes #151 has none of, against the parser rather than against a
    /// description of the parser.
    #[test]
    fn the_shapes_this_repository_could_not_supply() {
        let d = parse_pr_files(SHAPES).unwrap();
        let by = |p: &str| d.files.iter().find(|f| f.path.contains(p)).unwrap().clone();

        // A pure rename: GitHub sends no `patch` and `changes: 0`. That must NOT be
        // read as an upstream omission — nothing changed, so there is nothing to show,
        // and `previous_path` is what the row has to say. This is the case the design
        // document got wrong twice: first by calling #151's two `changes: 0` files
        // renames when they are `modified` with no previous name, and then by
        // promising a "previous → current" line for a state that, here, is the only
        // place a previous name actually exists.
        let r = by("README.MD");
        assert_eq!(r.status, "renamed");
        assert_eq!(r.previous_path.as_deref(), Some("acceptance/README.md"));
        assert_eq!((r.additions, r.deletions), (0, 0));
        assert!(r.hunks.is_empty());
        assert_eq!(r.omitted, None, "a rename is not an omission");

        // `\ No newline at end of file` sits *inside* the hunk, as its own line, after
        // the line it belongs to. That is the load-bearing part: `split_hunks` discards
        // anything ahead of the first header, so a marker able to sit outside one would
        // have vanished silently. Across 7985 real patches, **zero** appear before the
        // first `@@`.
        //
        // It can appear **twice** in one patch, though — 22 of those 7985 do, when
        // neither side of the file ends in a newline. An earlier version of this
        // comment claimed one was the maximum, on a sample of ten. Nothing in the
        // parser cares, since a marker is an ordinary body line either way, but the
        // claim was wrong and a wrong measurement in a comment outlives the sample it
        // came from.
        let n = by("openai.yaml");
        let last = n.hunks[0].lines.last().unwrap();
        assert_eq!(last, "\\ No newline at end of file");
        assert!(n.hunks[0].lines.len() > 1, "the marker is a line beside the code");

        // `@@ -1 +1 @@` — the count omitted when a range covers exactly one line.
        let s = by("libgccjit.version");
        assert_eq!(s.hunks[0].header, "@@ -1 +1 @@");
        assert_eq!((s.hunks[0].old_start, s.hunks[0].new_start), (1, 1));

        // A submodule bump is an ordinary hunk over one synthetic line. Recorded
        // because it looks exotic and needs nothing: no branch anywhere is about it.
        let g = by("src/gcc");
        assert_eq!(g.hunks.len(), 1);
        assert!(g.hunks[0].lines.iter().any(|l| l.starts_with("-Subproject commit ")));
        assert!(g.hunks[0].lines.iter().any(|l| l.starts_with("+Subproject commit ")));
    }

    /// The counts are the discriminator between a refusal and silence, and this is
    /// the rule stated on its own so it cannot drift.
    ///
    /// Measured on #151, both directions:
    /// - counts **kept**, no patch → the file really is too big. The 5290-change
    ///   plan has no patch even when fetched on a page of one.
    /// - counts **zeroed**, no patch → we were told nothing. `tests/tasks.test.ts`
    ///   reads 0/0/0 in the 62-file response and 163/3 with a patch on a page of
    ///   three.
    ///
    /// Only a rename earns `None`: the row names two paths, which is the whole of
    /// what happened, so nothing is being withheld.
    #[test]
    fn zeroed_counts_are_silence_and_kept_counts_are_a_refusal() {
        let row = |extra: &str| {
            let json = format!(r#"[{{"filename":"f.txt","status":"modified"{extra}}}]"#);
            parse_pr_files(&json).unwrap().files.remove(0).omitted
        };
        assert_eq!(row(r#","additions":5290,"deletions":0"#), Some(Omission::TooLargeUpstream));
        assert_eq!(row(r#","additions":0,"deletions":0"#), Some(Omission::Unreported));
        // Absent counts read as zero, so they are silence too — the safe direction.
        assert_eq!(row(""), Some(Omission::Unreported));

        let renamed = parse_pr_files(
            r#"[{"filename":"b.txt","previous_filename":"a.txt","status":"renamed",
                 "additions":0,"deletions":0}]"#,
        )
        .unwrap();
        assert_eq!(renamed.files[0].omitted, None, "a rename explains its own emptiness");

        // A binary add and a mode-only change are indistinguishable from a truncated
        // row on one response — all three are 0/0/0 with no patch — so they land on
        // `Unreported` together. That is the honest answer: a narrower fetch is what
        // tells them apart, and the view offers it rather than guessing.
        assert_eq!(
            parse_pr_files(r#"[{"filename":"i.png","status":"added","additions":0,"deletions":0}]"#)
                .unwrap().files[0].omitted,
            Some(Omission::Unreported),
        );
    }

    /// The two constants must not converge. `body` and `files` in the list call
    /// would put a description and a per-path diffstat on a fifty-row page that
    /// re-polls every 15 s — the payload `PR_DETAIL_FIELDS` exists to keep out of
    /// it.
    #[test]
    fn the_list_call_asks_for_neither_the_body_nor_the_files() {
        for f in ["body", "files", "additions", "deletions", "changedFiles"] {
            assert!(
                !PR_LIST_FIELDS.split(',').any(|x| x.trim() == f),
                "{f} must stay out of PR_LIST_FIELDS",
            );
            assert!(
                PR_DETAIL_FIELDS.split(',').any(|x| x.trim() == f),
                "{f} missing from PR_DETAIL_FIELDS",
            );
        }
    }
}

