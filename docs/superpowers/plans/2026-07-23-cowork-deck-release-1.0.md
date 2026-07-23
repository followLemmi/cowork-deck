# cowork-deck Release 1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести cowork-deck до «надёжного MVP, которому доверяешь» — закрыть P0-блокеры стабильности/безопасности и построить слой управления вниманием + связную визуальную систему, чтобы метки состояния и уведомления реально работали и продавали мультизадачность.

**Architecture:** Правки в существующей кодовой базе Tauri v2 (ядро Rust + ванильный TypeScript-фронтенд с xterm.js). Backend-задачи изолируют логику в чистые функции с юнит-тестами (`cargo test`); frontend-задачи с логикой покрываются vitest+jsdom; чисто визуальные (CSS) задачи проверяются вручную запуском `npm run tauri dev`. Каждая задача — самодостаточный коммит.

**Tech Stack:** Tauri v2, Rust (tokio, serde), TypeScript (vanilla, без фреймворков), xterm.js (`@xterm/xterm` + `@xterm/addon-fit`), Vite, Vitest, `@tauri-apps/plugin-notification`.

## Global Constraints

- Целевой расход памяти приложения — **< 100 МБ** в покое; не добавлять тяжёлых зависимостей и не тянуть фреймворки.
- Фронтенд — **только ванильный TypeScript**; никаких React/Vue и т.п.
- Тёмная тема; палитра — на базе One Dark (уже используется в теме терминала).
- Анимации — только на `transform`/`opacity` (GPU-композитинг, без роста памяти); уважать `prefers-reduced-motion`.
- Существующие команды тестов не менять: `npm test` (vitest) и `cargo test --manifest-path src-tauri/Cargo.toml`.
- Коммиты — Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
- Не ломать существующие тесты: `src-tauri/src/{model,hooks,commands,listener}.rs` (inline `#[cfg(test)]`), `src-tauri/tests/reporter.rs`, `tests/ipc.test.ts`.
- Строки интерфейса — на русском, в существующем стиле («готов», «работает», «ждёт ввода», «завершён», «ошибка»).

---

## File Structure

**Backend (Rust):**
- `src-tauri/tauri.conf.json` — CSP + `beforeDevCommand` (сборка dev-докладчика).
- `src-tauri/src/main.rs` — `resolve_reporter_path` (чистая функция + тесты).
- `src-tauri/src/listener.rs` — `next_backoff` + backoff в цикле accept.
- `src-tauri/Cargo.toml` — включить фичу `time` у tokio.

**Frontend (TS):**
- `src/sessions.ts` — обработка ошибки запуска, фокус активной плитки, кликабельный список, счётчик «ждут ввода», `waitingCount`.
- `src/terminal.ts` — акцентная тема xterm, метод `focus()`.
- `src/styles.css` — дизайн-токены, 3 уровня фона, метки состояния + пульс, адаптивная сетка, активная плитка, хром/сайдбар/кнопки, пустое состояние.
- `package.json` — devDependency `jsdom`.

**Tests:**
- `tests/sessions.test.ts` — новый (jsdom): ошибка запуска, фокус, кликабельный список.
- `tests/sessions-util.test.ts` — новый: `waitingCount`.

**Docs:**
- `docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md` — чек-лист ручной приёмки.

---

## Task 1: Строгий CSP (P0-1)

**Files:**
- Modify: `src-tauri/tauri.conf.json:16`

**Interfaces:**
- Consumes: —
- Produces: рабочий webview со строгим CSP; последующие задачи полагаются на то, что inline-стили xterm, локальные шрифты и IPC не блокируются.

- [ ] **Step 1: Заменить `csp: null` на строгий CSP + devCsp**

В `src-tauri/tauri.conf.json` заменить блок `"security": { "csp": null }` на:

```json
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost",
      "devCsp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420"
    }
```

Обоснование директив: `style-src 'unsafe-inline'` — xterm.js задаёт inline-стили ячеек; `font-src 'self'` — встроенный CaskaydiaCove; `connect-src ipc: http://ipc.localhost` — канал Tauri IPC; в `devCsp` добавлены `ws/http://localhost:1420` для Vite HMR и `script-src 'unsafe-inline'` для инъекций dev-сервера.

- [ ] **Step 2: Проверить валидность JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Проверить, что приложение грузится под CSP**

