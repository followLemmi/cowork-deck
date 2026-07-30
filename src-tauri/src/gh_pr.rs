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
