use crate::model::{ScheduleRun, SchedulePreset};
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

#[derive(Clone, serde::Serialize)]
struct FirePayload {
    #[serde(rename = "skillId")]
    skill_id: String,
    /// The occurrence being fired for. The frontend echoes it back through
    /// `schedule_ack` so a late or duplicated ack cannot stamp the wrong run.
    #[serde(rename = "occurrenceMs")]
    occurrence_ms: i64,
}

/// What one tick owes a single scenario.
#[derive(Debug, PartialEq, Eq)]
pub enum TickAction {
    /// First sighting: record the occurrence without running anything.
    Arm(NaiveDateTime),
    /// Emit a fire for this occurrence.
    Fire(NaiveDateTime),
    /// Nothing owed.
    Idle,
}

/// Identity of a firing rule. Compared, never parsed — two schedules are "the
/// same rule" when this matches.
pub fn fingerprint(preset: &SchedulePreset) -> String {
    match preset {
        SchedulePreset::Hourly { minute } => format!("hourly:{minute}"),
        SchedulePreset::Daily { hour, minute } => format!("daily:{hour}:{minute}"),
        SchedulePreset::Weekly { weekday, hour, minute } => format!("weekly:{weekday}:{hour}:{minute}"),
    }
}

/// Decide what to do with one scenario this tick.
///
/// The gate is `last_attempt`, not `last_run`: an occurrence is attempted at
/// most once. Keying off success instead would retry a permanently broken
/// scenario on every tick, which is a worse failure than skipping it — the
/// failure is surfaced through `last_outcome` instead.
pub fn decide(
    preset: &SchedulePreset,
    entry: Option<&ScheduleRun>,
    now: NaiveDateTime,
) -> TickAction {
    let occ = prev_occurrence(preset, now);
    let Some(run) = entry else { return TickAction::Arm(occ) };
    // The attempt only means anything under the rule it was made for. A
    // changed or resumed rule owes nothing yet.
    if run.preset.as_deref() != Some(fingerprint(preset).as_str()) {
        return TickAction::Arm(occ);
    }
    match chrono::DateTime::from_timestamp_millis(run.last_attempt) {
        Some(dt) if dt.naive_utc() >= occ => TickAction::Idle,
        _ => TickAction::Fire(occ),
    }
}