Run: `npm run tauri dev` (после Task 2 dev-докладчик соберётся; для этой задачи достаточно, что окно открывается)
Проверить вручную: окно открылось; в DevTools-консоли (`Ctrl/Cmd+Shift+I`) **нет** ошибок `Content-Security-Policy`; терминальная плитка рендерит текст; шрифт моноширинный (лигатуры не требуются). Закрыть.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "fix: set strict CSP for webview (P0-1)"
```

---

## Task 2: Докладчик находится в dev-режиме (P0-4)

**Files:**
- Modify: `src-tauri/src/main.rs:14-20`
- Modify: `src-tauri/tauri.conf.json:9`

**Interfaces:**
- Consumes: —
- Produces: `resolve_reporter_path(exe_dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf` — резолвер, выбирающий первый существующий кандидат; используется `reporter_path() -> String`.

- [ ] **Step 1: Написать падающие тесты резолвера**

В конец `src-tauri/src/main.rs` добавить:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn prefers_reporter_next_to_exe() {
        let dir = Path::new("/app");
        let got = resolve_reporter_path(dir, "cowork_report", |p| {
            p == Path::new("/app/cowork_report")
        });
        assert_eq!(got, Path::new("/app/cowork_report"));
    }

    #[test]
    fn falls_back_to_release_sibling_in_dev() {
        let dir = Path::new("/proj/target/debug");
        let release = dir.join("..").join("release").join("cowork_report");
        let got = resolve_reporter_path(dir, "cowork_report", |p| p == release);
        assert_eq!(got, release);
    }

    #[test]
    fn defaults_to_exe_dir_when_none_exist() {
        let dir = Path::new("/app");
        let got = resolve_reporter_path(dir, "cowork_report", |_| false);
        assert_eq!(got, Path::new("/app/cowork_report"));
    }
}
```

- [ ] **Step 2: Запустить тест — убедиться, что не компилируется/падает**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --bin cowork-deck resolve_reporter 2>&1 | tail -20`
Expected: ошибка компиляции `cannot find function resolve_reporter_path`.

- [ ] **Step 3: Реализовать резолвер и переписать `reporter_path`**

В `src-tauri/src/main.rs` заменить функцию `reporter_path` (строки 14-20) на:

```rust
use std::path::{Path, PathBuf};

fn reporter_name() -> &'static str {
    if cfg!(windows) { "cowork_report.exe" } else { "cowork_report" }
}

/// Resolve the reporter binary path by probing an ordered list of candidate
/// locations, returning the first that exists. Order: next to the current exe
/// (bundled sidecar / release build), then the sibling `release` dir (so
/// `tauri dev`, whose exe lives in `target/debug`, still finds a staged
/// reporter). Falls back to the exe-adjacent path so bundled behavior is
/// unchanged when nothing is found.
fn resolve_reporter_path(exe_dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let candidates = [
        exe_dir.join(name),
        exe_dir.join("..").join("release").join(name),
    ];
    for c in &candidates {
        if exists(c) {
            return c.clone();
        }
    }
    candidates[0].clone()
}

fn reporter_path() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    resolve_reporter_path(&dir, reporter_name(), |p| p.exists())
        .to_string_lossy()
        .to_string()
}
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --bin cowork-deck resolve_reporter`
Expected: 3 passed.

- [ ] **Step 5: Собирать debug-докладчик перед стартом dev**

В `src-tauri/tauri.conf.json` заменить `"beforeDevCommand": "npm run dev"` на:

```json
    "beforeDevCommand": "cargo build --manifest-path src-tauri/Cargo.toml --bin cowork_report && npm run dev",
```

Это кладёт `cowork_report` в `src-tauri/target/debug/` — рядом с dev-бинарём приложения, т.е. кандидат №1 резолвера.

- [ ] **Step 6: Проверить, что метки состояния работают в dev**

Run: `npm run tauri dev`
Проверить вручную: создать пространство (путь к любому репо), запустить сессию; метка плитки меняется `готов → работает` при вводе, а на `Stop`/простое — `ждёт ввода`. Если claude не установлен — пропустить проверку меток, убедиться хотя бы, что путь резолвится (лог без паники). Закрыть.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/tauri.conf.json
git commit -m "fix: resolve reporter path with dev fallback so hooks work in tauri dev (P0-4)"
```

---

## Task 3: Backoff в цикле accept слушателя (P0-3)

**Files:**
- Modify: `src-tauri/src/listener.rs:17-37`
- Modify: `src-tauri/Cargo.toml:20` (фича tokio `time`)
- Test: `src-tauri/src/listener.rs` (inline)

**Interfaces:**
- Consumes: —
- Produces: `next_backoff(current: Duration) -> Duration` — удвоение с потолком 1с.

- [ ] **Step 1: Написать падающий тест backoff**

