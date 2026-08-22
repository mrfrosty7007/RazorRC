//! Computed findings for the Copilot screen.
//!
//! These are the "AI insights" the product promises, and they are deliberately
//! not generated text. Each one is an aggregate over the job table, carries the
//! evidence it was derived from, and names the jobs it would act on — so a
//! merchant can check the arithmetic and disagree with the conclusion.
//!
//! Nothing here calls a model, and nothing here invents a number.

use rusqlite::{Connection, OptionalExtension, ToSql};

use crate::clock;
use crate::domain::{Insight, InsightKind, RecoveryActionKind, Signal, SuggestedAction};
use crate::error::EngineResult;

/// Jobs the engine still has a move on. Written once, used by every finding.
const OPEN: &str = "j.status IN ('queued', 'scheduled', 'in_progress', 'awaiting_customer')";

/// Below this, a "cluster" is one unlucky customer rather than a pattern.
const MIN_CLUSTER: usize = 2;

/// A group of open jobs and what they are worth.
struct Cluster {
    job_ids: Vec<String>,
    exposure_paise: i64,
    average_score: f64,
}

impl Cluster {
    fn is_reportable(&self) -> bool {
        self.job_ids.len() >= MIN_CLUSTER && self.exposure_paise > 0
    }

    /// Exposure discounted by how likely the engine thinks recovery is. This is
    /// the number the headline quotes, because quoting raw exposure would
    /// promise money the engine does not expect to get back.
    fn expected_paise(&self) -> i64 {
        (self.exposure_paise as f64 * self.average_score).round() as i64
    }

    fn count(&self) -> i64 {
        self.job_ids.len() as i64
    }
}

pub fn list(connection: &Connection) -> EngineResult<Vec<Insight>> {
    let detected_at = clock::now_iso();
    let mut insights = Vec::new();

    if let Some(insight) = payday_window(connection, &detected_at)? {
        insights.push(insight);
    }
    if let Some(insight) = stale_card_details(connection, &detected_at)? {
        insights.push(insight);
    }
    if let Some(insight) = expiring_soon(connection, &detected_at)? {
        insights.push(insight);
    }
    if let Some(insight) = issuer_concentration(connection, &detected_at)? {
        insights.push(insight);
    }

    // Biggest opportunity first: the screen is read top-down and acted on from
    // the top.
    insights.sort_by(|left, right| right.impact_paise.cmp(&left.impact_paise));
    Ok(insights)
}

/// The highest-yield rule in the engine, surfaced as a batch the merchant can
/// approve in one go.
fn payday_window(connection: &Connection, detected_at: &str) -> EngineResult<Option<Insight>> {
    let cluster = cluster(
        connection,
        "p.failure_reason = 'insufficient_funds'",
        &[],
    )?;

    if !cluster.is_reportable() {
        return Ok(None);
    }

    Ok(Some(Insight {
        id: "insight_payday_window".into(),
        kind: InsightKind::Opportunity,
        headline: format!(
            "{} failures are waiting on payday, not on a fix",
            cluster.count()
        ),
        body: "These payments failed for want of balance rather than for a broken \
               instrument. Re-presenting them into the salary window costs nothing and \
               needs no action from the customer."
            .into(),
        impact_paise: cluster.expected_paise(),
        confidence: cluster.average_score,
        evidence: vec![
            Signal::new(
                "Open insufficient-funds exposure",
                0.4,
                rupees(cluster.exposure_paise),
            ),
            Signal::new(
                "Average recovery score",
                cluster.average_score - 0.5,
                format!("{}% across the group", percent(cluster.average_score)),
            ),
        ],
        suggested_action: Some(SuggestedAction {
            kind: RecoveryActionKind::RetryOnPayday,
            label: "Schedule all for the salary window".into(),
            job_ids: cluster.job_ids,
        }),
        detected_at: detected_at.to_string(),
    }))
}

/// Card problems are the one failure class no retry can fix.
fn stale_card_details(connection: &Connection, detected_at: &str) -> EngineResult<Option<Insight>> {
    let cluster = cluster(
        connection,
        "p.failure_reason IN ('card_expired', 'invalid_card')",
        &[],
    )?;

    if !cluster.is_reportable() {
        return Ok(None);
    }

    Ok(Some(Insight {
        id: "insight_stale_cards".into(),
        kind: InsightKind::Risk,
        headline: format!("{} customers need to update a card", cluster.count()),
        body: "Retrying these spends gateway fees on a card that cannot succeed. The \
               only move that recovers this money is asking the customer for new \
               details, and the sooner it is asked the better it converts."
            .into(),
        impact_paise: cluster.expected_paise(),
        confidence: cluster.average_score,
        evidence: vec![
            Signal::new(
                "Exposure behind dead cards",
                0.35,
                rupees(cluster.exposure_paise),
            ),
            Signal::new(
                "Retries cannot clear these",
                -0.3,
                "An expired or invalid card fails identically on every attempt",
            ),
        ],
        suggested_action: Some(SuggestedAction {
            kind: RecoveryActionKind::RequestCardUpdate,
            label: "Send card-update requests".into(),
            job_ids: cluster.job_ids,
        }),
        detected_at: detected_at.to_string(),
    }))
}

