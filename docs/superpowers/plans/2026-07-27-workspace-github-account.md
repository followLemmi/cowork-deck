# GitHub-аккаунт на воркспейс — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Привязать GitHub-аккаунт и git-идентичность к воркспейсу так, чтобы сессия рождалась с нужным доступом, не переключая глобальное состояние `gh` и не мешая сессиям на других аккаунтах.

**Architecture:** Воркспейс хранит только имя аккаунта (`login`) — секретов в сторе нет. На старте сессии бэкенд резолвит токен через `gh auth token --user`, собирает список переменных окружения чистой функцией `gh::session_env` и передаёт их в `PtyManager::spawn`, который теперь умеет задавать env дочернего процесса. Переключений (`gh auth switch`) и записи в `~/.config/gh` или `.gitconfig` нет нигде. Поверх этого — экран «GitHub» (детект `gh`, аккаунты, установка, логин) и, во второй фазе, списки PR/issues репозитория воркспейса под его же аккаунтом.

**Tech Stack:** Tauri v2, Rust (`portable-pty`, `serde_json`), ванильный TypeScript, vitest, xterm.js. Внешний процесс `gh` (GitHub CLI) как единственный источник кредов. **Новых зависимостей ни в Cargo.toml, ни в package.json не добавляется.**

**Спека:** `docs/superpowers/specs/2026-07-27-workspace-github-account-design.md`

## Global Constraints

- Tauri v2, ядро Rust + ванильный TypeScript + xterm.js. **Только ванильный TS, без фреймворков.**
- Целевой расход памяти < 100 МБ; только лёгкие зависимости. **Новых зависимостей фича не вводит.**
- Тёмная тема, палитра One Dark, дизайн-токены из `styles.css` (`:root`). Анимации только на `transform`/`opacity` (ADR-008).
- Строки интерфейса — на русском, в существующем стиле.
- Команды тестов неизменны: `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`. База — **131 vitest / 29 cargo**, зелёные; `tsc --noEmit` чист. Каждая задача обязана оставлять их зелёными.
- Коммиты — Conventional Commits.
- **Инвариант безопасности:** токен GitHub никогда не попадает в стор, в лог, в событие для фронта и в текст ошибки. Нарушение этого инварианта — блокирующий дефект, а не замечание.
- В свежем клоне или worktree перед `cargo test` нужно один раз выполнить `npm install && npm run build && npm run stage:reporter` — `dist/` и `src-tauri/binaries/` в `.gitignore`, без них падает build-скрипт Tauri.

## Карта файлов

**Создаются:**
- `src-tauri/src/gh.rs` — всё знание о `gh`: детект, парсинг, резолв токена, сборка env, запросы PR/issues.
- `src/github.ts` — чистые функции фронта: команда установки, скоупы, выбор аккаунта, форматирование списков.
- `src/github-screen.ts` — экран «GitHub» (DOM), в стиле `forms.ts`/`modal.ts`.
- `tests/github.test.ts` — vitest на `src/github.ts`.

**Изменяются:**
- `src-tauri/src/model.rs` — `WorkspaceGithub`, поле `Workspace.github`.
- `src-tauri/src/pty.rs` — параметр `env` у `spawn`.
- `src-tauri/src/commands.rs` — резолв на старте сессии, новые команды.
- `src-tauri/src/main.rs` — регистрация модуля `gh` и новых команд.
- `src/ipc.ts` — типы и обёртки вызовов.
- `src/forms.ts` — блок GitHub в форме воркспейса.
- `src/workspaces.ts` — метка аккаунта и счётчики у строки воркспейса.
- `src/sessions.ts` — проброс `workspaceId`, бейдж деградации, служебный тайл команды.
- `src/main.ts` — пункт палитры «GitHub».
- `src/styles.css` — стили экрана, метки, бейджа.
- `README.md` — раздел про аккаунты и `COWORK_GH_PATH`.

Граница проведена так: **весь Rust, знающий про `gh`, живёт в одном `gh.rs`**, а `commands.rs` только склеивает его со стором и PTY. Во фронте чистая логика (`github.ts`) отделена от DOM (`github-screen.ts`), потому что тестируется только первая.

---

### Task 1: Модель `WorkspaceGithub` и обратная совместимость

**Files:**
- Modify: `src-tauri/src/model.rs:14-19` (struct `Workspace`), тесты в `mod tests` того же файла
- Modify: `src/ipc.ts:5` (интерфейс `Workspace`)

**Interfaces:**
- Consumes: ничего
- Produces: Rust `WorkspaceGithub { host: String, login: String, git_name: Option<String>, git_email: Option<String>, ssh_key: Option<String> }`, поле `Workspace.github: Option<WorkspaceGithub>`; TS `WorkspaceGithub { host, login, gitName?, gitEmail?, sshKey? }`, поле `Workspace.github?: WorkspaceGithub | null`

- [ ] **Step 1: Write the failing tests**

В `src-tauri/src/model.rs`, внутри `mod tests`:

```rust
    #[test]
    fn old_workspace_without_github_deserializes_to_none() {
        let old = r#"{"id":"w1","name":"proj","path":"/tmp/proj","color":"#61afef"}"#;
        let ws: Workspace = serde_json::from_str(old).unwrap();
        assert!(ws.github.is_none());
    }

    #[test]
    fn workspace_without_github_serializes_without_the_field() {
        let ws = Workspace {
            id: "w1".into(), name: "proj".into(), path: "/tmp/proj".into(),
            color: "#61afef".into(), github: None,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(!json.contains("github"), "старая форма файла должна остаться байт-в-байт: {json}");
    }

    #[test]
    fn workspace_github_round_trips_with_camel_case_keys() {
        let ws = Workspace {
            id: "w1".into(), name: "proj".into(), path: "/tmp/proj".into(), color: "#61afef".into(),
            github: Some(WorkspaceGithub {
                host: "github.com".into(),
                login: "followLemmi".into(),
                git_name: Some("Evgeny".into()),
                git_email: Some("e@example.com".into()),
                ssh_key: None,
            }),
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains(r#""gitName":"Evgeny""#), "{json}");
        assert!(!json.contains("sshKey"), "пустые поля не сериализуются: {json}");
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.github, ws.github);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml model::tests`
Expected: FAIL — компиляция не проходит, `WorkspaceGithub` не найден, у `Workspace` нет поля `github`.

- [ ] **Step 3: Write minimal implementation**

