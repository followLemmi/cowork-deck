# Scheduled Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a scenario fire automatically on a time-based schedule and launch its prompt into a new local Claude Code session, unattended.

**Architecture:** Approach A — a Rust async task on Tauri's tokio runtime decides *when* (pure occurrence math + persisted `schedule_state.json`) and emits `schedule://fire {skillId}`; the frontend executes *what* by reusing the existing `Deck.launch()` path. Schedule *definition* lives on `Skill.schedule`; runtime `lastRun` lives in a separate state file to avoid a write race with user edits.

**Tech Stack:** Tauri v2, Rust (tokio, serde, **new: chrono**), vanilla TypeScript + xterm.js, vitest, cargo test.

## Global Constraints
- Tauri v2, Rust core + vanilla TypeScript + xterm.js. **Vanilla TS only, no frameworks.**
- Memory target < 100 MB; lightweight deps only. Feature adds exactly one new crate: `chrono`.
- Dark theme, One Dark palette, tokens from `styles.css` `:root`. Animations only on `transform`/`opacity` (ADR-008).
- UI strings in Russian, existing style.
- Test commands unchanged: `npm test` (vitest run), `cargo test --manifest-path src-tauri/Cargo.toml`. Do not break existing tests (64 vitest / 17 cargo). `tsc --noEmit` clean.
- Conventional Commits.

## Key decisions (from spec)
- Missed runs while app closed → **always catch up once per scenario** on startup.
- Schedule format → **presets**: `hourly (minute)`, `daily (hour, minute)`, `weekly (weekday, hour, minute)`. Weekday 0=Sun..6=Sat.
- On fire → **new session each time** via existing launch path.
- Placeholders → **stored defaults** in the schedule; form requires them when enabled.
- Overlap → **skip** the new run if the scenario's previous scheduled session is still `working`/`waitingInput`.

## File Structure
- **Create** `src-tauri/src/scheduler.rs` — pure occurrence math (`next_occurrence`/`prev_occurrence`/`is_due`) + the async `run` loop + ready handshake.
- **Create** `src/schedule.ts` — pure TS helpers: `describeSchedule`, `nextRun`, `nextRunLabel`, `validateSchedule`, `shouldSkipOverlap`.
- **Modify** `src-tauri/src/model.rs` — `SchedulePreset`, `Schedule`, `Skill.schedule`.
- **Modify** `src-tauri/src/store.rs` — `schedule_state.json` read/save.
- **Modify** `src-tauri/src/commands.rs` — `AppState.scheduler_ready`, `scheduler_ready` command.
- **Modify** `src-tauri/src/main.rs` — `mod scheduler`, spawn loop in `setup`, register command.
- **Modify** `src-tauri/Cargo.toml` — add `chrono`.
- **Modify** `src/ipc.ts` — types + `schedulerReady` + `onScheduledFire`.
- **Modify** `src/sessions.ts` — `launchScheduled` + overlap guard + Tile bookkeeping.
- **Modify** `src/main.ts` — wire fire listener + `handleScheduledFire` + `schedulerReady()`.
- **Modify** `src/forms.ts` — schedule section in `skillForm` + validation.
- **Modify** `src/skills.ts` — `find(id)` + ⏰ row indicator + tooltip.

---

### Task 1: Rust data model — Schedule types + Skill.schedule + serde back-compat

**Files:**
- Modify: `src-tauri/src/model.rs` (add types after `Skill`, add field to `Skill`)
- Test: `src-tauri/src/model.rs` (in `mod tests`)

**Interfaces:**
- Produces: `model::SchedulePreset` (serde tag `kind`, camelCase variants `hourly`/`daily`/`weekly`), `model::Schedule { preset, defaults: HashMap<String,String>, enabled: bool }`, `Skill.schedule: Option<Schedule>`.

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/src/model.rs` inside `#[cfg(test)] mod tests` (add `use super::*;` is already present):

```rust
#[test]
fn old_skill_without_schedule_deserializes_to_none() {
    let old = r#"{"id":"s1","name":"Report","icon":"▶","prompt":"hi","workspaceId":null}"#;
    let sk: Skill = serde_json::from_str(old).unwrap();
    assert!(sk.schedule.is_none());
    // None schedule must be omitted on re-serialize (no "schedule" key).
    let json = serde_json::to_string(&sk).unwrap();
    assert!(!json.contains("schedule"), "None schedule must be omitted, got {json}");
}

#[test]
fn schedule_preset_round_trips_with_kind_tag() {
    let daily = Schedule {
        preset: SchedulePreset::Daily { hour: 9, minute: 30 },
        defaults: std::collections::HashMap::new(),
        enabled: true,
    };
    let json = serde_json::to_string(&daily).unwrap();
    assert!(json.contains(r#""kind":"daily""#), "got {json}");
    let back: Schedule = serde_json::from_str(&json).unwrap();
    assert_eq!(back, daily);

    let weekly: Schedule = serde_json::from_str(
        r#"{"preset":{"kind":"weekly","weekday":1,"hour":8,"minute":0},"defaults":{"name":"Bob"},"enabled":true}"#,
    ).unwrap();
    assert_eq!(weekly.preset, SchedulePreset::Weekly { weekday: 1, hour: 8, minute: 0 });
    assert_eq!(weekly.defaults.get("name").map(String::as_str), Some("Bob"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml model::tests::schedule`
Expected: FAIL — `SchedulePreset` / `Schedule` / `Skill.schedule` do not exist (compile error).

