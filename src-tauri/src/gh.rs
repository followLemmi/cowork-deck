//! Единственное место в коде, знающее о существовании GitHub CLI (`gh`).
//!
//! Дизайн-инвариант: приложение НИКОГДА не хранит токен и НИКОГДА не меняет
//! глобальное состояние gh (`gh auth switch`, `~/.config/gh/hosts.yml`).
//! Токен резолвится на старте сессии и живёт только в памяти процесса.

use crate::model::WorkspaceGithub;
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

const TOKEN_PREFIXES: [&str; 6] = ["gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_"];

/// Вырезает всё, что похоже на токен GitHub, из текста перед логированием или
/// отдачей во фронт.
///
/// Работаем по префиксам, а не по known-значению: токен мог прийти из stderr
/// самого gh, и тогда мы его не знаем. Совпадение засчитывается только на
/// границе слова, чтобы «github.com» и подобное не пострадало.
pub fn redact(msg: &str) -> String {
    let bytes = msg.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = String::with_capacity(msg.len());
    let mut i = 0;
    while i < msg.len() {
        let at_boundary = i == 0 || !is_word(bytes[i - 1]);
        if at_boundary && TOKEN_PREFIXES.iter().any(|p| msg[i..].starts_with(p)) {
            let mut j = i;
            while j < msg.len() && is_word(bytes[j]) {
                j += 1;
            }
            out.push_str("<redacted>");
            i = j;
        } else {
            let ch = msg[i..].chars().next().expect("i всегда на границе символа");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Читает токен указанного аккаунта из keyring gh, НЕ переключая активный
/// аккаунт. Таймаут обязателен: залоченный keyring на Linux умеет подвесить
/// процесс диалогом, а старт сессии блокировать нельзя.
pub fn token(host: &str, login: &str, timeout: std::time::Duration) -> Result<String, String> {
    let path = which_gh().ok_or_else(|| "gh не найден".to_string())?;
    let (host, login) = (host.to_string(), login.to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(&path)
            .args(["auth", "token", "--hostname", &host, "--user", &login])
            .output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(o)) if o.status.success() => {
            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if t.is_empty() {
                Err("gh вернул пустой токен".into())
            } else {
                Ok(t)
            }
        }
        Ok(Ok(o)) => Err(redact(String::from_utf8_lossy(&o.stderr).trim())),
        Ok(Err(e)) => Err(redact(&e.to_string())),
        // Поток остаётся висеть на заблокированном keyring — он отвалится сам,
        // когда диалог закроют. Мы его не ждём.
        Err(_) => Err("gh не ответил вовремя (возможно, залочен keyring)".into()),
    }
}

/// Собирает окружение дочерней сессии из привязки воркспейса.
///
/// `token = Some(_)` — обычный путь. `token = None` — деградация: сессия всё
/// равно стартует, но `GH_CONFIG_DIR` уводится в заведомо пустой каталог,
/// чтобы gh сказал "ты не залогинен" вместо тихой работы под чужим активным
/// аккаунтом. git-идентичность инжектится в обоих случаях — она известна и
/// без токена.
pub fn session_env(
    cfg: &WorkspaceGithub,
    token: Option<&str>,
    noauth_dir: &str,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    let mut put = |k: &str, v: &str| env.push((k.to_string(), v.to_string()));

    match token {
        Some(t) => {
            put("GH_TOKEN", t);
            // github MCP-сервер, если сессия его поднимает, читает эту переменную.
            put("GITHUB_PERSONAL_ACCESS_TOKEN", t);
            // GH_TOKEN действует на github.com; для прочих хостов gh смотрит
            // GH_ENTERPRISE_TOKEN, поэтому хост нужно назвать явно.
            if cfg.host != "github.com" {
                put("GH_HOST", &cfg.host);
            }
        }
        None => put("GH_CONFIG_DIR", noauth_dir),
    }

    if let Some(n) = cfg.git_name.as_deref().filter(|s| !s.trim().is_empty()) {
        put("GIT_AUTHOR_NAME", n);
        put("GIT_COMMITTER_NAME", n);
    }
    if let Some(e) = cfg.git_email.as_deref().filter(|s| !s.trim().is_empty()) {
        put("GIT_AUTHOR_EMAIL", e);
        put("GIT_COMMITTER_EMAIL", e);
    }
    if let Some(k) = cfg.ssh_key.as_deref().filter(|s| !s.trim().is_empty()) {
        put("GIT_SSH_COMMAND", &format!("ssh -i {k} -o IdentitiesOnly=yes"));
    }
    env
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

    #[test]
    fn redact_hides_every_known_token_shape() {
        assert_eq!(redact("failed with gho_abc123DEF here"), "failed with <redacted> here");
        assert_eq!(redact("ghp_xxx"), "<redacted>");
        assert_eq!(redact("token=github_pat_11ABC_longtail"), "token=<redacted>");
        for prefix in ["ghu_", "ghs_", "ghr_"] {
            let msg = format!("oops {prefix}secretvalue");
            assert_eq!(redact(&msg), "oops <redacted>", "не отредактирован префикс {prefix}");
        }
    }

    #[test]
    fn redact_leaves_ordinary_text_untouched() {
        let msg = "gh: could not find any credentials for github.com";
        assert_eq!(redact(msg), msg);
    }

    #[test]
    fn redact_handles_tokens_glued_to_punctuation() {
        assert_eq!(redact("(gho_abc)"), "(<redacted>)");
        assert_eq!(redact("\"gho_abc\","), "\"<redacted>\",");
    }

    #[test]
    fn redact_does_not_fire_mid_word_or_break_utf8() {
        // «не-токен» внутри слова не трогаем: граница слова обязательна.
        assert_eq!(redact("xgho_abc"), "xgho_abc");
        let cyrillic = "ошибка: gho_abc не подошёл";
        assert_eq!(redact(cyrillic), "ошибка: <redacted> не подошёл");
    }

    fn cfg_full() -> WorkspaceGithub {
        WorkspaceGithub {
            host: "github.com".into(),
            login: "followLemmi".into(),
            git_name: Some("Evgeny".into()),
            git_email: Some("e@example.com".into()),
            ssh_key: Some("/home/u/.ssh/id_work".into()),
        }
    }

    fn cfg_bare() -> WorkspaceGithub {
        WorkspaceGithub {
            host: "github.com".into(),
            login: "followLemmi".into(),
            git_name: None,
            git_email: None,
            ssh_key: None,
        }
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn full_config_with_token_sets_gh_git_and_ssh() {
        let env = session_env(&cfg_full(), Some("gho_secret"), "/tmp/noauth");
        assert_eq!(get(&env, "GH_TOKEN"), Some("gho_secret"));
        assert_eq!(get(&env, "GITHUB_PERSONAL_ACCESS_TOKEN"), Some("gho_secret"));
        assert_eq!(get(&env, "GIT_AUTHOR_NAME"), Some("Evgeny"));
        assert_eq!(get(&env, "GIT_COMMITTER_NAME"), Some("Evgeny"));
        assert_eq!(get(&env, "GIT_AUTHOR_EMAIL"), Some("e@example.com"));
        assert_eq!(get(&env, "GIT_COMMITTER_EMAIL"), Some("e@example.com"));
        assert_eq!(
            get(&env, "GIT_SSH_COMMAND"),
            Some("ssh -i /home/u/.ssh/id_work -o IdentitiesOnly=yes")
        );
        assert_eq!(get(&env, "GH_CONFIG_DIR"), None, "успешный резолв не трогает GH_CONFIG_DIR");
        assert_eq!(get(&env, "GH_HOST"), None, "для github.com GH_HOST не нужен");
    }

    #[test]
    fn empty_optional_fields_produce_no_variables_at_all() {
        let env = session_env(&cfg_bare(), Some("gho_secret"), "/tmp/noauth");
        assert_eq!(get(&env, "GH_TOKEN"), Some("gho_secret"));
        for k in [
            "GIT_AUTHOR_NAME",
            "GIT_COMMITTER_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_EMAIL",
            "GIT_SSH_COMMAND",
        ] {
            assert_eq!(get(&env, k), None, "{k} не должна появляться — наследование из ~/.gitconfig");
        }
    }

    #[test]
    fn blank_optional_fields_are_treated_as_absent() {
        let cfg = WorkspaceGithub {
            git_name: Some("   ".into()),
            git_email: Some("".into()),
            ssh_key: Some(" ".into()),
            ..cfg_bare()
        };
        let env = session_env(&cfg, Some("t"), "/tmp/noauth");
        assert_eq!(get(&env, "GIT_AUTHOR_NAME"), None);
        assert_eq!(get(&env, "GIT_AUTHOR_EMAIL"), None);
        assert_eq!(get(&env, "GIT_SSH_COMMAND"), None);
    }

    #[test]
    fn degraded_pins_an_empty_config_dir_and_never_sets_a_token() {
        let env = session_env(&cfg_full(), None, "/tmp/noauth");
        assert_eq!(get(&env, "GH_CONFIG_DIR"), Some("/tmp/noauth"));
        assert_eq!(get(&env, "GH_TOKEN"), None, "молчаливый уход на чужой активный аккаунт недопустим");
        assert_eq!(get(&env, "GITHUB_PERSONAL_ACCESS_TOKEN"), None);
        assert_eq!(get(&env, "GIT_AUTHOR_NAME"), Some("Evgeny"), "идентичность известна и без токена");
    }

    #[test]
    fn non_default_host_sets_gh_host() {
        let cfg = WorkspaceGithub { host: "ghe.example.com".into(), ..cfg_bare() };
        let env = session_env(&cfg, Some("t"), "/tmp/noauth");
        assert_eq!(get(&env, "GH_HOST"), Some("ghe.example.com"));
    }

    #[test]
    fn produces_no_duplicate_keys() {
        let env = session_env(&cfg_full(), Some("t"), "/tmp/noauth");
        let mut keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len(), "дубликаты ключей env: {keys:?}");
    }
}