В `src-tauri/src/model.rs` заменить struct `Workspace` и добавить рядом новый тип:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceGithub {
    /// Хост GitHub. В UI фазы 1 всегда "github.com"; поле существует, чтобы
    /// GHES можно было добавить без миграции файла.
    pub host: String,
    /// Имя аккаунта в gh (`gh auth status`). Публичное значение, НЕ секрет.
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitName")]
    pub git_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitEmail")]
    pub git_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sshKey")]
    pub ssh_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    /// Привязка к GitHub-аккаунту. Отсутствует в файлах, записанных до
    /// появления фичи; None не сериализуется, поэтому непривязанные
    /// воркспейсы сохраняют прежнюю форму на диске.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<WorkspaceGithub>,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, 32 passed (29 базовых + 3 новых). Если компилятор ругается на конструирование `Workspace` в других местах — добавить там `github: None`.

- [ ] **Step 5: Зеркалить типы во фронте**

В `src/ipc.ts` заменить строку с интерфейсом `Workspace`:

```ts
export interface WorkspaceGithub {
  host: string;
  login: string;
  gitName?: string;
  gitEmail?: string;
  sshKey?: string;
}
export interface Workspace {
  id: string; name: string; path: string; color: string;
  github?: WorkspaceGithub | null;
}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: чисто, 131 passed.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/model.rs src/ipc.ts
git commit -m "feat(github): workspace carries an optional GitHub account binding"
```

---

### Task 2: Детект `gh` и парсинг списка аккаунтов

**Files:**
- Create: `src-tauri/src/gh.rs`
- Modify: `src-tauri/src/main.rs` (добавить `mod gh;`)

**Interfaces:**
- Consumes: ничего
- Produces: `gh::GhAccount { host: String, login: String, active: bool, scopes: Vec<String>, state: String }`, `gh::GhStatus { path: Option<String>, version: Option<String>, accounts: Vec<GhAccount> }`, `gh::parse_auth_status(json: &str) -> Vec<GhAccount>`, `gh::which_gh() -> Option<String>`, `gh::status() -> GhStatus`

- [ ] **Step 1: Write the failing test**

Создать `src-tauri/src/gh.rs` с одним только тестовым модулем и заглушками не создавать — писать сразу тест, он не скомпилируется, это и есть красная фаза. Содержимое файла на этом шаге:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Сначала подключить модуль — в `src-tauri/src/main.rs` рядом с остальными `mod`-строками добавить `mod gh;`.

Run: `cargo test --manifest-path src-tauri/Cargo.toml gh::`
Expected: FAIL — `cannot find function parse_auth_status`, `cannot find type GhAccount`.

- [ ] **Step 3: Write minimal implementation**

Вставить в начало `src-tauri/src/gh.rs`, перед `mod tests`:

```rust
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
    let mut out = Vec::new();
    for (host, entries) in hosts {
        for e in entries.as_array().unwrap_or(&Vec::new()) {
            let login = e.get("login").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if login.is_empty() { continue; }
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
        if !p.is_empty() { return Some(p); }
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gh::`
Expected: PASS, 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh.rs src-tauri/src/main.rs
git commit -m "feat(github): detect gh and parse its account list"
```

---

### Task 3: Контракт окружения — `session_env`

Это ядро фичи. Функция чистая: на вход конфиг и (опционально) токен, на выход список переменных. Ни ввода-вывода, ни глобального состояния — поэтому вся семантика проверяется юнит-тестами.

**Files:**
- Modify: `src-tauri/src/gh.rs`

**Interfaces:**
- Consumes: `model::WorkspaceGithub` (Task 1)
- Produces: `gh::session_env(cfg: &WorkspaceGithub, token: Option<&str>, noauth_dir: &str) -> Vec<(String, String)>`

- [ ] **Step 1: Write the failing tests**

Добавить в `mod tests` в `src-tauri/src/gh.rs`:

```rust
    use crate::model::WorkspaceGithub;

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
            host: "github.com".into(), login: "followLemmi".into(),
            git_name: None, git_email: None, ssh_key: None,
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
        for k in ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_AUTHOR_EMAIL",
                  "GIT_COMMITTER_EMAIL", "GIT_SSH_COMMAND"] {
            assert_eq!(get(&env, k), None, "{k} не должна появляться — наследование из ~/.gitconfig");
        }
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gh::`
Expected: FAIL — `cannot find function session_env`.

- [ ] **Step 3: Write minimal implementation**

Добавить в `src-tauri/src/gh.rs` (перед `mod tests`):

```rust
use crate::model::WorkspaceGithub;

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gh::`
Expected: PASS, 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh.rs
git commit -m "feat(github): pure session_env builds the per-workspace environment contract"
```

---

### Task 4: Резолв токена с таймаутом и редактирование секретов

**Files:**
- Modify: `src-tauri/src/gh.rs`

**Interfaces:**
- Consumes: `gh::which_gh` (Task 2)
- Produces: `gh::redact(msg: &str) -> String`, `gh::token(host: &str, login: &str, timeout: std::time::Duration) -> Result<String, String>`

- [ ] **Step 1: Write the failing tests**

Добавить в `mod tests` в `src-tauri/src/gh.rs`:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gh::redact`
Expected: FAIL — `cannot find function redact`.

- [ ] **Step 3: Write minimal implementation**

Добавить в `src-tauri/src/gh.rs`:

```rust
const TOKEN_PREFIXES: [&str; 6] = ["gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_"];

