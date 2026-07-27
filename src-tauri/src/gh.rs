//! Единственное место в коде, знающее о существовании GitHub CLI (`gh`).
//!
//! Дизайн-инвариант: приложение НИКОГДА не хранит токен и НИКОГДА не меняет
//! глобальное состояние gh (`gh auth switch`, `~/.config/gh/hosts.yml`).
//! Токен резолвится на старте сессии и живёт только в памяти процесса.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GhAccount {
    pub host: String,
    pub login: String,
    pub active: bool,
    pub scopes: Vec<String>,
    /// "success" у рабочего аккаунта; иное значение отдаём в UI как есть.
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GhStatus {
    pub path: Option<String>,
    pub version: Option<String>,
    pub accounts: Vec<GhAccount>,
}

/// Разбирает вывод `gh auth status --json hosts`. Любой неожиданный ввод —
/// это "аккаунтов нет", а не паника: gh может смениться версией под нами.
pub fn parse_auth_status(json: &str) -> Vec<GhAccount> {
    let root: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let hosts = match root.get("hosts").and_then(|h| h.as_object()) {
        Some(h) => h,
        None => return Vec::new(),
    };
    let empty = Vec::new();
    let mut out = Vec::new();
    for (host, entries) in hosts {
        for e in entries.as_array().unwrap_or(&empty) {
            let login = e.get("login").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if login.is_empty() {
                continue;
            }
            let scopes = e
                .get("scopes")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            out.push(GhAccount {
                host: e.get("host").and_then(|v| v.as_str()).unwrap_or(host).to_string(),
                login,
                active: e.get("active").and_then(|v| v.as_bool()).unwrap_or(false),
                scopes,
                state: e.get("state").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
            });
        }
    }
    out
}

/// Зеркало `which_claude()` из commands.rs: сначала явный override, затем
/// проба `gh --version` на PATH.
pub fn which_gh() -> Option<String> {
    if let Ok(p) = std::env::var("COWORK_GH_PATH") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    match std::process::Command::new("gh").arg("--version").output() {
        Ok(o) if o.status.success() => Some("gh".to_string()),
        _ => None,
    }
}

pub fn status() -> GhStatus {
    let path = match which_gh() {
        Some(p) => p,
        None => return GhStatus { path: None, version: None, accounts: Vec::new() },
    };
    let version = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    let accounts = std::process::Command::new(&path)
        .args(["auth", "status", "--json", "hosts"])
        .output()
        .ok()
        .map(|o| parse_auth_status(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    GhStatus { path: Some(path), version, accounts }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_ACCOUNTS: &str = r#"{"hosts":{"github.com":[
        {"state":"success","active":true,"host":"github.com","login":"EvgenyKh_jvl","tokenSource":"keyring","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"},
        {"state":"success","active":false,"host":"github.com","login":"followLemmi","tokenSource":"keyring","scopes":"gist, read:org","gitProtocol":"https"}]}}"#;

    #[test]
    fn parses_two_accounts_with_scopes_split() {
        let accs = parse_auth_status(TWO_ACCOUNTS);
        assert_eq!(accs.len(), 2);
        assert_eq!(accs[0].login, "EvgenyKh_jvl");
        assert!(accs[0].active);
        assert_eq!(accs[0].scopes, vec!["gist", "read:org", "repo", "workflow"]);
        assert_eq!(accs[1].login, "followLemmi");
        assert!(!accs[1].active);
        assert_eq!(accs[1].scopes, vec!["gist", "read:org"]);
    }

    #[test]
    fn parses_empty_and_malformed_input_as_no_accounts() {
        assert!(parse_auth_status(r#"{"hosts":{}}"#).is_empty());
        assert!(parse_auth_status("").is_empty());
        assert!(parse_auth_status("not json at all").is_empty());
    }

    #[test]
    fn keeps_failed_accounts_but_marks_their_state() {
        let json = r#"{"hosts":{"github.com":[
            {"state":"timeout","active":true,"host":"github.com","login":"stale","scopes":""}]}}"#;
        let accs = parse_auth_status(json);
        assert_eq!(accs.len(), 1);
        assert_eq!(accs[0].state, "timeout");
        assert!(accs[0].scopes.is_empty(), "пустая строка скоупов не должна давать [\"\"]");
    }

    #[test]
    fn collects_accounts_across_multiple_hosts() {
        let json = r#"{"hosts":{
            "github.com":[{"state":"success","active":true,"host":"github.com","login":"a","scopes":"repo"}],
            "ghe.example.com":[{"state":"success","active":true,"host":"ghe.example.com","login":"b","scopes":"repo"}]}}"#;
        let mut logins: Vec<String> = parse_auth_status(json).into_iter().map(|a| a.login).collect();
        logins.sort();
        assert_eq!(logins, vec!["a", "b"]);
    }
}
