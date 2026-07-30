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
}
