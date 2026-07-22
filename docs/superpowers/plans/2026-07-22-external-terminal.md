# External Terminal Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the embedded xterm terminal with launching each Claude Code session in an external terminal emulator (default `ghostty -e`, configurable), while keeping in-window state labels and OS notifications via the existing hook→listener path.

**Architecture:** A global setting holds a terminal command template. `launch_session` writes the per-session hook settings to a temp file, splits the template into argv, appends `claude --settings <file> [prompt]`, and spawns the terminal process (cwd = workspace path), tracking the child for kill-on-close. The frontend deck becomes a list of session cards (no xterm); state labels/notifications are driven by `session://state`.

**Tech Stack:** Rust, Tauri v2, `shell-words` (new); remove `portable-pty` usage for launching and the `base64` dep. TypeScript/Vite; remove `@xterm/*`.

## Global Constraints

- Keep unchanged: command/event/state naming that survives (`session://state`, `session://exit`, camelCase SessionState), workspaces/skills store behavior, 127.0.0.1-only listener, single user, cross-platform, sessions best-effort terminate with the window.
- Removed surface: `start_session`, `write_session`, `resize_session`, `session://output`, `src/terminal.ts`, `src-tauri/src/pty.rs`, the `base64` dependency, `@xterm/*` deps. Nothing else may call these afterward.
- Default terminal command template: **empty string = auto-detect the system default terminal**. The user may override with an explicit template (e.g. `ghostty -e`). Auto-detect per OS: Linux → `$TERMINAL -e` if `$TERMINAL` set, else `x-terminal-emulator -e` if present, else first found among `ghostty -e`/`wezterm start --`/`kitty`/`alacritty -e`/`gnome-terminal --`/`konsole -e`/`xterm -e`; Windows → `wt` if present else `cmd /c start`; macOS → best-effort `open -a Terminal` note (documented as possibly needing a custom template).
- Temp settings files: `<std::env::temp_dir()>/coworkdeck-<session>.json`.
- Spawning terminals uses Rust `std::process::Command` (no Tauri shell plugin, no new capability).

---

## Task 1: Settings in the config store

**Files:** Modify `src-tauri/src/store.rs`, `src-tauri/src/model.rs` (add `Settings`). Test: inline in store.rs.

**Interfaces produced:**
- `model::Settings { terminal_command: String }` with `#[serde(rename = "terminalCommand")]` and a `Default` of `""` (empty = auto-detect system default; resolved at launch time in Task 3).
- `Store::settings(&self) -> Settings` (returns Default if file missing/unreadable) and `Store::save_settings(&self, &Settings) -> std::io::Result<()>`, backed by `settings.json` in the config dir.

- [ ] **Step 1: Failing test** in store.rs:
```rust
#[test]
fn settings_default_then_roundtrip() {
    let s = Store::new(tmp());
    assert_eq!(s.settings().terminal_command, ""); // empty = auto-detect
    let mut cfg = s.settings();
    cfg.terminal_command = "wezterm start --".into();
    s.save_settings(&cfg).unwrap();
    assert_eq!(Store::new(s.dir.clone()).settings().terminal_command, "wezterm start --");
}
```
- [ ] **Step 2:** `cd src-tauri && cargo test store::tests::settings_default_then_roundtrip` → FAIL.
- [ ] **Step 3:** Add to `model.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "terminalCommand")]
    pub terminal_command: String,
}
impl Default for Settings {
    fn default() -> Self { Settings { terminal_command: String::new() } } // empty = auto-detect
}
```
Add to `store.rs`:
```rust
use crate::model::Settings;
// inside impl Store:
fn settings_path(&self) -> std::path::PathBuf { self.dir.join("settings.json") }
pub fn settings(&self) -> Settings {
    match std::fs::read_to_string(self.settings_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}
pub fn save_settings(&self, s: &Settings) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(s)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(self.settings_path(), json)
}
```
(Reading settings tolerating a missing file with Default is correct here — a missing settings file is the expected first-run state, unlike the workspaces/skills truncation concern; single scalar, no list to truncate.)
- [ ] **Step 4:** `cargo test store::tests::settings_default_then_roundtrip` → PASS.
- [ ] **Step 5:** Commit: `feat: terminal command setting in config store`.

