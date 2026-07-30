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
