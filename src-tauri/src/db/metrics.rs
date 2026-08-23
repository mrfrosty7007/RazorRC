//! Dashboard and analytics aggregates.
//!
//! All of these are computed from the job table on demand. Nothing is cached and
//! nothing is hardcoded — including the deltas on the KPI cards, which are
//! measured against the previous equivalent window rather than invented, because
//! a made-up "+12% on last week" is the fastest way to lose a merchant's trust.
//!
//! One definition, used consistently: **at risk** is money that failed inside
//! the window and has not since been recovered or written off. A job the team
//! has suppressed still counts — the money is still gone.

use rusqlite::{params, Connection};

use crate::clock;
use crate::db::jobs;
use crate::domain::{
    AttemptEffectiveness, DashboardMetrics, FailureBreakdown, FunnelSegment, FunnelStage,
    MethodBreakdown, MetricDelta, MetricDeltas, RecoveryFunnel, RecoveryStatus, TrendPoint,
};
use crate::error::EngineResult;

/// Retries past the fourth are rare enough that a fifth bucket is noise.
const MAX_ATTEMPT_BUCKET: i64 = 4;

/// Totals for one window. The private shape the KPI cards and their deltas are
/// both built from, so a card and its delta can never disagree about a number.
#[derive(Debug, Clone, Copy, Default)]
struct Totals {
    failed_paise: i64,
    recovered_paise: i64,
    at_risk_paise: i64,
    active_jobs: i64,
}

impl Totals {
    fn recovery_rate(&self) -> f64 {
        ratio(self.recovered_paise, self.failed_paise)
    }
}

pub fn dashboard(connection: &Connection, window_days: u32) -> EngineResult<DashboardMetrics> {
    let days = window_days.max(1);
    let window_start = clock::iso_window_start(days);
    let previous_start = clock::iso_window_start(days * 2);

    let current = totals(connection, &window_start, None)?;
    let previous = totals(connection, &previous_start, Some(&window_start))?;

    Ok(DashboardMetrics {
        window_days,
        generated_at: clock::now_iso(),
        revenue_at_risk_paise: current.at_risk_paise,
        recovered_paise: current.recovered_paise,
        recovery_rate: current.recovery_rate(),
        active_jobs: current.active_jobs,
        deltas: MetricDeltas {
            revenue_at_risk: delta(current.at_risk_paise, previous.at_risk_paise, false),
            recovered: delta(current.recovered_paise, previous.recovered_paise, true),
            recovery_rate: MetricDelta {
                change: change(current.recovery_rate(), previous.recovery_rate()),
                higher_is_better: true,
            },
            active_jobs: delta(current.active_jobs, previous.active_jobs, false),
        },
        funnel: funnel(connection, &window_start)?,
    })
}

fn totals(
    connection: &Connection,
    from: &str,
    until: Option<&str>,
) -> EngineResult<Totals> {
    let active: Vec<&str> = RecoveryStatus::ACTIVE
        .iter()
        .map(|status| status.as_str())
        .collect();

    let sql = format!(
        "SELECT
           IFNULL(SUM(p.amount_paise), 0),
           IFNULL(SUM(CASE WHEN j.status = 'recovered'
                           THEN j.recovered_amount_paise ELSE 0 END), 0),
           IFNULL(SUM(CASE WHEN j.status IN ('recovered', 'written_off')
                           THEN 0 ELSE p.amount_paise END), 0),
           IFNULL(SUM(CASE WHEN j.status IN ('{}') THEN 1 ELSE 0 END), 0)
         FROM recovery_jobs j
         JOIN failed_payments p ON p.id = j.payment_id
         WHERE p.failed_at >= ?1 AND (?2 IS NULL OR p.failed_at < ?2)",
        active.join("', '")
    );

    let totals = connection.query_row(&sql, params![from, until], |row| {
        Ok(Totals {
            failed_paise: row.get(0)?,
            recovered_paise: row.get(1)?,
            at_risk_paise: row.get(2)?,
            active_jobs: row.get(3)?,
        })
    })?;

    Ok(totals)
}

