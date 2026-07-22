# cowork-deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lightweight cross-platform desktop app (Tauri) that runs several live interactive Claude Code sessions as tiled terminals, shows each session's state, and launches saved "skill" prompts into a new session with one button — organized by project workspaces.

**Architecture:** A Tauri v2 app: Rust core owns PTY processes, a local TCP status listener, and file-based config; a lightweight vanilla-TypeScript + xterm.js UI renders the tiles, workspace switcher, and skill buttons. Session state is detected via per-session Claude Code hooks (injected with `--settings` inline JSON) that invoke a tiny companion reporter binary, which reports events back to the local listener over 127.0.0.1. No framework, no bundled browser, nothing exposed to the network.

**Tech Stack:** Rust, Tauri v2, `portable-pty`, `tokio`, `serde`/`serde_json`, `tauri-plugin-notification`; TypeScript, Vite, `@xterm/xterm` + `@xterm/addon-fit`, `vitest`.

## Global Constraints

- Target idle memory footprint < 100 MB; prefer vanilla TS over any UI framework; throttle terminal rendering.
- Cross-platform: must build and run on Windows, macOS, and Linux. No OS-specific shell assumptions; do not rely on `curl` being present (use the companion reporter binary instead).
- Sessions terminate when the window closes — no background/detached sessions, no persistence of running sessions.
- Single user. No cloud, no sync, no remote access, no auth.
- State detection is best-effort: if hooks fail to fire, the terminal must still work as a plain terminal (graceful degradation — never crash the window).
- Config stored as human-readable files (JSON) in the OS app-config dir via Tauri's path API.
- All network activity is bound to `127.0.0.1` only.
- Claude Code CLI reference (verified against v2.1.217): interactive launch is `claude "<initial prompt>"`; per-session hooks via `--settings '<inline json>'`; hook events `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `Notification`, `SessionEnd`; hooks receive JSON on stdin including `session_id`.

---

## File Structure

**Rust core** (`src-tauri/`):
- `Cargo.toml` — crate + deps; declares two binaries (app + reporter).
- `tauri.conf.json` — Tauri config (window, bundle, plugins).
- `src/main.rs` — app entry: build Tauri, manage state, register commands, start listener.
- `src/model.rs` — `Workspace`, `Skill`, `SessionState`, `ReporterEvent`, and `event_kind_to_state()` mapping.
- `src/store.rs` — load/save/CRUD for workspaces & skills (JSON files in config dir).
- `src/hooks.rs` — build per-session `--settings` JSON string and the reporter hook command.
- `src/listener.rs` — local TCP listener; parses reporter lines → emits state to the app.
- `src/pty.rs` — `PtyManager`: spawn a command in a PTY, stream output, write input, kill; per-session registry.
- `src/commands.rs` — Tauri command handlers (workspaces/skills CRUD, start/write/close session).
- `src/bin/cowork_report.rs` — companion reporter binary invoked by hooks.

**Frontend** (`src/`, `index.html`, Vite):
- `index.html` — root markup.
- `src/ipc.ts` — thin typed wrappers over Tauri `invoke`/`listen`.
- `src/terminal.ts` — xterm panel wrapper (create, write, input→ipc, fit/resize).
- `src/workspaces.ts` — workspace switcher + CRUD UI.
- `src/skills.ts` — skill buttons + editor UI; launches a session with a template.
- `src/sessions.ts` — session tiles + state labels; OS notification on transitions.
- `src/main.ts` — bootstrap + layout wiring.
- `src/styles.css` — minimal styling.
- `tests/` — vitest for `ipc.ts` mapping.

---

## Task 1: Scaffold Tauri v2 app with an empty window

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`
- Create: `package.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/styles.css`
- Create: `.gitignore` (append)

**Interfaces:**
- Produces: a runnable Tauri app whose window loads the Vite dev server / built assets.

- [ ] **Step 1: Create the frontend package manifest**

`package.json`:
```json
{
  "name": "cowork-deck",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-notification": "^2",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create Vite config, root HTML, entry, styles**

`vite.config.ts`:
```ts
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2021", outDir: "dist" },
});
```

`index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>cowork-deck</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="app">
      <aside id="sidebar"></aside>
      <main id="deck"></main>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts`:
```ts
document.querySelector("#deck")!.textContent = "cowork-deck";
```

`src/styles.css`:
```css
* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
#app { display: flex; font-family: system-ui, sans-serif; }
#sidebar { width: 240px; background: #1b1b1f; color: #eee; padding: 8px; overflow: auto; }
#deck { flex: 1; display: grid; gap: 6px; padding: 6px; background: #0f0f12; }
```

- [ ] **Step 3: Create the Rust crate manifest and Tauri config**

`src-tauri/Cargo.toml`:
```toml
[package]
name = "cowork-deck"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "cowork-deck"
path = "src/main.rs"

[[bin]]
name = "cowork_report"
path = "src/bin/cowork_report.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-notification = "2"
portable-pty = "0.8"
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "sync", "macros"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build();
}
```

`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "cowork-deck",
  "version": "0.1.0",
  "identifier": "ca.jvl.coworkdeck",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      { "title": "cowork-deck", "width": 1200, "height": 800, "resizable": true }
    ],
    "security": { "csp": null }
  },
  "plugins": {},
  "bundle": { "active": true, "targets": "all" }
}
```

- [ ] **Step 4: Create the minimal Rust entry point**

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running cowork-deck");
}
```

- [ ] **Step 5: Install deps and run the dev app**

Run:
```bash
cd /home/evgeny-kharetski/workspace/lemsoft/cowork-deck
npm install
npm run tauri dev
```
Expected: a desktop window titled "cowork-deck" opens showing the text "cowork-deck". Close it.

- [ ] **Step 6: Commit**

```bash
cd /home/evgeny-kharetski/workspace/lemsoft/cowork-deck
printf '%s\n' 'node_modules/' 'dist/' 'src-tauri/target/' '.DS_Store' > .gitignore
git add -A
git commit -m "chore: scaffold Tauri v2 app with empty window"
```

---

## Task 2: De-risk spike — verify `--settings` hooks fire and carry `session_id`

This resolves the one flagged unknown from the spec before any state code is built. It runs the **real** installed `claude` once, headlessly, with an inline-JSON hook that appends to a file, and confirms the hook fires and the stdin payload contains `session_id`. The output is committed as evidence and pins the exact hook schema for Task 6.

**Files:**
- Create: `docs/superpowers/spikes/hook-probe.sh`
- Create: `docs/superpowers/spikes/RESULTS.md`

**Interfaces:**
- Produces: confirmed hook JSON schema (flat vs nested `hooks` form) recorded in `RESULTS.md`, consumed by Task 6.

- [ ] **Step 1: Write the probe script**

`docs/superpowers/spikes/hook-probe.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
OUT="$(mktemp)"
DIR="$(mktemp -d)"
# Nested schema (documented). The hook command writes the stdin payload to $OUT.
SETTINGS=$(cat <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"cat > $OUT"}]}]}}
JSON
)
echo "=== running claude headless with inline --settings ==="
( cd "$DIR" && printf 'say hi and nothing else\n' | claude -p --settings "$SETTINGS" "say hi" || true )
echo "=== hook capture file contents ==="
cat "$OUT" || echo "(empty — hook did not fire)"
echo
echo "=== session_id present? ==="
grep -o '"session_id"[^,]*' "$OUT" || echo "(no session_id found)"
```

- [ ] **Step 2: Run the probe**

Run:
```bash
bash /home/evgeny-kharetski/workspace/lemsoft/cowork-deck/docs/superpowers/spikes/hook-probe.sh
```
Expected: the capture file is non-empty JSON and contains a `"session_id"` field.

- [ ] **Step 3: Record results and decide schema**