/// Recovery windows close quietly. This is the finding that makes them loud.
fn expiring_soon(connection: &Connection, detected_at: &str) -> EngineResult<Option<Insight>> {
    let cutoff = clock::iso_minutes_from_now(24 * 60);
    let cluster = cluster(connection, "j.sla_expires_at <= ?1", &[&cutoff])?;

    if !cluster.is_reportable() {
        return Ok(None);
    }

    Ok(Some(Insight {
        id: "insight_sla_expiring".into(),
        kind: InsightKind::Anomaly,
        headline: format!(
            "{} recoveries lapse within a day",
            cluster.count()
        ),
        body: "Once the window closes these are written off, whatever the score says. \
               Anything worth chasing needs to move now."
            .into(),
        impact_paise: cluster.expected_paise(),
        confidence: cluster.average_score,
        evidence: vec![
            Signal::new("Exposure at the deadline", 0.3, rupees(cluster.exposure_paise)),
            Signal::new("Window closes", -0.25, "Within the next 24 hours".to_string()),
        ],
        suggested_action: Some(SuggestedAction {
            kind: RecoveryActionKind::HumanReview,
            label: "Review before the window closes".into(),
            job_ids: cluster.job_ids,
        }),
        detected_at: detected_at.to_string(),
    }))
}