- [ ] **Step 3: Add the types and field**

In `src-tauri/src/model.rs`, add after the `Skill` struct (currently ends at line 29):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SchedulePreset {
    Hourly { minute: u32 },
    Daily { hour: u32, minute: u32 },
    Weekly { weekday: u32, hour: u32, minute: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schedule {
    pub preset: SchedulePreset,
    #[serde(default)]
    pub defaults: std::collections::HashMap<String, String>,
    pub enabled: bool,
}
```

Then add this field to the `Skill` struct (after `workspace_id`):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Schedule>,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml model::`
Expected: PASS (new tests + existing model tests green).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/model.rs
git commit -m "feat(#9): schedule types on Skill model with serde back-compat"
```

---

### Task 2: Rust store — schedule_state.json read/save

**Files:**
- Modify: `src-tauri/src/store.rs`
- Test: `src-tauri/src/store.rs` (in `mod tests`)

**Interfaces:**
- Produces: `Store::schedule_state() -> HashMap<String, i64>`, `Store::save_schedule_state(&HashMap<String,i64>) -> std::io::Result<()>`. Map is `skillId → lastRunMs`.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/store.rs` inside `mod tests`:

```rust
#[test]
fn schedule_state_round_trips_and_defaults_empty() {
    use std::collections::HashMap;
    let s = Store::new(tmp());
    assert!(s.schedule_state().is_empty()); // NotFound -> empty
    let mut st: HashMap<String, i64> = HashMap::new();
    st.insert("skill-1".into(), 1_700_000_000_000);
    s.save_schedule_state(&st).unwrap();
    assert_eq!(Store::new(s.dir.clone()).schedule_state(), st);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml store::tests::schedule_state`
Expected: FAIL — `schedule_state` / `save_schedule_state` not found.

- [ ] **Step 3: Implement the methods**

In `src-tauri/src/store.rs`, add after `save_ui_state` (before the `upsert_*` block). Add `use std::collections::HashMap;` at the top if not present:

```rust
    fn schedule_state_path(&self) -> PathBuf { self.dir.join("schedule_state.json") }

    /// Runtime schedule state (skillId -> last-fired epoch millis), written
    /// ONLY by the scheduler. Kept separate from `Skill.schedule` so a user
    /// editing a scenario (which rewrites the whole Skill) can't clobber
    /// `lastRun`. Missing file -> empty map (first run).
    pub fn schedule_state(&self) -> HashMap<String, i64> {
        match std::fs::read_to_string(self.schedule_state_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    }
    pub fn save_schedule_state(&self, st: &HashMap<String, i64>) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(st)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(self.schedule_state_path(), json)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml store::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs
git commit -m "feat(#9): persist schedule_state.json (skillId -> lastRun)"
```

---

### Task 3: Rust scheduler — pure occurrence math (add chrono)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `chrono`)
- Create: `src-tauri/src/scheduler.rs`
- Modify: `src-tauri/src/main.rs:8` (add `mod scheduler;` near other `mod` lines)
- Test: `src-tauri/src/scheduler.rs`

**Interfaces:**
- Consumes: `model::SchedulePreset` (Task 1).
- Produces: `scheduler::next_occurrence(&SchedulePreset, NaiveDateTime) -> NaiveDateTime`, `scheduler::prev_occurrence(&SchedulePreset, NaiveDateTime) -> NaiveDateTime`, `scheduler::is_due(&SchedulePreset, Option<i64>, NaiveDateTime) -> bool`. All times are local wall-clock `NaiveDateTime`; `lastRun` millis are encoded as `naive.and_utc().timestamp_millis()` (a fixed opaque convention used consistently).

- [ ] **Step 1: Add chrono dependency**

In `src-tauri/Cargo.toml` under `[dependencies]` add:

```toml
chrono = "0.4"
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/main.rs`, add to the `mod` list (after `mod commands;` on line 8):

```rust
mod scheduler;
```

- [ ] **Step 3: Write the failing tests**

Create `src-tauri/src/scheduler.rs` with ONLY the test module first (implementation stubs added next step):

```rust
use crate::model::SchedulePreset;
use chrono::{Datelike, Duration, NaiveDateTime, Timelike};

// implementation goes here in Step 5

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap()
    }

    #[test]
    fn daily_next_and_prev_roll_over_midnight() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        // before today's 09:00
        let now = dt(2026, 7, 24, 8, 0);
        assert_eq!(next_occurrence(&p, now), dt(2026, 7, 24, 9, 0));
        assert_eq!(prev_occurrence(&p, now), dt(2026, 7, 23, 9, 0));
        // after today's 09:00
        let now = dt(2026, 7, 24, 10, 0);
        assert_eq!(next_occurrence(&p, now), dt(2026, 7, 25, 9, 0));
        assert_eq!(prev_occurrence(&p, now), dt(2026, 7, 24, 9, 0));
        // exactly at 09:00 -> prev is now, next is tomorrow
        let now = dt(2026, 7, 24, 9, 0);
        assert_eq!(prev_occurrence(&p, now), dt(2026, 7, 24, 9, 0));
        assert_eq!(next_occurrence(&p, now), dt(2026, 7, 25, 9, 0));
    }

    #[test]
    fn hourly_next_and_prev() {
        let p = SchedulePreset::Hourly { minute: 30 };
        let now = dt(2026, 7, 24, 10, 15);
        assert_eq!(next_occurrence(&p, now), dt(2026, 7, 24, 10, 30));
        assert_eq!(prev_occurrence(&p, now), dt(2026, 7, 24, 9, 30));
        let now = dt(2026, 7, 24, 10, 45);
        assert_eq!(next_occurrence(&p, now), dt(2026, 7, 24, 11, 30));
        assert_eq!(prev_occurrence(&p, now), dt(2026, 7, 24, 10, 30));
    }

    #[test]
    fn weekly_next_and_prev_across_week() {
        // 2026-07-24 is a Friday (weekday: Sun=0..Sat=6 -> Fri=5).
        let p = SchedulePreset::Weekly { weekday: 1, hour: 8, minute: 0 }; // Monday 08:00
        let now = dt(2026, 7, 24, 12, 0); // Friday
        assert_eq!(next_occurrence(&p, now), dt(2026, 7, 27, 8, 0)); // next Monday
        assert_eq!(prev_occurrence(&p, now), dt(2026, 7, 20, 8, 0)); // last Monday
    }

    #[test]
    fn is_due_when_never_run_or_missed() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        // never run
        assert!(is_due(&p, None, now));
        // last run was before the most recent occurrence (today 09:00) -> missed
        let prev = prev_occurrence(&p, now); // today 09:00
        let missed = (prev - Duration::hours(2)).and_utc().timestamp_millis();
        assert!(is_due(&p, Some(missed), now));
        // last run == most recent occurrence -> not due
        let ontime = prev.and_utc().timestamp_millis();
        assert!(!is_due(&p, Some(ontime), now));
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scheduler::tests`
Expected: FAIL — `next_occurrence`/`prev_occurrence`/`is_due` not defined.

- [ ] **Step 5: Write the implementation**

Replace the `// implementation goes here` comment in `src-tauri/src/scheduler.rs` with:

```rust
fn at(base: NaiveDateTime, h: u32, m: u32) -> NaiveDateTime {
    base.date().and_hms_opt(h, m, 0).unwrap_or_else(|| base.date().and_hms_opt(0, 0, 0).unwrap())
}

pub fn next_occurrence(preset: &SchedulePreset, now: NaiveDateTime) -> NaiveDateTime {
    match preset {
        SchedulePreset::Hourly { minute } => {
            let base = now.date().and_hms_opt(now.hour(), *minute, 0).unwrap();
            if base > now { base } else { base + Duration::hours(1) }
        }
        SchedulePreset::Daily { hour, minute } => {
            let base = at(now, *hour, *minute);
            if base > now { base } else { base + Duration::days(1) }
        }
        SchedulePreset::Weekly { weekday, hour, minute } => {
            let cur = now.weekday().num_days_from_sunday() as i64; // 0=Sun..6=Sat
            let delta = *weekday as i64 - cur;
            let mut b = at(now + Duration::days(delta), *hour, *minute);
            if b <= now { b += Duration::days(7); }
            b
        }
    }
}

pub fn prev_occurrence(preset: &SchedulePreset, now: NaiveDateTime) -> NaiveDateTime {
    match preset {
        SchedulePreset::Hourly { minute } => {
            let base = now.date().and_hms_opt(now.hour(), *minute, 0).unwrap();
            if base <= now { base } else { base - Duration::hours(1) }
        }
        SchedulePreset::Daily { hour, minute } => {
            let base = at(now, *hour, *minute);
            if base <= now { base } else { base - Duration::days(1) }
        }
        SchedulePreset::Weekly { weekday, hour, minute } => {
            let cur = now.weekday().num_days_from_sunday() as i64;
            let delta = *weekday as i64 - cur;
            let mut b = at(now + Duration::days(delta), *hour, *minute);
            if b > now { b -= Duration::days(7); }
            b
        }
    }
}

/// Due when never run, or the last fire predates the most recent occurrence
/// (a missed/owed run). Fires at most once per scenario per evaluation —
/// this is the "always catch up once" behavior.
pub fn is_due(preset: &SchedulePreset, last_run_ms: Option<i64>, now: NaiveDateTime) -> bool {
    let prev = prev_occurrence(preset, now);
    match last_run_ms {
        None => true,
        Some(ms) => match chrono::DateTime::from_timestamp_millis(ms) {
            Some(dt) => dt.naive_utc() < prev,
            None => true,
        },
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scheduler::`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/scheduler.rs src-tauri/src/main.rs
git commit -m "feat(#9): scheduler occurrence math (chrono) with tests"
```

---

### Task 4: Rust scheduler loop + ready handshake + wiring

**Files:**
- Modify: `src-tauri/src/scheduler.rs` (add `run` + `FirePayload`)
- Modify: `src-tauri/src/commands.rs` (`AppState.scheduler_ready`, `scheduler_ready` command)
- Modify: `src-tauri/src/main.rs` (create Notify, keep `dir` clone, spawn loop, register command)

**Interfaces:**
- Consumes: `next_occurrence`/`is_due`/`prev_occurrence` (Task 3), `Store::schedule_state`/`save_schedule_state` (Task 2), `model::Skill.schedule` (Task 1).
- Produces: event `schedule://fire` with payload `{ "skillId": string }`; command `scheduler_ready`; the frontend must call `scheduler_ready` once after attaching its listener.

- [ ] **Step 1: Add the async loop to `scheduler.rs`**

At the top of `src-tauri/src/scheduler.rs`, extend imports and add the loop. Add these `use` lines below the existing ones:

```rust
use crate::store::Store;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
```

Then add (above the `#[cfg(test)]` module):

```rust
#[derive(Clone, serde::Serialize)]
struct FirePayload {
    #[serde(rename = "skillId")]
    skill_id: String,
}

/// Backend scheduler loop. Waits for the frontend to signal readiness (so the
/// `schedule://fire` listener is attached and startup catch-up isn't lost),
/// then re-evaluates all enabled schedules each tick. Reads skills fresh every
/// tick from disk so user edits are picked up. Writes only `schedule_state.json`.
pub async fn run(app: AppHandle, dir: PathBuf, ready: Arc<Notify>) {
    ready.notified().await;
    loop {
        let now = chrono::Local::now().naive_local();
        let store = Store::new(dir.clone());
        let skills = store.skills();
        let mut state = store.schedule_state();
        let mut soonest: Option<NaiveDateTime> = None;
        let mut changed = false;

        for sk in &skills {
            let Some(sched) = &sk.schedule else { continue };
            if !sched.enabled { continue }
            let last = state.get(&sk.id).copied();
            if is_due(&sched.preset, last, now) {
                let _ = app.emit("schedule://fire", FirePayload { skill_id: sk.id.clone() });
                let occ = prev_occurrence(&sched.preset, now);
                state.insert(sk.id.clone(), occ.and_utc().timestamp_millis());
                changed = true;
            }
            let nxt = next_occurrence(&sched.preset, now);
            soonest = Some(soonest.map_or(nxt, |s| s.min(nxt)));
        }
        if changed {
            let _ = store.save_schedule_state(&state);
        }

        // Sleep until the soonest upcoming occurrence, capped at 30s so we
        // re-evaluate after system sleep / clock or DST changes.
        let cap = std::time::Duration::from_secs(30);
        let dur = match soonest {
            Some(s) => {
                let ms = (s - now).num_milliseconds().max(0) as u64;
                std::time::Duration::from_millis(ms).min(cap)
            }
            None => cap,
        };
        tokio::time::sleep(dur).await;
    }
}
```

- [ ] **Step 2: Add ready-Notify to AppState + the command**

In `src-tauri/src/commands.rs`, add the field to `AppState` (after `reporter_path`):

```rust
    pub scheduler_ready: std::sync::Arc<tokio::sync::Notify>,
```

Add the command (near the other `#[tauri::command]` fns):

```rust
#[tauri::command]
pub fn scheduler_ready(state: State<AppState>) {
    state.scheduler_ready.notify_one();
}
```

- [ ] **Step 3: Wire in `main.rs` setup**

In `src-tauri/src/main.rs`, change the store construction so `dir` survives (currently line ~55–56 `let store = store::Store::new(dir);`). Replace with:

```rust
            let dir = app.path().app_config_dir().expect("app config dir");
            let store = store::Store::new(dir.clone());
```

(If the original captured `dir` on the previous line, keep that line and only add `.clone()` on use — the point is `dir` must remain usable below.)

Then change the `app.manage(AppState { ... })` block to create and include the Notify, and spawn the loop right after. Replace the existing `app.manage(AppState { ... });` with:

```rust
            let scheduler_ready = std::sync::Arc::new(tokio::sync::Notify::new());
            app.manage(AppState {
                store: Mutex::new(store),
                pty: pty::PtyManager::new(),
                listener_port: port,
                reporter_path: reporter_path(),
                scheduler_ready: scheduler_ready.clone(),
            });

            let sched_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                scheduler::run(sched_handle, dir, scheduler_ready).await;
            });
```

Add `scheduler_ready` to the `invoke_handler` list (after `commands::session_tokens,`):

```rust
            commands::scheduler_ready,
```

- [ ] **Step 4: Verify it compiles and existing tests pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — all existing (17) + new scheduler/store/model tests green, no warnings-as-errors. The `run` loop is not unit-tested (its decisions are covered by Task 3's pure-function tests); it's exercised in the manual smoke test at the end.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scheduler.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(#9): scheduler loop + scheduler_ready handshake, emit schedule://fire"
```

---

### Task 5: TS pure helpers — `src/schedule.ts`

**Files:**
- Modify: `src/ipc.ts` (types + `schedulerReady` + `onScheduledFire`)
- Create: `src/schedule.ts`
- Test: `tests/schedule.test.ts`

**Interfaces:**
- Produces (ipc.ts): `SchedulePreset`, `Schedule`, `Skill.schedule`, `schedulerReady()`, `onScheduledFire(cb)`.
- Produces (schedule.ts): `describeSchedule(Schedule) -> string`, `nextRun(SchedulePreset, Date) -> Date`, `nextRunLabel(SchedulePreset, Date) -> string`, `validateSchedule(enabled, SchedulePreset, prompt, defaults) -> {ok:true}|{ok:false,error}`, `shouldSkipOverlap(SessionState|null) -> boolean`.

- [ ] **Step 1: Add types + IPC wrappers to `src/ipc.ts`**

Replace the `Skill` interface (line 6) and add types + wrappers:

```ts
export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };
export interface Schedule { preset: SchedulePreset; defaults: Record<string, string>; enabled: boolean; }
export interface Skill { id: string; name: string; icon: string; prompt: string; workspaceId?: string | null; schedule?: Schedule | null; }
```

Add near the other `invoke`/`listen` exports:

```ts
export const schedulerReady = () => invoke<void>("scheduler_ready");
export const onScheduledFire = (cb: (skillId: string) => void): Promise<UnlistenFn> =>
  listen<{ skillId: string }>("schedule://fire", (e) => cb(e.payload.skillId));
```

- [ ] **Step 2: Write the failing tests**

Create `tests/schedule.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeSchedule, nextRun, nextRunLabel, validateSchedule, shouldSkipOverlap } from "../src/schedule";

describe("describeSchedule", () => {
  it("formats each preset in Russian", () => {
    expect(describeSchedule({ preset: { kind: "hourly", minute: 5 }, defaults: {}, enabled: true }))
      .toBe("каждый час в :05");
    expect(describeSchedule({ preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true }))
      .toBe("ежедневно 09:00");
    expect(describeSchedule({ preset: { kind: "weekly", weekday: 1, hour: 8, minute: 30 }, defaults: {}, enabled: true }))
      .toBe("еженедельно пн 08:30");
  });
});

describe("nextRun", () => {
  it("daily rolls over to tomorrow when time has passed", () => {
    const now = new Date(2026, 6, 24, 10, 0, 0); // Fri 10:00
    const n = nextRun({ kind: "daily", hour: 9, minute: 0 }, now);
    expect(n.getDate()).toBe(25);
    expect(n.getHours()).toBe(9);
  });
  it("daily is today when time is still ahead", () => {
    const now = new Date(2026, 6, 24, 8, 0, 0);
    const n = nextRun({ kind: "daily", hour: 9, minute: 0 }, now);
    expect(n.getDate()).toBe(24);
  });
});

describe("nextRunLabel", () => {
  it("labels today/tomorrow", () => {
    const now = new Date(2026, 6, 24, 8, 0, 0);
    expect(nextRunLabel({ kind: "daily", hour: 9, minute: 0 }, now)).toBe("сегодня 09:00");
    expect(nextRunLabel({ kind: "daily", hour: 7, minute: 0 }, now)).toBe("завтра 07:00");
  });
});

describe("validateSchedule", () => {
  it("passes when disabled regardless of defaults", () => {
    expect(validateSchedule(false, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", {}).ok).toBe(true);
  });
  it("fails when an enabled schedule has a placeholder without a default", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", {});
    expect(r.ok).toBe(false);
  });
  it("passes when all placeholders have non-empty defaults", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", { name: "Bob" });
    expect(r.ok).toBe(true);
  });
  it("fails on out-of-range time", () => {
    expect(validateSchedule(true, { kind: "daily", hour: 25, minute: 0 }, "hi", {}).ok).toBe(false);
  });
});

describe("shouldSkipOverlap", () => {
  it("skips only when previous is still active", () => {
    expect(shouldSkipOverlap("working")).toBe(true);
    expect(shouldSkipOverlap("waitingInput")).toBe(true);
    expect(shouldSkipOverlap("ended")).toBe(false);
    expect(shouldSkipOverlap("error")).toBe(false);
    expect(shouldSkipOverlap("idle")).toBe(false);
    expect(shouldSkipOverlap(null)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/schedule.test.ts`
Expected: FAIL — `../src/schedule` module not found.

- [ ] **Step 4: Implement `src/schedule.ts`**

```ts
import type { Schedule, SchedulePreset, SessionState } from "./ipc";
import { parsePlaceholders } from "./placeholders";

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const pad = (n: number): string => String(n).padStart(2, "0");

export function describeSchedule(s: Schedule): string {
  const p = s.preset;
  if (p.kind === "hourly") return `каждый час в :${pad(p.minute)}`;
  if (p.kind === "daily") return `ежедневно ${pad(p.hour)}:${pad(p.minute)}`;
  return `еженедельно ${WEEKDAYS[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Next fire strictly after `now`, in local time. Display-only; the backend
 *  is authoritative for actual firing. */
export function nextRun(p: SchedulePreset, now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (p.kind === "hourly") {
    d.setMinutes(p.minute);
    if (d <= now) d.setHours(d.getHours() + 1);
    return d;
  }
  if (p.kind === "daily") {
    d.setHours(p.hour, p.minute, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  d.setHours(p.hour, p.minute, 0, 0);
  d.setDate(d.getDate() + (p.weekday - now.getDay()));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

export function nextRunLabel(p: SchedulePreset, now: Date): string {
  const d = nextRun(p, now);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `сегодня ${t}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `завтра ${t}`;
  return `${WEEKDAYS[d.getDay()]} ${t}`;
}

export function validateSchedule(
  enabled: boolean,
  preset: SchedulePreset,
  prompt: string,
  defaults: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  if (!enabled) return { ok: true };
  const minute = "minute" in preset ? preset.minute : 0;
  const hour = "hour" in preset ? preset.hour : 0;
  if (minute < 0 || minute > 59) return { ok: false, error: "Минуты: 0–59" };
  if (hour < 0 || hour > 23) return { ok: false, error: "Часы: 0–23" };
  if (preset.kind === "weekly" && (preset.weekday < 0 || preset.weekday > 6)) {
    return { ok: false, error: "День недели: 0–6" };
  }
  for (const name of parsePlaceholders(prompt)) {
    if (!defaults[name] || !defaults[name].trim()) {
      return { ok: false, error: `Заполните значение по умолчанию для {{${name}}}` };
    }
  }
  return { ok: true };
}

/** Overlap guard: skip a scheduled fire only if the scenario's previous
 *  scheduled session is still running or waiting for input. */
export function shouldSkipOverlap(prev: SessionState | null): boolean {
  return prev === "working" || prev === "waitingInput";
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/schedule.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/ipc.ts src/schedule.ts tests/schedule.test.ts
git commit -m "feat(#9): schedule TS types + pure helpers (describe/next/validate/overlap)"
```

---

### Task 6: Frontend fire path — Deck.launchScheduled + main.ts wiring

**Files:**
- Modify: `src/sessions.ts` (Tile field, `scheduledSessions` map, `launchScheduled`, spawnTile opt, remove cleanup)
- Modify: `src/skills.ts` (add `find`)
- Modify: `src/main.ts` (listener + `handleScheduledFire` + `schedulerReady()`)

**Interfaces:**
- Consumes: `shouldSkipOverlap` (Task 5), `onScheduledFire`/`schedulerReady` (Task 5), `fillPlaceholders` (existing `placeholders.ts`), `Deck.launch` pattern (existing).
- Produces: `Deck.launchScheduled(workspace, skill, filledPrompt) -> Promise<boolean>` (false = skipped), `SkillsPanel.find(id) -> Skill | undefined`.

- [ ] **Step 1: Add `find` to SkillsPanel**

In `src/skills.ts`, add a public method to the class (after `load()`):

```ts
  find(id: string): Skill | undefined { return this.items.find((s) => s.id === id); }
```

- [ ] **Step 2: Extend sessions.ts — Tile field, map, spawnTile opt, cleanup**

In `src/sessions.ts`:

Add the import at the top (with the other `./` imports):

```ts
import { shouldSkipOverlap } from "./schedule";
```

Add to the `Tile` interface a field:

```ts
  scheduledSkillId?: string;
```

Add a field to the `Deck` class (near `private tiles = new Map...`):

```ts
  private scheduledSessions = new Map<string, string>(); // skillId -> session
```

Extend the `spawnTile` opts type to include `scheduledSkillId`:

```ts
  private async spawnTile(opts: {
    session: string; cwd: string; workspaceId?: string; titleText: string; prompt: string | null; resume: boolean;
    scheduledSkillId?: string;
  }) {
```

Where the `tile` object literal is constructed inside `spawnTile`, add the field (alongside `workspacePath: cwd, workspaceId, prompt, ...`):

```ts
      scheduledSkillId: opts.scheduledSkillId,
```

In `remove(session)`, after `this.tiles.delete(session);` add:

```ts
    if (tile.scheduledSkillId && this.scheduledSessions.get(tile.scheduledSkillId) === session) {
      this.scheduledSessions.delete(tile.scheduledSkillId);
    }
```

- [ ] **Step 3: Add `launchScheduled` to Deck**

In `src/sessions.ts`, add this method next to `launch`:

```ts
  /** Fire a scheduled scenario as a fresh tile. Returns false (and does not
   *  launch) if this scenario's previous scheduled session is still active. */
  async launchScheduled(workspace: Workspace, skill: Skill, filledPrompt: string): Promise<boolean> {
    const prevSession = this.scheduledSessions.get(skill.id);
    const prevState = prevSession ? (this.tiles.get(prevSession)?.state ?? null) : null;
    if (shouldSkipOverlap(prevState)) {
      console.info("scheduled run skipped: previous still active", skill.id);
      return false;
    }
    const session = crypto.randomUUID();
    this.scheduledSessions.set(skill.id, session);
    await this.spawnTile({
      session,
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText: `⏰ ${skill.icon} ${skill.name}`,
      prompt: filledPrompt,
      resume: false,
      scheduledSkillId: skill.id,
    });
    return true;
  }
```

- [ ] **Step 4: Wire the fire listener in main.ts**

In `src/main.ts`:

Extend imports:

```ts
import { claudeAvailable, loadLayout, onScheduledFire, schedulerReady } from "./ipc";
import { resolvePrompt, fillPlaceholders } from "./placeholders";
```

(The existing `import { resolvePrompt } from "./placeholders";` line is replaced by the one above.)

Add the handler function (top-level, near `paletteCommands`):

```ts
async function handleScheduledFire(skillId: string) {
  const skill = skills.find(skillId);
  if (!skill?.schedule?.enabled) return;
  const ws = workspaces.all.find((w) => w.id === skill.workspaceId);
  if (!ws) { console.warn("scheduled fire: workspace missing for", skillId); return; }
  const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
  await deck.launchScheduled(ws, skill, filled);
}
```

In `boot()`, after `await deck.wireEvents();` add the listener, and at the end of `boot()` signal readiness:

```ts
  await onScheduledFire((skillId) => { void handleScheduledFire(skillId); });
```

and as the last line inside `boot()`:

```ts
  await schedulerReady();
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS, no type errors. (No new unit test here — the overlap decision is covered by Task 5's `shouldSkipOverlap` tests; the wiring is verified in the manual smoke test.)

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts src/skills.ts src/main.ts
git commit -m "feat(#9): fire path — launchScheduled + overlap guard + main wiring"
```

---

### Task 7: UI — schedule editor in skillForm + validation

**Files:**
- Modify: `src/forms.ts` (`skillForm` signature + schedule section + validation)
- Modify: `src/skills.ts` (pass `schedule` through add/edit)

**Interfaces:**
- Consumes: `validateSchedule` (Task 5), `parsePlaceholders` (existing), `Schedule`/`SchedulePreset` (Task 5).
- Produces: `skillForm` now resolves `{ name, icon, prompt, workspaceId, schedule: Schedule | null }`.

- [ ] **Step 1: Extend imports and signature in forms.ts**

In `src/forms.ts`, add imports at top:

```ts
import type { Schedule, SchedulePreset } from "./ipc";
import { parsePlaceholders } from "./placeholders";
import { validateSchedule } from "./schedule";
```

Change the `skillForm` signature and return type to include `schedule`:

```ts
export function skillForm(
  activeWorkspaceId: string | null,
  initial?: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule?: Schedule | null },
): Promise<{ name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null> {
```

- [ ] **Step 2: Build the schedule section (inside skillForm, before `const { row, ok, cancel } = actions();`)**

```ts
    // --- schedule section ---
    const schedEnabled = document.createElement("input");
    schedEnabled.type = "checkbox"; schedEnabled.className = "form-sched-enabled";
    schedEnabled.checked = !!initial?.schedule?.enabled;

    const kind = document.createElement("select");
    kind.className = "form-sched-kind";
    for (const [v, t] of [["hourly", "каждый час"], ["daily", "ежедневно"], ["weekly", "еженедельно"]] as const) {
      const o = document.createElement("option"); o.value = v; o.textContent = t; kind.append(o);
    }
    const weekday = document.createElement("select");
    weekday.className = "form-sched-weekday";
    ["вс", "пн", "вт", "ср", "чт", "пт", "сб"].forEach((w, i) => {
      const o = document.createElement("option"); o.value = String(i); o.textContent = w; weekday.append(o);
    });
    const hour = document.createElement("input");
    hour.type = "number"; hour.min = "0"; hour.max = "23"; hour.className = "form-sched-hour"; hour.value = "9";
    const minute = document.createElement("input");
    minute.type = "number"; minute.min = "0"; minute.max = "59"; minute.className = "form-sched-minute"; minute.value = "0";

    // prefill from initial
    const ip = initial?.schedule?.preset;
    if (ip) {
      kind.value = ip.kind;
      if (ip.kind === "hourly") minute.value = String(ip.minute);
      else if (ip.kind === "daily") { hour.value = String(ip.hour); minute.value = String(ip.minute); }
      else { weekday.value = String(ip.weekday); hour.value = String(ip.hour); minute.value = String(ip.minute); }
    }

    const timeRow = document.createElement("div");
    timeRow.className = "form-sched-time";
    const syncTimeRow = () => {
      weekday.style.display = kind.value === "weekly" ? "" : "none";
      hour.style.display = kind.value === "hourly" ? "none" : "";
    };
    kind.addEventListener("change", syncTimeRow);
    timeRow.append(kind, weekday, hour, minute);

    // per-placeholder default inputs, rebuilt when the prompt changes
    const defWrap = document.createElement("div");
    defWrap.className = "form-sched-defaults";
    const defInputs = new Map<string, HTMLInputElement>();
    const renderDefaults = () => {
      const names = parsePlaceholders(promptField.value);
      defWrap.innerHTML = "";
      const kept = new Map(defInputs);
      defInputs.clear();
      for (const n of names) {
        const inp = document.createElement("input");
        inp.className = "modal-input form-sched-def"; inp.type = "text"; inp.placeholder = `значение {{${n}}}`;
        inp.value = kept.get(n)?.value ?? initial?.schedule?.defaults?.[n] ?? "";
        defInputs.set(n, inp);
        defWrap.append(labeled(n, inp));
      }
    };
    promptField.addEventListener("input", renderDefaults);
    renderDefaults();

    const schedBody = document.createElement("div");
    schedBody.className = "form-sched-body";
    schedBody.append(timeRow, defWrap);
    const syncSchedBody = () => { schedBody.style.display = schedEnabled.checked ? "" : "none"; };
    schedEnabled.addEventListener("change", syncSchedBody);
    syncSchedBody(); syncTimeRow();

    const schedError = document.createElement("div");
    schedError.className = "form-sched-error"; schedError.style.display = "none";

    const readPreset = (): SchedulePreset => {
      const h = Number(hour.value), m = Number(minute.value);
      if (kind.value === "hourly") return { kind: "hourly", minute: m };
      if (kind.value === "daily") return { kind: "daily", hour: h, minute: m };
      return { kind: "weekly", weekday: Number(weekday.value), hour: h, minute: m };
    };
    const readSchedule = (): Schedule | null => {
      if (!schedEnabled.checked) return null;
      const defaults: Record<string, string> = {};
      for (const [n, inp] of defInputs) defaults[n] = inp.value.trim();
      return { preset: readPreset(), defaults, enabled: true };
    };
```

- [ ] **Step 3: Append the section to the box and update OK handler**

Change the `box.append(...)` call for the skill form to include the schedule rows:

```ts
    box.append(
      title, labeled("Имя", name), labeled("Значок", icon),
      labeled("Задание", promptField), labeled("Только для текущего пространства", scope),
      labeled("По расписанию", schedEnabled), schedBody, schedError, row,
    );
```

Replace the `ok.onclick` handler with one that validates the schedule and returns it:

```ts
    ok.onclick = () => {
      const n = name.value.trim(); const pr = promptField.value.trim();
      if (!n || !pr) return;
      const defaults: Record<string, string> = {};
      for (const [k, inp] of defInputs) defaults[k] = inp.value.trim();
      const v = validateSchedule(schedEnabled.checked, readPreset(), pr, defaults);
      if (!v.ok) { schedError.textContent = v.error; schedError.style.display = ""; return; }
      close({
        name: n, icon: icon.value.trim() || "▶", prompt: pr,
        workspaceId: scope.checked ? activeWorkspaceId : null,
        schedule: readSchedule(),
      });
    };
```

Update the `close` type annotation (a few lines above) to include `schedule`:

```ts
    const close = (v: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null) => { ov.remove(); resolve(v); };
```

- [ ] **Step 4: Pass `schedule` through in skills.ts add/edit**

In `src/skills.ts`:

`add()` builds `const sk: Skill = { id: crypto.randomUUID(), ...res };` — `res` now includes `schedule`, so it flows automatically. No change needed there beyond confirming `Skill` type (from ipc, Task 5) carries `schedule`.

In `edit()`, pass the current schedule into the form's `initial`:

```ts
    const res = await skillForm(this.getActiveWorkspaceId(), {
      name: cur.name, icon: cur.icon, prompt: cur.prompt, workspaceId: cur.workspaceId ?? null,
      schedule: cur.schedule ?? null,
    });
```

- [ ] **Step 5: Add minimal styles**

In `src/styles.css`, append:

```css
.form-sched-body { display: flex; flex-direction: column; gap: 8px; margin: 6px 0; }
.form-sched-time { display: flex; gap: 8px; align-items: center; }
.form-sched-time input[type="number"] { width: 4rem; }
.form-sched-defaults { display: flex; flex-direction: column; gap: 6px; }
.form-sched-error { color: var(--state-error, #e06c75); font-size: 12px; }
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. (Validation logic is covered by Task 5's `validateSchedule` tests; the form DOM is verified in the manual smoke test.)

- [ ] **Step 7: Commit**

```bash
git add src/forms.ts src/skills.ts src/styles.css
git commit -m "feat(#9): schedule editor in scenario form with validation"
```

---

### Task 8: UI — scenario row schedule indicator

**Files:**
- Modify: `src/skills.ts` (⏰ indicator + tooltip in `render`)

**Interfaces:**
- Consumes: `describeSchedule`, `nextRunLabel` (Task 5).

- [ ] **Step 1: Import helpers in skills.ts**

Add at the top of `src/skills.ts`:

```ts
import { describeSchedule, nextRunLabel } from "./schedule";
```

- [ ] **Step 2: Add the indicator in `render()`**

In the per-skill loop of `render()`, after the `run` button is created (and before appending the row), add:

```ts
      if (s.schedule?.enabled) {
        const clock = document.createElement("span");
        clock.className = "sk-sched";
        clock.textContent = "⏰";
        clock.title = `${describeSchedule(s.schedule)} · след.: ${nextRunLabel(s.schedule.preset, new Date())}`;
        run.append(clock);
      }
```

- [ ] **Step 3: Add minimal style**

In `src/styles.css`, append:

```css
.sk-sched { margin-left: 6px; opacity: 0.8; font-size: 11px; }
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts src/styles.css
git commit -m "feat(#9): scenario row schedule indicator (⏰ + next-run tooltip)"
```

---

## Manual smoke test (human, desktop GUI)

After all tasks, run `npm run tauri dev` and verify:

1. Create/edit a scenario, tick «По расписанию», choose «ежедневно», set the time to ~2 minutes from now, fill any placeholder defaults, save. The scenario row shows ⏰ with a tooltip («ежедневно HH:MM · след.: сегодня HH:MM»).
2. Wait for the time — a new tile «⏰ icon name» appears and runs the prompt in the scenario's workspace, with normal state/pill/tokens behavior.
3. Set «каждый час в :MM» to the current minute+1, confirm it fires; while that tile is still `работает`/`ждёт ввода`, confirm the next minute does NOT stack a second run (overlap skip — see console).
4. Close the app; re-open after a daily time has passed; confirm exactly one catch-up run fires on startup.
5. Regression: manual scenario launch, restore, broadcast, zoom, workspaces still work.

---

## Self-Review

**Spec coverage:**
- Model (presets, defaults, enabled) → Task 1. ✅
- Separate runtime state (no write race) → Task 2 (`schedule_state.json`). ✅
- Backend scheduler, background-safe, survives restart (persist next-run via `lastRun`), catch-up → Task 3 (`is_due`) + Task 4 (loop). ✅
- Fire reuses launch path, placeholder defaults, workspace scoping → Task 6 (`launchScheduled`, `handleScheduledFire`). ✅
- UI: which scenarios scheduled + next run → Task 8; editor + defaults + validation → Task 7. ✅
- Overlap skip, placeholder-without-default (blocked in form + `validateSchedule`), workspace deleted (skip+warn) → Tasks 5/6/7. ✅

**Deliberate scope trims (noted for the reviewer):**
- `session_crons` (CC's own cron) is empty in the spike (`docs/superpowers/spikes/RESULTS.md`) → not leveraged; we roll our own timer (as the spec concluded).
- "Last result" in the tooltip is **deferred**: it would require exposing `schedule_state.json` to the frontend. The tooltip shows the rule + next run only. If wanted, add a `schedule_state` command later. This is the one spec item intentionally not built in v1.

**Placeholder scan:** No TBD/TODO; every code step shows full code.

**Type consistency:** `launchScheduled`, `handleScheduledFire`, `shouldSkipOverlap`, `describeSchedule`, `nextRun`, `nextRunLabel`, `validateSchedule`, `schedule_state`/`save_schedule_state`, `scheduler_ready`, `schedule://fire {skillId}` — names/signatures match across tasks that consume them.