/// Вырезает всё, что похоже на токен GitHub, из текста перед логированием или
/// отдачей во фронт. Работает по префиксам, а не по конкретному значению:
/// токен мог прийти из stderr gh, и мы его тогда не знаем.
pub fn redact(msg: &str) -> String {
    let is_tokenish = |w: &str| TOKEN_PREFIXES.iter().any(|p| w.starts_with(p));
    msg.split_inclusive(char::is_whitespace)
        .map(|chunk| {
            let trimmed_end = chunk.trim_end();
            let ws = &chunk[trimmed_end.len()..];
            // Отделяем «обёртку» из пунктуации, чтобы (gho_abc) тоже поймать.
            let start = trimmed_end
                .find(|c: char| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(trimmed_end.len());
            let (lead, rest) = trimmed_end.split_at(start);
            let end = rest
                .rfind(|c: char| c.is_ascii_alphanumeric() || c == '_')
                .map(|i| i + rest[i..].chars().next().map_or(1, |c| c.len_utf8()))
                .unwrap_or(0);
            let (core, tail) = rest.split_at(end);
            if is_tokenish(core) {
                format!("{lead}<redacted>{tail}{ws}")
            } else {
                chunk.to_string()
            }
        })
        .collect()
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
            if t.is_empty() { Err("gh вернул пустой токен".into()) } else { Ok(t) }
        }
        Ok(Ok(o)) => Err(redact(String::from_utf8_lossy(&o.stderr).trim())),
        Ok(Err(e)) => Err(redact(&e.to_string())),
        // Поток остаётся висеть на заблокированном keyring — он отвалится сам,
        // когда диалог закроют. Мы его не ждём.
        Err(_) => Err("gh не ответил вовремя (возможно, залочен keyring)".into()),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gh::`
Expected: PASS, 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gh.rs
git commit -m "feat(github): resolve account tokens with a timeout, redact secrets from errors"
```

---

### Task 5: `PtyManager::spawn` принимает окружение

**Files:**
- Modify: `src-tauri/src/pty.rs:22-48` (сигнатура и сборка `CommandBuilder`), тест в `mod tests` того же файла
- Modify: `src-tauri/src/commands.rs` (единственный существующий вызов `spawn`)

**Interfaces:**
- Consumes: ничего
- Produces: `PtyManager::spawn(&self, session: &str, program: &str, args: &[String], cwd: &str, env: &[(String, String)], cols: u16, rows: u16, on_output: F, on_exit: impl Fn(bool))`

- [ ] **Step 1: Write the failing test**

В `src-tauri/src/pty.rs`, в `mod tests`, рядом с `spawns_streams_output_and_exits`:

```rust
    #[test]
    fn injected_env_reaches_the_child_process() {
        let mgr = PtyManager::new();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = seen.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        mgr.spawn(
            "envtest",
            "sh",
            &["-c".to_string(), "printf %s \"$COWORK_TEST_VAR\"".to_string()],
            ".",
            &[("COWORK_TEST_VAR".to_string(), "injected-value".to_string())],
            80, 24,
            move |bytes| sink.lock().unwrap().push_str(&String::from_utf8_lossy(&bytes)),
            move |_ok| { let _ = tx.send(()); },
        )
        .unwrap();
        rx.recv_timeout(std::time::Duration::from_secs(10)).expect("процесс не завершился");
        assert!(
            seen.lock().unwrap().contains("injected-value"),
            "дочерний процесс не увидел инжектированную переменную: {:?}",
            seen.lock().unwrap()
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::`
Expected: FAIL — компиляция: `spawn` принимает 8 аргументов, передано 9.

- [ ] **Step 3: Write minimal implementation**

В `src-tauri/src/pty.rs` в сигнатуре `spawn` добавить параметр после `cwd`:

```rust
        cwd: &str,
        env: &[(String, String)],
        cols: u16,
```

и сразу после `cmd.cwd(cwd);`:

```rust
        // Переменные воркспейса задаются только дочернему процессу. Окружение
        // самого приложения и других сессий не затрагивается — именно на этом
        // стоит изоляция аккаунтов.
        for (k, v) in env {
            cmd.env(k, v);
        }
```

- [ ] **Step 4: Обновить существующий вызов**

В `src-tauri/src/commands.rs` в `start_session` найти вызов `state.pty.spawn(` и добавить `&[],` сразу после аргумента `&cwd`. Существующий тест `spawns_streams_output_and_exits` — тоже добавить `&[],` после `"."`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, 33 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty.rs src-tauri/src/commands.rs
git commit -m "feat(pty): spawn accepts per-session environment variables"
```

---

### Task 6: Инжект на старте сессии

**Files:**
- Modify: `src-tauri/src/commands.rs` (`start_session`)
- Modify: `src/ipc.ts` (`startSession`, тип `SessionAuth`)
- Modify: `src/sessions.ts` (проброс `workspaceId` в вызов)

**Interfaces:**
- Consumes: `gh::token`, `gh::session_env` (Tasks 3–4), `PtyManager::spawn` с env (Task 5), `Workspace.github` (Task 1)
- Produces: Rust `SessionAuth { account: Option<String>, degraded: Option<String> }`, `start_session(..., workspace_id: Option<String>) -> Result<SessionAuth, String>`; TS `SessionAuth { account: string | null; degraded: string | null }`, `startSession(session, cwd, initialPrompt, cols, rows, resume, workspaceId?) => Promise<SessionAuth>`

- [ ] **Step 1: Write the failing test**

Резолв целиком — это I/O, поэтому тестируем выделенное решение, а не команду. В `src-tauri/src/commands.rs`, в `mod tests` (создать, если его нет — `#[cfg(test)] mod tests { use super::*; ... }`):

```rust
    use crate::model::WorkspaceGithub;

    #[test]
    fn no_binding_means_no_env_and_no_badge() {
        let outcome = resolve_session_auth(None, "/tmp/noauth", std::time::Duration::from_secs(5));
        assert!(outcome.env.is_empty());
        assert_eq!(outcome.auth.account, None);
        assert_eq!(outcome.auth.degraded, None);
    }

    #[test]
    fn binding_to_an_unknown_account_degrades_but_keeps_identity() {
        let cfg = WorkspaceGithub {
            host: "github.com".into(),
            login: "definitely-not-a-real-account-xyz".into(),
            git_name: Some("Evgeny".into()),
            git_email: None,
            ssh_key: None,
        };
        let outcome = resolve_session_auth(Some(&cfg), "/tmp/noauth", std::time::Duration::from_secs(5));
        assert_eq!(outcome.auth.account.as_deref(), Some("definitely-not-a-real-account-xyz"));
        assert!(outcome.auth.degraded.is_some(), "должна быть причина деградации");
        let keys: Vec<&str> = outcome.env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"GH_CONFIG_DIR"));
        assert!(keys.contains(&"GIT_AUTHOR_NAME"));
        assert!(!keys.contains(&"GH_TOKEN"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::`
Expected: FAIL — `cannot find function resolve_session_auth`.

- [ ] **Step 3: Write minimal implementation**

В `src-tauri/src/commands.rs` добавить:

```rust
use crate::gh;
use crate::model::WorkspaceGithub;

/// Что фронт узнаёт про аккаунт стартовавшей сессии. Токена здесь нет и быть
/// не может — только имя аккаунта и, если что-то пошло не так, причина.
#[derive(Debug, Clone, Serialize)]
pub struct SessionAuth {
    pub account: Option<String>,
    pub degraded: Option<String>,
}

pub struct AuthOutcome {
    pub env: Vec<(String, String)>,
    pub auth: SessionAuth,
}

/// Резолвит привязку воркспейса в окружение сессии. Сбой резолва НЕ блокирует
/// старт: сессия поднимается в деградированном режиме (см. gh::session_env).
pub fn resolve_session_auth(
    cfg: Option<&WorkspaceGithub>,
    noauth_dir: &str,
    timeout: std::time::Duration,
) -> AuthOutcome {
    let cfg = match cfg {
        Some(c) => c,
        None => return AuthOutcome { env: Vec::new(), auth: SessionAuth { account: None, degraded: None } },
    };
    match gh::token(&cfg.host, &cfg.login, timeout) {
        Ok(t) => AuthOutcome {
            env: gh::session_env(cfg, Some(&t), noauth_dir),
            auth: SessionAuth { account: Some(cfg.login.clone()), degraded: None },
        },
        Err(reason) => AuthOutcome {
            env: gh::session_env(cfg, None, noauth_dir),
            auth: SessionAuth { account: Some(cfg.login.clone()), degraded: Some(reason) },
        },
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::`
Expected: PASS, 2 passed. (Второй тест зовёт настоящий `gh`; если `gh` не установлен, он всё равно проходит — ветка деградации та же.)

- [ ] **Step 5: Подключить резолв к `start_session`**

В `src-tauri/src/commands.rs` в сигнатуре `start_session` добавить параметр перед `resume`:

```rust
    workspace_id: Option<String>,
    resume: bool,
) -> Result<SessionAuth, String> {
```

Сразу после строки `let program = which_claude()...`:

```rust
    let cfg = workspace_id.as_ref().and_then(|id| {
        state.store.lock().unwrap().workspaces().into_iter().find(|w| &w.id == id)?.github
    });
    let noauth_dir = state.store.lock().unwrap().dir.join("gh-noauth");
    let _ = std::fs::create_dir_all(&noauth_dir);
    let outcome = resolve_session_auth(
        cfg.as_ref(),
        &noauth_dir.to_string_lossy(),
        std::time::Duration::from_secs(5),
    );
```

В вызове `state.pty.spawn(...)` заменить `&[]` (из Task 5) на `&outcome.env`. В конце функции вернуть `Ok(outcome.auth)` вместо `Ok(())`.

- [ ] **Step 6: Обновить фронт**

В `src/ipc.ts`:

```ts
export interface SessionAuth { account: string | null; degraded: string | null; }

export const startSession = (
  session: string, cwd: string, initialPrompt: string | null, cols: number, rows: number,
  resume: boolean, workspaceId?: string | null,
) => invoke<SessionAuth>("start_session", {
  session, cwd, initialPrompt, cols, rows, resume, workspaceId: workspaceId ?? null,
});
```

В `src/sessions.ts` найти вызов `startSession(` (внутри `openTile`, около строки 170, где уже деструктурирован `workspaceId`) и передать его последним аргументом:

```ts
    const auth = await startSession(session, cwd, prompt, cols, rows, resume, workspaceId ?? null);
```

Пока результат `auth` только сохраняется в объекте тайла — бейдж рисуется в Task 12. Добавить поле в тип тайла: `auth?: SessionAuth`.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: чисто, 131 vitest, 35 cargo.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs src/ipc.ts src/sessions.ts
git commit -m "feat(github): inject the workspace account environment when a session starts"
```

---

### Task 7: Команды `gh_status` и `host_platform`

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs` (`invoke_handler`)
- Modify: `src/ipc.ts`

**Interfaces:**
- Consumes: `gh::status` (Task 2)
- Produces: TS `GhAccount`, `GhStatus`, `HostPlatform { os: "macos" | "windows" | "linux"; distro: string | null }`, `ghStatus()`, `hostPlatform()`

- [ ] **Step 1: Write the failing test**

В `src-tauri/src/commands.rs`, в `mod tests`:

```rust
    #[test]
    fn linux_distro_id_is_taken_from_os_release() {
        let sample = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\n";
        assert_eq!(parse_os_release_id(sample).as_deref(), Some("ubuntu"));
        assert_eq!(parse_os_release_id("ID=fedora\n").as_deref(), Some("fedora"));
        assert_eq!(parse_os_release_id("NAME=\"Weird\"\n"), None);
        assert_eq!(parse_os_release_id(""), None);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::linux_distro`
Expected: FAIL — `cannot find function parse_os_release_id`.

- [ ] **Step 3: Write minimal implementation**

В `src-tauri/src/commands.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct HostPlatform {
    /// "macos" | "windows" | "linux"
    pub os: String,
    /// ID дистрибутива из /etc/os-release; None на macOS/Windows.
    pub distro: Option<String>,
}

/// Достаёт `ID=` из /etc/os-release. Кавычки вокруг значения допустимы.
pub fn parse_os_release_id(contents: &str) -> Option<String> {
    contents.lines().find_map(|l| {
        l.strip_prefix("ID=")
            .map(|v| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
    })
}

#[tauri::command]
pub fn host_platform() -> HostPlatform {
    let os = if cfg!(target_os = "macos") { "macos" }
        else if cfg!(target_os = "windows") { "windows" }
        else { "linux" };
    let distro = if os == "linux" {
        std::fs::read_to_string("/etc/os-release").ok().as_deref().and_then(parse_os_release_id)
    } else { None };
    HostPlatform { os: os.to_string(), distro }
}

#[tauri::command]
pub fn gh_status() -> gh::GhStatus {
    gh::status()
}
```

В `src-tauri/src/main.rs` дописать обе команды в `tauri::generate_handler![...]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::`
Expected: PASS, 3 passed.

- [ ] **Step 5: Обёртки во фронте**

В `src/ipc.ts`:

```ts
export interface GhAccount { host: string; login: string; active: boolean; scopes: string[]; state: string; }
export interface GhStatus { path: string | null; version: string | null; accounts: GhAccount[]; }
export interface HostPlatform { os: "macos" | "windows" | "linux"; distro: string | null; }

export const ghStatus = () => invoke<GhStatus>("gh_status");
export const hostPlatform = () => invoke<HostPlatform>("host_platform");
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && cargo test --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src/ipc.ts
git commit -m "feat(github): expose gh status and host platform to the frontend"
```

---

### Task 8: Чистые функции фронта — `src/github.ts`

**Files:**
- Create: `src/github.ts`, `tests/github.test.ts`

**Interfaces:**
- Consumes: `GhAccount`, `GhStatus`, `HostPlatform` (Task 7)
- Produces: `installCommand(p: HostPlatform): string`, `missingScopes(acc: GhAccount): string[]`, `scopeWarning(acc: GhAccount): string | null`, `accountChoices(status: GhStatus, savedLogin?: string | null): AccountChoice[]` где `AccountChoice = { value: string; label: string; missing: boolean }`

- [ ] **Step 1: Write the failing tests**

Создать `tests/github.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { installCommand, missingScopes, scopeWarning, accountChoices } from "../src/github";
import type { GhAccount, GhStatus } from "../src/ipc";

const acc = (over: Partial<GhAccount> = {}): GhAccount => ({
  host: "github.com", login: "followLemmi", active: false,
  scopes: ["gist", "read:org", "repo", "workflow"], state: "success", ...over,
});

describe("installCommand", () => {
  it("uses the native package manager per platform", () => {
    expect(installCommand({ os: "macos", distro: null })).toBe("brew install gh");
    expect(installCommand({ os: "windows", distro: null })).toBe("winget install --id GitHub.cli");
    expect(installCommand({ os: "linux", distro: "ubuntu" })).toBe("sudo apt install gh");
    expect(installCommand({ os: "linux", distro: "debian" })).toBe("sudo apt install gh");
    expect(installCommand({ os: "linux", distro: "fedora" })).toBe("sudo dnf install gh");
    expect(installCommand({ os: "linux", distro: "arch" })).toBe("sudo pacman -S github-cli");
    expect(installCommand({ os: "linux", distro: "opensuse-tumbleweed" }))
      .toBe("sudo zypper install gh");
  });

  it("falls back to the documented installer for unknown distros", () => {
    // Поле в UI редактируемое: угадывать наугад хуже, чем честно предложить доку.
    expect(installCommand({ os: "linux", distro: "voidlinux" }))
      .toBe("# см. https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
    expect(installCommand({ os: "linux", distro: null }))
      .toBe("# см. https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
  });
});

describe("missingScopes", () => {
  it("reports repo as missing when absent", () => {
    expect(missingScopes(acc())).toEqual([]);
    expect(missingScopes(acc({ scopes: ["gist"] }))).toEqual(["repo"]);
  });
});

describe("scopeWarning", () => {
  it("warns in Russian only when something is missing", () => {
    expect(scopeWarning(acc())).toBeNull();
    expect(scopeWarning(acc({ scopes: ["gist"] })))
      .toBe("у аккаунта нет скоупа repo — приватные репозитории будут недоступны");
  });
});

describe("accountChoices", () => {
  const status = (accounts: GhAccount[]): GhStatus => ({ path: "gh", version: "gh version 2.82.1", accounts });

  it("puts the unbound option first and marks the active account", () => {
    const choices = accountChoices(status([acc({ login: "a", active: true }), acc({ login: "b" })]));
    expect(choices[0]).toEqual({ value: "", label: "— не привязан —", missing: false });
    expect(choices[1].value).toBe("a");
    expect(choices[1].label).toBe("a (активный в gh)");
    expect(choices[2].label).toBe("b");
  });

  it("keeps a saved login that gh no longer knows, flagged as missing", () => {
    const choices = accountChoices(status([acc({ login: "a" })]), "gone");
    const stale = choices.find((c) => c.value === "gone");
    expect(stale).toBeDefined();
    expect(stale!.missing).toBe(true);
    expect(stale!.label).toBe("gone (не найден в gh)");
  });

  it("offers only the unbound option when gh is absent", () => {
    expect(accountChoices({ path: null, version: null, accounts: [] })).toEqual([
      { value: "", label: "— не привязан —", missing: false },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github.test.ts`
Expected: FAIL — `Failed to resolve import "../src/github"`.

- [ ] **Step 3: Write minimal implementation**

Создать `src/github.ts`:

```ts
// Чистые функции GitHub-интеграции: ничего не знают о DOM и о Tauri, поэтому
// целиком покрываются юнит-тестами. Всё, что рисует — в github-screen.ts.

import type { GhAccount, GhStatus, HostPlatform } from "./ipc";

const LINUX_DOC = "# см. https://github.com/cli/cli/blob/trunk/docs/install_linux.md";

const APT = new Set(["ubuntu", "debian", "linuxmint", "pop", "raspbian"]);
const DNF = new Set(["fedora", "rhel", "centos", "rocky", "almalinux"]);
const PACMAN = new Set(["arch", "manjaro", "endeavouros"]);
const ZYPPER = new Set(["opensuse", "opensuse-tumbleweed", "opensuse-leap", "sles"]);

/** Команда установки gh для платформы. Результат подставляется в
 *  РЕДАКТИРУЕМОЕ поле: определение пакетного менеджера — эвристика, и
 *  последнее слово должно оставаться за пользователем. */
export function installCommand(p: HostPlatform): string {
  if (p.os === "macos") return "brew install gh";
  if (p.os === "windows") return "winget install --id GitHub.cli";
  const d = p.distro ?? "";
  if (APT.has(d)) return "sudo apt install gh";
  if (DNF.has(d)) return "sudo dnf install gh";
  if (PACMAN.has(d)) return "sudo pacman -S github-cli";
  if (ZYPPER.has(d)) return "sudo zypper install gh";
  return LINUX_DOC;
}

const REQUIRED_SCOPES = ["repo"];

/** Скоупы, без которых списки PR/issues по приватным репозиториям не работают. */
export function missingScopes(acc: GhAccount): string[] {
  return REQUIRED_SCOPES.filter((s) => !acc.scopes.includes(s));
}

export function scopeWarning(acc: GhAccount): string | null {
  const missing = missingScopes(acc);
  if (!missing.length) return null;
  return `у аккаунта нет скоупа ${missing.join(", ")} — приватные репозитории будут недоступны`;
}

export interface AccountChoice { value: string; label: string; missing: boolean; }

/** Варианты для селекта в форме воркспейса. Сохранённый логин, которого gh
 *  больше не знает, НЕ выбрасывается — иначе правка любого другого поля тихо
 *  снесла бы привязку. */
export function accountChoices(status: GhStatus, savedLogin?: string | null): AccountChoice[] {
  const choices: AccountChoice[] = [{ value: "", label: "— не привязан —", missing: false }];
  for (const a of status.accounts) {
    choices.push({
      value: a.login,
      label: a.active ? `${a.login} (активный в gh)` : a.login,
      missing: false,
    });
  }
  if (savedLogin && !status.accounts.some((a) => a.login === savedLogin)) {
    choices.push({ value: savedLogin, label: `${savedLogin} (не найден в gh)`, missing: true });
  }
  return choices;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/github.test.ts`
Expected: PASS, 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/github.ts tests/github.test.ts
git commit -m "feat(github): pure helpers for install command, scopes and account choices"
```

---

### Task 9: Служебный тайл с произвольной командой

Нужен, чтобы установка `gh` и `gh auth login` шли в настоящем терминале на глазах у пользователя. **Ключевое требование:** такой тайл не попадает в автовосстановление — иначе `sudo apt install` перезапустится сам при следующем старте приложения.

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`
- Modify: `src/ipc.ts`, `src/sessions.ts`
- Modify: `tests/sessions.test.ts` (проверка исключения из layout)

**Interfaces:**
- Consumes: `PtyManager::spawn` с env (Task 5)
- Produces: Rust `start_command_session(app, state, session: String, cwd: String, command: String, cols: u16, rows: u16) -> Result<(), String>`; TS `startCommandSession(session, cwd, command, cols, rows)`, `Deck.openCommandTile(titleText: string, command: string, cwd: string): void`

- [ ] **Step 1: Write the failing test**

В `tests/sessions.test.ts` (использует существующий там же хелпер сборки списка тайлов; если тесты layout живут в `tests/layout.test.ts` — добавить туда, рядом с проверками `toLayout`):

```ts
  it("служебные тайлы команд не попадают в сохраняемый layout", () => {
    const tiles = [
      { session: "s1", workspacePath: "/w", name: "проект", workspaceId: "w1" },
      { session: "cmd1", workspacePath: "/w", name: "установка gh", workspaceId: "w1", kind: "command" as const },
    ];
    const layout = toLayout(tiles);
    expect(layout.map((e) => e.sessionId)).toEqual(["s1"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sessions.test.ts`
Expected: FAIL — в layout попадают оба тайла (или ошибка типов на поле `kind`).

- [ ] **Step 3: Исключить командные тайлы из layout**

В `src/sessions.ts` найти `toLayout` (около строки 621) и добавить фильтр. Расширить принимаемый тип полем `kind?: "claude" | "command"`:

```ts
export function toLayout(
  tiles: { session: string; workspacePath: string; name: string; workspaceId?: string; kind?: "claude" | "command" }[],
): SessionEntry[] {
  return tiles
    // Командный тайл — разовое действие пользователя (установка пакета, вход в
    // аккаунт). Восстанавливать его на следующем запуске нельзя: это молча
    // выполнило бы sudo-команду без спроса.
    .filter((t) => t.kind !== "command")
    .map((t) => ({
      session: t.session, ...
    }));
}
```

(Сохранить существующее тело `.map(...)` без изменений.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Бэкенд-команда**

В `src-tauri/src/commands.rs`:

```rust
/// Запускает произвольную команду в PTY-тайле. Команду пишет пользователь и
/// видит её целиком до запуска (форма установки gh). Хуки Claude Code сюда не
/// подставляются — это не сессия агента, а обычный терминал.
#[tauri::command]
pub fn start_command_session(
    app: AppHandle,
    state: State<AppState>,
    session: String,
    cwd: String,
    command: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (program, args) = if cfg!(windows) {
        ("cmd".to_string(), vec!["/C".to_string(), command])
    } else {
        ("sh".to_string(), vec!["-lc".to_string(), command])
    };

    let app_out = app.clone();
    let sess_out = session.clone();
    let on_output = move |bytes: Vec<u8>| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = app_out.emit("session://output", OutputPayload { session: sess_out.clone(), data_b64: b64 });
    };
    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |ok: bool| {
        let _ = app_exit.emit("session://exit", ExitPayload { session: sess_exit.clone(), ok });
    };

    state
        .pty
        .spawn(&session, &program, &args, &cwd, &[], cols, rows, on_output, on_exit)
        .map_err(|e| e.to_string())
}
```

> Имена структур `OutputPayload` / `ExitPayload` взять те же, что уже использует `start_session` в этом файле.

Зарегистрировать `start_command_session` в `invoke_handler` в `src-tauri/src/main.rs`.

- [ ] **Step 6: Обёртка и тайл во фронте**

В `src/ipc.ts`:

```ts
export const startCommandSession = (
  session: string, cwd: string, command: string, cols: number, rows: number,
) => invoke<void>("start_command_session", { session, cwd, command, cols, rows });
```

В `src/sessions.ts` добавить метод класса `Deck` рядом с существующим `openTile`, переиспользуя его DOM-часть: создать тайл с `kind: "command"`, заголовком `titleText`, без кнопки перезапуска и без участия в broadcast, и вызвать `startCommandSession` вместо `startSession`. Состояние такого тайла ведётся только по событию `session://exit` (`завершён` / `ошибка`).

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit && npm test && cargo test --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src/ipc.ts src/sessions.ts tests/sessions.test.ts
git commit -m "feat(deck): run a one-off command in a tile, excluded from auto-restore"
```

---

### Task 10: Экран «GitHub»

**Files:**
- Create: `src/github-screen.ts`
- Modify: `src/main.ts` (пункт палитры), `src/styles.css`

**Interfaces:**
- Consumes: `ghStatus`, `hostPlatform` (Task 7), `installCommand`, `scopeWarning` (Task 8), `Deck.openCommandTile` (Task 9)
- Produces: `openGithubScreen(deck: { openCommandTile(title: string, command: string, cwd: string): void }): Promise<void>`

- [ ] **Step 1: Собрать экран**

Создать `src/github-screen.ts`. Разметка — оверлей в стиле `forms.ts` (`modal-overlay` / `modal-box`), содержимое зависит от `ghStatus()`:

```ts
import { ghStatus, hostPlatform, type GhStatus } from "./ipc";
import { installCommand, scopeWarning } from "./github";

/** Экран «GitHub»: статус утилиты, список аккаунтов, установка и вход.
 *  Рисование и только рисование — вся логика в github.ts. */
export async function openGithubScreen(
  deck: { openCommandTile(title: string, command: string, cwd: string): void },
): Promise<void> {
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box gh-screen";
  ov.append(box);
  document.body.append(ov);
  const close = () => ov.remove();
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });

  const render = async () => {
    box.innerHTML = "";
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "GitHub";
    box.append(title);

    const status = await ghStatus();
    if (!status.path) {
      box.append(await notFoundBlock(deck, close));
    } else {
      box.append(foundBlock(status, deck, close));
    }

    const reload = document.createElement("button");
    reload.className = "modal-cancel";
    reload.textContent = "Перечитать";
    reload.onclick = () => void render();
    const done = document.createElement("button");
    done.className = "modal-ok";
    done.textContent = "Готово";
    done.onclick = close;
    const row = document.createElement("div");
    row.className = "modal-actions";
    row.append(reload, done);
    box.append(row);
  };

  await render();
}
```

- [ ] **Step 2: Блок «gh не найден»**

В том же файле:

```ts
async function notFoundBlock(
  deck: { openCommandTile(title: string, command: string, cwd: string): void },
  close: () => void,
): Promise<HTMLElement> {
  const wrap = document.createElement("div");
  const note = document.createElement("p");
  note.className = "gh-note";
  note.textContent =
    "GitHub CLI (gh) не найден. Без него воркспейс нельзя привязать к аккаунту — " +
    "всё остальное в приложении работает как обычно.";

  const cmd = document.createElement("input");
  cmd.className = "modal-input";
  cmd.type = "text";
  cmd.value = installCommand(await hostPlatform());

  const hint = document.createElement("p");
  hint.className = "gh-hint";
  hint.textContent = "Команду можно поправить перед запуском — она выполнится в обычном тайле-терминале.";

  const run = document.createElement("button");
  run.className = "modal-ok";
  run.textContent = "Установить";
  run.onclick = () => {
    deck.openCommandTile("установка gh", cmd.value, ".");
    close();
  };

  const docs = document.createElement("a");
  docs.className = "gh-link";
  docs.href = "https://github.com/cli/cli#installation";
  docs.target = "_blank";
  docs.rel = "noreferrer";
  docs.textContent = "Поставлю сам — открыть инструкцию";

  wrap.append(note, cmd, hint, run, docs);
  return wrap;
}
```

- [ ] **Step 3: Блок со списком аккаунтов**

```ts
function foundBlock(
  status: GhStatus,
  deck: { openCommandTile(title: string, command: string, cwd: string): void },
  close: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  const where = document.createElement("p");
  where.className = "gh-note";
  where.textContent = `${status.version ?? "gh"} — ${status.path}`;
  wrap.append(where);

  if (!status.accounts.length) {
    const empty = document.createElement("p");
    empty.className = "gh-note";
    empty.textContent = "Аккаунтов нет. Добавьте первый — вход проходит в терминале.";
    wrap.append(empty);
  }

  for (const a of status.accounts) {
    const row = document.createElement("div");
    row.className = "gh-acc-row";
    const name = document.createElement("span");
    name.className = "gh-acc-login";
    name.textContent = a.active ? `${a.login} · активный в gh` : a.login;
    const meta = document.createElement("span");
    meta.className = "gh-acc-meta";
    meta.textContent = a.state === "success" ? a.scopes.join(", ") : `состояние: ${a.state}`;
    row.append(name, meta);
    const warn = scopeWarning(a);
    if (warn) {
      const w = document.createElement("span");
      w.className = "gh-acc-warn";
      w.textContent = warn;
      row.append(w);
    }
    wrap.append(row);
  }

  const add = document.createElement("button");
  add.className = "modal-ok";
  add.textContent = "Добавить аккаунт";
  add.onclick = () => {
    // Device-flow пользователь проходит сам; токен через приложение не идёт.
    deck.openCommandTile("вход в GitHub", "gh auth login", ".");
    close();
  };
  wrap.append(add);
  return wrap;
}
```

- [ ] **Step 4: Пункт палитры и стили**

В `src/main.ts` добавить команду в список палитры (рядом с существующими), например:

```ts
  { id: "github", title: "GitHub: аккаунты и установка", run: () => void openGithubScreen(deck) },
