//! Switching sync on: is there a `gh`, is there an account, and is there a
//! repository to create or to connect to.
//!
//! Nothing here is automatic. Sync publishes a person's session history and
//! their project facts, so it starts off and stays off until someone turns it
//! on knowing what it does.

use crate::gh::GhAccount;
use serde::{Deserialize, Serialize};

/// Written at creation, read at connect. Without it, "connect to an existing
/// repository" would happily adopt any repository at all and start committing a
/// person's memory into somebody else's project.
pub const MARKER: &str = ".cowork-sync.json";

/// The repository layout's version. Bumped when the shape changes in a way an
/// older build would misread; #318 is what refuses politely on a mismatch.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub format: u32,
}

pub fn marker_body() -> String {
    serde_json::to_string_pretty(&Marker { format: FORMAT }).unwrap_or_default()
}

/// Why sync cannot be switched on yet.
///
/// These are two of the three states `GhUnavailable` already names in
/// `src/gh-unavailable.ts`, deliberately: that module exists because the same
/// three reasons were being worded differently on two screens, and a third
/// wording here would be the same mistake with one more copy. The third state,
/// `no-repo`, is about a workspace's own folder and does not apply.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Blocked {
    NoGh,
    NoAccount,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preflight {
    pub blocked: Option<Blocked>,
    pub accounts: Vec<GhAccount>,
    /// The account listing itself failed. Kept apart from "no accounts" because
    /// telling someone with two accounts that they have none is its own bug
    /// (`gh::accounts_or_error`).
    pub error: Option<String>,
}

/// What the offer to switch sync on can say, from `gh`'s own answer.
pub fn preflight_from(status: crate::gh::GhStatus) -> Preflight {
    let blocked = if status.path.is_none() {
        Some(Blocked::NoGh)
    } else if status.accounts.is_empty() {
        // Only when the listing succeeded. A failed listing is a fault, and
        // routing it to "connect an account" would send someone to fix
        // something that is not broken.
        status.error.is_none().then_some(Blocked::NoAccount)
    } else {
        None
    };
    Preflight { blocked, accounts: status.accounts, error: status.error }
}

/// One `gh` call, injectable so the decisions below are testable without a
/// network or a real account.
pub trait Gh {
    fn run(&self, account: &GhAccount, args: &[&str]) -> Result<String, String>;
}

/// What is on the other end of a repository name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RepoState {
    /// No commits. Safe to adopt.
    Empty,
    /// Ours, and readable by this build.
    Ours { format: u32 },
    /// Ours, but written by a newer build.
    OursNewer { format: u32 },
    /// Somebody's project. Adopting it would commit a person's memory into it.
    Foreign,
    /// No such repository, or not visible to this account.
    Missing,
    /// The probe itself failed, so nothing is known.
    ///
    /// Kept apart from `Missing` because the two lead opposite ways: absent
    /// invites "create it", and a rate limit or a dropped connection must not.
    /// Offering to create a repository that already exists is how a person ends
    /// up with two of them and a split memory.
    Unknown { why: String },
}

/// Whether a repository can be adopted, without cloning it.
///
/// One API call rather than a clone: the repository may be large, and the
/// question — is there a marker at the root — is answerable from the contents
/// endpoint alone.
pub fn probe(gh: &dyn Gh, account: &GhAccount, repo: &str) -> RepoState {
    match gh.run(account, &["api", &format!("repos/{repo}/contents/{MARKER}")]) {
        Ok(body) => match read_marker(&body) {
            Some(f) if f <= FORMAT => RepoState::Ours { format: f },
            Some(f) => RepoState::OursNewer { format: f },
            // A file with that name we cannot parse is not evidence of ours.
            None => RepoState::Foreign,
        },
        Err(e) => {
            let lower = e.to_lowercase();
            if lower.contains("could not resolve to a repository") {
                RepoState::Missing
            } else if lower.contains("not found") || lower.contains("404") {
                // The marker is absent. That is either an empty repository —
                // which is fine — or somebody's project, which is not. The
                // repository itself exists, or the call above would have said
                // it could not be resolved.
                match is_empty(gh, account, repo) {
                    Some(true) => RepoState::Empty,
                    Some(false) => RepoState::Foreign,
                    None => RepoState::Unknown { why: crate::gh::redact(&e) },
                }
            } else {
                RepoState::Unknown { why: crate::gh::redact(&e) }
            }
        }
    }
}

/// `gh api` returns the contents endpoint's base64 payload; the marker is small
/// enough that the decoded body is the whole file.
fn read_marker(body: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let content = v.get("content")?.as_str()?;
    let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    let decoded = base64_decode(&cleaned)?;
    let text = String::from_utf8(decoded).ok()?;
    serde_json::from_str::<Marker>(&text).ok().map(|m| m.format)
}

