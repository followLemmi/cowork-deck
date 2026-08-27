//! The account's own accounting, asked for the way this app asks `gh` about
//! GitHub accounts: a bounded subprocess, no credential passing through here.
//!
//! `claude -p "/usage"` answers non-interactively and spends **nothing** —
//! measured `total_cost_usd: 0`, `input_tokens: 0`, `output_tokens: 0`, because
//! `/usage` never reaches a model. It is the same move as `gh auth status --json`
//! in `gh.rs`: the program that holds the credential is asked, rather than the
//! credential being borrowed. So ADR-0001's invariant is not narrowed here — the
//! app neither stores nor reads what another credential manager holds. See #306
//! for the surfaces that were investigated and declined, the OAuth token in
//! `~/.claude/.credentials.json` among them.
//!
//! The exposure is that the answer is **prose**. `Current session: 23% used ·
//! resets Aug 27, 4pm (Europe/Minsk)` is one rename away from unparseable, so
//! everything here fails to a `None` that the provider turns into a fall back to
//! `Observed` — never into an error banner, and never into a zero.

use crate::usage::banner;
use std::time::Duration;

/// One window as `/usage` printed it.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportedWindow {
    /// Claude Code's own words — "Current session", "Current week (all models)",
    /// "Current week (Fable)". Carried through to the screen so the dialog reads
    /// the same as `/usage` does, rather than this app renaming the provider's
    /// own vocabulary.
    pub label: String,
    pub used_fraction: f32,
    pub reset_text: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reported {
    pub session: Option<ReportedWindow>,
    /// The **binding** weekly window: the highest of "Current week (all models)"
    /// and any model-scoped week beside it.
    ///
    /// One window rather than one per model, and this is the deliberate part: a
    /// model-scoped week is a real ceiling, so dropping it would hide the number
    /// that stops the deck; but declaring a window per model would put a
    /// permanently-unknown row on the screen for everyone who has none. The
    /// highest one is the one that binds, it carries its own label, and
    /// `model_scoped` says when it is not the all-models figure.
    pub week: Option<ReportedWindow>,
    /// Set when `week` came from a model-scoped line rather than "all models",
    /// so the dialog can say which.
    pub model_scoped: bool,
    /// Whether the text said this account is on a subscription. `false` for an
    /// API key, Bedrock, Vertex or a logged-out install — none of which has these
    /// windows at all, which is why they land on `Unknown` rather than on an
    /// error.
    pub subscription: bool,
}

impl Reported {
    fn is_empty(&self) -> bool {
        self.session.is_none() && self.week.is_none()
    }
}

/// Who the account is. From `claude auth status --json`, which is documented by
/// its own `--help`, non-interactive, and answers the four cases #306 asked
/// about: a subscription, an API key, a third-party provider, and logged out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Auth {
    pub logged_in: bool,
    pub account: Option<String>,
    pub plan: Option<String>,
}

/// `Current session: 23% used · resets Aug 27, 4pm (Europe/Minsk)` and its
/// siblings, out of whatever `/usage` printed.
///
/// Deliberately not a regex and deliberately strict: a line has to have the
/// shape `<label>: <n>% used` to be read at all, and a percentage outside 0..=100
/// is a string this app has not understood rather than a window several times
/// spent.
pub fn parse_usage_text(text: &str) -> Reported {
    let mut out = Reported::default();
    let mut best_week: Option<(f32, ReportedWindow)> = None;
    let mut best_is_scoped = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.to_lowercase().contains("using your subscription") {
            out.subscription = true;
        }
        let Some((label, rest)) = line.split_once(": ") else { continue };
        let label = label.trim();
        let Some(pct) = percent_used(rest) else { continue };
        let win = ReportedWindow {
            label: label.to_string(),
            used_fraction: pct / 100.0,
            reset_text: reset_of(rest),
        };
        let lower = label.to_lowercase();
        if lower.starts_with("current session") {
            out.session = Some(win);
        } else if lower.starts_with("current week") {
            let scoped = !lower.contains("all models");
            // Strictly greater, so a model-scoped week tying with the all-models
            // figure does not displace the label everybody recognises.
            if best_week.as_ref().is_none_or(|(top, _)| pct > *top) {
                best_is_scoped = scoped;
                best_week = Some((pct, win));
            }
        }
    }
    if let Some((_, w)) = best_week {
        out.week = Some(w);
        out.model_scoped = best_is_scoped;
    }
    out
}

/// `23% used · resets …` → 23.0. Anything else → nothing.
fn percent_used(rest: &str) -> Option<f32> {
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if digits.is_empty() {
        return None;
    }
    let after = rest[digits.len()..].trim_start();
    if !after.starts_with('%') {
        return None;
    }
    // "% used" and nothing else. A "% remaining" would mean the opposite, and
    // reading it as "used" is the one misparse that would be actively harmful.
    if !after[1..].trim_start().to_lowercase().starts_with("used") {
        return None;
    }
    let v: f32 = digits.parse().ok()?;
    (0.0..=100.0).contains(&v).then_some(v)
}

