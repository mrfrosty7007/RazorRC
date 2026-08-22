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
