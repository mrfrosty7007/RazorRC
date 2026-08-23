//! Deterministic scoring and action selection — the authoritative implementation.
//!
//! `src/data/seed/rulesEngine.ts` is a mirror of this file, kept so the React
//! app has real, explainable recommendations while running in a browser tab.
//! When the two disagree, this one is right. The tests at the bottom are the
//! shared contract: they encode the same table the TypeScript mirror follows.
//!
//! Two properties matter more than the exact numbers:
//!
//! 1. **No randomness.** Same payment in, same recommendation out, forever. A
//!    merchant who reruns a decision must see the decision they saw before.
//! 2. **Every score carries its evidence.** `Scored::signals` is what the UI
//!    renders under "Why this action". A weight that isn't shown to the user is
//!    a weight nobody can argue with, which is how a recovery tool turns into a
//!    black box that quietly loses money.

use time::OffsetDateTime;

use crate::clock;
use crate::domain::{
    Channel, FailedPayment, FailureReason, PaymentMethod, RecoveryAction, RecoveryActionKind,
    RiskTier, Signal,
};
use crate::error::EngineResult;

/// ₹25,000. Above this, retries clear noticeably less often.
const HIGH_TICKET_PAISE: f64 = 25_00_000.0;
/// ₹50,000. Above this and with a poor score, a human should look.
const CRITICAL_TICKET_PAISE: f64 = 50_00_000.0;
/// ₹5,000. The floor for "worth a person's attention if it goes wrong".
const MEDIUM_TICKET_PAISE: f64 = 5_00_000.0;

/// Scores are never allowed to reach certainty in either direction.
const SCORE_FLOOR: f64 = 0.05;
const SCORE_CEILING: f64 = 0.95;
const CONFIDENCE_CEILING: f64 = 0.97;

/// Historical recovery rate per failure reason: the prior the score starts from.
///
/// These are the numbers to revisit first once real outcome data accumulates —
/// they are the only inputs in this file that are empirical rather than logical.
pub const fn base_score(reason: FailureReason) -> f64 {
    match reason {
        FailureReason::GatewayTimeout => 0.81,
        FailureReason::BankDowntime => 0.78,
        FailureReason::AuthenticationTimeout => 0.71,
        FailureReason::UpiCollectExpired => 0.66,
        FailureReason::InsufficientFunds => 0.62,
        FailureReason::DoNotHonour => 0.55,
        FailureReason::LimitExceeded => 0.48,
        FailureReason::CardExpired => 0.34,
        FailureReason::InvalidCard => 0.22,
        FailureReason::MandateRevoked => 0.18,
    }
}

/// A score together with the reasoning that produced it.
#[derive(Debug, Clone)]
pub struct Scored {
    /// Modelled probability this money comes back, 0.05..0.95.
    pub score: f64,
    /// Ordered as the UI lists them: the baseline first, then adjustments.
    pub signals: Vec<Signal>,
    pub risk_tier: RiskTier,
}

pub fn score_payment(payment: &FailedPayment) -> Scored {
    let base = base_score(payment.failure_reason);

    let mut signals = vec![Signal::new(
        "Failure reason baseline",
        base - 0.5,
        format!(
            "{}% of these recover historically",
            (base * 100.0).round() as i64
        ),
    )];

    let mut score = base;

    if payment.customer.successful_payments >= 5 {
        score += 0.08;
        signals.push(Signal::new(
            "Established payer",
            0.08,
            format!(
                "{} successful payments before this",
                payment.customer.successful_payments
            ),
        ));
    } else if payment.customer.successful_payments == 0 {
        score -= 0.06;
        signals.push(Signal::new(
            "First payment",
            -0.06,
            "No payment history to lean on",
        ));
    }

    if payment.attempt_count >= 3 {
        score -= 0.12;
        signals.push(Signal::new(
            "Retry fatigue",
            -0.12,
            format!("Already attempted {} times", payment.attempt_count),
        ));
    }

    if payment.amount_paise as f64 >= HIGH_TICKET_PAISE {
        score -= 0.05;
        signals.push(Signal::new(
            "High ticket",
            -0.05,
            "Large amounts clear less often on retry",
        ));
    }

    if payment.is_subscription {
        score += 0.05;
        signals.push(Signal::new(
            "Mandate on file",
            0.05,
            "Can be re-presented without customer action",
        ));
    }

    if payment.method == PaymentMethod::Upi {
        score += 0.03;
        signals.push(Signal::new(
            "UPI rail",
            0.03,
            "UPI re-collects settle faster than card retries",
        ));
    }

    let score = score.clamp(SCORE_FLOOR, SCORE_CEILING);

    Scored {
        score,
        signals,
        risk_tier: tier_for(payment, score),
    }
}