fn funnel(connection: &Connection, window_start: &str) -> EngineResult<RecoveryFunnel> {
    let mut statement = connection.prepare(
        "SELECT j.status, SUM(p.amount_paise), COUNT(*)
           FROM recovery_jobs j
           JOIN failed_payments p ON p.id = j.payment_id
          WHERE p.failed_at >= ?1
          GROUP BY j.status",
    )?;

    let mut rows = statement.query(params![window_start])?;

    // Fixed stage order so the funnel bars never reshuffle between polls.
    let mut segments: Vec<FunnelSegment> = FunnelStage::ALL
        .iter()
        .map(|stage| FunnelSegment {
            stage: *stage,
            amount_paise: 0,
            job_count: 0,
        })
        .collect();
    let mut total_paise = 0;

    while let Some(row) = rows.next()? {
        let status: RecoveryStatus = row.get(0)?;
        let amount_paise: i64 = row.get(1)?;
        let job_count: i64 = row.get(2)?;
        total_paise += amount_paise;

        let stage = status.funnel_stage();
        if let Some(segment) = segments.iter_mut().find(|entry| entry.stage == stage) {
            segment.amount_paise += amount_paise;
            segment.job_count += job_count;
        }
    }

    Ok(RecoveryFunnel {
        total_paise,
        segments,
    })
}

/// Daily series, zero-filled.
///
/// Zero-filling matters: a gap in the data draws a straight line across a day
/// where nothing failed, which reads as "no data" rather than "no failures".
pub fn trend(connection: &Connection, window_days: u32) -> EngineResult<Vec<TrendPoint>> {
    let days = window_days.max(1);

    // Bucket keys and the range predicate come from one clock read, and the
    // predicate is derived from the oldest bucket rather than computed again —
    // the same window definition the KPI cards use. See `clock::iso_window_start`
    // for what went wrong when the two were worked out separately.
    let mut points: Vec<TrendPoint> = clock::window_day_keys(days)
        .into_iter()
        .map(|date| TrendPoint {
            date,
            at_risk_paise: 0,
            recovered_paise: 0,
            recovery_rate: 0.0,
            attempts: 0,
        })
        .collect();

    let window_start = format!("{}T00:00:00.000Z", points[0].date);

    let mut by_day = connection.prepare(
        "SELECT substr(p.failed_at, 1, 10) AS day,
                IFNULL(SUM(p.amount_paise), 0),
                IFNULL(SUM(CASE WHEN j.status = 'recovered'
                                THEN j.recovered_amount_paise ELSE 0 END), 0),
                IFNULL(SUM(CASE WHEN j.status IN ('recovered', 'written_off')
                                THEN 0 ELSE p.amount_paise END), 0)
           FROM recovery_jobs j
           JOIN failed_payments p ON p.id = j.payment_id
          WHERE p.failed_at >= ?1
          GROUP BY day",
    )?;

    let mut rows = by_day.query(params![window_start])?;
    while let Some(row) = rows.next()? {
        let day: String = row.get(0)?;
        let failed_paise: i64 = row.get(1)?;
        let recovered_paise: i64 = row.get(2)?;
        let at_risk_paise: i64 = row.get(3)?;

        if let Some(point) = points.iter_mut().find(|point| point.date == day) {
            point.recovered_paise = recovered_paise;
            point.at_risk_paise = at_risk_paise;
            point.recovery_rate = ratio(recovered_paise, failed_paise);
        }
    }

    // Attempts are counted on the day they ran, not the day the payment failed,
    // so this is a second pass rather than another column above.
    let mut attempts = connection.prepare(
        "SELECT substr(occurred_at, 1, 10) AS day, COUNT(*)
           FROM recovery_attempts
          WHERE occurred_at >= ?1
          GROUP BY day",
    )?;

    let mut rows = attempts.query(params![window_start])?;
    while let Some(row) = rows.next()? {
        let day: String = row.get(0)?;
        let count: i64 = row.get(1)?;
        if let Some(point) = points.iter_mut().find(|point| point.date == day) {
            point.attempts = count;
        }
    }

    Ok(points)
}

pub fn failure_breakdown(
    connection: &Connection,
    window_days: u32,
) -> EngineResult<Vec<FailureBreakdown>> {
    let window_start = clock::iso_window_start(window_days.max(1));
    let mut statement = connection.prepare(&breakdown_sql("p.failure_reason"))?;
    let mut rows = statement.query(params![window_start])?;

    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let failed_paise: i64 = row.get(4)?;
        out.push(FailureBreakdown {
            reason: row.get(0)?,
            job_count: row.get(1)?,
            at_risk_paise: row.get(3)?,
            recovered_paise: row.get(2)?,
            recovery_rate: ratio(row.get(2)?, failed_paise),
        });
    }
    Ok(out)
}