В `src-tauri/src/listener.rs` в существующий `mod tests` добавить (после `use` добавь `use std::time::Duration;`):

```rust
    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(next_backoff(Duration::ZERO), Duration::from_millis(50));
        assert_eq!(next_backoff(Duration::from_millis(50)), Duration::from_millis(100));
        assert_eq!(next_backoff(Duration::from_millis(800)), Duration::from_secs(1));
        assert_eq!(next_backoff(Duration::from_secs(1)), Duration::from_secs(1));
    }
```

- [ ] **Step 2: Запустить тест — убедиться, что не компилируется**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib backoff_grows 2>&1 | tail -20`
Expected: ошибка `cannot find function next_backoff`.

- [ ] **Step 3: Включить фичу tokio `time`**

В `src-tauri/Cargo.toml` в строке зависимости tokio добавить `"time"`:

```toml
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "sync", "macros", "time"] }
```

- [ ] **Step 4: Реализовать `next_backoff` и вписать в цикл**

В `src-tauri/src/listener.rs` добавить над `start_listener` (после `use`-блока):

```rust
use std::time::Duration;

/// Next accept-retry backoff: 50ms first, then doubling up to a 1s cap.
fn next_backoff(current: Duration) -> Duration {
    if current.is_zero() {
        Duration::from_millis(50)
    } else {
        std::cmp::min(current * 2, Duration::from_secs(1))
    }
}
```

Заменить тело `tokio::spawn(async move { loop { ... } });` (строки 17-37) на:

```rust
    tokio::spawn(async move {
        let mut backoff = Duration::ZERO;
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => {
                    backoff = Duration::ZERO;
                    v
                }
                Err(_) => {
                    backoff = next_backoff(backoff);
                    tokio::time::sleep(backoff).await;
                    continue;
                }
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
```

- [ ] **Step 5: Запустить тесты слушателя — убедиться, что проходят**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib listener`
Expected: `backoff_grows_and_caps` и `receives_and_maps_a_line` passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/listener.rs src-tauri/Cargo.toml
git commit -m "fix: exponential backoff in listener accept loop to avoid busy-spin (P0-3)"
```

---

## Task 4: Ошибка запуска сессии → плитка «ошибка» (P0-2)

**Files:**
- Modify: `src/sessions.ts:64` (обернуть `panel.start`)
- Create: `tests/sessions.test.ts`
- Modify: `package.json` (devDependency `jsdom`)

**Interfaces:**
- Consumes: `Deck` (существующий класс), `TerminalPanel.write`, `Deck.setState`.
- Produces: при реджекте `panel.start` плитка получает состояние `error` и сообщение в терминал.

- [ ] **Step 1: Установить jsdom**

Run: `npm i -D jsdom`
Expected: устанавливается, `package.json` получает `"jsdom"` в devDependencies.

- [ ] **Step 2: Написать падающий тест обработки ошибки**

Create `tests/sessions.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const writeSpy = vi.fn();
const startMock = vi.fn();

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    mount: HTMLElement;
    constructor(session: string, mount: HTMLElement) {
      this.session = session;
      this.mount = mount;
    }
    start = startMock;
    write = writeSpy;
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onOutput: vi.fn().mockResolvedValue(() => {}),
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

import { Deck } from "../src/sessions";

const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

describe("Deck.launch error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("marks the tile as error when start rejects", async () => {
    startMock.mockRejectedValueOnce(new Error("claude-not-found"));
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl);

    await deck.launch(WS as any, null);

    const label = deckEl.querySelector(".tile-state")!;
    expect(label.className).toContain("state-error");
    expect(writeSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `npm test -- sessions.test`
Expected: FAIL — метка остаётся `state-idle` (ошибка не обрабатывается).

- [ ] **Step 4: Обернуть `panel.start` в try/catch**

В `src/sessions.ts` заменить последнюю строку метода `launch` (строка 64):

```ts
    await panel.start(workspace.path, skill ? skill.prompt : null);
```

на:

```ts
    try {
      await panel.start(workspace.path, skill ? skill.prompt : null);
    } catch (e) {
      this.setState(session, "error");
      const raw = String((e as { message?: string })?.message ?? e);
      const readable = raw.includes("claude-not-found")
        ? "claude не найден — укажите путь и перезапустите"
        : raw;
      panel.write(`\r\n[ошибка запуска: ${readable}]\r\n`);
    }
```

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `npm test -- sessions.test`
Expected: PASS.

- [ ] **Step 6: Прогнать весь фронт-набор (регрессия)**

Run: `npm test`
Expected: все тесты (`ipc.test.ts`, `sessions.test.ts`) passed.

- [ ] **Step 7: Commit**

```bash
git add src/sessions.ts tests/sessions.test.ts package.json package-lock.json
git commit -m "fix: surface session launch failure as error tile (P0-2)"
```

---

## Task 5: Дизайн-система — токены, фоны, хром, сайдбар, кнопки, тема xterm

**Files:**
- Modify: `src/styles.css` (токены `:root` + перевод базовых правил на переменные)
- Modify: `src/terminal.ts:20-28` (акцентная тема)

**Interfaces:**
- Consumes: существующая DOM-разметка (`#sidebar`, `#deck`, `.tile`, `.ws-*`, `.sk-*`, `<h3>`).
- Produces: CSS-переменные `--bg-app/--bg-panel/--bg-raised/--accent/...`, которые используют задачи 6-8.

- [ ] **Step 1: Добавить блок токенов в начало правил styles.css**

В `src/styles.css` сразу после `@font-face`-блоков (после строки 14) вставить:

```css
:root {
  --bg-app: #16181d;
  --bg-panel: #1b1e24;
  --bg-raised: #21252b;
  --bg-terminal: #1d1f21;

  --border: #2c313a;
  --border-strong: #3a414d;

  --fg: #e6e6e6;
  --fg-muted: #abb2bf;
  --fg-subtle: #6b727d;

  --accent: #61afef;
  --accent-weak: rgba(97, 175, 239, 0.14);

  --st-idle: #6b727d;
  --st-working: #98c379;
  --st-waiting: #e5c07b;
  --st-ended: #56b6c2;
  --st-error: #e06c75;

  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px;
  --fw-medium: 550; --fw-bold: 650;

  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --r-sm: 6px; --r-md: 10px;

  --shadow-tile: 0 2px 8px rgba(0, 0, 0, 0.35);
  --focus-ring: 0 0 0 1px var(--accent), 0 0 12px rgba(97, 175, 239, 0.25);

  --ease: cubic-bezier(0.2, 0, 0, 1);
  --dur-1: 120ms; --dur-2: 220ms;
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

- [ ] **Step 2: Перевести базовые правила на токены**

В `src/styles.css` заменить правила `#app`, `#sidebar`, `#deck` (строки 18-20), `.ws-*`, `.sk-*`, `.tile`, `.tile-head`, `.tile-body`, `.tile-close`, `.dot` на:

```css
#app { display: flex; font-family: var(--font-ui); color: var(--fg); background: var(--bg-app); }
#sidebar {
  width: 248px; background: var(--bg-panel); border-right: 1px solid var(--border);
  color: var(--fg); padding: var(--sp-3) var(--sp-2); overflow: auto;
  display: flex; flex-direction: column; gap: var(--sp-2);
}
#sidebar h3 {
  margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-bold);
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-subtle);
}
#sidebar h3:first-child { margin-top: 0; }
#deck { flex: 1; display: grid; gap: var(--sp-2); padding: var(--sp-2); background: var(--bg-app); }

.ws-row { display: flex; align-items: center; gap: var(--sp-2); padding: 6px var(--sp-2); border-radius: var(--r-sm); transition: background var(--dur-1) var(--ease); }
.ws-row:hover { background: var(--bg-raised); }
.ws-row.active { background: var(--accent-weak); box-shadow: inset 2px 0 0 var(--accent); }
.ws-label { flex: 1; text-align: left; background: none; border: none; color: var(--fg); font: inherit; font-size: var(--fs-base); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-row.active .ws-label { color: var(--accent); font-weight: var(--fw-medium); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.25); }

.sk-row { display: flex; gap: 6px; margin: var(--sp-1) 0; }
.sk-run { flex: 1; text-align: left; padding: 7px var(--sp-2); background: var(--bg-raised); color: var(--fg); border: 1px solid var(--border); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-base); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), transform var(--dur-1) var(--ease); }
.sk-run:hover { background: var(--accent-weak); border-color: var(--accent); transform: translateY(-1px); }
.sk-run:active { transform: translateY(0); }

.sk-del, .ws-del { background: none; border: none; color: var(--fg-subtle); border-radius: var(--r-sm); cursor: pointer; padding: 0 6px; opacity: 0; transition: opacity var(--dur-1) var(--ease), color var(--dur-1) var(--ease); }
.sk-row:hover .sk-del, .ws-row:hover .ws-del { opacity: 1; }
.sk-del:hover, .ws-del:hover { color: var(--st-error); }

.sk-add, .ws-add { width: 100%; padding: 7px; margin-top: var(--sp-1); background: none; color: var(--fg-muted); border: 1px dashed var(--border); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); cursor: pointer; transition: all var(--dur-1) var(--ease); }
.sk-add:hover, .ws-add:hover { border-color: var(--accent); color: var(--accent); border-style: solid; background: var(--accent-weak); }

button:focus-visible, .ws-label:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.tile { display: flex; flex-direction: column; background: var(--bg-terminal); border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; box-shadow: var(--shadow-tile); }
.tile-head { display: flex; align-items: center; gap: var(--sp-2); padding: 6px 10px; background: var(--bg-panel); border-bottom: 1px solid var(--border); color: var(--fg); font-size: var(--fs-sm); font-weight: var(--fw-medium); user-select: none; }
.tile-head span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); }
.tile-body { flex: 1; min-height: 0; background: var(--bg-terminal); padding: var(--sp-2); }
.tile-close { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: none; border: none; border-radius: var(--r-sm); color: var(--fg-subtle); cursor: pointer; font-size: 13px; transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease); }
.tile-close:hover { background: var(--bg-raised); color: var(--fg); }

#deck:empty::before {
  content: "Выберите пространство и запустите сессию или сценарий";
  margin: auto; max-width: 320px; text-align: center;
  color: var(--fg-subtle); font-family: var(--font-ui); font-size: var(--fs-base); line-height: 1.6;
}
```

Удалить устаревшее правило `.panel { ... }` (строка 21) — класс `.panel` в текущем коде не используется (плитки используют `.tile`).

- [ ] **Step 3: Синхронизировать акцент темы xterm**

В `src/terminal.ts` в объекте `theme` (строки 20-28) заменить три строки цвета курсора/выделения:

```ts
        background: "#1d1f21", foreground: "#e6e6e6", cursor: "#61afef",
        cursorAccent: "#1d1f21", selectionBackground: "rgba(97,175,239,0.28)",
```

(остальные цвета палитры оставить без изменений).

- [ ] **Step 4: Проверить, что фронт-тесты не сломаны**

Run: `npm test`
Expected: все passed (изменения чисто визуальные, логику не трогали).

- [ ] **Step 5: Визуальная проверка**

Run: `npm run tauri dev`
Проверить вручную: единая холодно-тёмная тема без «пяти разных чёрных»; сайдбар с uppercase-заголовками; кнопки сценариев с hover-подъёмом; «удалить» проявляется на hover строки; пустой дек показывает подсказку; курсор терминала голубой. Закрыть.

- [ ] **Step 6: Commit**

```bash
git add src/styles.css src/terminal.ts
git commit -m "feat: introduce design-system tokens, unified chrome and accent xterm theme"
```

---

## Task 6: Метки состояния — тройное кодирование + пульс

**Files:**
- Modify: `src/styles.css` (правила `.tile-state`, `.state-*`, keyframes)

**Interfaces:**
- Consumes: классы `.tile-state state-<state>`, которые уже проставляет `Deck` (`sessions.ts:72,97`) — TS не меняем.
- Produces: визуально различимые метки (цвет + точка-форма + пульс только у `waitingInput`).

- [ ] **Step 1: Переписать правила меток состояния**

В `src/styles.css` заменить блок `.tile-state` и `.state-*` (строки 38-43) на:

```css
.tile-state {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-ui); font-size: var(--fs-xs); font-weight: var(--fw-medium);
  padding: 2px 8px 2px 6px; border-radius: 999px;
  border: 1px solid transparent; line-height: 1.4; white-space: nowrap;
}
.tile-state::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; flex: none;
}

.state-idle         { color: var(--st-idle);    background: rgba(107, 114, 125, 0.14); }
.state-working      { color: var(--st-working); background: rgba(152, 195, 121, 0.14); }
.state-waitingInput { color: var(--st-waiting); background: rgba(229, 192, 123, 0.16); border-color: rgba(229, 192, 123, 0.4); }
.state-ended        { color: var(--st-ended);   background: rgba(86, 182, 194, 0.14); }
.state-error        { color: var(--st-error);   background: rgba(224, 108, 117, 0.16); border-color: rgba(224, 108, 117, 0.4); }

.state-waitingInput::before { animation: pulse-dot 1.4s var(--ease) infinite; }
@keyframes pulse-dot {
  0%, 100% { box-shadow: 0 0 0 0 rgba(229, 192, 123, 0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(229, 192, 123, 0); }
}
.state-working::before { animation: breathe 1.8s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
```

- [ ] **Step 2: Проверить фронт-тесты (регрессия)**

Run: `npm test`
Expected: все passed.

- [ ] **Step 3: Визуальная проверка различимости**

Run: `npm run tauri dev`
Проверить вручную: у каждого состояния цветная точка перед текстом; **пульсирует только «ждёт ввода»**; «работает» мягко «дышит»; «завершён» — циан (отличается от серого «готов»); «ошибка» — красная рамка. Проверить в macOS-фильтре дальтонизма (System Settings → Accessibility → Display → Color Filters) — состояния различимы по точке+тексту, а не только по цвету. Закрыть.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat: tri-coded state labels with pulse on waiting-input"
```

---

## Task 7: Адаптивная сетка плиток + скролл дека

**Files:**
- Modify: `src/styles.css:32` (правило `#deck` grid)

**Interfaces:**
- Consumes: `#deck` контейнер, дочерние `.tile`.
- Produces: авто-раскладка `auto-fit/minmax`, `min-height` плиток, скролл дека.

- [ ] **Step 1: Заменить фиксированную сетку на адаптивную**

В `src/styles.css` заменить строку 32:

```css
#deck { grid-template-columns: repeat(2, 1fr); grid-auto-rows: 1fr; }
```

на:

```css
#deck {
  grid-template-columns: repeat(auto-fit, minmax(clamp(320px, 42vw, 560px), 1fr));
  grid-auto-rows: minmax(240px, 1fr);
  overflow: auto;
}
.tile { min-height: 240px; }
```

- [ ] **Step 2: Проверить фронт-тесты (регрессия)**

Run: `npm test`
Expected: все passed.

- [ ] **Step 3: Визуальная проверка на 1/4/8 плитках**

Run: `npm run tauri dev`
Проверить вручную: 1 сессия занимает всю ширину дека (нет пустой половины); 4 сессии — аккуратная сетка; 8 сессий — плитки не сплющиваются ниже ~240px, дек скроллится. После смены раскладки терминал перерисовывается (fit срабатывает). Закрыть.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat: adaptive terminal grid with min tile height and deck scroll"
```

---

## Task 8: Фокус активной плитки + кликабельный список сессий

**Files:**
- Modify: `src/sessions.ts` (метод `focusTile`, вызовы, кликабельные строки)
- Modify: `src/terminal.ts` (метод `focus()`)
- Modify: `src/styles.css` (`.tile.is-active`, `#deck.has-active`, `.sess-row`)
- Modify: `tests/sessions.test.ts` (новый describe)

**Interfaces:**
- Consumes: `Deck.tiles`, `TerminalPanel`.
- Produces: `Deck.focusTile(session: string): void` — снимает `is-active` со всех плиток, ставит на нужную, ставит `has-active` на деке, скроллит к ней и фокусирует терминал. Строки списка сессий кликабельны и вызывают `focusTile`.

- [ ] **Step 1: Написать падающий тест фокуса**

В `tests/sessions.test.ts` добавить новый describe в конец файла:

```ts
describe("Deck.focusTile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
  });

  it("clicking a session row marks its tile active", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    const firstRow = listEl.querySelectorAll<HTMLElement>(".sess-row")[0];
    firstRow.click();

    const activeTiles = deckEl.querySelectorAll(".tile.is-active");
    expect(activeTiles.length).toBe(1);
    expect(deckEl.classList.contains("has-active")).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- sessions.test`
Expected: FAIL — `.sess-row` не кликабельны / нет класса `is-active`.

- [ ] **Step 3: Добавить `focus()` в TerminalPanel**

В `src/terminal.ts` добавить метод после `write` (после строки 49):

```ts
  focus() { this.term.focus(); }
```

- [ ] **Step 4: Добавить `focusTile` и вызовы в Deck**

В `src/sessions.ts` в класс `Deck` добавить метод (например, после `setState`):

```ts
  private focusTile(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    for (const t of this.tiles.values()) t.el.classList.toggle("is-active", t === tile);
    this.deckEl.classList.toggle("has-active", this.tiles.size > 0);
    tile.el.scrollIntoView({ block: "nearest" });
    tile.panel.focus();
  }
```

В методе `launch`, сразу после `this.deckEl.appendChild(el);` (строка 55) добавить:

```ts
    el.addEventListener("mousedown", () => this.focusTile(session));
```

В конце `launch` (после `await panel.start(...)`-блока) добавить:

```ts
    this.focusTile(session);
```

В `remove`, после `this.tiles.delete(session);` добавить сброс класса дека:

```ts
    if (this.tiles.size === 0) this.deckEl.classList.remove("has-active");
```

- [ ] **Step 5: Сделать строки списка кликабельными**

В `src/sessions.ts` в методе `renderList` заменить создание `row` так, чтобы строка вызывала фокус. Заменить строки создания `row` (строки 94-95) на:

```ts
      const row = document.createElement("div");
      row.className = "sess-row" + (t.el.classList.contains("is-active") ? " active" : "");
      row.onclick = () => this.focusTile(t.session);
```

- [ ] **Step 6: Добавить CSS активной плитки и строки**

В `src/styles.css` добавить (рядом с `.tile`):

```css
.tile.is-active { border-color: var(--accent); box-shadow: var(--focus-ring), var(--shadow-tile); }
#deck.has-active .tile:not(.is-active) { opacity: 0.82; transition: opacity var(--dur-2) var(--ease); }
.sess-row { display: flex; gap: 6px; align-items: center; font-size: var(--fs-sm); margin: 3px 0; padding: 4px 6px; border-radius: var(--r-sm); cursor: pointer; transition: background var(--dur-1) var(--ease); }
.sess-row:hover { background: var(--bg-raised); }
.sess-row.active { background: var(--accent-weak); }
```

Удалить старое правило `.sess-row` (строка 44), чтобы не дублировалось.

- [ ] **Step 7: Запустить тест — убедиться, что проходит**

Run: `npm test -- sessions.test`
Expected: PASS (оба describe).

- [ ] **Step 8: Визуальная проверка**

Run: `npm run tauri dev`
Проверить вручную: активная плитка имеет голубой контур+свечение, остальные слегка притушены; клик по строке в сайдбаре скроллит/фокусирует нужную плитку; ввод с клавиатуры идёт в сфокусированный терминал. Закрыть.

- [ ] **Step 9: Commit**

```bash
git add src/sessions.ts src/terminal.ts src/styles.css tests/sessions.test.ts
git commit -m "feat: active-tile focus and clickable session list (attention layer)"
```

---

## Task 9: Счётчик «N ждут ввода» в заголовке и заголовке окна

**Files:**
- Modify: `src/sessions.ts` (экспорт `waitingCount`, обновление заголовка списка + `document.title`)
- Create: `tests/sessions-util.test.ts`

**Interfaces:**
- Consumes: `Deck.tiles`, состояния плиток.
- Produces: `export function waitingCount(states: SessionState[]): number` — число сессий в `waitingInput`. `renderList` показывает «Сессии · N ждут ввода» и обновляет `document.title`.

- [ ] **Step 1: Написать падающий тест `waitingCount`**

Create `tests/sessions-util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { waitingCount } from "../src/sessions";
import type { SessionState } from "../src/ipc";

describe("waitingCount", () => {
  it("counts only waitingInput states", () => {
    const states: SessionState[] = ["idle", "waitingInput", "working", "waitingInput", "error"];
    expect(waitingCount(states)).toBe(2);
  });
  it("returns 0 for none", () => {
    expect(waitingCount(["idle", "working", "ended"])).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -- sessions-util`
Expected: FAIL — `waitingCount` не экспортируется.

- [ ] **Step 3: Реализовать `waitingCount` и обновление заголовка**

В `src/sessions.ts` добавить экспортируемую функцию в конец файла (вне класса):

```ts
export function waitingCount(states: SessionState[]): number {
  return states.filter((s) => s === "waitingInput").length;
}
```

В методе `renderList` заменить первую строку (строка 92):

```ts
    this.listEl.innerHTML = "<h3>Сессии</h3>";
```

на:

```ts
    const waiting = waitingCount([...this.tiles.values()].map((t) => t.state));
    const header = waiting > 0 ? `Сессии · ${waiting} ждут ввода` : "Сессии";
    this.listEl.innerHTML = `<h3>${header}</h3>`;
    document.title = waiting > 0 ? `(${waiting}) cowork-deck` : "cowork-deck";
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `npm test`
Expected: все passed (`sessions-util`, `sessions`, `ipc`).

- [ ] **Step 5: Визуальная проверка**

Run: `npm run tauri dev`
Проверить вручную: когда одна/несколько сессий переходят в «ждёт ввода», заголовок «Сессии» показывает счётчик, а заголовок окна получает префикс `(N)`. Когда все обслужены — счётчик исчезает. Закрыть.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts tests/sessions-util.test.ts
git commit -m "feat: waiting-input counter in sidebar and window title"
```

---

## Task 10: Приёмка Release 1.0 — ручной чек-лист (P1-1, P1-2)

**Files:**
- Create: `docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md`

**Interfaces:**
- Consumes: результаты задач 1-9.
- Produces: документированный чек-лист приёмки; закрывает «живую проверку» (P1-1) и «проверку sidecar сборкой» (P1-2).

- [ ] **Step 1: Прогнать полный набор автотестов**

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: все тесты passed (Rust + TS).

- [ ] **Step 2: Аудит зависимостей (P1-8)**

Run: `npm audit --omit=dev || true` и `cargo audit --file src-tauri/Cargo.lock 2>/dev/null || echo "cargo-audit не установлен — отметить в чек-листе"`
Записать найденное в чек-лист (не обязательно чинить в 1.0, но зафиксировать).

- [ ] **Step 3: Живая проверка петли на реальном claude 2.1.217 (P1-1)**

Run: `npm run tauri dev`
Проверить и записать в чек-лист (ниже) фактический результат по каждому пункту: метки `готов/работает/ждёт ввода/завершён/ошибка`; ОС-уведомления на `waitingInput/ended/error`; ресайз окна (терминал следует); расход памяти процесса < 100 МБ (Activity Monitor / `ps`).

- [ ] **Step 4: Проверка sidecar реальной сборкой (P1-2)**

Run: `npm run tauri build 2>&1 | tail -30`
Проверить вручную: сборка успешна; в бандле `cowork_report` лежит рядом с исполняемым файлом; запуск собранного приложения показывает рабочие метки. Записать результат.

- [ ] **Step 5: Создать документ чек-листа с фактическими результатами**

Create `docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md`:

```markdown
# cowork-deck Release 1.0 — чек-лист приёмки

Дата: <ГГГГ-ММ-ДД>

## Автотесты
- [ ] `npm test` — зелёный
- [ ] `cargo test` — зелёный

## P0
- [ ] CSP включён, консоль без нарушений
- [ ] Метки состояния работают в `tauri dev` (докладчик резолвится)
- [ ] Нет busy-loop в listener (backoff)
- [ ] Ошибка запуска → плитка «ошибка»

## Живая проверка (claude 2.1.217)
- [ ] готов / работает / ждёт ввода / завершён / ошибка — все наблюдаются
- [ ] ОС-уведомления приходят на waitingInput / ended / error
- [ ] Ресайз окна: терминал следует
- [ ] Память < 100 МБ: <фактическое значение>

## Sidecar
- [ ] `tauri build` успешен
- [ ] cowork_report рядом с exe в бандле
- [ ] Собранное приложение показывает метки

## Аудит
- [ ] npm audit: <результат>
- [ ] cargo audit: <результат / не установлен>

## Визуальный слой
- [ ] Единая тёмная тема (нет «пяти чёрных»)
- [ ] Пульс только у «ждёт ввода»
- [ ] Адаптивная сетка ок на 1/4/8
- [ ] Активная плитка выделена, клик по списку фокусирует
- [ ] Счётчик «N ждут ввода» в заголовке/окне

## Известные отложенные пункты (в 1.x)
- claude --continue при перезапуске
- нативные диалоги/folder picker вместо prompt/confirm/alert
- редактирование пространств/сценариев
- клик по ОС-уведомлению → фокус окна+плитки
- персист размера окна и активного пространства
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md
git commit -m "docs: Release 1.0 acceptance checklist with live-verification results"
```

---

## Self-Review Notes

- **Spec coverage:** P0-1 (Task 1), P0-2 (Task 4), P0-3 (Task 3), P0-4 (Task 2); attention layer — счётчик/список/фокус (Tasks 8-9); дизайн-система/пульс/сетка (Tasks 5-7); P1-1/P1-2/P1-8 живая приёмка (Task 10). OS-notification-click (F2) сознательно сведён к надёжному in-app эквиваленту (клик по строке списка → фокус) в Task 8; истинный клик по ОС-уведомлению отложен в 1.x (зафиксировано в чек-листе), т.к. надёжная маршрутизация клика в plugin-notification кроссплатформенно не гарантируется.
- **Type consistency:** `focusTile(session: string)`, `waitingCount(states: SessionState[]): number`, `TerminalPanel.focus()`, `resolve_reporter_path(&Path, &str, impl Fn(&Path)->bool)->PathBuf`, `next_backoff(Duration)->Duration` — имена согласованы между задачами и тестами.
- **Deferred (не входит в 1.0):** persist окна/пространства, редактирование, нативные диалоги, `--continue` — это Release 1.x (см. отчёт PM), отдельным планом.