```

В `src/styles.css` добавить стили `.gh-screen`, `.gh-note`, `.gh-hint`, `.gh-link`, `.gh-acc-row`, `.gh-acc-login`, `.gh-acc-meta`, `.gh-acc-warn`, используя существующие токены (`--fg-muted`, `--fg-subtle`, `--accent`, `--sp-2`, `--r-sm`). `.gh-acc-warn` — цветом предупреждения из палитры.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm test`

```bash
git add src/github-screen.ts src/main.ts src/styles.css
git commit -m "feat(github): GitHub screen with gh status, accounts, install and login"
```

---

### Task 11: Блок GitHub в форме воркспейса

**Files:**
- Modify: `src/forms.ts:47-113` (`workspaceForm`)
- Modify: `src/workspaces.ts` (`add`, `edit` — прокинуть `github`)

**Interfaces:**
- Consumes: `accountChoices` (Task 8), `ghStatus` (Task 7), `WorkspaceGithub` (Task 1)
- Produces: `workspaceForm(initial?: { name, path, color, github?: WorkspaceGithub | null }) => Promise<{ name, path, color, github: WorkspaceGithub | null } | null>`

- [ ] **Step 1: Расширить сигнатуру формы**

В `src/forms.ts` заменить сигнатуру и тип результата:

```ts
export function workspaceForm(
  initial?: { name: string; path: string; color: string; github?: WorkspaceGithub | null },
): Promise<{ name: string; path: string; color: string; github: WorkspaceGithub | null } | null> {
```

Импортировать сверху: `import { ghStatus, type WorkspaceGithub } from "./ipc";` и `import { accountChoices } from "./github";`.

- [ ] **Step 2: Добавить поля**

Внутри промиса, перед сборкой `box.append(...)`:

```ts
    const account = document.createElement("select");
    account.className = "modal-input form-gh-account";
    // gh может отсутствовать — тогда останется единственный пункт «не привязан».
    void ghStatus().then((st) => {
      for (const c of accountChoices(st, initial?.github?.login ?? null)) {
        const opt = document.createElement("option");
        opt.value = c.value;
        opt.textContent = c.label;
        if (c.missing) opt.classList.add("gh-missing");
        account.append(opt);
      }
      account.value = initial?.github?.login ?? "";
    });

    const gitName = document.createElement("input");
    gitName.className = "modal-input"; gitName.type = "text";
    gitName.placeholder = "как в глобальном .gitconfig";
    gitName.value = initial?.github?.gitName ?? "";

    const gitEmail = document.createElement("input");
    gitEmail.className = "modal-input"; gitEmail.type = "text";
    gitEmail.placeholder = "как в глобальном .gitconfig";
    gitEmail.value = initial?.github?.gitEmail ?? "";

    const sshKey = document.createElement("input");
    sshKey.className = "modal-input"; sshKey.type = "text";
    sshKey.placeholder = "путь к ключу для ssh-ремоутов (необязательно)";
    sshKey.value = initial?.github?.sshKey ?? "";

    const ghHint = document.createElement("p");
    ghHint.className = "form-hint";
    ghHint.textContent = "Применится к новым и перезапущенным сессиям — у живых окружение уже зафиксировано.";
```

