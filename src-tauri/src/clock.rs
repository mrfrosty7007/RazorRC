//! Time handling.
//!
//! One rule, applied everywhere: a timestamp that crosses a boundary — into
//! SQLite, into JSON, into the audit trail — is a fixed-width ISO-8601 UTC
//! string with millisecond precision, exactly what JavaScript's
//! `Date.toISOString()` produces.
//!
//! Fixed width is the load-bearing part. Queries compare timestamps with `>=`
//! on TEXT columns and the trend chart groups by `substr(failed_at, 1, 10)`, so
//! the format has to sort chronologically as plain text. RFC 3339 emitters that
//! drop an all-zero subsecond field break that: `...:00Z` sorts *after*
//! `...:00.500Z` because `Z` outranks `.` in ASCII.

use time::{format_description::well_known::Rfc3339, Date, Month, OffsetDateTime, Time, UtcOffset};

use crate::error::{EngineError, EngineResult};

const MILLIS_PER_MINUTE: i64 = 60_000;

pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

pub fn now_iso() -> String {
    to_iso(now())
}

/// The canonical wire and storage format. See the module note on fixed width.
pub fn to_iso(instant: OffsetDateTime) -> String {
    let utc = instant.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        utc.year(),
        u8::from(utc.month()),
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second(),
        utc.millisecond(),
    )
}

/// Accepts anything RFC 3339 accepts, so timestamps that arrived from Razorpay
/// or from an older build of this app still parse.
pub fn parse_iso(value: &str) -> EngineResult<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|instant| instant.to_offset(UtcOffset::UTC))
        .map_err(|cause| EngineError::corrupt(value, cause))
}

pub fn plus_minutes(instant: OffsetDateTime, minutes: i64) -> OffsetDateTime {
    instant + time::Duration::minutes(minutes)
}

pub fn iso_minutes_from_now(minutes: i64) -> String {
    to_iso(plus_minutes(now(), minutes))
}

/// Start of the window a dashboard query covers, as a comparable ISO string.
pub fn iso_days_ago(days: f64) -> String {
    to_iso(now() - time::Duration::seconds_f64(days * 86_400.0))
}

/// Midnight UTC at the head of a `days`-long window ending today.
///
/// Every window in this app is whole calendar days, not a rolling `days × 24h`,
/// and they all start here so that they cannot disagree. They used to: the trend
/// chart bucketed by calendar day while the KPI cards above it measured a
/// rolling window, so a failure from the small hours of the oldest day counted
/// towards "revenue at risk" but had no bar to sit in — a card and the chart
/// beside it differed by a whole job, with no way for a merchant to tell which
/// one was lying.
pub fn iso_window_start(days: u32) -> String {
    let first_day = iso_days_ago(f64::from(days.max(1) - 1));
    format!("{}T00:00:00.000Z", day_key(&first_day))
}

/// The `YYYY-MM-DD` keys of a `days`-long window ending today, oldest first.
///
/// One clock read for the whole series. Deriving the bucket keys and the range
/// predicate from separate reads of `now()` would let them straddle a midnight
/// and disagree about which day the window opens on — rare, but it would present
/// as a chart that silently drops its oldest bar.
pub fn window_day_keys(days: u32) -> Vec<String> {
    let base = now();
    (0..days.max(1))
        .rev()
        .map(|offset| {
            let at = base - time::Duration::seconds_f64(f64::from(offset) * 86_400.0);
            to_iso(at)[..10].to_string()
        })
        .collect()
}

/// The `YYYY-MM-DD` prefix, used as the trend chart's bucket key.
pub fn day_key(iso: &str) -> &str {
    if iso.len() >= 10 {
        &iso[..10]
    } else {
        iso
    }
}

/// Whole minutes between two instants, rounded to nearest — matching the
/// TypeScript mirror's `Math.round(diff / 60_000)`.
pub fn minutes_between(from: OffsetDateTime, to: OffsetDateTime) -> i64 {
    let millis = (to - from).whole_milliseconds();
    let rounded = (millis as f64) / (MILLIS_PER_MINUTE as f64);
    rounded.round() as i64
}

/// 06:30 UTC on the first of the month after `instant`.
///
/// Used by the payday rule. Extracted because month arithmetic across a
/// December boundary is the one place this calculation goes wrong.
pub fn first_of_next_month_at_0630(instant: OffsetDateTime) -> EngineResult<OffsetDateTime> {
    let (year, month) = match instant.month() {
        Month::December => (instant.year() + 1, Month::January),
        other => (instant.year(), other.next()),
    };

    let date = Date::from_calendar_date(year, month, 1)
        .map_err(|cause| EngineError::corrupt("payday-date", cause))?;

    Ok(date.with_time(at_0630()).assume_utc())
}

/// Same day as `instant`, moved forward `days`, at 06:30 UTC.
pub fn same_month_day_at_0630(
    instant: OffsetDateTime,
    day_of_month: u8,
) -> EngineResult<OffsetDateTime> {
    let date = Date::from_calendar_date(instant.year(), instant.month(), day_of_month)
        .map_err(|cause| EngineError::corrupt("payday-date", cause))?;

    Ok(date.with_time(at_0630()).assume_utc())
}

fn at_0630() -> Time {
    // Infallible: 06:30:00 is always a valid wall-clock time.
    Time::from_hms(6, 30, 0).expect("06:30 is a valid time")
}

