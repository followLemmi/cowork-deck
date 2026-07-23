# cowork-deck — «Продуктивность агентов» (Группа B) — Design Spec

**Дата:** 2026-07-23
**Ветка:** feat/group-b (от `main`, merge Release 1.0 + Группа A = `9a6d78b`)
**Контекст:** второй спек из «следующего пула» (12 фич), см. vault `Overview/cowork-deck - Roadmap (Next Pool)` §«Kickoff Группы B». Release 1.0 + Группа A влиты в `main` (PR #1). Собственные модалки (`src/modal.ts`, `src/forms.ts`) уже есть — webview Tauri не поддерживает `window.prompt/confirm/alert`.

## Цель
Сделать работу с агентами продуктивнее: рестарт сессии сохраняет контекст (`claude --resume`), сценарии параметризуются плейсхолдерами, при запуске приложения восстанавливаются вчерашние плитки, а один ввод можно разослать в несколько сессий сразу (broadcast).

## Границы (scope)
**Входит:** 4 фичи Группы B — (1) continue при рестарте, (2) плейсхолдеры `{{name}}`, (3) авто-restore при запуске, (4) broadcast-ввод.
**НЕ входит** (Группа C и позже): токен-метр + статистика, пилюля статуса поверх окон, git-индикатор на плитке, persist размера/позиции окна, крупные ставки (мультипровайдер, agent teams, browser automation, mobile, project memory, SSH, tunnel).

## Глобальные ограничения (наследуются всеми задачами)
- Tauri v2, ядро Rust + ванильный TypeScript + xterm.js. **Только ванильный TS, без фреймворков.**
- Целевой расход памяти < 100 МБ; только лёгкие зависимости. **Группа B не добавляет новых зависимостей.**
- Тёмная тема, палитра One Dark, дизайн-токены из `styles.css` (`:root`). Анимации только на transform/opacity/box-shadow; `prefers-reduced-motion` обработан глобально.
- Строки интерфейса — на русском, в существующем стиле.
- Команды тестов неизменны: `npm test` (vitest), `cargo test --manifest-path src-tauri/Cargo.toml`. Не ломать существующие тесты (47 vitest / 15 cargo на старте ветки).
- Коммиты — Conventional Commits.

## Проверенные факты о `claude` (v2.1.218, установлен локально)
- `--session-id <uuid>` — задать свой id сессии при **первом** запуске (id должен быть свежим/неиспользованным).
- `-r, --resume <id>` — возобновить разговор по id.
- **Проверено вживую (print-mode):** `claude --session-id <uuid> -p "…"` создаёт сессию, а `claude --resume <тот же uuid> -p "…"` её возобновляет (модель помнит контекст первого запуска). `tile.session` в приложении — уже валидный UUID (`crypto.randomUUID()`), используем его как session-id.

---

## Фича 1 — `claude --resume` при рестарте (детерминированный session-id)

**Поведение**
- Сейчас кнопка ⟳ (`src/sessions.ts`) и restore запускают **новый** `claude`, теряя контекст.
- Первый запуск плитки: `claude --settings <json> --session-id <tile.session> [initial_prompt]`.
- Рестарт (⟳) и restore: `claude --settings <json> --resume <tile.session>` — **без** initial_prompt (контекст уже в claude).

**Архитектура**
- Rust `build_claude_args(settings_json, initial_prompt, session_id, resume: bool)`:
  - `resume == false` → `["--settings", json, "--session-id", session_id, (prompt?)]`
  - `resume == true`  → `["--settings", json, "--resume", session_id]` (prompt игнорируется)
- `start_session` получает новый параметр `resume: bool`, пробрасывает его и `session` в `build_claude_args`.
- IPC `startSession(session, cwd, initialPrompt, cols, rows, resume)`; TS-обёртка в `src/ipc.ts`.
- `TerminalPanel.start(cwd, initialPrompt, resume = false)`; при ⟳ вызывается `start(cwd, prompt, true)`, при первом launch — `false`.

**Открытый риск — спайк ПЕРЕД реализацией (первая задача плана):**
Проверить, что `--settings <json>` (хуки меток состояния) работает вместе с `--resume` в **интерактивном** режиме (не print). Если хуки не подхватываются на resume — восстановленные/перезапущенные плитки перестанут репортить состояние. Fallback при провале спайка: держать хуки не через `--settings`, а через отдельный конфиг/переменные окружения, либо документировать деградацию (resume без меток) и вынести решение пользователю. Спайк фиксирует фактическое поведение до кодирования фич 1 и 3.

**Тесты:** cargo — `build_claude_args` для обоих режимов (первый запуск с `--session-id` и промптом; resume с `--resume` и без промпта).

---

## Фича 2 — Плейсхолдеры `{{name}}` → авто-форма

**Поведение**
- Skill хранит `prompt` **с** плейсхолдерами вида `{{name}}` (изменений схемы Skill не требуется).
- При запуске сценария: находим уникальные плейсхолдеры. Если есть — модалка с полем на каждый (label = имя плейсхолдера, в порядке первого появления). После OK подставляем значения → готовый prompt идёт как initial_prompt в `launch`. Отмена → запуск не происходит.
- Плейсхолдеров нет → запуск как сейчас, без модалки.

**Архитектура (чисто фронтенд, без Rust)**
- Новый модуль `src/placeholders.ts` (чистые функции, легко тестируются):
  - `parsePlaceholders(prompt: string): string[]` — regex `/\{\{\s*([\w-]+)\s*\}\}/g`, уникальные, в порядке появления.
  - `fillPlaceholders(prompt: string, values: Record<string, string>): string` — подстановка всех вхождений.
- Форма ввода: `placeholderForm(names: string[]): Promise<Record<string,string> | null>` в `src/forms.ts`, переиспользуя оверлей/стили `src/modal.ts` (по образцу `skillForm`).
- Точка вызова: там, где `SkillsPanel.onLaunch` → `Deck.launch`. Перед `launch` проверяем `parsePlaceholders(skill.prompt)`; если непусто — `placeholderForm`, затем `launch` с новым skill-объектом, где `prompt` = `fillPlaceholders(...)`. Оригинальный skill в store не мутируется.

**Тесты (vitest):** `parsePlaceholders` (пусто / один / несколько / дубликаты / пробелы внутри скобок); `fillPlaceholders` (множественные вхождения, отсутствующий ключ оставляет плейсхолдер как есть); `placeholderForm` (jsdom) возвращает значения на OK и `null` на отмену.

---

## Фича 3 — Авто-restore при запуске

**Поведение**
- Приложение персистит «что было открыто» (не PTY, а раскладку плиток). При старте автоматически (без спроса) открывает эти плитки и возобновляет разговоры через `--resume`.
- Крайние случаи: папка/workspace исчезли или resume не удался → плитка показывает ошибку + кнопку ⟳ (уже есть); остальные восстанавливаются. Пустой layout → ничего не делаем.

**Архитектура**
- Rust: новый файл `sessions.json` в `app_config_dir`. Тип `SessionEntry { session_id: String, cwd: String, name: String, icon: Option<String> }` (`icon == None` → чистый терминал; для сценария — эмодзи для заголовка). Промпт **не** храним (resume несёт контекст).
- `store.rs`: методы `layout() -> Vec<SessionEntry>` и `save_layout(&[SessionEntry]) -> io::Result<()>` (тот же паттерн read_vec/write_vec, что у workspaces/skills).
- Команды в `commands.rs` + регистрация в `main.rs`: `load_layout() -> Vec<SessionEntry>`, `save_layout(sessions: Vec<SessionEntry>)`.
- Frontend (`src/sessions.ts`): Deck сериализует текущие плитки в `SessionEntry[]` и вызывает `saveLayout` при **изменении набора** плиток (после `launch` и после `remove`). При старте (в `main.ts`) — `loadLayout()`; для каждой записи создаём плитку и `panel.start(cwd, null, /*resume*/ true)` с тем же `session_id`.
- `kill_all` при закрытии окна остаётся; layout переживает закрытие (пишется заранее, при каждом изменении набора).

**Тесты:** cargo — round-trip `save_layout`/`layout` в `store.rs` (включая пустой и NotFound-случай). vitest — сериализация плиток Deck → `SessionEntry[]` (чистая функция-хелпер, отделённая от DOM).

---

## Фича 4 — Broadcast-ввод (режим + панель)

**Поведение**
- Тумблер «broadcast» (команда + хоткей + пункт палитры). Включён → на плитках появляются чекбоксы выбора, снизу — панель ввода с текстовым полем.
- Enter в панели ввода → текст + `\r` пишется во все отмеченные сессии. Выключение режима убирает чекбоксы и панель.
- Обычный ввод в отдельный терминал не затрагивается — broadcast явный и отдельный (не «зеркалит» активную плитку).

**Архитектура (фронтенд, без Rust)**
- Фан-аут циклом по существующему `writeSession(session, text + "\r")` для каждой отмеченной плитки (без нового Rust-команды — минимум поверхности).
- Состояние режима и множество отмеченных сессий — в `Deck`. Методы: `toggleBroadcast()`, внутренняя отправка `broadcastInput(text)`.
- UI: чекбокс в `tile-head` (виден только в режиме); нижняя панель ввода — отдельный контейнер в разметке deck (по образцу `tile-search`), показывается классом.
- Регистрация команды `broadcast` в `src/commands.ts`, пункт в `src/palette.ts`, диспатч в `src/main.ts`. Хоткей — через `matchHotkey(e, isMac)` (app-модификатор на macOS только Cmd; конкретную клавишу выбрать в плане, не шадоуя readline/xterm).

**Тесты (vitest):** чистая функция фан-аута — по списку отмеченных сессий и тексту формирует набор вызовов `writeSession(session, text+"\r")` (мок `writeSession`, проверяем адресатов и содержимое); toggle-логика режима.

---

## Cross-cutting

- **Реестр команд:** новые команды (broadcast toggle) регистрировать в `src/commands.ts` + `src/palette.ts` + диспатч в `src/main.ts` (урок Группы A).
- **Capabilities Tauri:** новые команды `load_layout`/`save_layout`/обновлённая `start_session` — сверить строки в `src-tauri/gen/schemas/` при необходимости.
- **Уроки прошлой сессии:** `vi.hoisted()` для мок-переменных в фабрике `vi.mock`; `// @vitest-environment jsdom` для тестов, тянущих xterm; хоткеи платформо-зависимы (`matchHotkey`).
- **Последовательность реализации:** 1) спайк `--settings`+`--resume` → continue → 2) плейсхолдеры → 3) restore (опирается на 1) → 4) broadcast. Каждая задача — per-task ревью, в конце — whole-branch ревью (opus), как в Release 1.0.

## Критерии готовности
- ⟳ и авто-restore возобновляют разговор claude (виден прежний контекст), а не начинают новый.
- Сценарий с `{{name}}` спрашивает значения перед запуском и подставляет их; без плейсхолдеров — запуск без модалки.
- После перезапуска приложения вчерашние плитки открываются автоматически и возобновляются.
- В режиме broadcast один ввод уходит во все отмеченные сессии; вне режима поведение ввода не меняется.
- `npm test` и `cargo test` зелёные; `tsc` чист; новых зависимостей нет.