В `box.append(...)` добавить после `colorRow`:

```ts
      labeled("Аккаунт GitHub", account),
      labeled("Имя в коммитах", gitName),
      labeled("Почта в коммитах", gitEmail),
      labeled("SSH-ключ", sshKey),
      ghHint,
```

- [ ] **Step 3: Собрать результат**

Заменить тело `ok.onclick`:

```ts
    ok.onclick = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n || !p) return; // требуются оба
      const login = account.value.trim();
      const trimmed = (el: HTMLInputElement) => {
        const v = el.value.trim();
        return v ? v : undefined;
      };
      // Пустой логин снимает привязку целиком: держать git-идентичность без
      // аккаунта — это отдельная фича, которой мы не обещали.
      const github: WorkspaceGithub | null = login
        ? {
            host: initial?.github?.host ?? "github.com",
            login,
            gitName: trimmed(gitName),
            gitEmail: trimmed(gitEmail),
            sshKey: trimmed(sshKey),
          }
        : null;
      close({ name: n, path: p, color, github });
    };
```

И тип в `close`:

```ts
    const close = (v: { name: string; path: string; color: string; github: WorkspaceGithub | null } | null) => { ov.remove(); resolve(v); };
```

- [ ] **Step 4: Прокинуть через панель**

В `src/workspaces.ts` в `edit()` заменить вызов формы:

```ts
    const res = await workspaceForm({ name: cur.name, path: cur.path, color: cur.color, github: cur.github ?? null });
```

`add()` и `saveWorkspace({ ...cur, ...res })` менять не нужно — новое поле проходит спредом.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm test`
Expected: чисто, 139 passed.

```bash
git add src/forms.ts src/workspaces.ts
git commit -m "feat(github): pick the workspace account and git identity in the workspace form"
```

---

### Task 12: Индикация аккаунта и деградации

**Files:**
- Modify: `src/workspaces.ts` (`render` — метка у строки)
- Modify: `src/sessions.ts` (бейдж на тайле по `SessionAuth`)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `SessionAuth` (Task 6), `Workspace.github` (Task 1)
- Produces: визуальная индикация; новых экспортов нет

- [ ] **Step 1: Метка аккаунта в сайдбаре**

В `src/workspaces.ts` в `render()`, после `label`:

```ts
      if (w.github) {
        const acc = document.createElement("span");
        acc.className = "ws-account";
        acc.textContent = w.github.login;
        acc.title = `GitHub: ${w.github.login}`;
        row.append(acc);
      }
```

(вставить в `row.append(dot, label, ...)` перед `edit`).

- [ ] **Step 2: Бейдж деградации на тайле**

В `src/sessions.ts`, там где в Task 6 сохранён `auth`, после старта сессии:

```ts
      if (auth.degraded) {
        const badge = document.createElement("span");
        badge.className = "tile-auth-badge";
        badge.textContent = "GitHub ✕";
        badge.title = `Аккаунт ${auth.account ?? ""} не подключён: ${auth.degraded}`;
        head.append(badge);
      }