---

## Task 2: Launch argv builder, temp settings file, external process manager

**Files:** Modify `src-tauri/src/hooks.rs` (temp-file writer); create `src-tauri/src/external.rs`; modify `src-tauri/Cargo.toml` (add `shell-words = "1"`); `main.rs` (`mod external;`). Tests: inline + integration.

**Interfaces produced:**
- `hooks::write_settings_file(reporter_path: &str, port: u16, session: &str) -> std::io::Result<std::path::PathBuf>` — writes `build_settings_json(...)` to `temp_dir()/coworkdeck-<session>.json`, returns the path.
- `external::detect_default_terminal() -> String` — returns a non-empty terminal command template for the current OS (see Global Constraints). Used to resolve an empty (auto) template.
- `external::build_launch_argv(template: &str, program: &str, settings_file: &str, prompt: &Option<String>) -> Result<Vec<String>, String>` — shell-splits `template`, errors if empty, then appends `program`, `"--settings"`, `settings_file`, and the prompt if present.
- `external::ExternalManager` with `new()`, `launch(&self, session: &str, argv: &[String], cwd: &str) -> std::io::Result<()>` (spawns `argv[0]` with `argv[1..]`, cwd set, stores the `Child`), `kill(&self, session: &str)`, `kill_all(&self)`.

