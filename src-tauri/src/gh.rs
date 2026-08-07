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
    /// Set when the account listing itself failed — which the UI must show as
    /// a fault, not as "no accounts": a user with two accounts staring at an
    /// empty list has no way to guess the difference.
    pub error: Option<String>,
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

/// Successful discoveries only; a miss stays retryable, so installing gh
/// does not require an app restart.
static GH_CACHE: std::sync::OnceLock<crate::which::Resolution> = std::sync::OnceLock::new();

/// Shared discovery (see `which.rs`): override, PATH, installer directories,
/// login shell. A candidate only counts if it can do `auth status --json` —
/// see `usable_gh`.
pub fn which_gh() -> Option<crate::which::Resolution> {
    if let Ok(p) = std::env::var("COWORK_GH_PATH") {
        if !p.is_empty() {
            return Some(crate::which::Resolution { program: p, path_env: None });
        }
    }
    if let Some(hit) = GH_CACHE.get() {
        return Some(hit.clone());
    }
    let mut candidates = crate::which::under_home(&[".local/bin/gh"]);
    if !cfg!(windows) {
        candidates.push("/opt/homebrew/bin/gh".to_string());
        candidates.push("/usr/local/bin/gh".to_string());
        candidates.push("/home/linuxbrew/.linuxbrew/bin/gh".to_string());
    }
    let found = crate::which::discover(&["gh"], &candidates, &usable_gh)?;
    Some(GH_CACHE.get_or_init(|| found).clone())
}

/// gh qualifies if it runs AND knows `auth status --json`: a distro-packaged
/// gh on the GUI PATH can be years older than the one the user's shell sees,
/// and it answers the account listing with "unknown flag" — outwardly
/// indistinguishable from "no accounts". Only that answer disqualifies: a
/// healthy gh with zero accounts also exits non-zero.
fn usable_gh(r: &crate::which::Resolution) -> bool {
    if !crate::which::version_runs(r) {
        return false;
    }
    // `gh auth status` talks to the network and the keyring, and a locked
    // keyring on Linux can hang it behind a dialog (see `token`). The probe
    // is bounded for that reason, and a timeout rejects the candidate:
    // better a false "gh not found" than a frozen window.
    let mut cmd = r.command();
    cmd.args(["auth", "status", "--json", "hosts"]);
    match crate::which::output_with_deadline(cmd, std::time::Duration::from_secs(5)) {
        Some(o) if o.status.success() => true,
        Some(o) => !String::from_utf8_lossy(&o.stderr).contains("unknown flag"),
        None => false,
    }
}

/// Separates "no accounts" from "the listing failed": an empty parse with a
/// non-zero exit is a fault, except for the one legitimate case of a gh that
/// simply is not logged into any host.
fn accounts_or_error(stdout: &str, stderr: &str, success: bool) -> (Vec<GhAccount>, Option<String>) {
    let accounts = parse_auth_status(stdout);
    if accounts.is_empty() && !success {
        let msg = redact(stderr.trim());
        // Pinned to gh's actual wording ("You are not logged into any GitHub
        // hosts..."); gh ships unlocalized English, so the string is stable.
        // If gh ever rephrases it, the failure is noisy — the empty state
        // shows an error paragraph — never a silent swallow.
        if !msg.to_lowercase().contains("not logged in") {
            return (accounts, Some(msg));
        }
    }
    (accounts, None)
}

pub fn status() -> GhStatus {
    let resolved = match which_gh() {
        Some(r) => r,
        None => return GhStatus { path: None, version: None, accounts: Vec::new(), error: None },
    };
    let version = resolved
        .command()
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    // Bounded like the discovery probe, and for the same keyring reason —
    // but here a timeout becomes a visible error, not a rejected candidate.
    let mut listing = resolved.command();
    listing.args(["auth", "status", "--json", "hosts"]);
    let (accounts, error) =
        match crate::which::output_with_deadline(listing, std::time::Duration::from_secs(10)) {
            Some(o) => accounts_or_error(
                &String::from_utf8_lossy(&o.stdout),
                &String::from_utf8_lossy(&o.stderr),
                o.status.success(),
            ),
            None => (Vec::new(), Some("gh did not answer in time (locked keyring?)".to_string())),
        };
    GhStatus { path: Some(resolved.program.clone()), version, accounts, error }
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
    let (host, login) = (host.to_string(), login.to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    // Discovery runs INSIDE the timed thread, not before it: on a cache miss
    // it probes the PATH, installer dirs and the login shell, and its
    // `gh auth status` probes can stall on the same locked keyring this
    // timeout exists for. This function is reached from `start_session` on
    // the main thread — the caller's deadline has to cover all of it.
    std::thread::spawn(move || {
        let out = match which_gh() {
            None => Err("gh not found".to_string()),
            Some(resolved) => {
                let mut cmd = resolved.command();
                cmd.args(["auth", "token", "--hostname", &host, "--user", &login]);
                cmd.output().map_err(|e| redact(&e.to_string()))
            }
        };
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
        Ok(Err(e)) => Err(e),
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
    fn a_failed_listing_is_an_error_not_an_empty_account_list() {
        // An old gh that does not know `--json`: parse is empty, exit is
        // non-zero — the UI must hear about it.
        let (accs, err) = accounts_or_error("", "unknown flag: --json", false);
        assert!(accs.is_empty());
        assert!(err.is_some());

        // Zero accounts is not a fault.
        let (accs, err) =
            accounts_or_error("", "You are not logged into any GitHub hosts. To log in, run: gh auth login", false);
        assert!(accs.is_empty());
        assert!(err.is_none(), "not-logged-in is the legitimate empty state");

        // A healthy listing carries no error.
        let (accs, err) = accounts_or_error(TWO_ACCOUNTS, "", true);
        assert_eq!(accs.len(), 2);
        assert!(err.is_none());
    }

    #[test]
    fn listing_errors_are_redacted_before_leaving_the_module() {
        let (_, err) = accounts_or_error("", "boom gho_secret123 boom", false);
        assert_eq!(err.as_deref(), Some("boom <redacted> boom"));
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
