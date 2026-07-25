# cowork-deck — «Запланированные сценарии» (#9) — Design Spec

**Дата:** 2026-07-24
**Ветка:** feat/scheduled-scenarios (от `main`)
**Issue:** [#9](https://github.com/followLemmi/cowork-deck/issues/9) — запуск сценария по расписанию, локально, без cloud agents.
**Контекст:** сценарии (`Skill = {id, name, icon, prompt, workspaceId}`, `src/skills.ts`) запускаются только вручную. Cowork предлагает запланированные задачи на **облачных** агентах; наше отличие — то же самое на **локальном** Claude Code: без облака, без доплат, полный локальный контекст и права.

## Цель
Привязать к сценарию расписание, чтобы он срабатывал автоматически и запускал свой промпт в новую локальную сессию без участия пользователя. Ручной запуск сценариев продолжает работать без изменений.

## Границы (scope)
**Входит:** (1) модель расписания (простые пресеты), (2) backend-планировщик на tokio-runtime Tauri, (3) путь срабатывания через существующий `launch()`, (4) UI: редактор расписания в форме сценария + индикатор в строке, (5) дефолты плейсхолдеров, (6) catch-up пропущенных прогонов, (7) guard от наложения.

**НЕ входит (YAGNI / позже):** cron-выражения, несколько расписаний на один сценарий, отдельный экран «история прогонов», переиспользование/`--resume` одной сессии между прогонами, срабатывание при закрытом приложении (демон/системный сервис), стоимость в $.

## Глобальные ограничения (наследуются всеми задачами)
- Tauri v2, ядро Rust + ванильный TypeScript + xterm.js. **Только ванильный TS, без фреймворков.**
- Целевой расход памяти < 100 МБ; только лёгкие зависимости.
- Тёмная тема, палитра One Dark, дизайн-токены из `styles.css` (`:root`). Анимации только на `transform`/`opacity` (ADR-008).
- Строки интерфейса — на русском, в существующем стиле.
- Команды тестов неизменны: `npm test` (vitest run), `cargo test --manifest-path src-tauri/Cargo.toml`. Не ломать существующие тесты (64 vitest / 17 cargo). `tsc --noEmit` чист.
- Коммиты — Conventional Commits.

## Ключевые решения (согласованы при брейншторме)
1. **Модель работы:** приложение не демонизировано — расписание срабатывает только пока окно открыто. Пропуски при закрытом приложении **всегда догоняются** — один прогон на сценарий при старте, независимо от давности.
2. **Формат расписания:** простые пресеты — `каждый час в :MM` / `ежедневно в HH:MM` / `еженедельно в день+HH:MM`. Без cron, без новых JS-зависимостей.
3. **Срабатывание:** **новая сессия каждый раз** через существующий путь `Deck.launch()` — как клик по кнопке сценария.
4. **Плейсхолдеры:** дефолты хранятся в конфиге расписания; форма требует их заполнить при включённом расписании.
5. **Планировщик:** подход **A** — backend-таймер (Rust) решает «когда» и персистит состояние; фронт исполняет «что» через `launch()`. Спавн `claude` не дублируется.

## Новая зависимость
- `chrono` (Cargo, фичи по умолчанию — нужен `clock`/`Local`) — гражданская арифметика дат и локального времени/DST для пресетов `ежедневно`/`еженедельно`. Своя реализация местного времени рискованна. **Единственная** новая зависимость фичи. Требует пересборки Rust.

## Модель данных

### Определение расписания (редактирует пользователь; в `skills.json`)
```ts
type SchedulePreset =
  | { kind: "hourly"; minute: number }                        // каждый час в :MM   (0–59)
  | { kind: "daily";  hour: number; minute: number }          // ежедневно HH:MM
  | { kind: "weekly"; weekday: number; hour: number; minute: number }; // weekday 0=вс..6=сб

interface Schedule {
  preset: SchedulePreset;
  defaults: Record<string, string>;   // значение на каждый уникальный {{placeholder}} промпта
  enabled: boolean;
}
interface Skill {
  id: string; name: string; icon: string; prompt: string;
  workspaceId?: string | null;
  schedule?: Schedule | null;          // отсутствует у несценарных/старых записей → без расписания
}
```

### Рантайм-состояние (пишет ТОЛЬКО планировщик; отдельный `schedule_state.json`)
```ts
// skillId → { lastRunMs: number }   — эпоха мс последнего сработавшего occurrence
```
**Почему отдельный файл:** пользователь редактирует `Skill` (перезаписывает весь объект через `save_skill`), а планировщик обновляет `lastRun`. Хранение `lastRun` внутри `Skill` создало бы гонку записи (потеря `lastRun` при правке сценария). Разделение definition/state её устраняет.

### Rust-зеркало (`src-tauri/src/model.rs`)
- `Schedule`, `SchedulePreset` (serde, `rename_all = "camelCase"`, тег `kind`), поле `Skill::schedule: Option<Schedule>` со `#[serde(default, skip_serializing_if = "Option::is_none")]` — старые `skills.json` без поля грузятся как `None`, `None` не сериализуется.
- Тип состояния `ScheduleState` (map skillId → lastRun) — свой файл через `Store`.

## Компоненты

### Планировщик — `src-tauri/src/scheduler.rs` (новый)
Изолированный модуль: чистые функции времени + асинхронный цикл.

**Чистые функции (тестируемые, `now: DateTime<Local>` параметром):**
- `next_occurrence(preset, now) -> DateTime<Local>` — ближайшее срабатывание строго после `now`.
- `prev_occurrence(preset, now) -> DateTime<Local>` — последнее срабатывание в момент `≤ now`.
- `is_due(preset, last_run: Option<i64>, now) -> bool` — `last_run` отсутствует или `< prev_occurrence(now)` (реализует «всегда догнать», максимум один прогон на сценарий за старт/тик).

**Асинхронный цикл (`start_scheduler(app: AppHandle)`), запуск в `setup`:**
1. **Handshake:** ждёт, пока фронт вызовет команду `scheduler_ready()` (см. ниже) — гарантия, что слушатель `schedule://fire` уже навешен и стартовый catch-up не потеряется.
2. Итерация:
   - читает сценарии с `schedule.enabled == true` + `schedule_state`;
   - для каждого: `is_due` → если да, эмитит `schedule://fire { skillId }`, ставит `lastRun = prev_occurrence(now)` (именно occurrence, не `now` — иначе дрейф; при catch-up это пропущенное время, при обычном прогоне ≈ `now`), персистит `schedule_state.json`;
   - вычисляет ближайший `next_occurrence` среди всех; спит `min(до ближайшего, 30 c)` — потолок тика пересчитывает после сна системы/смены времени/DST.
3. `enabled == false` и сценарии без расписания игнорируются.

Планировщик держит `AppState`/`Store` (как `listener`), пишет только `schedule_state.json`.

### Команды (`src-tauri/src/commands.rs`)
- `scheduler_ready()` — фронт зовёт один раз после навешивания слушателей; разблокирует цикл планировщика (через канал/`Notify` в состоянии).
- Существующая `save_skill` уже персистит `Skill.schedule` — отдельная команда для расписания не нужна.

### Фронт — путь срабатывания (`src/main.ts` + `src/sessions.ts`)
- `main.ts`: `listen("schedule://fire", ({payload:{skillId}}) => onScheduledFire(skillId))` навешивается **рано**, затем `invoke("scheduler_ready")`.
- `onScheduledFire(skillId)` (в `main.ts`, где доступны `SkillsPanel` и список workspaces):
  1. найти `Skill` по id; если нет `schedule?.enabled` — игнор;
  2. найти `Workspace` по `skill.workspaceId`; нет → пропуск + лог/уведомление;
  3. `filled = fillPlaceholders(skill.prompt, skill.schedule.defaults)`;
  4. `deck.launch(workspace, { ...skill, prompt: filled })`.
- `Deck` (`src/sessions.ts`): новый метод-обёртка `launchScheduled(workspace, skill, filledPrompt)` c **guard-ом наложения** через `Map<skillId, session>`:
  - если для `skillId` уже есть сессия в состоянии `working`/`waitingInput` → пропуск (лог + опц. уведомление «прогон пропущен: предыдущий ещё активен»);
  - иначе — обычный `spawnTile` с `titleText = "⏰ icon name"`, регистрация `skillId → session`;
  - при завершении/удалении тайла запись из карты снимается.

### UI — форма сценария (`src/forms.ts`) и строка (`src/skills.ts`)
- **`skillForm`:** блок «Расписание»: чекбокс «по расписанию» раскрывает селектор пресета + поля времени (HH:MM; для `weekly` — день недели). Если `parsePlaceholders(prompt)` непусто — под-форма «значения по умолчанию» (поле на плейсхолдер).
  - **Валидация:** `enabled ⇒` каждый плейсхолдер имеет непустой дефолт и время валидно; иначе сохранение блокируется с подсказкой.
  - Результат маппится в `Schedule` и кладётся в `Skill.schedule`.
- **Строка сценария:** при `schedule.enabled` — значок ⏰ + `title` с человекочитаемым правилом и следующим запуском (напр. «⏰ ежедневно 09:00 · след.: сегодня 09:00»); «последний прогон» — в том же тултипе (`lastRun`). Без расписания строка не меняется.
- Отдельного экрана истории нет: запланированные тайлы видны в деке и пилюле как обычные сессии.

## Поток данных (срабатывание)
```
tokio scheduler loop (Rust)
  └─ is_due? ── emit "schedule://fire {skillId}" ──▶ main.ts listener
                                                       └─ resolve Skill+Workspace, fill defaults
                                                            └─ Deck.launchScheduled (overlap guard)
                                                                 └─ spawnTile → start_session (PTY, claude)
                                                                      └─ обычные события state/output/exit,
                                                                         пилюля, токены, git — без доработок
  └─ persist schedule_state.json (lastRun)
```

## Обработка ошибок и крайние случаи
| Случай | Поведение |
|---|---|
| `claude` не найден при срабатывании | тайл → `ошибка` (существующий путь) + уведомление |
| Предыдущий прогон сценария активен (`working`/`waitingInput`) | новый прогон пропускается (guard `Map<skillId, session>`) |
| Пропуски пока приложение закрыто | catch-up 1 раз на сценарий при старте (`is_due`) |
| Плейсхолдер без дефолта | не допускается формой; в рантайме — пропуск + лог |
| Workspace сценария удалён | пропуск + лог/уведомление |
| Сон системы / смена времени / DST | потолок тика 30 c пересчитывает; `chrono::Local` |
| `enabled == false` / нет расписания | планировщик игнорирует |
| Гонка правки сценария и записи `lastRun` | исключена: `lastRun` в отдельном `schedule_state.json` |

## Тестирование
**Rust (`cargo test`)** — чистые функции с `now` параметром (без реального времени):
- `next_occurrence`/`prev_occurrence` по каждому пресету: переносы через час/сутки/неделю, арифметика дня недели, границы полуночи/воскресенья;
- `is_due` (нет `lastRun` / `lastRun < prev` / `lastRun == prev`);
- сериализация `Schedule` (теги `kind`) и round-trip старого `skills.json` без поля (обратная совместимость).

**TS (`vitest`)** — чистые функции:
- `fillPlaceholders` с дефолтами;
- решение guard-а наложения (по состояниям сессий);
- валидация формы (дефолты обязательны при `enabled`);
- человекочитаемое описание расписания и «следующий запуск».

Существующие тесты зелёные; `tsc --noEmit` чист.

## Файлы (ориентир)
- **Новое:** `src-tauri/src/scheduler.rs`; TS-модуль расписания (напр. `src/schedule.ts` — чистые функции описания/валидации).
- **Правки Rust:** `model.rs` (типы), `store.rs` (`schedule_state.json` read/save), `commands.rs` (`scheduler_ready`), `main.rs` (регистрация модуля + запуск в `setup` + `scheduler_ready` в `invoke_handler`).
- **Правки TS:** `ipc.ts` (типы + `schedulerReady`), `forms.ts` (блок расписания + валидация), `skills.ts` (индикатор строки), `sessions.ts` (`launchScheduled` + guard), `main.ts` (слушатель + `onScheduledFire`).
