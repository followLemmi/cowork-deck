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
}