/// Day and abbreviated month, e.g. `1 Sep`. Matches what the TypeScript mirror
/// gets from `Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })`,
/// which is the string a merchant reads on the action label.
pub fn day_month_label(instant: OffsetDateTime) -> String {
    format!("{} {}", instant.day(), month_abbreviation(instant.month()))
}

const fn month_abbreviation(month: Month) -> &'static str {
    match month {
        Month::January => "Jan",
        Month::February => "Feb",
        Month::March => "Mar",
        Month::April => "Apr",
        Month::May => "May",
        Month::June => "Jun",
        Month::July => "Jul",
        Month::August => "Aug",
        Month::September => "Sep",
        Month::October => "Oct",
        Month::November => "Nov",
        Month::December => "Dec",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> OffsetDateTime {
        parse_iso(iso).unwrap()
    }

    #[test]
    fn iso_round_trips() {
        let original = "2026-08-22T11:40:07.250Z";
        assert_eq!(to_iso(at(original)), original);
    }

    #[test]
    fn iso_is_fixed_width_so_text_sort_is_chronological() {
        let midnight = to_iso(at("2026-08-22T00:00:00Z"));
        let later = to_iso(at("2026-08-22T00:00:00.500Z"));

        assert_eq!(midnight.len(), later.len());
        assert_eq!(midnight, "2026-08-22T00:00:00.000Z");
        assert!(midnight < later, "{midnight} should sort before {later}");
    }

    #[test]
    fn offsets_are_normalised_to_utc() {
        // Razorpay sends IST timestamps; storage is always UTC.
        assert_eq!(
            to_iso(at("2026-08-22T17:10:00+05:30")),
            "2026-08-22T11:40:00.000Z"
        );
    }

    #[test]
    fn day_key_is_the_date_prefix() {
        assert_eq!(day_key("2026-08-22T11:40:00.000Z"), "2026-08-22");
        assert_eq!(day_key("short"), "short");
    }

    #[test]
    fn a_window_starts_at_midnight_on_its_oldest_day() {
        let start = iso_window_start(7);
        assert!(start.ends_with("T00:00:00.000Z"), "{start}");
        // The oldest bucket the trend chart draws is `days - 1` days back, and
        // the window has to begin there or the chart loses a bar the KPI counted.
        assert_eq!(day_key(&start), day_key(&iso_days_ago(6.0)));
    }

    #[test]
    fn a_window_of_one_day_is_today() {
        assert_eq!(day_key(&iso_window_start(1)), day_key(&now_iso()));
        // Zero is coerced to one rather than underflowing.
        assert_eq!(iso_window_start(0), iso_window_start(1));
    }

    #[test]
    fn the_previous_window_abuts_the_current_one() {
        // How the dashboard builds its deltas: doubling the window and taking
        // everything before the current start must give an equal-length window.
        let current = iso_window_start(7);
        let previous = iso_window_start(14);
        assert!(previous < current, "{previous} should precede {current}");
        assert_eq!(day_key(&previous), day_key(&iso_days_ago(13.0)));
    }

    #[test]
    fn window_day_keys_agree_with_the_window_start() {
        let keys = window_day_keys(30);
        assert_eq!(keys.len(), 30);
        assert_eq!(keys.last().unwrap(), day_key(&now_iso()));

        // The trend chart derives its range predicate from the oldest key, so
        // this is the equality the two definitions rest on.
        assert_eq!(
            format!("{}T00:00:00.000Z", keys[0]),
            iso_window_start(30),
            "the oldest bucket and the window start disagree"
        );
    }

    #[test]
    fn window_day_keys_ascend_without_gaps() {
        let keys = window_day_keys(14);
        assert!(
            keys.windows(2).all(|pair| pair[0] < pair[1]),
            "keys are not strictly ascending: {keys:?}"
        );
        // Zero-filling the chart depends on there being no duplicate days.
        assert_eq!(
            keys.iter().collect::<std::collections::HashSet<_>>().len(),
            keys.len()
        );
    }

    #[test]
    fn minutes_between_rounds_to_nearest() {
        assert_eq!(
            minutes_between(at("2026-08-22T00:00:00Z"), at("2026-08-22T00:00:31Z")),
            1
        );
        assert_eq!(
            minutes_between(at("2026-08-22T00:00:00Z"), at("2026-08-22T00:00:29Z")),
            0
        );
        assert_eq!(
            minutes_between(at("2026-08-22T00:00:00Z"), at("2026-08-22T06:30:00Z")),
            390
        );
    }

    #[test]
    fn payday_crosses_the_december_boundary() {
        let target = first_of_next_month_at_0630(at("2026-12-18T22:05:00Z")).unwrap();
        assert_eq!(to_iso(target), "2027-01-01T06:30:00.000Z");
    }

    #[test]
    fn payday_is_the_first_of_next_month() {
        let target = first_of_next_month_at_0630(at("2026-08-22T11:40:00Z")).unwrap();
        assert_eq!(to_iso(target), "2026-09-01T06:30:00.000Z");
    }

    #[test]
    fn day_month_label_matches_the_en_in_short_form() {
        assert_eq!(day_month_label(at("2026-09-01T06:30:00Z")), "1 Sep");
        assert_eq!(day_month_label(at("2027-01-01T06:30:00Z")), "1 Jan");
        assert_eq!(day_month_label(at("2026-12-31T06:30:00Z")), "31 Dec");
    }
}