```

Нормальное состояние бейджа не рисует вовсе — тайлы не засоряем.

- [ ] **Step 3: Пометка устаревшего окружения**

Там, где `WorkspacesPanel` сохраняет воркспейс (`saveWorkspace` в `add`/`edit`), сообщить деке, что привязка изменилась, и пометить живые тайлы этого воркспейса:

```ts
      const stale = document.createElement("span");
      stale.className = "tile-auth-badge stale";
      stale.textContent = "GitHub ⟳";
      stale.title = "Привязка воркспейса изменилась — окружение подхватится после перезапуска сессии";
```

Пометка снимается при перезапуске тайла (там же, где сбрасывается его состояние).

- [ ] **Step 4: Стили**

В `src/styles.css` добавить `.ws-account` (мелкий, `--fg-subtle`, обрезка многоточием) и `.tile-auth-badge` / `.tile-auth-badge.stale` (мелкий бейдж в шапке тайла, цвет предупреждения из палитры).

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm test`

```bash
git add src/workspaces.ts src/sessions.ts src/styles.css
git commit -m "feat(github): show the workspace account and flag degraded or stale sessions"
```

---

### Task 13: Документация и ручная проверка изоляции

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Раздел про аккаунты**

В список фич добавить пункт:

```markdown
- **GitHub-аккаунт на воркспейс** — привяжите воркспейс к аккаунту `gh`, и его сессии стартуют уже с нужным доступом: `gh pr list`, `git push` и коммиты идут от правильного лица. Разные воркспейсы могут работать на разных аккаунтах **одновременно** — приложение не переключает активный аккаунт `gh` и не трогает `~/.config/gh`.
```

Отдельным разделом после «Locating the `claude` binary»:

```markdown
## GitHub-аккаунты воркспейсов

Требуется [GitHub CLI](https://cli.github.com/) (`gh`), залогиненный в нужные аккаунты
(`gh auth login`). Экран «GitHub» в палитре команд покажет статус, список аккаунтов и
поможет установить `gh`, если его нет.

Токены приложение **не хранит**: в настройках воркспейса лежит только имя аккаунта, а токен
читается из keyring `gh` в момент старта сессии и передаётся дочернему процессу через
переменные окружения. Переключений (`gh auth switch`) приложение не делает — именно поэтому
сессии на разных аккаунтах не мешают друг другу.

Если `gh` лежит не на `PATH`, укажите путь через `COWORK_GH_PATH`.

Смена аккаунта у воркспейса действует на новые и перезапущенные сессии: окружение процесса
фиксируется при запуске и на лету не меняется.
```

- [ ] **Step 2: Заметка про свежий клон**

В раздел «Tests» добавить:

```markdown
> В свежем клоне (или git worktree) перед `cargo test` выполните один раз
> `npm install && npm run build && npm run stage:reporter` — `dist/` и `src-tauri/binaries/`
> не в git, а без них падает build-скрипт Tauri.
```

- [ ] **Step 3: Ручная проверка изоляции**

Главное обещание фичи автотестами не проверяется — прогнать руками и записать результат в PR:

1. Завести два воркспейса, привязанных к **разным** аккаунтам.
2. Запустить по сессии в каждом **одновременно**.
3. В каждой выполнить `gh auth status` — показывает свой аккаунт воркспейса.
4. `gh pr list` в приватном репозитории каждого — отдаёт результаты своего аккаунта.
5. В одной попробовать `gh auth switch` — gh отказывает; вторая сессия продолжает работать как ни в чём не бывало.
6. В своём терминале **вне** приложения выполнить `gh auth status` — активный аккаунт прежний, приложение его не меняло.
7. Сделать коммит в каждой сессии — `git log -1 --format='%an <%ae>'` показывает идентичность своего воркспейса.
8. Снять привязку у воркспейса, перезапустить сессию — окружение чистое, бейджей нет.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: per-workspace GitHub accounts"
```

---

## Self-review плана

**Покрытие спеки.** Каждый раздел спеки закрыт: модель данных → Task 1; `gh.rs` (детект, аккаунты, токен, env) → Tasks 2–4; `pty.rs` → Task 5; резолв в `start_session` → Task 6; команды `gh_status`/`host_platform` → Task 7; `github.ts` → Task 8; установка и логин через тайл → Tasks 9–10; форма воркспейса → Task 11; индикация → Task 12; README и ручная проверка изоляции → Task 13. Инвариант «токен не утекает» реализуется в Task 4 (`redact`) и проверяется в Tasks 3 и 6.

**Согласованность типов.** `WorkspaceGithub` (Task 1) используется в Tasks 3, 6, 11 с теми же именами полей; `SessionAuth` (Task 6) — в Task 12; `GhStatus`/`GhAccount` (Tasks 2, 7) — в Tasks 8, 10, 11. Сигнатура `session_env(cfg, token, noauth_dir)` одинакова в Tasks 3 и 6.

**Плейсхолдеры.** Проверено: «TBD», «добавить обработку ошибок», «аналогично Task N» и шагов без кода в плане нет. Единственные места, где вместо кода дано словесное описание, — стили (Tasks 10, 12): там перечислены конкретные классы, а точная разметка отдана реализующему, поскольку тестами она не покрывается и должна лечь в существующую сетку `styles.css`.

**Границы плана.** Показ PR и issues из плана исключён: эта территория принадлежит эпику [#48](https://github.com/followLemmi/cowork-deck/issues/48), и правильная её форма — GitHub-провайдер для порта `TaskProvider` после мержа трекера, а не второй счётчик в том же сайдбаре. См. раздел «Что дальше» в спеке.