- [ ] **Step 1: Failing tests.**
In `hooks.rs`:
```rust
#[test]
fn writes_settings_file_with_session_command() {
    let p = write_settings_file("/opt/cowork_report", 7777, "sess-file").unwrap();
    let body = std::fs::read_to_string(&p).unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().contains("sess-file"));
    let _ = std::fs::remove_file(p);
}
```
In `external.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_argv_from_template() {
        let argv = build_launch_argv("ghostty -e", "claude", "/tmp/s.json", &Some("do it".into())).unwrap();
        assert_eq!(argv, vec!["ghostty","-e","claude","--settings","/tmp/s.json","do it"]);
        let argv2 = build_launch_argv("wezterm start --", "claude", "/tmp/s.json", &None).unwrap();
        assert_eq!(argv2, vec!["wezterm","start","--","claude","--settings","/tmp/s.json"]);
        assert!(build_launch_argv("   ", "claude", "/tmp/s.json", &None).is_err());
    }
    #[test]
    fn detect_returns_nonempty() {
        // On any supported OS the resolver must yield a runnable prefix.
        assert!(!detect_default_terminal().trim().is_empty());
    }
    #[test]
    fn manager_launches_and_kills() {
        let m = ExternalManager::new();
        #[cfg(windows)]
        let argv: Vec<String> = ["cmd","/C","ping 127.0.0.1 -n 6"].iter().map(|s| s.to_string()).collect();
        #[cfg(not(windows))]
        let argv: Vec<String> = ["sh","-c","sleep 5"].iter().map(|s| s.to_string()).collect();
        m.launch("s1", &argv, ".").unwrap();
        m.kill_all(); // must not panic; child killed
    }
}
```
- [ ] **Step 2:** `cd src-tauri && cargo test hooks::tests::writes_settings_file_with_session_command external::tests` → FAIL (compile).
- [ ] **Step 3: Implement.** Add `shell-words = "1"` to `Cargo.toml` `[dependencies]`.
Append to `hooks.rs`:
```rust
pub fn write_settings_file(
    reporter_path: &str, port: u16, session: &str,
) -> std::io::Result<std::path::PathBuf> {
    let json = build_settings_json(reporter_path, port, session);
    let mut path = std::env::temp_dir();
    path.push(format!("coworkdeck-{}.json", session));
    std::fs::write(&path, json)?;
    Ok(path)
}
```
Create `src-tauri/src/external.rs`:
```rust
use std::collections::HashMap;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

/// Return a runnable terminal command template for the current OS. Used when the
/// user's template is empty ("auto"). Each candidate carries the correct flag to
/// run a command in that terminal.
pub fn detect_default_terminal() -> String {
    #[cfg(target_os = "windows")]
    {
        if which("wt") { return "wt".into(); }
        return "cmd /c start".into();
    }
    #[cfg(target_os = "macos")]
    {
        // Best-effort: Terminal.app via `open` needs a script wrapper for args, which
        // does not fit the prefix model. Fall back to a common terminal if present,
        // else return a Terminal.app hint the user can refine.
        for (bin, tmpl) in [("ghostty","ghostty -e"),("wezterm","wezterm start --"),("kitty","kitty"),("alacritty","alacritty -e")] {
            if which(bin) { return tmpl.into(); }
        }
        return "open -a Terminal".into();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(t) = std::env::var("TERMINAL") {
            if !t.trim().is_empty() { return format!("{} -e", t.trim()); }
        }
        if which("x-terminal-emulator") { return "x-terminal-emulator -e".into(); }
        for (bin, tmpl) in [
            ("ghostty","ghostty -e"), ("wezterm","wezterm start --"), ("kitty","kitty"),
            ("alacritty","alacritty -e"), ("gnome-terminal","gnome-terminal --"),
            ("konsole","konsole -e"), ("xterm","xterm -e"),
        ] {
            if which(bin) { return tmpl.into(); }
        }
        return "xterm -e".into();
    }
}

/// Is `bin` resolvable on PATH? Scans `$PATH` directly (no shell builtin, no crate).
fn which(bin: &str) -> bool {
    let path = match std::env::var_os("PATH") { Some(p) => p, None => return false };
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() { return true; }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                if dir.join(format!("{bin}.{ext}")).is_file() { return true; }
            }
        }
    }
    false
}

/// Split the terminal command template and append the claude invocation.
pub fn build_launch_argv(
    template: &str, program: &str, settings_file: &str, prompt: &Option<String>,
) -> Result<Vec<String>, String> {
    let mut argv = shell_words::split(template).map_err(|e| e.to_string())?;
    if argv.is_empty() {
        return Err("empty terminal command".into());
    }
    argv.push(program.to_string());
    argv.push("--settings".to_string());
    argv.push(settings_file.to_string());
    if let Some(p) = prompt {
        argv.push(p.clone());
    }
    Ok(argv)
}

#[derive(Clone)]
pub struct ExternalManager {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

impl ExternalManager {
    pub fn new() -> ExternalManager {
        ExternalManager { children: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn launch(&self, session: &str, argv: &[String], cwd: &str) -> std::io::Result<()> {
        // Replace any previous terminal for this session id.
        self.kill(session);
        let child = Command::new(&argv[0]).args(&argv[1..]).current_dir(cwd).spawn()?;
        self.children.lock().unwrap().insert(session.to_string(), child);
        Ok(())
    }

    pub fn kill(&self, session: &str) {
        if let Some(mut c) = self.children.lock().unwrap().remove(session) {
            let _ = c.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut map = self.children.lock().unwrap();
        for (_, mut c) in map.drain() {
            let _ = c.kill();
        }
    }
}
```
Add `mod external;` to `main.rs`.
- [ ] **Step 4:** `cargo test hooks::tests external::tests` → PASS.
- [ ] **Step 5:** Commit: `feat: launch argv builder, temp settings file, external process manager`.

---

## Task 3: Rewire command layer, AppState, and main.rs to external mode

**Files:** Modify `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml` (remove `base64`); delete `src-tauri/src/pty.rs` and remove `mod pty;`. Test: inline `build_claude_args` test is removed (function gone) — no new unit test needed beyond Task 2; rely on `cargo build` + existing suite.