/// Just enough base64 for a file of two dozen bytes. A dependency for this would
/// be a poor trade, and the input is one endpoint's fixed encoding.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = T.iter().position(|&t| t == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// `None` when the question could not be answered, which is not the same as
/// "no". Treating a failed call as "not empty" would refuse a repository that
/// is perfectly adoptable, every time the network hiccups.
fn is_empty(gh: &dyn Gh, account: &GhAccount, repo: &str) -> Option<bool> {
    // A repository with no commits has no default branch, which is the cheapest
    // reliable signal the API gives.
    let s = gh
        .run(account, &["api", &format!("repos/{repo}"), "--jq", ".size,.default_branch"])
        .ok()?;
    let d = s.lines().nth(1)?.trim().to_string();
    Some(d.is_empty() || d == "null")
}

/// The argv for creating the repository. Split out from the call so a test can
/// read it: this is the one command in the app that can publish a person's
/// session history to the world if it is wrong.
pub fn create_argv(name: &str) -> Vec<String> {
    vec![
        "repo".into(),
        "create".into(),
        name.into(),
        // Explicit, never implied. `gh repo create` without a visibility flag
        // prompts, and a prompt on a stdin nobody is attached to is not a
        // default anyone chose.
        "--private".into(),
        "--clone=false".into(),
    ]
}