/// Risk is about exposure, not probability alone: a ₹90,000 failure with a
/// mediocre score deserves a person, a ₹300 failure with the same score does not.
///
/// Lifetime value is divided by twelve to put it on the same footing as a single
/// month's exposure, so a high-LTV subscriber with a small monthly charge still
/// tiers above a one-off buyer of the same amount.
fn tier_for(payment: &FailedPayment, score: f64) -> RiskTier {
    let monthly_ltv = payment.customer.lifetime_value_paise as f64 / 12.0;
    let value = (payment.amount_paise as f64).max(monthly_ltv);

    if value >= CRITICAL_TICKET_PAISE && score < 0.5 {
        RiskTier::Critical
    } else if value >= HIGH_TICKET_PAISE || score < 0.35 {
        RiskTier::High
    } else if value >= MEDIUM_TICKET_PAISE {
        RiskTier::Medium
    } else {
        RiskTier::Low
    }
}

/// The channel each action goes out on. Retries never touch the customer.
pub const fn channel_for(kind: RecoveryActionKind) -> Channel {
    match kind {
        RecoveryActionKind::AutoRetry
        | RecoveryActionKind::RetryOnPayday
        | RecoveryActionKind::RetryAfterDowntime => Channel::Gateway,
        RecoveryActionKind::SwitchToUpi
        | RecoveryActionKind::SendPaymentLink
        | RecoveryActionKind::DunningWhatsapp => Channel::Whatsapp,
        RecoveryActionKind::RequestCardUpdate | RecoveryActionKind::DunningEmail => Channel::Email,
        RecoveryActionKind::HumanReview => Channel::InApp,
    }
}

/// Silent re-presentation is more reliable than anything that needs a human, so
/// the score is discounted by how much cooperation the action depends on.
pub const fn confidence_factor(kind: RecoveryActionKind) -> f64 {
    match kind {
        RecoveryActionKind::AutoRetry
        | RecoveryActionKind::RetryAfterDowntime
        | RecoveryActionKind::RetryOnPayday => 1.0,
        RecoveryActionKind::SendPaymentLink | RecoveryActionKind::SwitchToUpi => 0.9,
        RecoveryActionKind::RequestCardUpdate
        | RecoveryActionKind::DunningEmail
        | RecoveryActionKind::DunningWhatsapp => 0.75,
        RecoveryActionKind::HumanReview => 0.5,
    }
}

/// What the engine intends to do, before confidence and evidence are attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub kind: RecoveryActionKind,
    pub delay_minutes: i64,
    pub label: String,
}