**Interfaces produced (Tauri commands — the new frontend contract):**
- `get_settings() -> Settings`
- `save_settings(settings: Settings) -> Result<(), String>`
- `launch_session(session: String, cwd: String, initial_prompt: Option<String>) -> Result<(), String>`
- `close_session(session: String)` (now kills the external terminal via ExternalManager)
- `claude_available() -> bool` (unchanged)
- Removed: `start_session`, `write_session`, `resize_session`.
- Events: `session://state`, `session://exit` remain; `session://output` removed.

- [ ] **Step 1:** Replace `AppState` in `commands.rs`:
```rust
pub struct AppState {
    pub store: Mutex<Store>,
    pub external: crate::external::ExternalManager,
    pub listener_port: u16,
    pub reporter_path: String,
}
```
Remove `build_claude_args`, `OutputPayload`, and its test; delete the `base64` import and use.
- [ ] **Step 2:** Add settings commands and the new launch command:
```rust
use crate::model::Settings;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.store.lock().unwrap().settings()
}
#[tauri::command]
pub fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    state.store.lock().unwrap().save_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn launch_session(
    state: State<AppState>,
    session: String,
    cwd: String,
    initial_prompt: Option<String>,
) -> Result<(), String> {
    let program = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
    let settings_file = crate::hooks::write_settings_file(&state.reporter_path, state.listener_port, &session)
        .map_err(|e| e.to_string())?;
    let mut template = state.store.lock().unwrap().settings().terminal_command;
    if template.trim().is_empty() {
        // Empty setting = auto: resolve the system default terminal at launch time.
        template = crate::external::detect_default_terminal();
    }
    let argv = crate::external::build_launch_argv(
        &template, &program, &settings_file.to_string_lossy(), &initial_prompt,
    )?;
    state.external.launch(&session, &argv, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_session(state: State<AppState>, session: String) {
    state.external.kill(&session);
}
```
Keep `claude_available`/`which_claude`/`emit_state` and `StatePayload`/`ExitPayload` (used by the listener callback and any exit emission). The listener callback still emits `session://state`.
- [ ] **Step 3:** Update `main.rs`: remove `mod pty;`, delete `src-tauri/src/pty.rs`; build `AppState { external: external::ExternalManager::new(), ... }`; window-close `kill_all` calls `state.external.kill_all()`; update `invoke_handler!` to the new command set (`get_settings, save_settings, list_workspaces, save_workspace, remove_workspace, list_skills, save_skill, remove_skill, claude_available, launch_session, close_session`). Remove `base64` from `Cargo.toml`.
- [ ] **Step 4:** `cd src-tauri && cargo test && cargo build` → all pass, both binaries build, no `pty`/`base64` references remain.
- [ ] **Step 5:** Commit: `feat: external-terminal command layer; remove embedded PTY path`.

---

## Task 4: Frontend — cards, settings field, remove xterm

**Files:** Modify `src/ipc.ts`, `src/sessions.ts`, `src/main.ts`, `src/styles.css`, `package.json`; delete `src/terminal.ts`, `tests/ipc.test.ts` (update). Verify by `npx tsc --noEmit` + `npm run build` (window behavior deferred to user).

**Interfaces produced (ipc.ts):** remove `startSession`/`writeSession`/`resizeSession`/`onOutput`; add `launchSession(session, cwd, initialPrompt)`, `getSettings()`, `saveSettings(s)`; keep `onState`/`onExit`/`closeSession`/`claudeAvailable`; add `Settings` type `{ terminalCommand: string }`.