Write `docs/superpowers/spikes/RESULTS.md` with: the exact captured JSON, whether the **nested** schema (`Stop":[{"hooks":[{"type":"command","command":...}]}]`) fired, and `claude --version`. If the nested form did NOT fire, re-run replacing the `Stop` value with the flat form `[{"command":"cat > $OUT"}]` and record which one works. Task 6 uses whichever schema this step confirms.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/spikes
git commit -m "spike: verify claude --settings hooks fire and carry session_id"
```

---

## Task 3: Core model — types and event→state mapping

**Files:**
- Create: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/main.rs` (add `mod model;`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/model.rs`

**Interfaces:**
- Produces:
  - `enum SessionState { Idle, Working, WaitingInput, Ended, Error }` (serde, `rename_all = "camelCase"`).
  - `struct Workspace { id: String, name: String, path: String, color: String }`
  - `struct Skill { id: String, name: String, icon: String, prompt: String, workspace_id: Option<String> }`
  - `struct ReporterEvent { session: String, kind: String, notification_type: Option<String> }`
  - `fn event_kind_to_state(kind: &str, notification_type: Option<&str>) -> Option<SessionState>`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/model.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_kinds_to_states() {
        assert_eq!(event_kind_to_state("start", None), Some(SessionState::Idle));
        assert_eq!(event_kind_to_state("working", None), Some(SessionState::Working));
        assert_eq!(event_kind_to_state("waiting", None), Some(SessionState::WaitingInput));
        assert_eq!(event_kind_to_state("ended", None), Some(SessionState::Ended));
        assert_eq!(
            event_kind_to_state("notify", Some("permission_prompt")),
            Some(SessionState::WaitingInput)
        );
        assert_eq!(
            event_kind_to_state("notify", Some("idle_prompt")),
            Some(SessionState::WaitingInput)
        );
        assert_eq!(event_kind_to_state("notify", Some("other")), None);
        assert_eq!(event_kind_to_state("garbage", None), None);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test model::tests::maps_kinds_to_states`
Expected: FAIL — `event_kind_to_state` / `SessionState` not found.

- [ ] **Step 3: Implement the model**

Prepend to `src-tauri/src/model.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Idle,
    Working,
    WaitingInput,
    Ended,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub prompt: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReporterEvent {
    pub session: String,
    pub kind: String,
    #[serde(rename = "notificationType")]
    pub notification_type: Option<String>,
}

/// Map a reporter `kind` (+ optional notification type) to a session state.
/// Returns None for kinds that should not change the visible state.
pub fn event_kind_to_state(kind: &str, notification_type: Option<&str>) -> Option<SessionState> {
    match kind {
        "start" => Some(SessionState::Idle),
        "working" => Some(SessionState::Working),
        "waiting" => Some(SessionState::WaitingInput),
        "ended" => Some(SessionState::Ended),
        "notify" => match notification_type {
            Some(t) if t.contains("permission") || t.contains("idle") => {
                Some(SessionState::WaitingInput)
            }
            _ => None,
        },
        _ => None,
    }
}
```

Add to `src-tauri/src/main.rs` (above `fn main`): `mod model;`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test model::tests::maps_kinds_to_states`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/model.rs src-tauri/src/main.rs
git commit -m "feat: core model types and event-to-state mapping"
```

---

## Task 4: Config store — workspaces & skills CRUD

**Files:**
- Create: `src-tauri/src/store.rs`
- Modify: `src-tauri/src/main.rs` (add `mod store;`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/store.rs`

**Interfaces:**
- Consumes: `model::{Workspace, Skill}`.
- Produces:
  - `struct Store { dir: PathBuf }`
  - `Store::new(dir: PathBuf) -> Store`
  - `fn workspaces(&self) -> Vec<Workspace>` / `fn save_workspaces(&self, &[Workspace]) -> std::io::Result<()>`
  - `fn skills(&self) -> Vec<Skill>` / `fn save_skills(&self, &[Skill]) -> std::io::Result<()>`
  - `fn upsert_workspace(&self, Workspace) -> std::io::Result<Vec<Workspace>>`
  - `fn delete_workspace(&self, id: &str) -> std::io::Result<Vec<Workspace>>`
  - `fn upsert_skill(&self, Skill) -> std::io::Result<Vec<Skill>>`
  - `fn delete_skill(&self, id: &str) -> std::io::Result<Vec<Skill>>`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/store.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Workspace;

    fn tmp() -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("coworkdeck-test-{}", std::process::id()));
        d.push(format!("{:?}", std::time::SystemTime::now()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn empty_store_reads_empty_then_upserts_and_deletes() {
        let s = Store::new(tmp());
        assert!(s.workspaces().is_empty());
        let w = Workspace { id: "w1".into(), name: "Grosh".into(), path: "/tmp/grosh".into(), color: "#3b82f6".into() };
        let after = s.upsert_workspace(w.clone()).unwrap();
        assert_eq!(after.len(), 1);
        // reload from disk
        assert_eq!(Store::new(s.dir.clone()).workspaces().len(), 1);
        // update in place (same id)
        let mut w2 = w.clone();
        w2.name = "Grosh 2".into();
        let after = s.upsert_workspace(w2).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "Grosh 2");
        // delete
        let after = s.delete_workspace("w1").unwrap();
        assert!(after.is_empty());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test store::tests`
Expected: FAIL — `Store` not found.

- [ ] **Step 3: Implement the store**

Prepend to `src-tauri/src/store.rs`:
```rust
use crate::model::{Skill, Workspace};
use std::path::PathBuf;

pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        let _ = std::fs::create_dir_all(&dir);
        Store { dir }
    }

    fn ws_path(&self) -> PathBuf { self.dir.join("workspaces.json") }
    fn sk_path(&self) -> PathBuf { self.dir.join("skills.json") }

    fn read_vec<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Vec<T> {
        match std::fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    fn write_vec<T: serde::Serialize>(path: &PathBuf, items: &[T]) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(items)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(path, json)
    }

    pub fn workspaces(&self) -> Vec<Workspace> { Self::read_vec(&self.ws_path()) }
    pub fn save_workspaces(&self, items: &[Workspace]) -> std::io::Result<()> {
        Self::write_vec(&self.ws_path(), items)
    }
    pub fn skills(&self) -> Vec<Skill> { Self::read_vec(&self.sk_path()) }
    pub fn save_skills(&self, items: &[Skill]) -> std::io::Result<()> {
        Self::write_vec(&self.sk_path(), items)
    }

    pub fn upsert_workspace(&self, w: Workspace) -> std::io::Result<Vec<Workspace>> {
        let mut items = self.workspaces();
        match items.iter_mut().find(|x| x.id == w.id) {
            Some(existing) => *existing = w,
            None => items.push(w),
        }
        self.save_workspaces(&items)?;
        Ok(items)
    }

    pub fn delete_workspace(&self, id: &str) -> std::io::Result<Vec<Workspace>> {
        let mut items = self.workspaces();
        items.retain(|x| x.id != id);
        self.save_workspaces(&items)?;
        Ok(items)
    }

    pub fn upsert_skill(&self, sk: Skill) -> std::io::Result<Vec<Skill>> {
        let mut items = self.skills();
        match items.iter_mut().find(|x| x.id == sk.id) {
            Some(existing) => *existing = sk,
            None => items.push(sk),
        }
        self.save_skills(&items)?;
        Ok(items)
    }

    pub fn delete_skill(&self, id: &str) -> std::io::Result<Vec<Skill>> {
        let mut items = self.skills();
        items.retain(|x| x.id != id);
        self.save_skills(&items)?;
        Ok(items)
    }
}
```

Add to `src-tauri/src/main.rs`: `mod store;`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test store::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs src-tauri/src/main.rs
git commit -m "feat: file-based config store for workspaces and skills"
```

---

## Task 5: Companion reporter binary

The reporter is invoked by Claude Code hooks. It takes `kind`, `port`, `session` as args, optionally reads the hook's stdin JSON to extract `notification_type`, and sends one newline-delimited JSON line to `127.0.0.1:<port>`. It must never block the host session: short connect timeout, ignore all errors.

**Files:**
- Create: `src-tauri/src/bin/cowork_report.rs`
- Test: integration test `src-tauri/tests/reporter.rs`

**Interfaces:**
- Consumes: argv `[kind, port, session]`; optional stdin JSON with `notification_type`.
- Produces: writes a line `{"session":..,"kind":..,"notificationType":..}\n` to the given TCP port, then exits 0.

- [ ] **Step 1: Write the failing integration test**

`src-tauri/tests/reporter.rs`:
```rust
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Command, Stdio};

#[test]
fn reporter_sends_a_json_line() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    });

    let bin = env!("CARGO_BIN_EXE_cowork_report");
    let mut child = Command::new(bin)
        .args(["waiting", &port.to_string(), "sess-1"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    // provide a hook-like stdin payload
    use std::io::Write;
    child.stdin.take().unwrap().write_all(b"{\"session_id\":\"x\"}").unwrap();
    child.wait().unwrap();

    let line = handle.join().unwrap();
    assert!(line.contains("\"session\":\"sess-1\""), "got: {line}");
    assert!(line.contains("\"kind\":\"waiting\""), "got: {line}");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --test reporter`
Expected: FAIL — binary has no such behavior yet (or compile error, since the bin is a stub).

- [ ] **Step 3: Implement the reporter**

`src-tauri/src/bin/cowork_report.rs`:
```rust
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // args: [prog, kind, port, session]
    if args.len() < 4 {
        return;
    }
    let kind = &args[1];
    let port = &args[2];
    let session = &args[3];

    // Best-effort: read optional stdin JSON to extract notification_type.
    let mut buf = String::new();
    let _ = std::io::stdin().read_to_string(&mut buf);
    let notification_type = extract_field(&buf, "notification_type");

    let payload = match notification_type {
        Some(nt) => format!(
            "{{\"session\":\"{}\",\"kind\":\"{}\",\"notificationType\":\"{}\"}}\n",
            esc(session), esc(kind), esc(&nt)
        ),
        None => format!(
            "{{\"session\":\"{}\",\"kind\":\"{}\"}}\n",
            esc(session), esc(kind)
        ),
    };

    let addr = format!("127.0.0.1:{}", port);
    if let Ok(sock) = addr.parse() {
        if let Ok(mut stream) =
            TcpStream::connect_timeout(&sock, Duration::from_millis(300))
        {
            let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
            let _ = stream.write_all(payload.as_bytes());
            let _ = stream.flush();
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Minimal string-field extractor for a flat JSON object. Avoids a serde dep
/// in the reporter to keep it tiny; hook payload fields we need are strings.
fn extract_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let start = json.find(&needle)? + needle.len();
    let rest = &json[start..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(after[..end].to_string())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --test reporter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/cowork_report.rs src-tauri/tests/reporter.rs
git commit -m "feat: companion reporter binary for hook events"
```

---

## Task 6: Hook settings builder

Builds the inline `--settings` JSON string wiring each Claude Code hook event to a reporter invocation carrying the port and app session id. Uses the schema confirmed in Task 2 (nested form below; switch to flat form if the spike found that instead).

**Files:**
- Create: `src-tauri/src/hooks.rs`
- Modify: `src-tauri/src/main.rs` (add `mod hooks;`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/hooks.rs`

**Interfaces:**
- Produces: `fn build_settings_json(reporter_path: &str, port: u16, session: &str) -> String` — a valid JSON string suitable for `claude --settings <this>`, mapping `SessionStart→start`, `UserPromptSubmit→working`, `PreToolUse→working`, `Stop→waiting`, `PermissionRequest→waiting`, `Notification→notify`, `SessionEnd→ended`.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/hooks.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_json_with_all_events() {
        let s = build_settings_json("/opt/cowork_report", 51234, "sess-9");
        let v: serde_json::Value = serde_json::from_str(&s).expect("valid json");
        let hooks = &v["hooks"];
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "PermissionRequest", "Notification", "SessionEnd"] {
            assert!(hooks.get(ev).is_some(), "missing event {ev}");
        }
        // command must carry port + session
        let cmd = hooks["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("51234"), "cmd: {cmd}");
        assert!(cmd.contains("sess-9"), "cmd: {cmd}");
        assert!(cmd.contains("waiting"), "cmd: {cmd}");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test hooks::tests`
Expected: FAIL — `build_settings_json` not found.

- [ ] **Step 3: Implement the builder**

Prepend to `src-tauri/src/hooks.rs`:
```rust
use serde_json::json;

/// Build a Claude Code `--settings` JSON string that reports hook events to the
/// local listener via the companion reporter binary.
pub fn build_settings_json(reporter_path: &str, port: u16, session: &str) -> String {
    let mapping = [
        ("SessionStart", "start"),
        ("UserPromptSubmit", "working"),
        ("PreToolUse", "working"),
        ("Stop", "waiting"),
        ("PermissionRequest", "waiting"),
        ("Notification", "notify"),
        ("SessionEnd", "ended"),
    ];

    let mut hooks = serde_json::Map::new();
    for (event, kind) in mapping {
        // Quote the reporter path for shells; args are literal (no shell metachars).
        let command = format!("\"{}\" {} {} {}", reporter_path, kind, port, session);
        hooks.insert(
            event.to_string(),
            json!([ { "hooks": [ { "type": "command", "command": command } ] } ]),
        );
    }

    json!({ "hooks": hooks }).to_string()
}
```

Add to `src-tauri/src/main.rs`: `mod hooks;`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test hooks::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks.rs src-tauri/src/main.rs
git commit -m "feat: per-session hook settings JSON builder"
```

---

## Task 7: Local status listener

A tokio TCP listener bound to `127.0.0.1:0` (random free port). It reads newline-delimited reporter lines, parses them into `ReporterEvent`, maps to `SessionState` via `event_kind_to_state`, and invokes a callback with `(session_id, SessionState)`. In the app this callback emits a Tauri event; the test uses a channel.

**Files:**
- Create: `src-tauri/src/listener.rs`
- Modify: `src-tauri/src/main.rs` (add `mod listener;`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/listener.rs`

**Interfaces:**
- Consumes: `model::{ReporterEvent, SessionState, event_kind_to_state}`.
- Produces:
  - `async fn start_listener<F>(on_state: F) -> std::io::Result<u16>` where `F: Fn(String, SessionState) + Send + Sync + 'static`. Returns the bound port; spawns the accept loop on the current tokio runtime.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/listener.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionState;
    use std::sync::mpsc;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn receives_and_maps_a_line() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |sess, state| {
            tx.send((sess, state)).unwrap();
        })
        .await
        .unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"{\"session\":\"sess-1\",\"kind\":\"working\"}\n")
            .await
            .unwrap();
        stream.flush().await.unwrap();

        let (sess, state) = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(sess, "sess-1");
        assert_eq!(state, SessionState::Working);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test listener::tests`
Expected: FAIL — `start_listener` not found.

- [ ] **Step 3: Implement the listener**

Prepend to `src-tauri/src/listener.rs`:
```rust
use crate::model::{event_kind_to_state, ReporterEvent};
use crate::model::SessionState;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;

/// Start a 127.0.0.1 listener; returns the bound port. For each reporter line
/// that maps to a state, `on_state(session_id, state)` is invoked.
pub async fn start_listener<F>(on_state: F) -> std::io::Result<u16>
where
    F: Fn(String, SessionState) + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let cb = Arc::new(on_state);

    tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let cb = cb.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(ev) = serde_json::from_str::<ReporterEvent>(&line) {
                        if let Some(state) =
                            event_kind_to_state(&ev.kind, ev.notification_type.as_deref())
                        {
                            cb(ev.session, state);
                        }
                    }
                }
            });
        }
    });

    Ok(port)
}
```

Add to `src-tauri/src/main.rs`: `mod listener;`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test listener::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/listener.rs src-tauri/src/main.rs
git commit -m "feat: local TCP status listener mapping reporter events to states"
```