pub fn method_breakdown(
    connection: &Connection,
    window_days: u32,
) -> EngineResult<Vec<MethodBreakdown>> {
    let window_start = clock::iso_window_start(window_days.max(1));
    let mut statement = connection.prepare(&breakdown_sql("p.method"))?;
    let mut rows = statement.query(params![window_start])?;

    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let failed_paise: i64 = row.get(4)?;
        out.push(MethodBreakdown {
            method: row.get(0)?,
            job_count: row.get(1)?,
            at_risk_paise: row.get(3)?,
            recovered_paise: row.get(2)?,
            recovery_rate: ratio(row.get(2)?, failed_paise),
        });
    }
    Ok(out)
}

/// `column` is one of two literals chosen in this file — never user input.
fn breakdown_sql(column: &str) -> String {
    format!(
        "SELECT {column},
                COUNT(*),
                IFNULL(SUM(CASE WHEN j.status = 'recovered'
                                THEN j.recovered_amount_paise ELSE 0 END), 0),
                IFNULL(SUM(CASE WHEN j.status IN ('recovered', 'written_off')
                                THEN 0 ELSE p.amount_paise END), 0),
                IFNULL(SUM(p.amount_paise), 0)
           FROM recovery_jobs j
           JOIN failed_payments p ON p.id = j.payment_id
          WHERE p.failed_at >= ?1
          GROUP BY {column}
          ORDER BY 4 DESC"
    )
}

/// How well each successive attempt does. Used to argue for a retry budget:
/// if the fourth attempt recovers nothing, stop paying for it.
///
/// Counted on the day the attempt *ran*, which is not the day the payment
/// failed. Filtering on `failed_at` quietly biased this table against the
/// strategies it exists to judge: a fourth retry, or a card-update email
/// answered a week later, happens long after the failure, so on a 7-day window
/// the slowest and most patient strategies were the ones most likely to fall
/// outside it — exactly the successes that justify the retry budget.
pub fn attempt_effectiveness(
    connection: &Connection,
    window_days: u32,
) -> EngineResult<Vec<AttemptEffectiveness>> {
    let window_start = clock::iso_window_start(window_days.max(1));

    let mut buckets: Vec<AttemptEffectiveness> = (1..=MAX_ATTEMPT_BUCKET)
        .map(|attempt| AttemptEffectiveness {
            attempt,
            attempted: 0,
            recovered: 0,
            recovery_rate: 0.0,
        })
        .collect();

    let mut statement = connection.prepare(
        "SELECT a.sequence,
                COUNT(*),
                SUM(CASE WHEN a.outcome = 'succeeded' THEN 1 ELSE 0 END)
           FROM recovery_attempts a
          WHERE a.occurred_at >= ?1 AND a.sequence <= ?2
          GROUP BY a.sequence",
    )?;

    let mut rows = statement.query(params![window_start, MAX_ATTEMPT_BUCKET])?;
    while let Some(row) = rows.next()? {
        let sequence: i64 = row.get(0)?;
        let attempted: i64 = row.get(1)?;
        let recovered: i64 = row.get(2)?;

        if let Some(bucket) = buckets
            .iter_mut()
            .find(|bucket| bucket.attempt == sequence)
        {
            bucket.attempted = attempted;
            bucket.recovered = recovered;
            bucket.recovery_rate = ratio(recovered, attempted);
        }
    }

    Ok(buckets)
}

/// Depth of the queue the engine still has work on, for the sidebar.
pub fn queue_depth(connection: &Connection) -> EngineResult<i64> {
    jobs::count_by_status(connection, RecoveryStatus::ACTIVE)
}

fn ratio(part: i64, whole: i64) -> f64 {
    if whole <= 0 {
        0.0
    } else {
        (part as f64 / whole as f64).clamp(0.0, 1.0)
    }
}

fn delta(current: i64, previous: i64, higher_is_better: bool) -> MetricDelta {
    MetricDelta {
        change: change(current as f64, previous as f64),
        higher_is_better,
    }
}

