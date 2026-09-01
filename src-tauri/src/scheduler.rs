use crate::model::{ScheduleRun, SchedulePreset, Skill, Workspace, SCHEDULE_STATE_VERSION};
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
    /// Which workspace the run belongs in, resolved here (`resolve_workspace`)
    /// rather than left to the frontend. `None` when the scenario's pin names
    /// no workspace that exists: the fire still goes out, so the refusal is
    /// journalled as `no-workspace` instead of the schedule going quiet.
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
    /// The occurrence being fired for. The frontend echoes it back through
    /// `schedule_ack` so a late or duplicated ack cannot stamp the wrong run.
    #[serde(rename = "occurrenceMs")]
    occurrence_ms: i64,
    /// True when this fire is making up for a missed occurrence, so the tile
    /// can say why it appeared at a time nobody scheduled.
    #[serde(rename = "catchUp")]
    catch_up: bool,
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

/// Which workspace a scheduled fire runs in: the one the scenario is pinned to,
/// and nothing else.
///
/// The absence of a fallback is the point (#249). An unpinned scenario used to
/// run in whichever workspace happened to be selected when the schedule fired,
/// which is a coin flip deciding which repository an unattended `claude` running
/// `git` and `gh` works in — and it guessed silently. A pin that no longer names
/// a workspace resolves to nothing for the same reason: refusing is cheap, and
/// running the prompt in the wrong folder is not.
pub fn resolve_workspace(pin: Option<&str>, workspaces: &[Workspace]) -> Option<String> {
    let id = pin?;
    workspaces.iter().find(|w| w.id == id).map(|w| w.id.clone())
}

/// The one-time migration that goes with the pin requirement above.
///
/// A schedule saved before #249 may carry no pin at all. Under the old rule it
/// ran in whatever workspace was active, so `ui_state.activeWorkspaceId` is
/// precisely the workspace this machine would have chosen — stamping it is what
/// keeps every existing schedule behaving exactly as it did on upgrade.
///
/// Returns the rewritten list, or `None` when there is nothing to do. Stamping
/// happens once because a stamped scenario is no longer unpinned. A scenario is
/// left alone when there is no stored active workspace to stamp: it then refuses
/// visibly (`no-workspace`, in the row and in the journal), which is the whole
/// improvement, rather than being pinned to a guess.
pub fn pin_scheduled(skills: &[Skill], active: Option<&str>) -> Option<Vec<Skill>> {
    let active = active?;
    let needs_pin = |sk: &Skill| sk.schedule.is_some() && sk.workspace_id.is_none();
    if !skills.iter().any(needs_pin) { return None }
    Some(skills.iter().cloned().map(|mut sk| {
        if needs_pin(&sk) { sk.workspace_id = Some(active.to_string()); }
        sk
    }).collect())
}

/// Run `pin_scheduled` against what is on disk, once, at startup.
///
/// The stored active workspace is only used if it still exists: a pin to a
/// deleted workspace would make the scenario an orphan, which is a different
/// wrong answer, not a migration.
pub fn migrate_pins(store: &Store) {
    let skills = store.skills();
    let workspaces = store.workspaces();
    let active = store.ui_state().active_workspace_id
        .filter(|id| workspaces.iter().any(|w| &w.id == id));
    let Some(pinned) = pin_scheduled(&skills, active.as_deref()) else { return };
    if let Err(e) = store.save_skills(&pinned) {
        // Nothing else to do about it: the schedules that would have been
        // stamped stay unpinned, and refuse rather than run in the wrong place.
        eprintln!("error: failed to pin scheduled scenarios to a workspace ({e})");
    }
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

/// Local wall clock -> true epoch millis. Version 1 used
/// `naive.and_utc().timestamp_millis()`, which labelled a local time as UTC:
/// self-consistent in one timezone, wrong by the offset after travel or a DST
/// change, and meaningless to anything else that reads the file.
pub fn to_epoch_ms(t: NaiveDateTime) -> i64 {
    t.and_local_timezone(chrono::Local)
        .earliest()
        // A wall clock inside a DST spring-forward gap does not exist; the
        // occurrence it stands for is the following instant.
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|| t.and_utc().timestamp_millis())
}