---

## Task 8: PTY manager

Spawns a command in a pseudo-terminal, streams output bytes via a callback, accepts input writes, resizes, and kills. Keeps a registry keyed by session id. Tested with a portable command (`printf` on unix / `cmd /c echo` on Windows) — never the real `claude`.

**Files:**
- Create: `src-tauri/src/pty.rs`
- Modify: `src-tauri/src/main.rs` (add `mod pty;`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/pty.rs`

**Interfaces:**
- Produces:
  - `struct PtyManager` with `PtyManager::new() -> PtyManager`.
  - `fn spawn<F>(&self, session: &str, program: &str, args: &[String], cwd: &str, cols: u16, rows: u16, on_output: F, on_exit: impl Fn(bool) + Send + 'static) -> std::io::Result<()>` where `F: Fn(Vec<u8>) + Send + 'static`. `on_exit(success)` fires when the process ends.
  - `fn write(&self, session: &str, data: &[u8]) -> std::io::Result<()>`
  - `fn resize(&self, session: &str, cols: u16, rows: u16) -> std::io::Result<()>`
  - `fn kill(&self, session: &str)`
  - `fn kill_all(&self)`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/pty.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawns_streams_output_and_exits() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<bool>();

        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), "echo COWORK_OK".to_string()]);
        #[cfg(not(windows))]
        let (prog, args) = ("/bin/sh", vec!["-c".to_string(), "printf COWORK_OK".to_string()]);

        mgr.spawn(
            "s1", prog, &args, ".", 80, 24,
            move |bytes| { let _ = tx.send(bytes); },
            move |ok| { let _ = etx.send(ok); },
        ).unwrap();

        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend_from_slice(&b);
                if String::from_utf8_lossy(&got).contains("COWORK_OK") { break; }
            }
        }
        assert!(String::from_utf8_lossy(&got).contains("COWORK_OK"), "got: {:?}", String::from_utf8_lossy(&got));
        assert!(erx.recv_timeout(Duration::from_secs(5)).is_ok(), "exit not reported");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test pty::tests`
Expected: FAIL — `PtyManager` not found.

- [ ] **Step 3: Implement the PTY manager**

Prepend to `src-tauri/src/pty.rs`:
```rust
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send>,
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl PtyManager {
    pub fn new() -> PtyManager {
        PtyManager { sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn spawn<F>(
        &self,
        session: &str,
        program: &str,
        args: &[String],
        cwd: &str,
        cols: u16,
        rows: u16,
        on_output: F,
        on_exit: impl Fn(bool) + Send + 'static,
    ) -> std::io::Result<()>
    where
        F: Fn(Vec<u8>) + Send + 'static,
    {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(to_io)?;

        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.cwd(cwd);

        let mut child = pair.slave.spawn_command(cmd).map_err(to_io)?;
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(to_io)?;
        let writer = pair.master.take_writer().map_err(to_io)?;

        // Reader thread: stream output until EOF.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(buf[..n].to_vec()),
                }
            }
        });

        // Waiter thread: report exit status.
        std::thread::spawn(move || {
            let status = child.wait();
            let ok = status.map(|s| s.success()).unwrap_or(false);
            on_exit(ok);
        });

        self.sessions.lock().unwrap().insert(
            session.to_string(),
            Session { master: pair.master, writer, killer: Box::new(killer) },
        );
        Ok(())
    }

    pub fn write(&self, session: &str, data: &[u8]) -> std::io::Result<()> {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session) {
            s.writer.write_all(data)?;
            s.writer.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, session: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        let map = self.sessions.lock().unwrap();
        if let Some(s) = map.get(session) {
            s.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(to_io)?;
        }
        Ok(())
    }

    pub fn kill(&self, session: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(session) {
            let _ = s.killer.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut map = self.sessions.lock().unwrap();
        for (_, mut s) in map.drain() {
            let _ = s.killer.kill();
        }
    }
}

fn to_io<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}
```

Add to `src-tauri/src/main.rs`: `mod pty;`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test pty::tests`
Expected: PASS. (If `clone_killer`/`ChildKiller` names differ in the resolved `portable-pty` version, run `cargo doc --open -p portable-pty` and adjust to the equivalent kill handle; the rest of the interface is stable.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs src-tauri/src/main.rs
git commit -m "feat: PTY manager with output streaming, input, resize, kill"
```

---

## Task 9: App state, Tauri commands, and wiring

Ties the core together: a managed `AppState { store, pty, listener_port, reporter_path }`; commands for config CRUD and session lifecycle; the listener started at boot emitting `session://state`; PTY output emitted as `session://output`; and `kill_all` on window close.

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs` (rewrite to wire everything)
- Test: inline `#[cfg(test)]` in `src-tauri/src/commands.rs` for the arg-building helper (no Tauri runtime needed).

**Interfaces:**
- Consumes: all prior modules.
- Produces (Tauri commands, all `async` or sync as noted; names are the IPC contract for the frontend):
  - `list_workspaces() -> Vec<Workspace>`
  - `save_workspace(ws: Workspace) -> Vec<Workspace>`
  - `remove_workspace(id: String) -> Vec<Workspace>`
  - `list_skills() -> Vec<Skill>`
  - `save_skill(sk: Skill) -> Vec<Skill>`
  - `remove_skill(id: String) -> Vec<Skill>`
  - `start_session(session: String, cwd: String, initial_prompt: Option<String>, cols: u16, rows: u16) -> Result<(), String>` — launches `claude` with hook settings and optional initial prompt.
  - `write_session(session: String, data: String) -> Result<(), String>`
  - `resize_session(session: String, cols: u16, rows: u16) -> Result<(), String>`
  - `close_session(session: String)`
  - `claude_available() -> bool`
- Also produces helper `fn build_claude_args(settings_json: &str, initial_prompt: &Option<String>) -> Vec<String>` (unit-tested).
- Emits events: `session://output` `{ session: String, dataB64: String }`; `session://state` `{ session: String, state: SessionState }`; `session://exit` `{ session: String, ok: bool }`.

- [ ] **Step 1: Write the failing test for the arg builder**

Add to `src-tauri/src/commands.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_claude_args_with_settings_and_prompt() {
        let args = build_claude_args("{\"hooks\":{}}", &Some("collect email report".into()));
        assert_eq!(args[0], "--settings");
        assert_eq!(args[1], "{\"hooks\":{}}");
        assert_eq!(args.last().unwrap(), "collect email report");
    }

    #[test]
    fn builds_claude_args_without_prompt() {
        let args = build_claude_args("{}", &None);
        assert_eq!(args, vec!["--settings".to_string(), "{}".to_string()]);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test commands::tests`
Expected: FAIL — `build_claude_args` not found.

- [ ] **Step 3: Implement commands and the arg builder**

`src-tauri/src/commands.rs`:
```rust
use crate::hooks::build_settings_json;
use crate::model::{Skill, Workspace};
use crate::pty::PtyManager;
use crate::store::Store;
use base64::Engine;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    pub store: Mutex<Store>,
    pub pty: PtyManager,
    pub listener_port: u16,
    pub reporter_path: String,
}

/// Build the argv (after the program name) for launching an interactive claude
/// session with per-session hook settings and an optional initial prompt.
pub fn build_claude_args(settings_json: &str, initial_prompt: &Option<String>) -> Vec<String> {
    let mut args = vec!["--settings".to_string(), settings_json.to_string()];
    if let Some(p) = initial_prompt {
        args.push(p.clone());
    }
    args
}

#[derive(Clone, Serialize)]
struct OutputPayload { session: String, #[serde(rename = "dataB64")] data_b64: String }
#[derive(Clone, Serialize)]
struct StatePayload { session: String, state: crate::model::SessionState }
#[derive(Clone, Serialize)]
struct ExitPayload { session: String, ok: bool }

#[tauri::command]
pub fn list_workspaces(state: State<AppState>) -> Vec<Workspace> {
    state.store.lock().unwrap().workspaces()
}
#[tauri::command]
pub fn save_workspace(state: State<AppState>, ws: Workspace) -> Result<Vec<Workspace>, String> {
    state.store.lock().unwrap().upsert_workspace(ws).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn remove_workspace(state: State<AppState>, id: String) -> Result<Vec<Workspace>, String> {
    state.store.lock().unwrap().delete_workspace(&id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn list_skills(state: State<AppState>) -> Vec<Skill> {
    state.store.lock().unwrap().skills()
}
#[tauri::command]
pub fn save_skill(state: State<AppState>, sk: Skill) -> Result<Vec<Skill>, String> {
    state.store.lock().unwrap().upsert_skill(sk).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn remove_skill(state: State<AppState>, id: String) -> Result<Vec<Skill>, String> {
    state.store.lock().unwrap().delete_skill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_available() -> bool {
    which_claude().is_some()
}

fn which_claude() -> Option<String> {
    // Respect an explicit override, else rely on PATH resolution by the OS.
    if let Ok(p) = std::env::var("COWORK_CLAUDE_PATH") {
        if !p.is_empty() { return Some(p); }
    }
    let candidate = if cfg!(windows) { "claude.cmd" } else { "claude" };
    // Probe by attempting a version call.
    match std::process::Command::new(candidate).arg("--version").output() {
        Ok(o) if o.status.success() => Some(candidate.to_string()),
        _ => {
            // Fallback to bare "claude" on Windows too.
            match std::process::Command::new("claude").arg("--version").output() {
                Ok(o) if o.status.success() => Some("claude".to_string()),
                _ => None,
            }
        }
    }
}

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    state: State<AppState>,
    session: String,
    cwd: String,
    initial_prompt: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let program = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
    let settings = build_settings_json(&state.reporter_path, state.listener_port, &session);
    let args = build_claude_args(&settings, &initial_prompt);

    let app_out = app.clone();
    let sess_out = session.clone();
    let on_output = move |bytes: Vec<u8>| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = app_out.emit("session://output", OutputPayload { session: sess_out.clone(), data_b64: b64 });
    };

    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |ok: bool| {
        let state = if ok { crate::model::SessionState::Ended } else { crate::model::SessionState::Error };
        let _ = app_exit.emit("session://state", StatePayload { session: sess_exit.clone(), state });
        let _ = app_exit.emit("session://exit", ExitPayload { session: sess_exit.clone(), ok });
    };

    state.pty
        .spawn(&session, &program, &args, &cwd, cols, rows, on_output, on_exit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_session(state: State<AppState>, session: String, data: String) -> Result<(), String> {
    state.pty.write(&session, data.as_bytes()).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn resize_session(state: State<AppState>, session: String, cols: u16, rows: u16) -> Result<(), String> {
    state.pty.resize(&session, cols, rows).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn close_session(state: State<AppState>, session: String) {
    state.pty.kill(&session);
}

/// Called by main during setup to emit state changes coming from the listener.
pub fn emit_state(app: &AppHandle, session: String, state: crate::model::SessionState) {
    let _ = app.emit("session://state", StatePayload { session, state });
}
```

Add `base64 = "0.22"` to `src-tauri/Cargo.toml` `[dependencies]`.

- [ ] **Step 4: Rewrite `main.rs` to wire everything**

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod store;
mod hooks;
mod listener;
mod pty;
mod commands;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

fn reporter_path() -> String {
    // The reporter binary is built next to the main executable.
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let name = if cfg!(windows) { "cowork_report.exe" } else { "cowork_report" };
    dir.join(name).to_string_lossy().to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Config dir for the store.
            let dir = app.path().app_config_dir().expect("app config dir");
            let store = store::Store::new(dir);

            // Start the status listener on the tokio runtime Tauri provides.
            let handle_for_cb = handle.clone();
            let port = tauri::async_runtime::block_on(async move {
                listener::start_listener(move |session, state| {
                    commands::emit_state(&handle_for_cb, session, state);
                })
                .await
                .expect("listener bind")
            });

            app.manage(AppState {
                store: Mutex::new(store),
                pty: pty::PtyManager::new(),
                listener_port: port,
                reporter_path: reporter_path(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.pty.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_workspaces,
            commands::save_workspace,
            commands::remove_workspace,
            commands::list_skills,
            commands::save_skill,
            commands::remove_skill,
            commands::claude_available,
            commands::start_session,
            commands::write_session,
            commands::resize_session,
            commands::close_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running cowork-deck");
}
```

- [ ] **Step 5: Run tests and build**

Run: `cd src-tauri && cargo test && cargo build`
Expected: all tests PASS; build succeeds (both `cowork-deck` and `cowork_report` binaries).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat: app state, Tauri commands, and boot wiring"
```

---

## Task 10: Frontend IPC layer

Typed wrappers over Tauri `invoke`/`listen`, plus base64 decode for terminal output. Unit-tested with a mocked `@tauri-apps/api`.

**Files:**
- Create: `src/ipc.ts`, `tests/ipc.test.ts`
- Create: `tsconfig.json`

**Interfaces:**
- Produces: typed functions `listWorkspaces`, `saveWorkspace`, `removeWorkspace`, `listSkills`, `saveSkill`, `removeSkill`, `claudeAvailable`, `startSession`, `writeSession`, `resizeSession`, `closeSession`, and event subscriptions `onOutput`, `onState`, `onExit`; plus `types` `Workspace`, `Skill`, `SessionState`.

- [ ] **Step 1: Write tsconfig**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 2: Write the failing test**

`tests/ipc.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { listWorkspaces, startSession, decodeB64 } from "../src/ipc";

describe("ipc", () => {
  beforeEach(() => invoke.mockReset());

  it("listWorkspaces calls the right command", async () => {
    invoke.mockResolvedValue([{ id: "w1", name: "X", path: "/x", color: "#fff" }]);
    const res = await listWorkspaces();
    expect(invoke).toHaveBeenCalledWith("list_workspaces");
    expect(res[0].id).toBe("w1");
  });

  it("startSession passes all params", async () => {
    invoke.mockResolvedValue(undefined);
    await startSession("s1", "/proj", "do the thing", 80, 24);
    expect(invoke).toHaveBeenCalledWith("start_session", {
      session: "s1", cwd: "/proj", initialPrompt: "do the thing", cols: 80, rows: 24,
    });
  });

  it("decodeB64 round-trips utf8", () => {
    const b64 = btoa("héllo");
    expect(decodeB64(b64)).toBe("héllo");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/evgeny-kharetski/workspace/lemsoft/cowork-deck && npx vitest run tests/ipc.test.ts`
Expected: FAIL — `../src/ipc` does not export these yet.

- [ ] **Step 4: Implement the IPC layer**

`src/ipc.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SessionState = "idle" | "working" | "waitingInput" | "ended" | "error";
export interface Workspace { id: string; name: string; path: string; color: string; }
export interface Skill { id: string; name: string; icon: string; prompt: string; workspaceId?: string | null; }

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");
export const saveWorkspace = (ws: Workspace) => invoke<Workspace[]>("save_workspace", { ws });
export const removeWorkspace = (id: string) => invoke<Workspace[]>("remove_workspace", { id });
export const listSkills = () => invoke<Skill[]>("list_skills");
export const saveSkill = (sk: Skill) => invoke<Skill[]>("save_skill", { sk });
export const removeSkill = (id: string) => invoke<Skill[]>("remove_skill", { id });
export const claudeAvailable = () => invoke<boolean>("claude_available");

export const startSession = (
  session: string, cwd: string, initialPrompt: string | null, cols: number, rows: number,
) => invoke<void>("start_session", { session, cwd, initialPrompt, cols, rows });
export const writeSession = (session: string, data: string) => invoke<void>("write_session", { session, data });
export const resizeSession = (session: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { session, cols, rows });
export const closeSession = (session: string) => invoke<void>("close_session", { session });

export function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const onOutput = (cb: (session: string, text: string) => void): Promise<UnlistenFn> =>
  listen<{ session: string; dataB64: string }>("session://output", (e) =>
    cb(e.payload.session, decodeB64(e.payload.dataB64)));
export const onState = (cb: (session: string, state: SessionState) => void): Promise<UnlistenFn> =>
  listen<{ session: string; state: SessionState }>("session://state", (e) =>
    cb(e.payload.session, e.payload.state));
export const onExit = (cb: (session: string, ok: boolean) => void): Promise<UnlistenFn> =>
  listen<{ session: string; ok: boolean }>("session://exit", (e) =>
    cb(e.payload.session, e.payload.ok));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts tests/ipc.test.ts tsconfig.json
git commit -m "feat: typed frontend IPC layer with tests"
```

---

## Task 11: Terminal panel (xterm) bound to a session

**Files:**
- Create: `src/terminal.ts`
- Modify: `src/main.ts` (temporary manual harness), `src/styles.css`

**Interfaces:**
- Consumes: `ipc.{startSession, writeSession, resizeSession, onOutput}`; `@xterm/xterm`, `@xterm/addon-fit`.
- Produces: `class TerminalPanel` with `constructor(session: string, mount: HTMLElement)`, `async start(cwd: string, initialPrompt: string | null)`, `write(text: string)`, `fit()`, `dispose()`.

- [ ] **Step 1: Implement the terminal panel**

`src/terminal.ts`:
```ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { startSession, writeSession, resizeSession } from "./ipc";

export class TerminalPanel {
  private term: Terminal;
  private fit: FitAddon;
  constructor(private session: string, mount: HTMLElement) {
    this.term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 5000 });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(mount);
    this.fit.fit();
    this.term.onData((d) => { void writeSession(this.session, d); });
    this.term.onResize(({ cols, rows }) => { void resizeSession(this.session, cols, rows); });
  }
  async start(cwd: string, initialPrompt: string | null) {
    const { cols, rows } = this.term;
    await startSession(this.session, cwd, initialPrompt, cols, rows);
  }
  write(text: string) { this.term.write(text); }
  fit() { this.fit.fit(); }
  dispose() { this.term.dispose(); }
}
```

- [ ] **Step 2: Wire a temporary single-panel harness in main.ts**

Replace `src/main.ts`:
```ts
import { TerminalPanel } from "./terminal";
import { onOutput } from "./ipc";

const deck = document.querySelector<HTMLElement>("#deck")!;
const mount = document.createElement("div");
mount.className = "panel";
deck.appendChild(mount);

const session = "manual-1";
const panel = new TerminalPanel(session, mount);
onOutput((s, text) => { if (s === session) panel.write(text); });
// Launch in the project root with a trivial prompt to verify interactivity.
panel.start(".", "say hello and wait").catch((e) => console.error(e));
window.addEventListener("resize", () => panel.fit());
```

Add to `src/styles.css`:
```css
.panel { background: #000; border: 1px solid #333; border-radius: 6px; overflow: hidden; min-height: 200px; }
```

- [ ] **Step 3: Manual verification**

Run: `npm run tauri dev`
Expected: a terminal appears, `claude` starts, prints a response to "say hello and wait", and you can type into it and get replies. Type `exit` or close the window to end.

- [ ] **Step 4: Commit**

```bash
git add src/terminal.ts src/main.ts src/styles.css
git commit -m "feat: xterm terminal panel bound to a live claude session"
```

---

## Task 12: Workspaces UI (switcher + CRUD)

**Files:**
- Create: `src/workspaces.ts`
- Modify: `src/main.ts`, `src/styles.css`

**Interfaces:**
- Consumes: `ipc.{listWorkspaces, saveWorkspace, removeWorkspace}`.
- Produces: `class WorkspacesPanel` with `constructor(mount: HTMLElement, onSelect: (ws: Workspace) => void)`, `async load()`, `get active(): Workspace | null`. Uses `crypto.randomUUID()` for new ids. Path entry is a text field (manual paste of the project folder path).

- [ ] **Step 1: Implement the workspaces panel**

`src/workspaces.ts`:
```ts
import { listWorkspaces, saveWorkspace, removeWorkspace, type Workspace } from "./ipc";

export class WorkspacesPanel {
  private items: Workspace[] = [];
  private activeId: string | null = null;
  constructor(private mount: HTMLElement, private onSelect: (ws: Workspace) => void) {}

  get active(): Workspace | null {
    return this.items.find((w) => w.id === this.activeId) ?? null;
  }

  async load() {
    this.items = await listWorkspaces();
    if (!this.activeId && this.items[0]) this.select(this.items[0].id);
    this.render();
  }

  private select(id: string) {
    this.activeId = id;
    const ws = this.active;
    if (ws) this.onSelect(ws);
    this.render();
  }

  private async add() {
    const name = prompt("Имя пространства")?.trim();
    if (!name) return;
    const path = prompt("Путь к папке проекта")?.trim();
    if (!path) return;
    const ws: Workspace = { id: crypto.randomUUID(), name, path, color: "#3b82f6" };
    this.items = await saveWorkspace(ws);
    this.select(ws.id);
  }

  private async del(id: string) {
    if (!confirm("Удалить пространство?")) return;
    this.items = await removeWorkspace(id);
    if (this.activeId === id) this.activeId = this.items[0]?.id ?? null;
    this.render();
  }

  private render() {
    this.mount.innerHTML = "<h3>Пространства</h3>";
    for (const w of this.items) {
      const row = document.createElement("div");
      row.className = "ws-row" + (w.id === this.activeId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = w.color;
      const label = document.createElement("button");
      label.className = "ws-label"; label.textContent = w.name;
      label.onclick = () => this.select(w.id);
      const x = document.createElement("button");
      x.className = "ws-del"; x.textContent = "✕";
      x.onclick = () => this.del(w.id);
      row.append(dot, label, x);
      this.mount.appendChild(row);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "ws-add"; addBtn.textContent = "+ пространство";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
```

- [ ] **Step 2: Wire into main.ts**

Replace `src/main.ts`:
```ts
import { WorkspacesPanel } from "./workspaces";
import type { Workspace } from "./ipc";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const wsMount = document.createElement("div");
sidebar.appendChild(wsMount);

let activeWorkspace: Workspace | null = null;
const workspaces = new WorkspacesPanel(wsMount, (ws) => { activeWorkspace = ws; });
workspaces.load();
```

Add to `src/styles.css`:
```css
.ws-row { display: flex; align-items: center; gap: 6px; padding: 4px; border-radius: 4px; }
.ws-row.active { background: #2a2a30; }
.ws-label { flex: 1; text-align: left; background: none; border: none; color: #eee; cursor: pointer; }
.ws-del, .ws-add { background: none; border: 1px solid #444; color: #aaa; border-radius: 4px; cursor: pointer; }
.ws-add { margin-top: 8px; width: 100%; padding: 6px; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
```

- [ ] **Step 3: Manual verification**

Run: `npm run tauri dev`
Expected: sidebar shows "Пространства" with a "+ пространство" button; adding one (name + a real folder path like `/home/evgeny-kharetski/workspace/lemsoft/grosh`) persists it (still present after restart); selecting highlights it; deleting removes it.

- [ ] **Step 4: Commit**

```bash
git add src/workspaces.ts src/main.ts src/styles.css
git commit -m "feat: workspaces switcher with create/delete/persist"
```

---

## Task 13: Skills UI (buttons + editor) launching sessions

**Files:**
- Create: `src/skills.ts`
- Modify: `src/main.ts`, `src/styles.css`

**Interfaces:**
- Consumes: `ipc.{listSkills, saveSkill, removeSkill}`; a `launch(skill: Skill)` callback provided by main (which creates a terminal panel — see Task 14).
- Produces: `class SkillsPanel` with `constructor(mount: HTMLElement, getActiveWorkspaceId: () => string | null, onLaunch: (skill: Skill) => void)`, `async load()`. Shows skills that are global (`workspaceId == null`) plus those matching the active workspace. Editor via prompts (name, icon, multi-line prompt).

- [ ] **Step 1: Implement the skills panel**

`src/skills.ts`:
```ts
import { listSkills, saveSkill, removeSkill, type Skill } from "./ipc";

export class SkillsPanel {
  private items: Skill[] = [];
  constructor(
    private mount: HTMLElement,
    private getActiveWorkspaceId: () => string | null,
    private onLaunch: (skill: Skill) => void,
  ) {}

  async load() { this.items = await listSkills(); this.render(); }

  private visible(): Skill[] {
    const wid = this.getActiveWorkspaceId();
    return this.items.filter((s) => !s.workspaceId || s.workspaceId === wid);
  }

  private async add() {
    const name = prompt("Имя сценария")?.trim();
    if (!name) return;
    const icon = prompt("Значок (эмодзи)", "▶")?.trim() || "▶";
    const promptText = prompt("Текст задания (первое сообщение)")?.trim();
    if (!promptText) return;
    const scope = confirm("Привязать к текущему пространству? (Отмена = общий)");
    const sk: Skill = {
      id: crypto.randomUUID(), name, icon, prompt: promptText,
      workspaceId: scope ? this.getActiveWorkspaceId() : null,
    };
    this.items = await saveSkill(sk);
    this.render();
  }

  private async del(id: string) {
    if (!confirm("Удалить сценарий?")) return;
    this.items = await removeSkill(id);
    this.render();
  }

  private render() {
    this.mount.innerHTML = "<h3>Сценарии</h3>";
    for (const s of this.visible()) {
      const row = document.createElement("div");
      row.className = "sk-row";
      const run = document.createElement("button");
      run.className = "sk-run"; run.textContent = `${s.icon} ${s.name}`;
      run.title = s.prompt;
      run.onclick = () => this.onLaunch(s);
      const x = document.createElement("button");
      x.className = "sk-del"; x.textContent = "✕";
      x.onclick = () => this.del(s.id);
      row.append(run, x);
      this.mount.appendChild(row);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "sk-add"; addBtn.textContent = "+ сценарий";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
```

- [ ] **Step 2: Wire into main.ts (with a temporary launch stub)**

Update `src/main.ts` to add skills below workspaces; launch stub just logs for now (real launch lands in Task 14):
```ts
import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import type { Workspace } from "./ipc";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
sidebar.append(wsMount, skMount);

let activeWorkspace: Workspace | null = null;
const workspaces = new WorkspacesPanel(wsMount, (ws) => { activeWorkspace = ws; });
const skills = new SkillsPanel(skMount, () => activeWorkspace?.id ?? null, (skill) => {
  console.log("launch skill", skill.name, "in", activeWorkspace?.path);
});
workspaces.load();
skills.load();
```

Add to `src/styles.css`:
```css
.sk-row { display: flex; gap: 6px; margin: 4px 0; }
.sk-run { flex: 1; text-align: left; padding: 6px; background: #26304a; color: #eee; border: none; border-radius: 4px; cursor: pointer; }
.sk-del { background: none; border: 1px solid #444; color: #aaa; border-radius: 4px; cursor: pointer; }
.sk-add { width: 100%; padding: 6px; margin-top: 8px; background: none; border: 1px solid #444; color: #aaa; border-radius: 4px; cursor: pointer; }
```

- [ ] **Step 3: Manual verification**

Run: `npm run tauri dev`
Expected: "Сценарии" section with "+ сценарий"; adding one persists it; global skills show under any workspace, workspace-scoped ones only under their workspace; clicking a skill logs to the devtools console.

- [ ] **Step 4: Commit**

```bash
git add src/skills.ts src/main.ts src/styles.css
git commit -m "feat: skills panel with create/delete and launch callback"
```

---

## Task 14: Session tiles, state labels, and OS notifications

The deck manager owns terminal tiles. It creates a tile when a skill launches (Task 13 callback) or via a "+ сессия" button that opens a plain interactive session in the active workspace. It shows a state label per tile + per session in a list, and raises an OS notification on transitions into `waitingInput`, `ended`, or `error`.

**Files:**
- Create: `src/sessions.ts`
- Modify: `src/main.ts`
- Modify: `src-tauri/tauri.conf.json` (notification permission), `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `TerminalPanel`; `ipc.{onOutput, onState, onExit, closeSession, type SessionState, type Skill, type Workspace}`; `@tauri-apps/plugin-notification`.
- Produces: `class Deck` with `constructor(deckEl, listEl)`, `wireEvents()`, `launch(workspace: Workspace, skill: Skill | null)`.

- [ ] **Step 1: Grant notification capability**

Create `src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for cowork-deck",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "notification:default"
  ]
}
```

- [ ] **Step 2: Implement the deck**

`src/sessions.ts`:
```ts
import { TerminalPanel } from "./terminal";
import { onOutput, onState, onExit, closeSession, type SessionState, type Skill, type Workspace } from "./ipc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

interface Tile { session: string; name: string; panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement; }

const LABEL: Record<SessionState, string> = {
  idle: "готов", working: "работает", waitingInput: "ждёт ввода", ended: "завершён", error: "ошибка",
};
const NOTIFY_ON: SessionState[] = ["waitingInput", "ended", "error"];

export class Deck {
  private tiles = new Map<string, Tile>();
  private notifyOk = false;
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement) {}

  async wireEvents() {
    this.notifyOk = await isPermissionGranted();
    if (!this.notifyOk) this.notifyOk = (await requestPermission()) === "granted";
    await onOutput((s, text) => this.tiles.get(s)?.panel.write(text));
    await onState((s, state) => this.setState(s, state));
    await onExit((s) => { /* state already emitted; keep tile for scrollback */ void s; });
  }

  async launch(workspace: Workspace, skill: Skill | null) {
    const session = crypto.randomUUID();
    const el = document.createElement("div");
    el.className = "tile";
    const head = document.createElement("div");
    head.className = "tile-head";
    const title = document.createElement("span");
    title.textContent = skill ? `${skill.icon} ${skill.name}` : `терминал · ${workspace.name}`;
    const label = document.createElement("span");
    label.className = "tile-state state-idle"; label.textContent = LABEL.idle;
    const close = document.createElement("button");
    close.textContent = "✕"; close.className = "tile-close";
    close.onclick = () => this.remove(session);
    head.append(title, label, close);
    const mount = document.createElement("div");
    mount.className = "tile-body";
    el.append(head, mount);
    this.deckEl.appendChild(el);

    const panel = new TerminalPanel(session, mount);
    const tile: Tile = { session, name: title.textContent!, panel, state: "idle", el, label };
    this.tiles.set(session, tile);
    this.renderList();
    await panel.start(workspace.path, skill ? skill.prompt : null);
  }

  private setState(session: string, state: SessionState) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    const prev = tile.state;
    tile.state = state;
    tile.label.className = `tile-state state-${state}`;
    tile.label.textContent = LABEL[state];
    this.renderList();
    if (state !== prev && NOTIFY_ON.includes(state) && this.notifyOk) {
      sendNotification({ title: `cowork-deck · ${LABEL[state]}`, body: tile.name });
    }
  }

  private remove(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    void closeSession(session);
    tile.panel.dispose();
    tile.el.remove();
    this.tiles.delete(session);
    this.renderList();
  }

  private renderList() {
    this.listEl.innerHTML = "<h3>Сессии</h3>";
    for (const t of this.tiles.values()) {
      const row = document.createElement("div");
      row.className = "sess-row";
      row.innerHTML = `<span class="tile-state state-${t.state}">${LABEL[t.state]}</span> <span>${t.name}</span>`;
      this.listEl.appendChild(row);
    }
  }
}
```

- [ ] **Step 3: Final main.ts wiring**

`src/main.ts`:
```ts
import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable, type Workspace } from "./ipc";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
const listMount = document.createElement("div");
const newBtn = document.createElement("button");
newBtn.textContent = "+ сессия"; newBtn.className = "ws-add";
sidebar.append(wsMount, skMount, newBtn, listMount);