/// Action selection, ordered by how much customer effort it costs: re-present
/// silently where we can, ask the customer only when we must, hand to a human
/// when the engine has no good move.
pub fn decide(payment: &FailedPayment) -> EngineResult<Decision> {
    let decision = match payment.failure_reason {
        FailureReason::GatewayTimeout => Decision {
            kind: RecoveryActionKind::AutoRetry,
            delay_minutes: 15,
            label: "Retry charge in 15 min".to_string(),
        },

        FailureReason::BankDowntime => Decision {
            kind: RecoveryActionKind::RetryAfterDowntime,
            delay_minutes: 90,
            label: "Retry once issuer recovers".to_string(),
        },

        FailureReason::AuthenticationTimeout => Decision {
            kind: RecoveryActionKind::SendPaymentLink,
            delay_minutes: 5,
            label: "Send a fresh payment link".to_string(),
        },

        FailureReason::UpiCollectExpired => Decision {
            kind: RecoveryActionKind::SendPaymentLink,
            delay_minutes: 30,
            label: "Send a new UPI request".to_string(),
        },

        FailureReason::InsufficientFunds => {
            let failed_at = clock::parse_iso(&payment.failed_at)?;
            let (delay_minutes, target) = payday_plan(failed_at)?;
            Decision {
                kind: RecoveryActionKind::RetryOnPayday,
                delay_minutes,
                label: format!("Retry on {}", clock::day_month_label(target)),
            }
        }

        FailureReason::DoNotHonour => {
            if payment.attempt_count < 2 {
                Decision {
                    kind: RecoveryActionKind::AutoRetry,
                    delay_minutes: 240,
                    label: "Retry charge in 4 hours".to_string(),
                }
            } else {
                Decision {
                    kind: RecoveryActionKind::SwitchToUpi,
                    delay_minutes: 0,
                    label: "Offer UPI instead".to_string(),
                }
            }
        }

        FailureReason::LimitExceeded => Decision {
            kind: RecoveryActionKind::AutoRetry,
            delay_minutes: 1_440,
            label: "Retry charge tomorrow".to_string(),
        },

        FailureReason::CardExpired => Decision {
            kind: RecoveryActionKind::RequestCardUpdate,
            delay_minutes: 0,
            label: "Request new card details".to_string(),
        },

        FailureReason::InvalidCard => {
            if payment.is_subscription {
                Decision {
                    kind: RecoveryActionKind::RequestCardUpdate,
                    delay_minutes: 0,
                    label: "Request new card details".to_string(),
                }
            } else {
                Decision {
                    kind: RecoveryActionKind::SendPaymentLink,
                    delay_minutes: 0,
                    label: "Send a fresh payment link".to_string(),
                }
            }
        }

        FailureReason::MandateRevoked => Decision {
            kind: RecoveryActionKind::HumanReview,
            delay_minutes: 0,
            label: "Needs a human decision".to_string(),
        },
    };

    Ok(decision)
}

pub fn select_action(payment: &FailedPayment, scored: &Scored) -> EngineResult<RecoveryAction> {
    let decision = decide(payment)?;
    let confidence =
        (scored.score * confidence_factor(decision.kind)).clamp(SCORE_FLOOR, CONFIDENCE_CEILING);

    Ok(RecoveryAction {
        kind: decision.kind,
        label: decision.label,
        channel: channel_for(decision.kind),
        confidence,
        signals: scored.signals.clone(),
        delay_minutes: decision.delay_minutes,
    })
}

/// Score and choose in one call. This is what ingest uses.
pub fn evaluate(payment: &FailedPayment) -> EngineResult<(Scored, RecoveryAction)> {
    let scored = score_payment(payment);
    let action = select_action(payment, &scored)?;
    Ok((scored, action))
}

const DAY: i64 = 24 * 60;
const WEEK: i64 = 7 * DAY;

/// How long the recovery window stays open, in minutes from the failure.
///
/// Not part of the TypeScript mirror — the seeded fixtures carry an SLA per job
/// instead — because it is an ingest concern rather than a scoring one. The
/// policy is that the window reflects who has to act: downtime resolves itself
/// within a day or it was not downtime, an abandoned checkout goes cold in two,
/// and anything needing the customer to find their card needs a week.
pub fn sla_minutes(payment: &FailedPayment, action: &RecoveryAction) -> i64 {
    let window = match payment.failure_reason {
        FailureReason::GatewayTimeout | FailureReason::BankDowntime => DAY,

        FailureReason::AuthenticationTimeout | FailureReason::UpiCollectExpired => 2 * DAY,

        FailureReason::DoNotHonour
        | FailureReason::LimitExceeded
        | FailureReason::InsufficientFunds => 3 * DAY,

        FailureReason::CardExpired | FailureReason::InvalidCard => WEEK,

        // A revoked mandate is a conversation, not a retry.
        FailureReason::MandateRevoked => 2 * WEEK,
    };

    // A mandate on file means there is always a next cycle to land in.
    let window = if payment.is_subscription {
        window.max(WEEK)
    } else {
        window
    };

    // A job must outlive its own first action — but only an action scheduled
    // *outside* the window needs that help. A payday retry can legitimately be
    // four weeks out, and without this it would be born past its SLA and show
    // on the dashboard as expired before it had ever been tried.
    //
    // Applying the grace period unconditionally was a bug: a 90-minute downtime
    // retry stretched the one-day window to 1,530 minutes, which meant the
    // per-reason policy above was never the number it claimed to be.
    if action.delay_minutes >= window {
        action.delay_minutes + DAY
    } else {
        window
    }
}