/// Fractional change, with no baseline reading as flat.
///
/// The alternative — treating a jump from zero as infinite growth — renders as
/// a nonsense percentage on the first day of use.
fn change(current: f64, previous: f64) -> f64 {
    if previous.abs() < f64::EPSILON {
        0.0
    } else {
        (current - previous) / previous
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Store;
    use crate::domain::{Actor, CustomerRef, FailedPayment, FailureReason, PaymentMethod};

    fn payment(index: u32, reason: FailureReason, amount_paise: i64, days_ago: f64) -> FailedPayment {
        FailedPayment {
            id: format!("fp_{index:04}"),
            razorpay_payment_id: format!("pay_TEST{index:04}"),
            razorpay_order_id: format!("order_TEST{index:04}"),
            customer: CustomerRef {
                id: format!("cust_{index:04}"),
                name: format!("Customer {index}"),
                email: format!("customer{index}@example.in"),
                phone_masked: "+91 98••• ••21".into(),
                lifetime_value_paise: 12_00_000,
                successful_payments: 4,
            },
            amount_paise,
            method: if index % 2 == 0 {
                PaymentMethod::Upi
            } else {
                PaymentMethod::Card
            },
            card_network: None,
            issuer: Some("HDFC Bank".into()),
            failure_reason: reason,
            gateway_description: "Payment failed".into(),
            failed_at: clock::iso_days_ago(days_ago),
            attempt_count: 1,
            is_subscription: false,
        }
    }

    /// Three ₹2,000 failures in the last three days; one of them recovered.
    fn store_with_history() -> Store {
        let store = Store::in_memory().unwrap();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();

            for index in 1..=3u32 {
                jobs::ingest(
                    &transaction,
                    &payment(index, FailureReason::InsufficientFunds, 2_00_000, index as f64),
                    Actor::engine(),
                )
                .unwrap();
            }

            transaction
                .execute(
                    // No digit separators: SQLite is not Rust.
                    "UPDATE recovery_jobs
                        SET status = 'recovered', recovered_amount_paise = 200000,
                            next_action_at = NULL
                      WHERE id = 'job_0001'",
                    [],
                )
                .unwrap();

            transaction.commit().unwrap();
        }
        store
    }

    #[test]
    fn the_dashboard_adds_up() {
        let store = store_with_history();
        let connection = store.lock().unwrap();

        let metrics = dashboard(&connection, 30).unwrap();

        assert_eq!(metrics.window_days, 30);
        assert_eq!(metrics.recovered_paise, 2_00_000);
        // Two of three still open.
        assert_eq!(metrics.revenue_at_risk_paise, 4_00_000);
        assert_eq!(metrics.active_jobs, 2);
        assert!((metrics.recovery_rate - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn an_empty_store_reports_zeroes_rather_than_failing() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        let metrics = dashboard(&connection, 30).unwrap();
        assert_eq!(metrics.revenue_at_risk_paise, 0);
        assert_eq!(metrics.recovery_rate, 0.0);
        // No baseline must read as flat, not as infinite growth.
        assert_eq!(metrics.deltas.recovered.change, 0.0);
        assert_eq!(metrics.funnel.total_paise, 0);
        assert_eq!(metrics.funnel.segments.len(), FunnelStage::ALL.len());
    }

    #[test]
    fn the_funnel_accounts_for_every_rupee() {
        let store = store_with_history();
        let connection = store.lock().unwrap();

        let metrics = dashboard(&connection, 30).unwrap();
        let summed: i64 = metrics
            .funnel
            .segments
            .iter()
            .map(|segment| segment.amount_paise)
            .sum();

        assert_eq!(summed, metrics.funnel.total_paise);
        assert_eq!(metrics.funnel.total_paise, 6_00_000);
    }

    #[test]
    fn deltas_are_measured_against_the_previous_window() {
        let store = Store::in_memory().unwrap();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            // One failure this week, two the week before.
            jobs::ingest(
                &transaction,
                &payment(1, FailureReason::CardExpired, 1_00_000, 2.0),
                Actor::engine(),
            )
            .unwrap();
            jobs::ingest(
                &transaction,
                &payment(2, FailureReason::CardExpired, 1_00_000, 9.0),
                Actor::engine(),
            )
            .unwrap();
            jobs::ingest(
                &transaction,
                &payment(3, FailureReason::CardExpired, 1_00_000, 10.0),
                Actor::engine(),
            )
            .unwrap();
            transaction.commit().unwrap();
        }

        let connection = store.lock().unwrap();
        let metrics = dashboard(&connection, 7).unwrap();

        assert_eq!(metrics.revenue_at_risk_paise, 1_00_000);
        // Exposure halved, and falling exposure is good news.
        assert!((metrics.deltas.revenue_at_risk.change + 0.5).abs() < 1e-9);
        assert!(!metrics.deltas.revenue_at_risk.higher_is_better);
    }

    #[test]
    fn the_trend_is_zero_filled_and_ordered() {
        let store = store_with_history();
        let connection = store.lock().unwrap();

        let series = trend(&connection, 14).unwrap();
        assert_eq!(series.len(), 14);

        let mut sorted = series.clone();
        sorted.sort_by(|left, right| left.date.cmp(&right.date));
        let dates: Vec<&String> = series.iter().map(|point| &point.date).collect();
        let expected: Vec<&String> = sorted.iter().map(|point| &point.date).collect();
        assert_eq!(dates, expected, "trend points are not in date order");

        assert!(series.iter().any(|point| point.at_risk_paise > 0));
    }

    #[test]
    fn breakdowns_cover_only_what_happened() {
        let store = store_with_history();
        let connection = store.lock().unwrap();

        let reasons = failure_breakdown(&connection, 30).unwrap();
        assert_eq!(reasons.len(), 1);
        assert_eq!(reasons[0].reason, FailureReason::InsufficientFunds);
        assert_eq!(reasons[0].job_count, 3);
        assert_eq!(reasons[0].recovered_paise, 2_00_000);

        let methods = method_breakdown(&connection, 30).unwrap();
        assert_eq!(methods.iter().map(|row| row.job_count).sum::<i64>(), 3);
    }

    #[test]
    fn attempt_buckets_are_always_present() {
        let store = store_with_history();
        let connection = store.lock().unwrap();

        let buckets = attempt_effectiveness(&connection, 30).unwrap();
        assert_eq!(buckets.len(), MAX_ATTEMPT_BUCKET as usize);
        assert_eq!(buckets[0].attempt, 1);
        // No attempts have run yet, so every rate is a real zero.
        assert!(buckets.iter().all(|bucket| bucket.recovery_rate == 0.0));
    }

    /// One millisecond before a `days`-long window opens — i.e. late on the day
    /// before the oldest bar the trend chart draws. Derived from the clock helper
    /// rather than hardcoded so the fixture holds at any hour of the day.
    fn just_before_window(days: u32) -> String {
        let start = clock::parse_iso(&clock::iso_window_start(days)).unwrap();
        clock::to_iso(start - time::Duration::milliseconds(1))
    }

    #[test]
    fn the_kpi_cards_and_the_trend_cover_the_same_window() {
        let store = store_with_history();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            let mut stray = payment(9, FailureReason::DoNotHonour, 5_00_000, 0.0);
            stray.failed_at = just_before_window(7);
            jobs::ingest(&transaction, &stray, Actor::engine()).unwrap();
            transaction.commit().unwrap();
        }

        let connection = store.lock().unwrap();

        for window in [7u32, 14, 30] {
            let metrics = dashboard(&connection, window).unwrap();
            let summed: i64 = trend(&connection, window)
                .unwrap()
                .iter()
                .map(|point| point.at_risk_paise)
                .sum();

            assert_eq!(
                summed, metrics.revenue_at_risk_paise,
                "{window}D: the trend sums to a different number than the KPI card above it"
            );
        }

        // The stray really is outside the short window, so the agreement above is
        // agreement about a boundary rather than a vacuous match.
        assert_eq!(dashboard(&connection, 7).unwrap().revenue_at_risk_paise, 4_00_000);
        assert_eq!(dashboard(&connection, 14).unwrap().revenue_at_risk_paise, 9_00_000);
    }

    #[test]
    fn attempt_effectiveness_counts_the_day_the_attempt_ran() {
        let store = Store::in_memory().unwrap();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            // Failed 20 days ago; the payday retry that recovered it ran yesterday.
            jobs::ingest(
                &transaction,
                &payment(1, FailureReason::InsufficientFunds, 3_00_000, 20.0),
                Actor::engine(),
            )
            .unwrap();
            transaction
                .execute(
                    "INSERT INTO recovery_attempts
                       (id, job_id, sequence, kind, channel, occurred_at, outcome, note)
                     VALUES ('att_0001', 'job_0001', 2, 'retry_on_payday', 'gateway',
                             ?1, 'succeeded', '')",
                    params![clock::iso_days_ago(1.0)],
                )
                .unwrap();
            transaction.commit().unwrap();
        }

        let connection = store.lock().unwrap();
        let buckets = attempt_effectiveness(&connection, 7).unwrap();

        let second = &buckets[1];
        assert_eq!(second.attempt, 2);
        // Judging the retry budget by the failure date hid the late successes
        // that are the whole argument for a second attempt.
        assert_eq!(second.attempted, 1);
        assert_eq!(second.recovered, 1);
        assert_eq!(second.recovery_rate, 1.0);
    }

    #[test]
    fn a_rate_never_divides_by_zero() {
        assert_eq!(ratio(5, 0), 0.0);
        assert_eq!(ratio(0, 0), 0.0);
        assert_eq!(ratio(1, 2), 0.5);
        // Recovering more than was lost would be a data error, not a 300% rate.
        assert_eq!(ratio(300, 100), 1.0);
    }
}
