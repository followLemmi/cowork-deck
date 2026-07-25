use crate::model::SchedulePreset;
use chrono::{Datelike, Duration, NaiveDateTime, Timelike};

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