/// Salary credits in India cluster on the 1st and, for many employers, the last
/// working day of the month. Re-presenting insufficient-funds failures into that
/// window is the single highest-yield rule in the engine, which is why it gets
/// real date arithmetic instead of a flat 24-hour delay.
///
/// Returns the delay in minutes and the instant the retry lands on, so the
/// action label and the schedule can never disagree.
fn payday_plan(failed_at: OffsetDateTime) -> EngineResult<(i64, OffsetDateTime)> {
    let day = failed_at.day();

    // Failures in the first two days of the month are already inside the
    // window; wait for tomorrow rather than a whole month.
    let payday = if day <= 2 {
        clock::same_month_day_at_0630(failed_at, day + 1)?
    } else {
        clock::first_of_next_month_at_0630(failed_at)?
    };

    // Never fire immediately, even if payday has technically already passed.
    let delay_minutes = clock::minutes_between(failed_at, payday).max(60);

    Ok((delay_minutes, clock::plus_minutes(failed_at, delay_minutes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::CustomerRef;

    fn customer(successful_payments: i64, lifetime_value_paise: i64) -> CustomerRef {
        CustomerRef {
            id: "cust_TEST".into(),
            name: "Meera Iyer".into(),
            email: "meera.iyer@example.in".into(),
            phone_masked: "+91 98••• ••21".into(),
            lifetime_value_paise,
            successful_payments,
        }
    }

    /// A ₹1,200 first-time card failure. Every test tweaks one field of this.
    fn payment(reason: FailureReason) -> FailedPayment {
        FailedPayment {
            id: "job_TEST".into(),
            razorpay_payment_id: "pay_TEST".into(),
            razorpay_order_id: "order_TEST".into(),
            customer: customer(2, 24_00_000),
            amount_paise: 1_20_000,
            method: PaymentMethod::Card,
            card_network: Some("VISA".into()),
            issuer: Some("HDFC Bank".into()),
            failure_reason: reason,
            gateway_description: "Payment failed".into(),
            failed_at: "2026-08-22T11:40:00.000Z".into(),
            attempt_count: 1,
            is_subscription: false,
        }
    }

    #[test]
    fn score_starts_from_the_reason_baseline() {
        let scored = score_payment(&payment(FailureReason::GatewayTimeout));
        assert!((scored.score - 0.81).abs() < 1e-9);

        let baseline = &scored.signals[0];
        assert_eq!(baseline.label, "Failure reason baseline");
        assert_eq!(baseline.detail, "81% of these recover historically");
        // The baseline signal is expressed relative to a coin flip.
        assert!((baseline.weight - 0.31).abs() < 1e-9);
    }

    #[test]
    fn every_reason_produces_at_least_one_signal() {
        // An unexplained recommendation is worse than no recommendation.
        for reason in FailureReason::ALL {
            let scored = score_payment(&payment(*reason));
            assert!(!scored.signals.is_empty(), "{reason} produced no evidence");
        }
    }

    #[test]
    fn established_payers_score_higher_than_first_timers() {
        let mut established = payment(FailureReason::InsufficientFunds);
        established.customer = customer(9, 24_00_000);

        let mut first_timer = payment(FailureReason::InsufficientFunds);
        first_timer.customer = customer(0, 24_00_000);

        let established = score_payment(&established);
        let first_timer = score_payment(&first_timer);

        assert!((established.score - 0.70).abs() < 1e-9);
        assert!((first_timer.score - 0.56).abs() < 1e-9);
        assert!(established
            .signals
            .iter()
            .any(|signal| signal.label == "Established payer"));
        assert!(first_timer
            .signals
            .iter()
            .any(|signal| signal.label == "First payment" && signal.weight < 0.0));
    }

    #[test]
    fn retry_fatigue_only_applies_from_the_third_attempt() {
        let has_fatigue = |attempts: i64| {
            let mut subject = payment(FailureReason::DoNotHonour);
            subject.attempt_count = attempts;
            score_payment(&subject)
                .signals
                .iter()
                .any(|signal| signal.label == "Retry fatigue")
        };

        assert!(!has_fatigue(1));
        assert!(!has_fatigue(2));
        assert!(has_fatigue(3));
        assert!(has_fatigue(4));
    }

    #[test]
    fn scores_never_reach_certainty() {
        let mut best = payment(FailureReason::GatewayTimeout);
        best.customer = customer(40, 10_00_000);
        best.method = PaymentMethod::Upi;
        best.is_subscription = true;
        assert!(score_payment(&best).score <= SCORE_CEILING);

        let mut worst = payment(FailureReason::MandateRevoked);
        worst.customer = customer(0, 0);
        worst.attempt_count = 4;
        worst.amount_paise = 90_00_000;
        assert!(score_payment(&worst).score >= SCORE_FLOOR);
    }

    #[test]
    fn tiering_weighs_exposure_not_just_probability() {
        // Small amount, poor score: high, because the score alone is alarming.
        let mut small = payment(FailureReason::MandateRevoked);
        small.amount_paise = 29_900;
        small.customer = customer(1, 1_00_000);
        assert_eq!(score_payment(&small).risk_tier, RiskTier::High);

        // Large amount, poor score: critical, because a person should decide.
        let mut large = payment(FailureReason::InvalidCard);
        large.amount_paise = 75_00_000;
        assert_eq!(score_payment(&large).risk_tier, RiskTier::Critical);

        // Large amount, good score: high, but the engine can handle it.
        let mut confident = payment(FailureReason::GatewayTimeout);
        confident.amount_paise = 75_00_000;
        assert_eq!(score_payment(&confident).risk_tier, RiskTier::High);

        // Everyday amount, healthy score: low.
        let mut ordinary = payment(FailureReason::GatewayTimeout);
        ordinary.amount_paise = 45_000;
        ordinary.customer = customer(3, 6_00_000);
        assert_eq!(score_payment(&ordinary).risk_tier, RiskTier::Low);
    }

    #[test]
    fn a_valuable_subscriber_outranks_their_small_monthly_charge() {
        // ₹499/month, but ₹3,60,000 of lifetime value: ₹30,000 monthly exposure.
        let mut subject = payment(FailureReason::GatewayTimeout);
        subject.amount_paise = 49_900;
        subject.customer = customer(24, 3_60_00_000);
        assert_eq!(score_payment(&subject).risk_tier, RiskTier::High);
    }

    #[test]
    fn action_table_matches_the_typescript_mirror() {
        let cases: &[(FailureReason, RecoveryActionKind, i64)] = &[
            (
                FailureReason::GatewayTimeout,
                RecoveryActionKind::AutoRetry,
                15,
            ),
            (
                FailureReason::BankDowntime,
                RecoveryActionKind::RetryAfterDowntime,
                90,
            ),
            (
                FailureReason::AuthenticationTimeout,
                RecoveryActionKind::SendPaymentLink,
                5,
            ),
            (
                FailureReason::UpiCollectExpired,
                RecoveryActionKind::SendPaymentLink,
                30,
            ),
            (
                FailureReason::DoNotHonour,
                RecoveryActionKind::AutoRetry,
                240,
            ),
            (
                FailureReason::LimitExceeded,
                RecoveryActionKind::AutoRetry,
                1_440,
            ),
            (
                FailureReason::CardExpired,
                RecoveryActionKind::RequestCardUpdate,
                0,
            ),
            (
                FailureReason::InvalidCard,
                RecoveryActionKind::SendPaymentLink,
                0,
            ),
            (
                FailureReason::MandateRevoked,
                RecoveryActionKind::HumanReview,
                0,
            ),
        ];

        for (reason, expected_kind, expected_delay) in cases {
            let decision = decide(&payment(*reason)).unwrap();
            assert_eq!(decision.kind, *expected_kind, "wrong action for {reason}");
            assert_eq!(
                decision.delay_minutes, *expected_delay,
                "wrong delay for {reason}"
            );
            assert!(!decision.label.is_empty(), "{reason} produced no label");
        }
    }

    #[test]
    fn every_reason_yields_a_decision() {
        for reason in FailureReason::ALL {
            assert!(decide(&payment(*reason)).is_ok(), "{reason} had no decision");
        }
    }

    #[test]
    fn repeated_do_not_honour_stops_retrying_and_switches_rail() {
        let mut third_attempt = payment(FailureReason::DoNotHonour);
        third_attempt.attempt_count = 2;

        let decision = decide(&third_attempt).unwrap();
        assert_eq!(decision.kind, RecoveryActionKind::SwitchToUpi);
        assert_eq!(decision.delay_minutes, 0);
    }

    #[test]
    fn an_invalid_card_on_a_mandate_asks_for_a_new_card() {
        let mut mandate = payment(FailureReason::InvalidCard);
        mandate.is_subscription = true;
        assert_eq!(
            decide(&mandate).unwrap().kind,
            RecoveryActionKind::RequestCardUpdate
        );
    }

    #[test]
    fn payday_retries_land_on_the_first_at_0630() {
        let subject = payment(FailureReason::InsufficientFunds);
        let decision = decide(&subject).unwrap();

        assert_eq!(decision.kind, RecoveryActionKind::RetryOnPayday);
        assert_eq!(decision.label, "Retry on 1 Sep");

        let failed_at = clock::parse_iso(&subject.failed_at).unwrap();
        let fires_at = clock::plus_minutes(failed_at, decision.delay_minutes);
        assert_eq!(clock::to_iso(fires_at), "2026-09-01T06:30:00.000Z");
    }

    #[test]
    fn payday_retries_cross_the_year_boundary() {
        let mut december = payment(FailureReason::InsufficientFunds);
        december.failed_at = "2026-12-27T19:00:00.000Z".into();

        let decision = decide(&december).unwrap();
        assert_eq!(decision.label, "Retry on 1 Jan");
    }

    #[test]
    fn a_failure_inside_the_payday_window_waits_a_day_not_a_month() {
        let mut first_of_month = payment(FailureReason::InsufficientFunds);
        first_of_month.failed_at = "2026-09-01T02:00:00.000Z".into();

        let decision = decide(&first_of_month).unwrap();
        assert_eq!(decision.label, "Retry on 2 Sep");
        // 02:00 on the 1st to 06:30 on the 2nd.
        assert_eq!(decision.delay_minutes, 28 * 60 + 30);
    }

    #[test]
    fn payday_always_lands_at_0630_and_never_inside_the_hour() {
        // Walked across a whole month because the two branches of the rule meet
        // at the 2nd, and February/December are where date arithmetic breaks.
        for day in 1..=28 {
            for month in ["02", "09", "12"] {
                let mut subject = payment(FailureReason::InsufficientFunds);
                subject.failed_at = format!("2026-{month}-{day:02}T13:05:00.000Z");

                let decision = decide(&subject).unwrap();
                let failed_at = clock::parse_iso(&subject.failed_at).unwrap();
                let fires_at = clock::to_iso(clock::plus_minutes(failed_at, decision.delay_minutes));

                assert!(
                    decision.delay_minutes >= 60,
                    "{} scheduled inside the hour",
                    subject.failed_at
                );
                assert!(
                    fires_at.ends_with("T06:30:00.000Z"),
                    "{} fires at {fires_at}, outside the salary window",
                    subject.failed_at
                );
            }
        }
    }

    #[test]
    fn confidence_is_discounted_by_how_much_the_customer_must_do() {
        let mut retryable = payment(FailureReason::GatewayTimeout);
        retryable.customer = customer(2, 24_00_000);
        let (scored, action) = evaluate(&retryable).unwrap();
        // A silent retry is worth the full score.
        assert!((action.confidence - scored.score).abs() < 1e-9);

        let needs_human = payment(FailureReason::MandateRevoked);
        let (scored, action) = evaluate(&needs_human).unwrap();
        assert!((action.confidence - scored.score * 0.5).abs() < 1e-9);
    }

    #[test]
    fn actions_carry_their_evidence_and_a_channel() {
        for reason in FailureReason::ALL {
            let (_, action) = evaluate(&payment(*reason)).unwrap();
            assert!(
                !action.signals.is_empty(),
                "{reason} recommended an action with no evidence"
            );
            assert_eq!(action.channel, channel_for(action.kind));
            assert!(action.confidence > 0.0 && action.confidence <= CONFIDENCE_CEILING);
        }
    }

    #[test]
    fn retries_never_contact_the_customer() {
        for kind in [
            RecoveryActionKind::AutoRetry,
            RecoveryActionKind::RetryOnPayday,
            RecoveryActionKind::RetryAfterDowntime,
        ] {
            assert_eq!(channel_for(kind), Channel::Gateway);
        }
    }

    #[test]
    fn evaluation_is_deterministic() {
        let subject = payment(FailureReason::InsufficientFunds);
        let first = evaluate(&subject).unwrap();
        let second = evaluate(&subject).unwrap();

        assert_eq!(first.0.score, second.0.score);
        assert_eq!(first.1.label, second.1.label);
        assert_eq!(first.1.delay_minutes, second.1.delay_minutes);
        assert_eq!(first.1.confidence, second.1.confidence);
    }

    #[test]
    fn no_job_is_born_past_its_own_sla() {
        // The payday rule can schedule four weeks out, so this is the case where
        // a fixed window per reason would produce an already-expired job.
        for reason in FailureReason::ALL {
            for day in [1, 3, 27] {
                let mut subject = payment(*reason);
                subject.failed_at = format!("2026-08-{day:02}T13:05:00.000Z");

                let (_, action) = evaluate(&subject).unwrap();
                let sla = sla_minutes(&subject, &action);

                assert!(
                    sla > action.delay_minutes,
                    "{reason} on the {day}th expires at {sla} min but acts at {} min",
                    action.delay_minutes
                );
            }
        }
    }

    #[test]
    fn the_recovery_window_reflects_who_has_to_act() {
        let downtime = payment(FailureReason::BankDowntime);
        let (_, action) = evaluate(&downtime).unwrap();
        assert_eq!(sla_minutes(&downtime, &action), DAY);

        // Finding a new card takes a person days, not hours.
        let expired = payment(FailureReason::CardExpired);
        let (_, action) = evaluate(&expired).unwrap();
        assert_eq!(sla_minutes(&expired, &action), WEEK);

        // A mandate on file widens even the shortest window.
        let mut subscription = payment(FailureReason::BankDowntime);
        subscription.is_subscription = true;
        let (_, action) = evaluate(&subscription).unwrap();
        assert_eq!(sla_minutes(&subscription, &action), WEEK);
    }

    #[test]
    fn only_an_action_scheduled_past_the_window_extends_it() {
        // A downtime retry fires 90 minutes in, well inside its one-day window,
        // so the SLA is the policy number and nothing more. The grace period
        // must not quietly add a day to every job that has any delay at all.
        let downtime = payment(FailureReason::BankDowntime);
        let (_, action) = evaluate(&downtime).unwrap();
        assert_eq!(action.delay_minutes, 90);
        assert_eq!(sla_minutes(&downtime, &action), DAY);

        // A payday retry a month out is the case the grace period exists for:
        // the window stretches to a day past the action rather than expiring
        // before the engine has tried anything.
        let mut payday = payment(FailureReason::InsufficientFunds);
        payday.failed_at = "2026-08-03T13:05:00.000Z".into();
        let (_, action) = evaluate(&payday).unwrap();
        assert!(action.delay_minutes > 3 * DAY);
        assert_eq!(
            sla_minutes(&payday, &action),
            action.delay_minutes + DAY,
            "a retry scheduled past the window must carry the window with it"
        );
    }
}