/// The prose after "resets", normalised the same way a PTY banner is so that one
/// parser (`banner::resolve_reset`) reads both.
fn reset_of(rest: &str) -> Option<String> {
    let lower = banner::normalise(rest);
    let i = lower.find("resets ")?;
    let s = lower[i + "resets ".len()..].trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// The JSON `claude auth status --json` prints. Tolerant: every field is
/// optional, because a version that renames one should cost the label on the row
/// and not the row.
pub fn parse_auth_status(json: &str) -> Auth {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Auth::default(),
    };
    let logged_in = v["loggedIn"].as_bool().unwrap_or(false);
    let account = v["email"]
        .as_str()
        .or_else(|| v["orgName"].as_str())
        .map(str::to_string);
    // The plan a person recognises, in the app's own words where Claude Code's
    // are a slug: a subscription says which, and everything else says what it is
    // instead of a subscription — which is the fact that explains an unknown row.
    let plan = match (v["authMethod"].as_str(), v["apiProvider"].as_str()) {
        (_, Some(p)) if p != "firstParty" => Some(p.to_string()),
        (Some("claude.ai"), _) => v["subscriptionType"].as_str().map(str::to_string),
        (Some(m), _) => Some(m.to_string()),
        _ => None,
    };
    Auth { logged_in, account, plan }
}

/// Pull the `result` string out of `--output-format json`.
///
/// The envelope is asked for rather than the bare text, and it earns that: the
/// bare form interleaves the person's own settings warnings with the answer on
/// one stream, and `result` is the answer with nothing else in it. A shape this
/// does not recognise yields `None`, which is a fall back to `Observed`.
pub fn result_text(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    // An array of stream events, newest last; or a single object, which is what
    // an older `--output-format json` produced.
    let last = match &v {
        serde_json::Value::Array(items) => items
            .iter()
            .rev()
            .find(|o| o["type"] == "result")
            .cloned()?,
        other => other.clone(),
    };
    last["result"].as_str().map(str::to_string)
}

/// Ask `claude` what the account has left. `None` on anything unexpected.
///
/// `--settings '{"hooks":{}}'` is the important argument: without it this probe
/// fires the person's own `SessionStart` hooks every five minutes, which is a
/// side effect nobody asked a limits screen for. The pattern is already used in
/// this repository's own tests.
pub fn ask_usage(deadline: Duration) -> Option<Reported> {
    let r = crate::commands::which_claude()?;
    let mut cmd = r.command();
    cmd.args([
        "--settings",
        r#"{"hooks":{}}"#,
        "--output-format",
        "json",
        "-p",
        "/usage",
    ]);
    let out = crate::which::output_with_deadline(cmd, deadline)?;
    if !out.status.success() {
        return None;
    }
    let text = result_text(&String::from_utf8_lossy(&out.stdout))?;
    let parsed = parse_usage_text(&text);
    (!parsed.is_empty()).then_some(parsed)
}

/// Who is signed in. `None` when `claude` could not be asked at all — which is
/// different from "logged out", and the row says so differently.
pub fn ask_auth(deadline: Duration) -> Option<Auth> {
    let r = crate::commands::which_claude()?;
    let mut cmd = r.command();
    cmd.args(["auth", "status", "--json"]);
    let out = crate::which::output_with_deadline(cmd, deadline)?;
    // A logged-out install may exit non-zero and still print usable JSON, so the
    // status is not the gate — the parse is.
    let json = String::from_utf8_lossy(&out.stdout);
    let auth = parse_auth_status(&json);
    (auth.logged_in || !json.trim().is_empty()).then_some(auth)
}

