//! The GitHub issues provider: pure parsers over `gh issue list --json`, argv
//! builders, and a `TaskProvider` over an injected runner. Follows `gh_pr.rs`:
//! nothing here runs a process, so every rule has a test with no network.
use crate::tasks::board::{KindId, StepId};
use crate::tasks::model::{Task, TaskDraft, TaskError, TaskOrigin};
use crate::tasks::provider::{ProviderCapabilities, TaskPatch, TaskProvider};

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
    // Spec decision 4's direction: `"open"` for a literal `"OPEN"`, everything
    // else `"closed"`. The two agree on the only values `gh issue list` emits;
    // they differ on an absent or differently-cased `state`, and defaulting to
    // *open* there is the worse half — it yields an open card carrying a
    // non-null `resolved`, so ✓ gets offered on an issue already closed.
    let open = r.get("state").and_then(|v| v.as_str()) == Some("OPEN");
    Task {
        id: r.get("number").and_then(|v| v.as_u64()).unwrap_or(0).to_string(),
        title: s("title"),
        // Nothing on an issue maps to a kind. `kindLabel` returns "" for
        // an empty id and `board.ts:264` then omits the chip.
        kind: KindId(String::new()),
        status: StepId(if open { "open" } else { "closed" }.to_string()),
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

/// The `'a` is what lets Task 10 hand it a runner that borrows the app state;
/// nothing else in this task needs it.
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
        // The payload is the offending id, exactly as `fs.rs:238` passes it —
        // `Display` wraps it in a sentence, so a sentence here renders inside
        // another one. Why no kind is settable at all is in `a_kind_patch_is_
        // refused`'s doc comment.
        if let Some(k) = &patch.kind {
            return Err(TaskError::UnknownKind(k.0.clone()));
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

    /// `state` absent entirely — the case `missing_optional_keys_do_not_panic`
    /// does *not* cover, because it keeps `"state":"OPEN"`.
    ///
    /// Spec decision 4 reads `"open"` when `state == "OPEN"`, **else**
    /// `"closed"`, and the direction is the whole point: the inverse fallback
    /// hands the board an *open* card whose `resolved` is non-null, and the UI
    /// then offers ✓ on an issue that is already closed. Defaulting to closed is
    /// merely a card in the wrong column, which is visible and harmless.
    #[test]
    fn a_row_with_no_state_at_all_falls_back_to_closed_not_open() {
        let json = r#"[{"number":5,"title":"t","createdAt":"c","closedAt":"d",
            "body":"","labels":[],"url":"u"}]"#;
        let t = &parse_issues(json, "deck").unwrap()[0];
        assert_eq!(t.status.as_str(), "closed");
        // And the pair stays coherent: a close time with an open step is the
        // contradiction the fallback's direction exists to avoid.
        assert_eq!(t.resolved.as_deref(), Some("d"));
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

    /// Pins that the constant still asks for the eight fields `row_to_task`
    /// reads. It does **not** check that the parser reads them — it compares the
    /// constant against a hardcoded copy of the same names, so renaming a key
    /// inside `row_to_task` leaves this green. The parser side is covered by
    /// `an_open_issue_maps_field_by_field`, which asserts every mapped value.
    /// Mirrors `gh_pr.rs`'s own guard, and has the same limit.
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

    use crate::tasks::provider::{TaskPatch, TaskProvider};
    use std::cell::RefCell;

    /// Records every argv it is handed **and the stdin that came with it**, and
    /// replies from a script. The whole point of the injected runner: the
    /// provider's branches are testable without a process, exactly as
    /// `parse_issues` is without a network.
    ///
    /// `stdins` is a parallel vector rather than a field on a tuple, so the
    /// argv assertions read as they always did; the two cannot drift because the
    /// one closure pushes to both. Discarding the stdin here is what let the
    /// create/edit guard pass a runner given *no* body — see
    /// `create_sends_the_body_on_stdin_and_never_in_argv`.
    struct FakeGh {
        calls: RefCell<Vec<Vec<String>>>,
        stdins: RefCell<Vec<Option<String>>>,
        replies: RefCell<Vec<Result<String, String>>>,
    }

    fn provider(replies: Vec<Result<String, String>>) -> (GhIssueProvider<'static>, std::rc::Rc<FakeGh>) {
        let fake = std::rc::Rc::new(FakeGh {
            calls: RefCell::new(Vec::new()),
            stdins: RefCell::new(Vec::new()),
            replies: RefCell::new(replies),
        });
        let f = fake.clone();
        let p = GhIssueProvider::new(
            // A *resolver*, not a value: resolving the repository runs `gh`, and
            // nothing that merely constructs a provider may do I/O — see the
            // constructor's own doc comment.
            Box::new(|| Ok("o/n".to_string())),
            Box::new(move |argv: &[String], stdin: Option<&str>| {
                f.calls.borrow_mut().push(argv.to_vec());
                f.stdins.borrow_mut().push(stdin.map(str::to_string));
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
    /// `gh issue view` answers with a bare object, not an array of one — so the
    /// read-back every write path ends on is scripted with these two, never with
    /// the array fixtures above. `parse_issue` refuses an array outright
    /// (`a_single_issue_parse_refuses_a_list`), which is exactly the mistake it
    /// is there to catch.
    const ONE_OPEN_OBJECT: &str = r#"{"number":42,"title":"t","state":"OPEN",
        "createdAt":"c","closedAt":null,"body":"","labels":[],"url":"u"}"#;
    const ONE_CLOSED_OBJECT: &str = r#"{"number":7,"title":"t","state":"CLOSED",
        "createdAt":"c","closedAt":"d","body":"","labels":[],"url":"u"}"#;

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

    /// Both halves, and the positive one is the half that hangs. `issue_create_
    /// argv` pins `--body-file -` in argv, so a `create` that handed the runner
    /// `None` would be a `gh` told to read a body from stdin and given none —
    /// the interactive prompt in a spawned child that the constant's comment
    /// exists to prevent. The negative assertion alone is satisfied by `None`.
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
        // The half that actually prevents the hang: something must arrive on
        // stdin, and it must be the body verbatim, newline included.
        assert_eq!(
            fake.stdins.borrow()[0].as_deref(),
            Some("line one\nline two"),
            "`--body-file -` with no stdin is an interactive prompt in a child process",
        );
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

    /// `edit` carries `--body-file -` too, so it hangs on a missing stdin the
    /// same way `create` does, and needs the same positive assertion.
    #[test]
    fn a_title_or_body_patch_edits_the_issue() {
        let (p, fake) = provider(vec![Ok(String::new()), Ok(ONE_OPEN_OBJECT.into())]);
        p.update(
            "42",
            TaskPatch { title: Some("New".into()), body: Some("New body".into()), ..Default::default() },
        )
        .unwrap();
        assert!(fake.calls.borrow()[0].iter().any(|a| a == "edit"));
        assert_eq!(
            fake.stdins.borrow()[0].as_deref(),
            Some("New body"),
            "`--body-file -` with no stdin is an interactive prompt in a child process",
        );
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
    /// only thing that can catch it: the fake replies with **whatever the script
    /// holds**, whatever argv it is handed, so *nothing else here inspects how the
    /// issue was addressed*. Measured rather than assumed — rewriting `resolve` to
    /// search makes exactly one test of the whole suite fail, this one.
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
}