let activeWorkspace: Workspace | null = null;
const deck = new Deck(deckEl, listMount);
deck.wireEvents();

const workspaces = new WorkspacesPanel(wsMount, (ws) => { activeWorkspace = ws; });
const skills = new SkillsPanel(skMount, () => activeWorkspace?.id ?? null, (skill) => {
  if (activeWorkspace) deck.launch(activeWorkspace, skill);
});
newBtn.onclick = () => { if (activeWorkspace) deck.launch(activeWorkspace, null); };

workspaces.load();
skills.load();

claudeAvailable().then((ok) => {
  if (!ok) alert("Не найден исполняемый файл claude. Укажите путь через переменную окружения COWORK_CLAUDE_PATH и перезапустите приложение.");
});
```

Add to `src/styles.css`:
```css
#deck { grid-template-columns: repeat(2, 1fr); grid-auto-rows: 1fr; }
.tile { display: flex; flex-direction: column; background: #000; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
.tile-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: #16161a; color: #eee; font-size: 12px; }
.tile-head span:first-child { flex: 1; }
.tile-body { flex: 1; min-height: 0; }
.tile-close { background: none; border: none; color: #aaa; cursor: pointer; }
.tile-state { font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.state-idle { background: #334; color: #cde; }
.state-working { background: #1e3a2a; color: #8f8; }
.state-waitingInput { background: #4a3a10; color: #fd6; }
.state-ended { background: #333; color: #bbb; }
.state-error { background: #4a1e1e; color: #f88; }
.sess-row { display: flex; gap: 6px; align-items: center; font-size: 12px; margin: 3px 0; }
```

- [ ] **Step 4: Manual verification (end-to-end)**

Run: `npm run tauri dev`
Expected:
1. Add a workspace pointing at a real project folder; add a skill with a prompt like "list the files here and summarize the project".
2. Click the skill → a tile opens, label goes `работает`, then `ждёт ввода` when Claude finishes; an OS notification fires on `ждёт ввода`.
3. `+ сессия` opens a plain interactive terminal in the active workspace.
4. Typing works; closing a tile ends that session; closing the window ends all sessions (verify no lingering `claude` processes: `pgrep -fa claude`).

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/main.ts src/styles.css src-tauri/capabilities/default.json
git commit -m "feat: session tiles with state labels and OS notifications"
```

---

## Task 15: Robustness — claude path override, restart, graceful degradation

**Files:**
- Modify: `src/sessions.ts` (restart control on error/ended), `src/ipc.ts` (no change expected), `README.md` (create)

**Interfaces:**
- Consumes: existing commands.
- Produces: a "⟳ перезапустить" button on tiles in `ended`/`error` state that starts a fresh session in the same workspace with the same initial prompt; a README documenting `COWORK_CLAUDE_PATH` and behavior when hooks don't fire.

- [ ] **Step 1: Add restart affordance to the deck**

In `src/sessions.ts`, extend `Tile` to remember launch context and add a restart button. Add fields to the `Tile` interface: `workspacePath: string; prompt: string | null; restartBtn: HTMLButtonElement;`. In `launch`, capture `workspacePath: workspace.path` and `prompt: skill ? skill.prompt : null`, create a hidden restart button in the head:
```ts
const restart = document.createElement("button");
restart.textContent = "⟳"; restart.className = "tile-close"; restart.style.display = "none";
restart.title = "перезапустить";
restart.onclick = async () => {
  restart.style.display = "none";
  tile.panel.write("\r\n[перезапуск сессии...]\r\n");
  await tile.panel.start(tile.workspacePath, tile.prompt);
  this.setState(session, "idle");
};
head.insertBefore(restart, close);
```
Store `restartBtn: restart` on the tile. In `setState`, show it when state is `ended` or `error`, hide otherwise:
```ts
tile.restartBtn.style.display = (state === "ended" || state === "error") ? "inline" : "none";
```

- [ ] **Step 2: Manual verification**

Run: `npm run tauri dev`. Launch a session, let it finish (or type `/exit` to end it), confirm the ⟳ button appears and restarts the session in place. Confirm that if hooks never fire (e.g. an older claude), the terminal still works fully — only the state label stays `готов`.

- [ ] **Step 3: Write README**

Create `README.md` documenting: what the app is; build/run (`npm install`, `npm run tauri dev`, `npm run tauri build`); that sessions end with the window; `COWORK_CLAUDE_PATH` override when `claude` isn't on PATH; and the graceful-degradation note (terminals work even if state hooks don't fire).

- [ ] **Step 4: Commit**

```bash
git add src/sessions.ts README.md
git commit -m "feat: session restart, claude path override, and README"
```

---

## Task 16: Release build and final smoke check

**Files:**
- Modify: none (verification task); may adjust `tauri.conf.json` bundle targets if a platform build needs it.

- [ ] **Step 1: Run the full test suite**

Run: `cd src-tauri && cargo test && cd .. && npx vitest run`
Expected: all Rust and TS tests PASS.

- [ ] **Step 2: Produce a release build**

Run: `npm run tauri build`
Expected: a bundled app is produced for the current OS under `src-tauri/target/release/bundle/`. Note the idle memory of the running app (Activity Monitor / Task Manager / `ps`) and confirm it is well under the 100 MB target with 1–2 idle tiles.

- [ ] **Step 3: Smoke checklist**

Verify against the spec: two live tiles in different workspaces run simultaneously; state labels update; OS notification fires on `ждёт ввода`; skill button launches with the saved prompt; closing the window kills all `claude` processes (`pgrep -fa claude` empty afterward).

- [ ] **Step 4: Commit any final adjustments**

```bash
git add -A
git commit -m "chore: release build verification and smoke check"
```

---

## Self-Review Notes

- **Spec coverage:** desktop window (T1); live interactive terminals (T8, T11); text-template skills launched per button (T13, T14); in-app state labels + OS notifications (T14); sessions die with window (T9 `kill_all` on close); minimal-resource stack — Tauri, vanilla TS, no framework, render via xterm (T1, T16 verifies footprint); multi-OS — portable-pty, reporter binary instead of curl, `cmd`/`sh` handled in tests (T5, T8); workspaces by project (T4, T12); state detection via hooks (T2 spike, T5–T7); graceful degradation + claude-not-found + restart (T9, T14, T15). All spec sections map to a task.
- **Known contingency (flagged in spec):** exact hook JSON schema is confirmed empirically in T2 before T6 depends on it; T6 notes the flat-vs-nested fallback.
- **Type consistency:** `SessionState` variants are camelCase across Rust serde and TS (`idle|working|waitingInput|ended|error`); command names match between `commands.rs` handlers, `generate_handler!`, and `ipc.ts`; event names (`session://output|state|exit`) match between `commands.rs`/`main.rs` emits and `ipc.ts` listeners; `Skill.workspaceId`/`Workspace` field names align via serde `rename`.