/// A single issuer dominating the failures is an outage, not a customer problem —
/// and outages are worth waiting out rather than retrying into.
fn issuer_concentration(
    connection: &Connection,
    detected_at: &str,
) -> EngineResult<Option<Insight>> {
    let total = cluster(connection, "1 = 1", &[])?;
    if total.exposure_paise == 0 {
        return Ok(None);
    }

    let worst: Option<(String, i64, i64)> = connection
        .query_row(
            &format!(
                "SELECT IFNULL(p.issuer, 'Unknown'), SUM(p.amount_paise), COUNT(*)
                   FROM recovery_jobs j
                   JOIN failed_payments p ON p.id = j.payment_id
                  WHERE {OPEN} AND p.issuer IS NOT NULL
                  GROUP BY p.issuer
                  ORDER BY 2 DESC
                  LIMIT 1"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        // No issuers on the open jobs is an empty result, not a failure; a real
        // query error still propagates.
        .optional()?;

    let Some((issuer, exposure_paise, job_count)) = worst else {
        return Ok(None);
    };

    let share = exposure_paise as f64 / total.exposure_paise as f64;
    if job_count < MIN_CLUSTER as i64 || share < 0.4 {
        return Ok(None);
    }

    Ok(Some(Insight {
        id: "insight_issuer_concentration".into(),
        kind: InsightKind::Anomaly,
        headline: format!("{issuer} accounts for {}% of open exposure", percent(share)),
        body: "Failures this concentrated on one issuer usually mean a problem on their \
               side rather than on the customers'. Spacing retries out until it clears \
               recovers more than hammering the same rail."
            .into(),
        impact_paise: exposure_paise,
        confidence: share.clamp(0.0, 0.95),
        evidence: vec![
            Signal::new("Exposure on this issuer", 0.3, rupees(exposure_paise)),
            Signal::new(
                "Share of all open exposure",
                share - 0.5,
                format!("{job_count} of the open jobs"),
            ),
        ],
        suggested_action: None,
        detected_at: detected_at.to_string(),
    }))
}

/// Runs one aggregate over the open jobs matching `predicate`.
///
/// `predicate` is always a literal from this file; anything variable is bound
/// through `args`.
fn cluster(
    connection: &Connection,
    predicate: &str,
    args: &[&dyn ToSql],
) -> EngineResult<Cluster> {
    let sql = format!(
        "SELECT j.id, p.amount_paise, j.recovery_score
           FROM recovery_jobs j
           JOIN failed_payments p ON p.id = j.payment_id
          WHERE {OPEN} AND {predicate}
          ORDER BY p.amount_paise DESC"
    );

    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(args)?;

    let mut job_ids = Vec::new();
    let mut exposure_paise = 0i64;
    let mut score_total = 0.0;

    while let Some(row) = rows.next()? {
        job_ids.push(row.get::<_, String>(0)?);
        exposure_paise += row.get::<_, i64>(1)?;
        score_total += row.get::<_, f64>(2)?;
    }

    let average_score = if job_ids.is_empty() {
        0.0
    } else {
        score_total / job_ids.len() as f64
    };

    Ok(Cluster {
        job_ids,
        exposure_paise,
        average_score,
    })
}

/// `₹1,20,450` — Indian digit grouping, because this string is read by a
/// merchant in Mumbai, not by a formatter in the browser.
fn rupees(paise: i64) -> String {
    let rupees = paise / 100;
    let digits = rupees.abs().to_string();
    let bytes = digits.as_bytes();

    let mut grouped = String::new();
    if bytes.len() <= 3 {
        grouped.push_str(&digits);
    } else {
        // Last three digits, then pairs.
        let head = &digits[..bytes.len() - 3];
        let tail = &digits[bytes.len() - 3..];

        let mut pairs: Vec<String> = Vec::new();
        let head_bytes = head.as_bytes();
        let mut index = head_bytes.len();
        while index > 2 {
            pairs.push(head[index - 2..index].to_string());
            index -= 2;
        }
        pairs.push(head[..index].to_string());
        pairs.reverse();

        grouped.push_str(&pairs.join(","));
        grouped.push(',');
        grouped.push_str(tail);
    }

    format!("₹{}{grouped}", if rupees < 0 { "-" } else { "" })
}

fn percent(fraction: f64) -> i64 {
    (fraction * 100.0).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{jobs, Store};
    use crate::domain::{Actor, CustomerRef, FailedPayment, FailureReason, PaymentMethod};

    fn payment(index: u32, reason: FailureReason, amount_paise: i64) -> FailedPayment {
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
                successful_payments: 6,
            },
            amount_paise,
            method: PaymentMethod::Card,
            card_network: Some("VISA".into()),
            issuer: Some("HDFC Bank".into()),
            failure_reason: reason,
            gateway_description: "Payment failed".into(),
            failed_at: clock::iso_days_ago(1.0),
            attempt_count: 1,
            is_subscription: false,
        }
    }

    fn store_with(payments: &[FailedPayment]) -> Store {
        let store = Store::in_memory().unwrap();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            for entry in payments {
                jobs::ingest(&transaction, entry, Actor::engine()).unwrap();
            }
            transaction.commit().unwrap();
        }
        store
    }

    #[test]
    fn an_empty_store_produces_no_findings() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();
        assert!(list(&connection).unwrap().is_empty());
    }

    #[test]
    fn one_failure_is_not_a_pattern() {
        let store = store_with(&[payment(1, FailureReason::InsufficientFunds, 2_00_000)]);
        let connection = store.lock().unwrap();

        let found = list(&connection).unwrap();
        assert!(
            !found.iter().any(|insight| insight.id == "insight_payday_window"),
            "a single job was reported as a cluster"
        );
    }

    #[test]
    fn a_payday_cluster_names_the_jobs_it_would_act_on() {
        let store = store_with(&[
            payment(1, FailureReason::InsufficientFunds, 2_00_000),
            payment(2, FailureReason::InsufficientFunds, 3_00_000),
            payment(3, FailureReason::InsufficientFunds, 1_00_000),
        ]);
        let connection = store.lock().unwrap();

        let found = list(&connection).unwrap();
        let payday = found
            .iter()
            .find(|insight| insight.id == "insight_payday_window")
            .expect("no payday insight");

        assert_eq!(payday.kind, InsightKind::Opportunity);
        assert!(!payday.evidence.is_empty(), "a finding with no evidence");

        let action = payday.suggested_action.as_ref().unwrap();
        assert_eq!(action.kind, RecoveryActionKind::RetryOnPayday);
        assert_eq!(action.job_ids.len(), 3);

        // Impact is discounted by the score, so it can never exceed exposure.
        assert!(payday.impact_paise > 0);
        assert!(payday.impact_paise < 6_00_000);
    }

    #[test]
    fn card_failures_are_reported_as_a_risk_not_an_opportunity() {
        let store = store_with(&[
            payment(1, FailureReason::CardExpired, 4_00_000),
            payment(2, FailureReason::InvalidCard, 4_00_000),
        ]);
        let connection = store.lock().unwrap();

        let found = list(&connection).unwrap();
        let cards = found
            .iter()
            .find(|insight| insight.id == "insight_stale_cards")
            .expect("no card insight");

        assert_eq!(cards.kind, InsightKind::Risk);
        assert_eq!(
            cards.suggested_action.as_ref().unwrap().kind,
            RecoveryActionKind::RequestCardUpdate
        );
    }

    #[test]
    fn findings_are_ordered_by_what_they_are_worth() {
        let store = store_with(&[
            payment(1, FailureReason::InsufficientFunds, 9_00_000),
            payment(2, FailureReason::InsufficientFunds, 9_00_000),
            payment(3, FailureReason::CardExpired, 1_00_000),
            payment(4, FailureReason::InvalidCard, 1_00_000),
        ]);
        let connection = store.lock().unwrap();

        let found = list(&connection).unwrap();
        assert!(found.len() >= 2);
        for pair in found.windows(2) {
            assert!(
                pair[0].impact_paise >= pair[1].impact_paise,
                "findings are not ordered by impact"
            );
        }
    }

    #[test]
    fn rupees_use_indian_digit_grouping() {
        assert_eq!(rupees(0), "₹0");
        assert_eq!(rupees(99_900), "₹999");
        assert_eq!(rupees(1_20_000), "₹1,200");
        assert_eq!(rupees(12_34_56_700), "₹12,34,567");
        assert_eq!(rupees(-1_00_00_000), "₹-1,00,000");
    }
}
