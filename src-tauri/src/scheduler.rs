use crate::model::SchedulePreset;
use crate::store::Store;
use chrono::{Datelike, Duration, NaiveDateTime, Timelike};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Wall-clock `h:m` on the day of `base`. Hour/minute are clamped into range:
/// the form validates them, but a hand-edited `skills.json` must degrade
/// rather than panic inside the scheduler loop.
fn at(base: NaiveDateTime, h: u32, m: u32) -> NaiveDateTime {
    base.date()
        .and_hms_opt(h.min(23), m.min(59), 0)
        .unwrap_or_else(|| base.date().and_hms_opt(0, 0, 0).unwrap())
}

/// Nearest firing time strictly after `now` (local wall clock).
pub fn next_occurrence(preset: &SchedulePreset, now: NaiveDateTime) -> NaiveDateTime {
    match preset {
        SchedulePreset::Hourly { minute } => {
            let base = at(now, now.hour(), *minute);
            if base > now { base } else { base + Duration::hours(1) }
        }
        SchedulePreset::Daily { hour, minute } => {
            let base = at(now, *hour, *minute);
            if base > now { base } else { base + Duration::days(1) }
        }
        SchedulePreset::Weekly { weekday, hour, minute } => {
            let cur = now.weekday().num_days_from_sunday() as i64; // 0=Sun..6=Sat
            let delta = (*weekday).min(6) as i64 - cur;
            let mut b = at(now + Duration::days(delta), *hour, *minute);
            if b <= now { b += Duration::days(7); }
            b
        }
    }
}

/// Most recent firing time at or before `now` (local wall clock).
pub fn prev_occurrence(preset: &SchedulePreset, now: NaiveDateTime) -> NaiveDateTime {
    match preset {
        SchedulePreset::Hourly { minute } => {
            let base = at(now, now.hour(), *minute);
            if base <= now { base } else { base - Duration::hours(1) }
        }
        SchedulePreset::Daily { hour, minute } => {
            let base = at(now, *hour, *minute);
            if base <= now { base } else { base - Duration::days(1) }
        }
        SchedulePreset::Weekly { weekday, hour, minute } => {
            let cur = now.weekday().num_days_from_sunday() as i64;
            let delta = (*weekday).min(6) as i64 - cur;
            let mut b = at(now + Duration::days(delta), *hour, *minute);
            if b > now { b -= Duration::days(7); }
            b
        }
    }
}

/// Due when never run, or the last fire predates the most recent occurrence
/// (a missed/owed run). Fires at most once per scenario per evaluation —
/// this is the "always catch up once" behavior. A schedule the scheduler has
/// never seen is armed (given a `lastRun`) by the loop without firing, so the
/// `None` branch here only means "state was lost" in practice.
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

#[derive(Clone, serde::Serialize)]
struct FirePayload {
    #[serde(rename = "skillId")]
    skill_id: String,
}

/// Ceiling on one tick's sleep. Even when the next occurrence is far away we
/// wake up this often so system sleep, a clock change or DST is picked up.
const TICK_CAP: std::time::Duration = std::time::Duration::from_secs(30);

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
            let occ = prev_occurrence(&sched.preset, now);
            match state.get(&sk.id).copied() {
                // First time we see this schedule: arm it at the most recent
                // occurrence without firing. A schedule that has never run owes
                // no catch-up — the user just created it; firing here would
                // launch a session the moment they hit save.
                None => {
                    state.insert(sk.id.clone(), occ.and_utc().timestamp_millis());
                    changed = true;
                }
                last => {
                    if is_due(&sched.preset, last, now) {
                        let _ = app.emit("schedule://fire", FirePayload { skill_id: sk.id.clone() });
                        // Stamp the occurrence, not `now` — otherwise repeated
                        // fires drift later and later. For a catch-up this is
                        // the missed time; for an on-time run it is ≈ `now`.
                        state.insert(sk.id.clone(), occ.and_utc().timestamp_millis());
                        changed = true;
                    }
                }
            }
            let nxt = next_occurrence(&sched.preset, now);
            soonest = Some(soonest.map_or(nxt, |s| s.min(nxt)));
        }

        // Drop state for scenarios that no longer exist so the file can't grow
        // without bound. Disabled schedules keep their entry: re-enabling one
        // should not look like a never-seen schedule.
        let known: std::collections::HashSet<&str> = skills.iter().map(|s| s.id.as_str()).collect();
        let before = state.len();
        state.retain(|id, _| known.contains(id.as_str()));
        if state.len() != before { changed = true; }

        if changed {
            if let Err(e) = store.save_schedule_state(&state) {
                eprintln!("warning: failed to save schedule_state.json ({e})");
            }
        }

        // Sleep until the soonest upcoming occurrence, capped so we re-evaluate
        // after system sleep / clock or DST changes.
        let dur = match soonest {
            Some(s) => {
                let ms = (s - now).num_milliseconds().max(0) as u64;
                std::time::Duration::from_millis(ms).min(TICK_CAP)
            }
            None => TICK_CAP,
        };
        tokio::time::sleep(dur).await;
    }
}

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