/// Inverse of `to_epoch_ms`, plus the version-1 reading for records written
/// before the format was fixed.
pub fn from_epoch_ms(ms: i64, version: u8) -> Option<NaiveDateTime> {
    let dt = chrono::DateTime::from_timestamp_millis(ms)?;
    Some(if version >= 2 {
        dt.with_timezone(&chrono::Local).naive_local()
    } else {
        dt.naive_utc()
    })
}

/// Whether a fire is making up for a missed occurrence rather than running on
/// time. The loop ticks every 30 s, so an on-time fire is always close to its
/// occurrence; anything further behind was owed from a period when the app was
/// closed or parked.
pub fn is_catch_up(occurrence: NaiveDateTime, now: NaiveDateTime) -> bool {
    (now - occurrence).num_seconds() > 120
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
    match from_epoch_ms(run.last_attempt, run.version) {
        Some(dt) if dt >= occ => TickAction::Idle,
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
        version: cur.version,
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
        // `try_workspaces`, not `workspaces()`: a fire is refused when its pin
        // resolves to nothing, so an unreadable file read as "there are no
        // workspaces" would refuse every scheduled run — and an occurrence is
        // attempted at most once, so that refusal is not retried. Skipping the
        // tick instead stamps nothing, and the next tick 30 s later resolves it.
        let workspaces = match store.try_workspaces() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("error: failed to read workspaces.json ({e}); schedules wait for the next tick");
                tokio::time::sleep(TICK_CAP).await;
                continue;
            }
        };
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
                        last_attempt: to_epoch_ms(occ),
                        last_run: prev.and_then(|r| r.last_run),
                        last_outcome: prev.and_then(|r| r.last_outcome.clone()),
                        preset: Some(fingerprint(&sched.preset)), version: SCHEDULE_STATE_VERSION });
                    changed = true;
                }
                TickAction::Fire(occ) => {
                    let occurrence_ms = to_epoch_ms(occ);
                    let _ = app.emit("schedule://fire", FirePayload {
                        skill_id: sk.id.clone(),
                        workspace_id: resolve_workspace(sk.workspace_id.as_deref(), &workspaces),
                        occurrence_ms,
                        catch_up: is_catch_up(occ, now),
                    });
                    // Record the attempt only. Whether a session actually
                    // started is the frontend's to report, via `schedule_ack`.
                    let prev_run = state.get(&sk.id).and_then(|r| r.last_run);
                    state.insert(sk.id.clone(), ScheduleRun {
                        last_attempt: occurrence_ms,
                        last_run: prev_run,
                        last_outcome: None,
                        preset: Some(fingerprint(&sched.preset)), version: SCHEDULE_STATE_VERSION });
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
                // Not a warning: the map is re-read from disk every tick, so a
                // failing write means every schedule is re-armed forever and
                // nothing ever fires. That is the feature being down, and it
                // has to reach the user rather than stderr nobody reads.
                eprintln!("error: failed to save schedule_state.json ({e})");
                let _ = app.emit("schedule://broken", format!(
                    "Could not save schedule state ({e}). \
                     Until this is fixed, scheduled scenarios will not fire."));
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
    use crate::model::{Schedule, UiStatePatch};
    use chrono::NaiveDate;

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap()
    }

    fn ws(id: &str) -> Workspace {
        Workspace {
            id: id.into(), name: id.into(), path: format!("/tmp/{id}"), color: "#61afef".into(),
            github: None, tracker: None, repo: None,
        }
    }

    /// A scenario, scheduled or not, pinned or not.
    fn skill(id: &str, pin: Option<&str>, scheduled: bool) -> Skill {
        Skill {
            id: id.into(), name: id.into(), icon: "play".into(), prompt: "go".into(),
            workspace_id: pin.map(str::to_string),
            schedule: scheduled.then(|| Schedule {
                preset: SchedulePreset::Daily { hour: 9, minute: 0 },
                defaults: Default::default(),
                enabled: true,
            }),
        }
    }

    /// A fresh store directory, unique per call.
    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let mut d = std::env::temp_dir();
        d.push(format!("coworkdeck-sched-test-{}", std::process::id()));
        d.push(format!("{:?}-{}", std::time::SystemTime::now(), SEQ.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The pin, and only the pin. Under the old rule this returned the active
    /// workspace when there was no pin, which is what #249 is about.
    #[test]
    fn a_fire_resolves_to_the_workspace_the_scenario_is_pinned_to() {
        let all = [ws("a"), ws("b")];
        assert_eq!(resolve_workspace(Some("b"), &all).as_deref(), Some("b"));
    }

    /// No fallback, so an unpinned scenario resolves to nothing and the fire is
    /// refused rather than landing in whichever workspace was on screen.
    #[test]
    fn an_unpinned_scenario_resolves_to_nothing() {
        assert_eq!(resolve_workspace(None, &[ws("a")]), None);
    }

    /// A pin to a workspace that has since been deleted is not a licence to pick
    /// another one.
    #[test]
    fn a_pin_to_a_deleted_workspace_resolves_to_nothing() {
        assert_eq!(resolve_workspace(Some("gone"), &[ws("a"), ws("b")]), None);
    }

    /// The migration proper: what the old fallback would have chosen on this
    /// machine becomes the pin, so no existing schedule changes behaviour.
    #[test]
    fn an_unpinned_scheduled_scenario_acquires_the_stored_active_workspace() {
        let skills = [skill("s1", None, true), skill("s2", Some("b"), true), skill("s3", None, false)];
        let out = pin_scheduled(&skills, Some("a")).expect("something to migrate");
        assert_eq!(out[0].workspace_id.as_deref(), Some("a"));
        assert_eq!(out[1].workspace_id.as_deref(), Some("b"), "an existing pin is not overwritten");
        assert_eq!(out[2].workspace_id, None, "a scenario with no schedule needs no pin");
    }

    /// Nothing to stamp with: the scenario stays unpinned and refuses visibly,
    /// which beats pinning it to a guess.
    #[test]
    fn nothing_is_stamped_when_no_workspace_was_ever_active() {
        assert!(pin_scheduled(&[skill("s1", None, true)], None).is_none());
    }

    /// Exactly once, and through the store: after the first pass every scheduled
    /// scenario is pinned, so the second pass has nothing to do and rewrites
    /// nothing — the person's own repin cannot be undone by the next launch.
    #[test]
    fn the_migration_stamps_a_scenario_once_and_then_finds_nothing_to_do() {
        let s = Store::new(tmp());
        s.save_workspaces(&[ws("a"), ws("b")]).unwrap();
        s.save_ui_state(&UiStatePatch { active_workspace_id: Some("a".into()), ..Default::default() }).unwrap();
        s.save_skills(&[skill("s1", None, true)]).unwrap();

        migrate_pins(&s);
        assert_eq!(s.skills()[0].workspace_id.as_deref(), Some("a"));

        // Repinned by hand, then another launch: the migration is done with this
        // scenario and must not drag it back to the active workspace.
        let mut repinned = s.skills();
        repinned[0].workspace_id = Some("b".into());
        s.save_skills(&repinned).unwrap();
        migrate_pins(&s);
        assert_eq!(s.skills()[0].workspace_id.as_deref(), Some("b"));
    }

    /// A stored active workspace that no longer exists is not a pin: stamping it
    /// would turn every migrated schedule into an orphan.
    #[test]
    fn the_migration_ignores_a_stored_active_workspace_that_is_gone() {
        let s = Store::new(tmp());
        s.save_workspaces(&[ws("a")]).unwrap();
        s.save_ui_state(&UiStatePatch { active_workspace_id: Some("deleted".into()), ..Default::default() }).unwrap();
        s.save_skills(&[skill("s1", None, true)]).unwrap();

        migrate_pins(&s);
        assert_eq!(s.skills()[0].workspace_id, None);
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
            last_attempt: to_epoch_ms(attempt),
            last_run: Some(to_epoch_ms(attempt)),
            last_outcome: Some("launched".into()),
            preset: Some(fingerprint(preset)), version: SCHEDULE_STATE_VERSION }
    }

    /// Version-1 files hold a local wall clock labelled as UTC. Reading one
    /// back with the version-1 rule has to yield the wall clock it meant, or
    /// every schedule shifts by the machine's UTC offset on upgrade.
    #[test]
    fn a_version_1_timestamp_reads_back_as_the_wall_clock_it_meant() {
        let wall = dt(2026, 7, 24, 9, 0);
        let v1_ms = wall.and_utc().timestamp_millis();
        assert_eq!(from_epoch_ms(v1_ms, 1), Some(wall));
    }

    #[test]
    fn a_version_2_timestamp_round_trips_through_a_real_epoch() {
        let wall = dt(2026, 7, 24, 9, 0);
        assert_eq!(from_epoch_ms(to_epoch_ms(wall), 2), Some(wall));
    }

    /// A tile that appears at 14:20 for a 09:00 schedule looks like a fault
    /// unless it says it is catching up. The tick runs every 30 s, so an
    /// on-time fire is always within a couple of minutes of its occurrence.
    #[test]
    fn a_fire_long_after_its_occurrence_is_a_catch_up() {
        let occ = dt(2026, 7, 24, 9, 0);
        assert!(!is_catch_up(occ, dt(2026, 7, 24, 9, 0)));
        assert!(!is_catch_up(occ, dt(2026, 7, 24, 9, 1)));
        assert!(is_catch_up(occ, dt(2026, 7, 24, 14, 20)));
        assert!(is_catch_up(occ, dt(2026, 7, 26, 9, 0)));
    }

    /// A launch is the only thing that advances `last_run` — that field is
    /// what "when did this scenario last actually run" is read from.
    #[test]
    fn a_launched_ack_records_the_run() {
        let occ = to_epoch_ms(dt(2026, 7, 24, 9, 0));
        let attempted = ScheduleRun { last_attempt: occ, last_run: None, last_outcome: None, preset: None, version: SCHEDULE_STATE_VERSION };

        let updated = apply_ack(Some(&attempted), occ, "launched").expect("ack applies");
        assert_eq!(updated.last_run, Some(occ));
        assert_eq!(updated.last_outcome.as_deref(), Some("launched"));
    }

    /// A refusal is recorded, not hidden: `last_run` stays where it was, so the
    /// scenario can honestly report "last ran three days ago" while the reason
    /// for today's silence is right there next to it.
    #[test]
    fn a_failed_ack_records_the_reason_without_claiming_a_run() {
        let yesterday = to_epoch_ms(dt(2026, 7, 23, 9, 0));
        let occ = to_epoch_ms(dt(2026, 7, 24, 9, 0));
        let attempted = ScheduleRun {
            last_attempt: occ,
            last_run: Some(yesterday),
            last_outcome: Some("launched".into()), preset: None, version: SCHEDULE_STATE_VERSION };

        let updated = apply_ack(Some(&attempted), occ, "no-workspace").expect("ack applies");
        assert_eq!(updated.last_run, Some(yesterday));
        assert_eq!(updated.last_outcome.as_deref(), Some("no-workspace"));
    }

    /// An ack for an occurrence we are no longer waiting on is dropped, so a
    /// late or replayed message cannot stamp a run that never happened.
    #[test]
    fn a_stale_ack_is_ignored() {
        let occ = to_epoch_ms(dt(2026, 7, 24, 9, 0));
        let older = to_epoch_ms(dt(2026, 7, 23, 9, 0));
        let current = ScheduleRun { last_attempt: occ, last_run: None, last_outcome: None, preset: None, version: SCHEDULE_STATE_VERSION };

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
            last_attempt: to_epoch_ms(dt(2026, 7, 23, 18, 0)),
            last_run: Some(to_epoch_ms(dt(2026, 7, 23, 18, 0))),
            last_outcome: Some("launched".into()),
            preset: Some(fingerprint(&old)), version: SCHEDULE_STATE_VERSION };

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
            last_attempt: to_epoch_ms(dt(2026, 7, 17, 9, 0)),
            last_run: Some(to_epoch_ms(dt(2026, 7, 17, 9, 0))),
            last_outcome: Some("launched".into()),
            preset: None, version: SCHEDULE_STATE_VERSION };

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
            last_attempt: to_epoch_ms(dt(2026, 7, 24, 9, 0)),
            last_run: Some(to_epoch_ms(dt(2026, 7, 23, 9, 0))),
            last_outcome: Some("no-workspace".into()),
            preset: Some(fingerprint(&p)), version: SCHEDULE_STATE_VERSION };
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