- [ ] **Step 1:** Update `src/ipc.ts`:
```ts
export interface Settings { terminalCommand: string; }
export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const launchSession = (session: string, cwd: string, initialPrompt: string | null) =>
  invoke<void>("launch_session", { session, cwd, initialPrompt });
// remove startSession, writeSession, resizeSession, onOutput and the decodeB64/onOutput exports
```
Update `tests/ipc.test.ts`: drop the startSession/decodeB64 cases; add a test that `launchSession("s1","/p","do it")` invokes `"launch_session"` with `{ session:"s1", cwd:"/p", initialPrompt:"do it" }`, and that `getSettings` calls `"get_settings"`.
- [ ] **Step 2:** Delete `src/terminal.ts`. Rewrite `src/sessions.ts` `Deck` so `launch(workspace, skill|null)` creates a **card** (no TerminalPanel): a session id via `crypto.randomUUID()`, a card element with title (`skill ? icon+name : "терминал · "+workspace.name`), a state label (`state-idle` initially), and a close button (calls `closeSession` + removes the card). `wireEvents` subscribes only to `onState` (update label + notify on transitions into waitingInput/ended/error) and `onExit` (mark ended). Keep the existing `LABEL`/`NOTIFY_ON`/notification-permission logic. Build card DOM with `textContent` (no innerHTML for names). `launch()` calls `launchSession(session, workspace.path, skill ? skill.prompt : null)`.
- [ ] **Step 3:** `src/main.ts`: add a settings field in the sidebar — a text input for the terminal command, loaded via `getSettings()` and saved via `saveSettings({ terminalCommand })` on change (blur or a small Save button). When the value is empty, show placeholder text `(системный по умолчанию)` so the user knows empty means auto-detect the system default terminal. Keep workspaces/skills wiring and the launch handlers reading `workspaces.active` live. Remove any `onOutput`/TerminalPanel references. Update `src/styles.css`: drop `.tile-body` xterm sizing; add `.card`/settings-field styles as needed.
- [ ] **Step 4:** `package.json`: remove `@xterm/xterm` and `@xterm/addon-fit` from dependencies. Run `npm install` to update the lockfile.
- [ ] **Step 5:** Verify: `npx tsc --noEmit` (no errors, no dangling imports of removed modules), `npm run build` (succeeds), `npx vitest run` (updated ipc tests pass).
- [ ] **Step 6:** Commit: `feat: session cards + terminal-command setting; remove xterm frontend`.

---

## Task 5: Verify build and update README

**Files:** Modify `README.md`. Verification task otherwise.

- [ ] **Step 1:** Full suites: `cd src-tauri && cargo test` (all pass) ; `cd .. && npx vitest run` (pass) ; `npm run build` (pass) ; `cargo build --release --manifest-path src-tauri/Cargo.toml` (pass).
- [ ] **Step 2:** Update `README.md`: document that sessions open in an external terminal; that the terminal command setting defaults to the **system default terminal** (empty = auto-detect; Linux via `$TERMINAL`/`x-terminal-emulator`, Windows via `wt`/`cmd`, macOS best-effort) and can be overridden (e.g. `ghostty -e`); the single-instance-terminal caveat for close-on-exit; that state labels/notifications still work via hooks. Remove references to the embedded terminal.
- [ ] **Step 3:** Produce a USER SMOKE CHECKLIST in the report: set terminal command, launch a skill → external terminal window opens running claude, label goes working→waitingInput, OS notification fires; `pgrep -fa claude` and closing the pult window behavior (note the single-instance caveat).
- [ ] **Step 4:** Commit any doc change: `docs: README for external-terminal mode`.

---

## Self-Review Notes

- Spec coverage: terminal setting (T1); temp settings file + argv + external spawn/kill (T2); command layer + kill_all-on-close + removal of embedded path (T3); cards UI + settings field + xterm removal (T4); verify + README (T5).
- Removed-surface consistency: after T3/T4, no code references `start_session`/`write_session`/`resize_session`/`session://output`/`pty`/`base64`/`@xterm/*` — checked in T3 Step 4 and T4 Step 5.
- State path unchanged: hooks → reporter → listener → `session://state`; the temp settings file uses the same `build_settings_json`, so labels/notifications keep working with the external terminal.