/// Resolve a reported reset time. Local time, correctly by construction: the
/// process that printed the prose is a child of this one, so its "4pm" is this
/// machine's.
pub fn resolve(reset_text: Option<&str>) -> Option<i64> {
    banner::resolve_reset(chrono::Local::now(), reset_text?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real thing, captured from `claude` 2.1.247 on 2026-08-27.
    const REAL: &str = "You are currently using your subscription to power your Claude Code usage\n\
        \n\
        Current session: 23% used · resets Aug 27, 4pm (Europe/Minsk)\n\
        Current week (all models): 24% used · resets Sep 1, 8am (Europe/Minsk)\n\
        Current week (Fable): 0% used\n\
        \n\
        What's contributing to your limits usage?\n\
        Last 24h · 409 requests · 7 sessions\n\
          75% of your usage was while 4+ sessions ran in parallel\n";

    #[test]
    fn the_captured_output_parses_into_two_windows() {
        let r = parse_usage_text(REAL);
        assert!(r.subscription);
        let s = r.session.expect("a session window");
        assert_eq!(s.label, "Current session");
        assert!((s.used_fraction - 0.23).abs() < 1e-6);
        assert_eq!(s.reset_text.as_deref(), Some("aug 27, 4pm (europe/minsk)"));
        let w = r.week.expect("a weekly window");
        assert_eq!(w.label, "Current week (all models)");
        assert!(!r.model_scoped);
    }

    /// The prose under the windows is full of percentages, and none of them is a
    /// limit. "75% of your usage was while 4+ sessions ran in parallel" has to
    /// stay out of the answer.
    #[test]
    fn the_contributing_prose_is_not_mistaken_for_a_window() {
        let r = parse_usage_text(REAL);
        assert_eq!(r.session.unwrap().label, "Current session");
        // Exactly two windows came out of a text carrying six percentages.
        assert!(r.week.is_some());
    }

    /// A model-scoped week above the all-models figure is the one that binds, and
    /// it brings its own label with it.
    #[test]
    fn the_binding_weekly_window_is_the_highest_one() {
        let t = "Current week (all models): 24% used · resets Sep 1, 8am\n\
                 Current week (Opus): 91% used · resets Sep 1, 8am\n";
        let r = parse_usage_text(t);
        let w = r.week.unwrap();
        assert_eq!(w.label, "Current week (Opus)");
        assert!((w.used_fraction - 0.91).abs() < 1e-6);
        assert!(r.model_scoped);
    }

    #[test]
    fn a_tie_keeps_the_label_everyone_recognises() {
        let t = "Current week (all models): 24% used\nCurrent week (Opus): 24% used\n";
        let r = parse_usage_text(t);
        assert_eq!(r.week.unwrap().label, "Current week (all models)");
        assert!(!r.model_scoped);
    }

    #[test]
    fn a_window_with_no_reset_printed_is_a_window_with_no_reset() {
        let r = parse_usage_text("Current session: 0% used\n");
        assert_eq!(r.session.unwrap().reset_text, None);
    }

    /// The misparse that would be actively harmful: reading "remaining" as
    /// "used" would tell a person they are nearly out when they have barely
    /// started.
    #[test]
    fn a_remaining_percentage_is_refused_rather_than_read_as_used() {
        assert_eq!(parse_usage_text("Current session: 77% remaining\n").session, None);
    }

    /// The degradation #306 asked to have written before the caller: a renamed or
    /// restructured `/usage` must produce nothing, so the provider falls back to
    /// `Observed` with the block still on screen.
    #[test]
    fn an_unrecognisable_answer_yields_nothing_rather_than_a_zero() {
        for text in [
            "",
            "Total cost: $0.0000\nTotal duration (API): 0s\n",
            "Session usage: nearly none\n",
            "Current session — 23 percent\n",
            "Current session: 900% used\n",
        ] {
            let r = parse_usage_text(text);
            assert!(r.is_empty(), "{text:?} should have parsed to nothing");
        }
    }

    #[test]
    fn the_result_string_comes_out_of_the_stream_envelope() {
        let stdout = r#"[{"type":"system","subtype":"init"},
                         {"type":"assistant"},
                         {"type":"result","subtype":"success","result":"Current session: 5% used","total_cost_usd":0}]"#;
        assert_eq!(result_text(stdout).as_deref(), Some("Current session: 5% used"));
    }

    #[test]
    fn a_bare_result_object_is_read_too_and_a_shape_we_do_not_know_is_not() {
        assert_eq!(result_text(r#"{"type":"result","result":"x"}"#).as_deref(), Some("x"));
        assert_eq!(result_text("not json"), None);
        assert_eq!(result_text(r#"[{"type":"system"}]"#), None);
    }

    /// The four auth cases #306 asked about, each landing somewhere a row can
    /// print. The first is captured from this machine.
    #[test]
    fn a_subscription_names_its_plan() {
        let a = parse_auth_status(
            r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
                "email":"person@example.com","orgName":"JVL","subscriptionType":"team"}"#,
        );
        assert!(a.logged_in);
        assert_eq!(a.account.as_deref(), Some("person@example.com"));
        assert_eq!(a.plan.as_deref(), Some("team"));
    }

    #[test]
    fn an_api_key_a_third_party_provider_and_a_logged_out_install_are_all_readable() {
        let key = parse_auth_status(r#"{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}"#);
        assert_eq!(key.plan.as_deref(), Some("apiKey"));
        let bedrock = parse_auth_status(r#"{"loggedIn":true,"authMethod":"apiKey","apiProvider":"bedrock"}"#);
        assert_eq!(bedrock.plan.as_deref(), Some("bedrock"));
        let out = parse_auth_status(r#"{"loggedIn":false}"#);
        assert!(!out.logged_in);
        assert_eq!(out.plan, None);
        // And a shape nobody recognises costs the label, not the row.
        let junk = parse_auth_status("{}");
        assert!(!junk.logged_in);
    }
}