/// Fold the frontend's report of one fire into that scenario's record.
///
/// Returns `None` when the ack does not match the attempt we are waiting on —
/// an unknown scenario, or an occurrence already superseded. Dropping those
/// keeps a replayed or late message from stamping a run that never happened.
pub fn apply_ack(
    entry: Option<&ScheduleRun>,
    occurrence_ms: i64,
    outcome: &str,
) -> Option<ScheduleRun> {
    let cur = entry?;
    if cur.last_attempt != occurrence_ms { return None }
    Some(ScheduleRun {
        last_attempt: cur.last_attempt,
        last_run: if outcome == "launched" { Some(occurrence_ms) } else { cur.last_run },
        last_outcome: Some(outcome.to_string()),
        preset: cur.preset.clone(),
    })
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
            // Not scheduled right now — off, or the schedule was removed. Clear
            // the rule the last attempt belonged to, so switching it back on
            // arms afresh instead of looking like a run that is owed. The rest
            // of the record survives, so "last ran on Tuesday" is not lost.
            let active = sk.schedule.as_ref().filter(|s| s.enabled);
            let Some(sched) = active else {
                if let Some(run) = state.get(&sk.id) {
                    if run.preset.is_some() {
                        let mut cleared = run.clone();
                        cleared.preset = None;
                        state.insert(sk.id.clone(), cleared);
                        changed = true;
                    }
                }
                continue;
            };
            // Stamp the occurrence, not `now` — otherwise repeated fires drift
            // later and later. For a catch-up this is the missed time; for an
            // on-time run it is ≈ `now`.
            match decide(&sched.preset, state.get(&sk.id), now) {
                TickAction::Arm(occ) => {
                    // Keep whatever history the entry already had: an armed
                    // rule is a new rule, not a new scenario.
                    let prev = state.get(&sk.id);
                    state.insert(sk.id.clone(), ScheduleRun {
                        last_attempt: occ.and_utc().timestamp_millis(),
                        last_run: prev.and_then(|r| r.last_run),
                        last_outcome: prev.and_then(|r| r.last_outcome.clone()),
                        preset: Some(fingerprint(&sched.preset)),
                    });
                    changed = true;
                }
                TickAction::Fire(occ) => {
                    let occurrence_ms = occ.and_utc().timestamp_millis();
                    let _ = app.emit("schedule://fire", FirePayload {
                        skill_id: sk.id.clone(),
                        occurrence_ms,
                    });
                    // Record the attempt only. Whether a session actually
                    // started is the frontend's to report, via `schedule_ack`.
                    let prev_run = state.get(&sk.id).and_then(|r| r.last_run);
                    state.insert(sk.id.clone(), ScheduleRun {
                        last_attempt: occurrence_ms,
                        last_run: prev_run,
                        last_outcome: None,
                        preset: Some(fingerprint(&sched.preset)),
                    });
                    changed = true;
                }
                TickAction::Idle => {}
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

    /// A record left by a successful run of `preset` at `attempt`.
    fn run_at(preset: &SchedulePreset, attempt: NaiveDateTime) -> ScheduleRun {
        ScheduleRun {
            last_attempt: attempt.and_utc().timestamp_millis(),
            last_run: Some(attempt.and_utc().timestamp_millis()),
            last_outcome: Some("launched".into()),
            preset: Some(fingerprint(preset)),
        }
    }

    /// A launch is the only thing that advances `last_run` — that field is
    /// what "when did this scenario last actually run" is read from.
    #[test]
    fn a_launched_ack_records_the_run() {
        let occ = dt(2026, 7, 24, 9, 0).and_utc().timestamp_millis();
        let attempted = ScheduleRun { last_attempt: occ, last_run: None, last_outcome: None, preset: None };

        let updated = apply_ack(Some(&attempted), occ, "launched").expect("ack applies");
        assert_eq!(updated.last_run, Some(occ));
        assert_eq!(updated.last_outcome.as_deref(), Some("launched"));
    }

    /// A refusal is recorded, not hidden: `last_run` stays where it was, so the
    /// scenario can honestly report "last ran three days ago" while the reason
    /// for today's silence is right there next to it.
    #[test]
    fn a_failed_ack_records_the_reason_without_claiming_a_run() {
        let yesterday = dt(2026, 7, 23, 9, 0).and_utc().timestamp_millis();
        let occ = dt(2026, 7, 24, 9, 0).and_utc().timestamp_millis();
        let attempted = ScheduleRun {
            last_attempt: occ,
            last_run: Some(yesterday),
            last_outcome: Some("launched".into()), preset: None };

        let updated = apply_ack(Some(&attempted), occ, "no-workspace").expect("ack applies");
        assert_eq!(updated.last_run, Some(yesterday));
        assert_eq!(updated.last_outcome.as_deref(), Some("no-workspace"));
    }

    /// An ack for an occurrence we are no longer waiting on is dropped, so a
    /// late or replayed message cannot stamp a run that never happened.
    #[test]
    fn a_stale_ack_is_ignored() {
        let occ = dt(2026, 7, 24, 9, 0).and_utc().timestamp_millis();
        let older = dt(2026, 7, 23, 9, 0).and_utc().timestamp_millis();
        let current = ScheduleRun { last_attempt: occ, last_run: None, last_outcome: None, preset: None };

        assert_eq!(apply_ack(Some(&current), older, "launched"), None);
        assert_eq!(apply_ack(None, occ, "launched"), None);
    }

    /// Moving a daily run from 18:00 to 09:00 at 10:00 must not fire on the
    /// spot. The old attempt belongs to the old rule and owes nothing under
    /// the new one.
    #[test]
    fn changing_the_rule_re_arms_instead_of_firing() {
        let old = SchedulePreset::Daily { hour: 18, minute: 0 };
        let new = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        let entry = ScheduleRun {
            last_attempt: dt(2026, 7, 23, 18, 0).and_utc().timestamp_millis(),
            last_run: Some(dt(2026, 7, 23, 18, 0).and_utc().timestamp_millis()),
            last_outcome: Some("launched".into()),
            preset: Some(fingerprint(&old)),
        };

        assert_eq!(decide(&new, Some(&entry), now), TickAction::Arm(dt(2026, 7, 24, 9, 0)));
    }

    /// Same story for a schedule switched off and back on a week later: the
    /// loop clears the fingerprint while it is paused, so resuming arms rather
    /// than firing a week's worth of "owed" run.
    #[test]
    fn resuming_a_paused_schedule_re_arms() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        let paused = ScheduleRun {
            last_attempt: dt(2026, 7, 17, 9, 0).and_utc().timestamp_millis(),
            last_run: Some(dt(2026, 7, 17, 9, 0).and_utc().timestamp_millis()),
            last_outcome: Some("launched".into()),
            preset: None,
        };

        assert_eq!(decide(&p, Some(&paused), now), TickAction::Arm(dt(2026, 7, 24, 9, 0)));
    }

    /// A schedule the loop has never seen is armed, not fired: the user just
    /// saved it and owes no catch-up.
    #[test]
    fn unseen_schedule_is_armed_without_firing() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        assert_eq!(decide(&p, None, now), TickAction::Arm(dt(2026, 7, 24, 9, 0)));
    }

    /// The gate is the attempt, not the success. Without this a scenario that
    /// fails every time — no workspace, `claude` missing — would be retried on
    /// every 30-second tick forever.
    #[test]
    fn an_occurrence_is_attempted_at_most_once() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        let failed = ScheduleRun {
            last_attempt: dt(2026, 7, 24, 9, 0).and_utc().timestamp_millis(),
            last_run: Some(dt(2026, 7, 23, 9, 0).and_utc().timestamp_millis()),
            last_outcome: Some("no-workspace".into()),
            preset: Some(fingerprint(&p)),
        };
        assert_eq!(decide(&p, Some(&failed), now), TickAction::Idle);
    }

    /// Missed while the app was closed: one catch-up fire, for the occurrence
    /// that was missed rather than for `now`.
    #[test]
    fn a_missed_occurrence_fires_once() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        let stale = run_at(&p, dt(2026, 7, 21, 9, 0));
        assert_eq!(
            decide(&p, Some(&stale), now),
            TickAction::Fire(dt(2026, 7, 24, 9, 0))
        );
    }

    /// Already handled this occurrence, next one is in the future.
    #[test]
    fn an_up_to_date_schedule_stays_idle() {
        let p = SchedulePreset::Daily { hour: 9, minute: 0 };
        let now = dt(2026, 7, 24, 10, 0);
        assert_eq!(decide(&p, Some(&run_at(&p, dt(2026, 7, 24, 9, 0))), now), TickAction::Idle);
    }

}