/// Create it, and answer with the clone URL.
pub fn create(gh: &dyn Gh, account: &GhAccount, name: &str) -> Result<String, String> {
    let argv = create_argv(name);
    let args: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    gh.run(account, &args)?;
    gh.run(account, &["repo", "view", name, "--json", "url", "--jq", ".url"])
        .map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gh::GhStatus;
    use std::cell::RefCell;

    fn account() -> GhAccount {
        GhAccount {
            host: "github.com".into(),
            login: "followLemmi".into(),
            active: true,
            scopes: vec!["repo".into()],
            state: "success".into(),
        }
    }

    /// Answers canned replies and records what it was asked, so a test can
    /// assert on the argv as well as on the decision.
    struct FakeGh {
        replies: Vec<Result<String, String>>,
        seen: RefCell<Vec<Vec<String>>>,
        next: RefCell<usize>,
    }

    impl FakeGh {
        fn new(replies: Vec<Result<String, String>>) -> FakeGh {
            FakeGh { replies, seen: RefCell::new(Vec::new()), next: RefCell::new(0) }
        }
    }

    impl Gh for FakeGh {
        fn run(&self, _a: &GhAccount, args: &[&str]) -> Result<String, String> {
            self.seen.borrow_mut().push(args.iter().map(|s| s.to_string()).collect());
            let mut n = self.next.borrow_mut();
            let r = self.replies.get(*n).cloned().unwrap_or(Err("no reply".into()));
            *n += 1;
            r
        }
    }

    fn contents_reply(body: &str) -> String {
        // The contents endpoint returns base64 with newlines in it, which is
        // the detail a naive decoder gets wrong.
        let b64 = base64_encode(body.as_bytes());
        let wrapped = format!("{}\n{}", &b64[..b64.len() / 2], &b64[b64.len() / 2..]);
        serde_json::json!({ "content": wrapped, "encoding": "base64" }).to_string()
    }

    fn base64_encode(input: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in input.chunks(3) {
            let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            for i in 0..4 {
                if i <= c.len() {
                    out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn preflight_names_the_two_states_the_ui_already_has_words_for() {
        let no_gh = GhStatus { path: None, version: None, accounts: vec![], error: None };
        assert_eq!(preflight_from(no_gh).blocked, Some(Blocked::NoGh));

        let no_account = GhStatus {
            path: Some("/usr/bin/gh".into()),
            version: Some("2".into()),
            accounts: vec![],
            error: None,
        };
        assert_eq!(preflight_from(no_account).blocked, Some(Blocked::NoAccount));

        let ready = GhStatus {
            path: Some("/usr/bin/gh".into()),
            version: Some("2".into()),
            accounts: vec![account()],
            error: None,
        };
        assert_eq!(preflight_from(ready).blocked, None);
    }

    /// A failed listing is a fault, not an empty one. Routing it to "connect an
    /// account" sends someone to fix something that is not broken — and
    /// `gh::accounts_or_error` exists precisely because the two look identical
    /// from outside.
    #[test]
    fn a_failed_account_listing_is_not_reported_as_having_no_account() {
        let failed = GhStatus {
            path: Some("/usr/bin/gh".into()),
            version: Some("2".into()),
            accounts: vec![],
            error: Some("unknown flag: --json".into()),
        };
        let p = preflight_from(failed);
        assert_eq!(p.blocked, None, "not a missing account");
        assert!(p.error.is_some(), "and the fault is carried through");
    }

    #[test]
    fn a_repository_with_our_marker_is_ours() {
        let gh = FakeGh::new(vec![Ok(contents_reply(&marker_body()))]);
        assert_eq!(probe(&gh, &account(), "me/mem"), RepoState::Ours { format: FORMAT });
    }

    /// Written by a newer build. Adopting it and committing would corrupt it for
    /// the machine that made it; #318 is what says so in words.
    #[test]
    fn a_newer_format_is_told_apart_from_one_we_can_read() {
        let gh = FakeGh::new(vec![Ok(contents_reply(r#"{"format": 99}"#))]);
        assert_eq!(probe(&gh, &account(), "me/mem"), RepoState::OursNewer { format: 99 });
    }

    #[test]
    fn an_empty_repository_can_be_adopted() {
        let gh = FakeGh::new(vec![
            Err("gh: Not Found (HTTP 404)".into()),
            Ok("0\nnull".into()),
        ]);
        assert_eq!(probe(&gh, &account(), "me/mem"), RepoState::Empty);
    }

    /// The failure worth refusing: a repository full of somebody's work, with
    /// no marker. Adopting it would commit a person's session history into it.
    #[test]
    fn a_repository_with_commits_and_no_marker_is_refused() {
        let gh = FakeGh::new(vec![
            Err("gh: Not Found (HTTP 404)".into()),
            Ok("1024\nmain".into()),
        ]);
        assert_eq!(probe(&gh, &account(), "me/mem"), RepoState::Foreign);
    }

    /// A dropped connection is not evidence that the repository is absent, and
    /// the two lead opposite ways: absent invites "create it", and creating one
    /// that already exists is how a person ends up with two and a split memory.
    #[test]
    fn a_failed_probe_is_unknown_rather_than_missing() {
        let gh = FakeGh::new(vec![Err("dial tcp: connection refused".into())]);
        assert!(
            matches!(probe(&gh, &account(), "me/mem"), RepoState::Unknown { .. }),
            "a network failure must not read as an absent repository"
        );

        // And the same when only the emptiness check is what failed.
        let gh = FakeGh::new(vec![
            Err("gh: Not Found (HTTP 404)".into()),
            Err("API rate limit exceeded".into()),
        ]);
        assert!(matches!(probe(&gh, &account(), "me/mem"), RepoState::Unknown { .. }));
    }

    #[test]
    fn a_repository_that_does_not_exist_is_missing() {
        let gh = FakeGh::new(vec![Err(
            "GraphQL: Could not resolve to a Repository with the name 'me/nope'".into(),
        )]);
        assert_eq!(probe(&gh, &account(), "me/nope"), RepoState::Missing);
    }

    #[test]
    fn a_marker_we_cannot_parse_is_not_evidence_of_ours() {
        let gh = FakeGh::new(vec![Ok(contents_reply("not json at all"))]);
        assert_eq!(probe(&gh, &account(), "me/mem"), RepoState::Foreign);
    }

    /// This is the one command in the app that could publish a person's session
    /// history to the world.
    #[test]
    fn creation_is_private_and_never_relies_on_a_default() {
        let argv = create_argv("cowork-deck-memory");
        assert!(argv.contains(&"--private".to_string()), "{argv:?}");
        assert!(!argv.iter().any(|a| a.contains("public")), "{argv:?}");
        assert!(
            !argv.iter().any(|a| a == "--internal"),
            "internal is org-visible, which is not private: {argv:?}"
        );
    }

    #[test]
    fn create_answers_with_the_clone_url() {
        let gh = FakeGh::new(vec![
            Ok(String::new()),
            Ok("https://github.com/me/cowork-deck-memory\n".into()),
        ]);
        let url = create(&gh, &account(), "cowork-deck-memory").unwrap();
        assert_eq!(url, "https://github.com/me/cowork-deck-memory");
        assert_eq!(gh.seen.borrow()[0][0], "repo");
        assert!(gh.seen.borrow()[0].contains(&"--private".to_string()));
    }

    /// Against base64 produced by something that is not this file. A decoder
    /// tested only against its own encoder can be wrong in a matching way and
    /// still pass.
    #[test]
    fn the_decoder_agrees_with_a_reference_encoding() {
        let reference = "ewogICJmb3JtYXQiOiAxCn0=";
        let decoded = String::from_utf8(base64_decode(reference).expect("decodes")).unwrap();
        assert_eq!(decoded, marker_body(), "decoded: {decoded}");

        // Padding, and the lengths that exercise each remainder.
        for (text, b64) in [("a", "YQ=="), ("ab", "YWI="), ("abc", "YWJj"), ("abcd", "YWJjZA==")] {
            assert_eq!(
                String::from_utf8(base64_decode(b64).unwrap()).unwrap(),
                text,
                "{b64}"
            );
        }
    }

    #[test]
    fn the_marker_round_trips_through_the_contents_encoding() {
        assert_eq!(read_marker(&contents_reply(&marker_body())), Some(FORMAT));
        assert_eq!(read_marker("{}"), None);
        assert_eq!(read_marker("not json"), None);
    }
}
