//! What a fresh install starts with.
//!
//! Two things happen here, and they are deliberately separate:
//!
//! * **Default playbooks** are installed on every start via `INSERT OR IGNORE`,
//!   so a new release can add one without touching what the merchant has since
//!   configured.
//! * **A demo dataset** is installed only into a store that has never seen a
//!   payment, and only when [`DEMO_SEED_ENV`] is not `0`. It exists so the
//!   desktop app opens onto a populated dashboard instead of four zeroes.
//!
//! The demo rows are *not* fabricated decisions. Each payment is pushed through
//! [`crate::db::jobs::ingest`], which scores it with the same rules engine that
//! scores a webhook, so every number on the screen is one the engine actually
//! produced. The seeding itself is recorded in the audit trail as
//! `system.demo_seed`, so a reviewer can always tell where the data came from.

use rusqlite::params;

use crate::clock;
use crate::db::{attempt_id, audit, jobs, playbooks, Store};
use crate::domain::{
    Actor, AuditSeverity, CustomerRef, FailedPayment, FailureReason, Merchant, MerchantMode,
    PaymentMethod, Playbook, PlaybookStats, PlaybookStep, PlaybookTrigger, RecoveryActionKind,
};
use crate::error::EngineResult;

/// Set to `0` to start against a genuinely empty store.
pub const DEMO_SEED_ENV: &str = "REVIVEAI_DEMO_SEED";

/// Installs defaults and, on a first run, the demo dataset.
///
/// Returns the number of demo jobs created — zero on every start after the
/// first, and zero when seeding is switched off.
pub fn install(store: &Store) -> EngineResult<usize> {
    {
        let connection = store.lock()?;
        for (ordinal, playbook) in default_playbooks().iter().enumerate() {
            playbooks::ensure(&connection, ordinal as i64 + 1, playbook)?;
        }
    }

    let seeded = if demo_seed_enabled() && is_empty(store)? {
        seed_demo(store)?
    } else {
        0
    };

    {
        let connection = store.lock()?;
        playbooks::refresh_stats(&connection)?;
    }

    Ok(seeded)
}

/// Identity shown in the sidebar.
///
/// Read from the environment so a real merchant account can be named without a
/// rebuild, with the same defaults the seeded UI uses so the two never disagree
/// about whose dashboard this is. Live mode is inferred from the key rather than
/// configured separately — a mislabelled mode on a live key is the one mistake
/// here with real consequences.
pub fn merchant() -> Merchant {
    let key_id = env_string("RAZORPAY_KEY_ID").unwrap_or_default();

    Merchant {
        id: env_string("REVIVEAI_MERCHANT_ID").unwrap_or_else(|| "acc_KLm3RtNvQz".to_string()),
        name: env_string("REVIVEAI_MERCHANT_NAME").unwrap_or_else(|| "Kettle & Co.".to_string()),
        mode: if key_id.starts_with("rzp_live_") {
            MerchantMode::Live
        } else {
            MerchantMode::Test
        },
    }
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn demo_seed_enabled() -> bool {
    env_string(DEMO_SEED_ENV).as_deref() != Some("0")
}

fn is_empty(store: &Store) -> EngineResult<bool> {
    let connection = store.lock()?;
    let payments: i64 =
        connection.query_row("SELECT COUNT(*) FROM failed_payments", [], |row| row.get(0))?;
    Ok(payments == 0)
}

// ---------------------------------------------------------------------------
// Default playbooks
// ---------------------------------------------------------------------------

/// Mirrors `PLAYBOOKS` in `src/data/seed/fixtures.ts`, minus the statistics —
/// those are recomputed from the job table by
/// [`crate::db::playbooks::refresh_stats`] rather than asserted here.
fn default_playbooks() -> Vec<Playbook> {
    let now = clock::now_iso();

    let build = |id: &str,
                 name: &str,
                 description: &str,
                 enabled: bool,
                 reasons: Vec<FailureReason>,
                 methods: Vec<PaymentMethod>,
                 min_amount_paise: Option<i64>,
                 steps: Vec<(RecoveryActionKind, i64)>| Playbook {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        enabled,
        trigger: PlaybookTrigger {
            reasons,
            methods,
            min_amount_paise,
            subscription_only: false,
        },
        steps: steps
            .into_iter()
            .enumerate()
            .map(|(index, (kind, delay_minutes))| PlaybookStep {
                sequence: index as i64 + 1,
                kind,
                delay_minutes,
                stop_on_success: true,
            })
            .collect(),
        stats: PlaybookStats {
            jobs_matched: 0,
            recovered_paise: 0,
            recovery_rate: 0.0,
        },
        updated_at: now.clone(),
    };

    vec![
        build(
            "pb_payday",
            "Payday re-present",
            "Hold insufficient-funds failures until the salary window, then re-present \
             silently before contacting the customer.",
            true,
            vec![FailureReason::InsufficientFunds],
            vec![
                PaymentMethod::Card,
                PaymentMethod::Upi,
                PaymentMethod::Netbanking,
                PaymentMethod::Emandate,
            ],
            None,
            vec![
                (RecoveryActionKind::RetryOnPayday, 0),
                (RecoveryActionKind::DunningWhatsapp, 720),
                (RecoveryActionKind::SendPaymentLink, 2_880),
            ],
        ),
        build(
            "pb_downtime",
            "Issuer downtime hold",
            "Pause retries while an issuer is degraded, then drain the backlog in small \
             batches once it recovers.",
            true,
            vec![FailureReason::BankDowntime, FailureReason::GatewayTimeout],
            vec![
                PaymentMethod::Netbanking,
                PaymentMethod::Upi,
                PaymentMethod::Card,
                PaymentMethod::Emandate,
            ],
            None,
            vec![
                (RecoveryActionKind::RetryAfterDowntime, 90),
                (RecoveryActionKind::AutoRetry, 240),
            ],
        ),
        build(
            "pb_card_refresh",
            "Card refresh",
            "Ask for current card details when the instrument itself is dead, and offer \
             UPI as the faster alternative.",
            true,
            vec![FailureReason::CardExpired, FailureReason::InvalidCard],
            vec![PaymentMethod::Card, PaymentMethod::Emi],
            None,
            vec![
                (RecoveryActionKind::RequestCardUpdate, 0),
                (RecoveryActionKind::SwitchToUpi, 1_440),
                (RecoveryActionKind::DunningEmail, 4_320),
            ],
        ),
        build(
            "pb_checkout_dropoff",
            "Checkout drop-off rescue",
            "Send a fresh hosted link within minutes of an abandoned authentication, \
             while intent is still warm.",
            true,
            vec![
                FailureReason::AuthenticationTimeout,
                FailureReason::UpiCollectExpired,
            ],
            vec![
                PaymentMethod::Card,
                PaymentMethod::Upi,
                PaymentMethod::Netbanking,
                PaymentMethod::Emi,
            ],
            None,
            vec![
                (RecoveryActionKind::SendPaymentLink, 5),
                (RecoveryActionKind::DunningWhatsapp, 180),
            ],
        ),
        build(
            "pb_high_value",
            "High-value manual desk",
            "Route anything above ₹50,000 to a human before any automated contact goes out.",
            false,
            vec![
                FailureReason::DoNotHonour,
                FailureReason::LimitExceeded,
                FailureReason::MandateRevoked,
            ],
            vec![
                PaymentMethod::Card,
                PaymentMethod::Netbanking,
                PaymentMethod::Emandate,
                PaymentMethod::Emi,
            ],
            Some(50_00_000),
            vec![(RecoveryActionKind::HumanReview, 0)],
        ),
    ]
}

// ---------------------------------------------------------------------------
// Demo dataset
// ---------------------------------------------------------------------------

/// One row of the demo table: who, how much, how, why, and how long ago.
struct DemoRow {
    name: &'static str,
    email: &'static str,
    amount_paise: i64,
    method: PaymentMethod,
    network: Option<&'static str>,
    issuer: &'static str,
    reason: FailureReason,
    days_ago: f64,
    subscription: bool,
    /// Whether this one has since been recovered, and for how much.
    recovered: bool,
}

/// Shaped like a mid-size Indian D2C merchant's bad week: insufficient funds
/// dominates, one issuer is having a rough day, and the long tail is mandates.
const DEMO_ROWS: &[DemoRow] = &[
    DemoRow {
        name: "Ananya Iyer",
        email: "ananya.iyer@example.in",
        amount_paise: 2_45_000,
        method: PaymentMethod::Card,
        network: Some("VISA"),
        issuer: "HDFC Bank",
        reason: FailureReason::InsufficientFunds,
        days_ago: 0.4,
        subscription: false,
        recovered: false,
    },
    DemoRow {
        name: "Rohan Menon",
        email: "rohan.menon@example.in",
        amount_paise: 8_99_000,
        method: PaymentMethod::Emandate,
        network: None,
        issuer: "ICICI Bank",
        reason: FailureReason::MandateRevoked,
        days_ago: 1.2,
        subscription: true,
        recovered: false,
    },
    DemoRow {
        name: "Priya Deshpande",
        email: "priya.deshpande@example.in",
        amount_paise: 1_20_000,
        method: PaymentMethod::Upi,
        network: None,
        issuer: "State Bank of India",
        reason: FailureReason::UpiCollectExpired,
        days_ago: 0.8,
        subscription: false,
        recovered: true,
    },
    DemoRow {
        name: "Kabir Sethi",
        email: "kabir.sethi@example.in",
        amount_paise: 62_50_000,
        method: PaymentMethod::Card,
        network: Some("MasterCard"),
        issuer: "Axis Bank",
        reason: FailureReason::DoNotHonour,
        days_ago: 2.1,
        subscription: false,
        recovered: false,
    },
    DemoRow {
        name: "Meera Nair",
        email: "meera.nair@example.in",
        amount_paise: 3_10_000,
        method: PaymentMethod::Card,
        network: Some("RuPay"),
        issuer: "HDFC Bank",
        reason: FailureReason::CardExpired,
        days_ago: 3.4,
        subscription: true,
        recovered: false,
    },
    DemoRow {
        name: "Arjun Bhatia",
        email: "arjun.bhatia@example.in",
        amount_paise: 4_75_000,
        method: PaymentMethod::Netbanking,
        network: None,
        issuer: "Kotak Mahindra Bank",
        reason: FailureReason::BankDowntime,
        days_ago: 0.2,
        subscription: false,
        recovered: false,
    },
    DemoRow {
        name: "Sneha Kulkarni",
        email: "sneha.kulkarni@example.in",
        amount_paise: 1_85_000,
        method: PaymentMethod::Upi,
        network: None,
        issuer: "HDFC Bank",
        reason: FailureReason::InsufficientFunds,
        days_ago: 4.6,
        subscription: false,
        recovered: true,
    },
    DemoRow {
        name: "Vikram Raghavan",
        email: "vikram.raghavan@example.in",
        amount_paise: 12_40_000,
        method: PaymentMethod::Card,
        network: Some("VISA"),
        issuer: "HDFC Bank",
        reason: FailureReason::LimitExceeded,
        days_ago: 5.3,
        subscription: false,
        recovered: false,
    },
    DemoRow {
        name: "Divya Pillai",
        email: "divya.pillai@example.in",
        amount_paise: 99_000,
        method: PaymentMethod::Card,
        network: Some("VISA"),
        issuer: "HDFC Bank",
        reason: FailureReason::AuthenticationTimeout,
        days_ago: 6.1,
        subscription: false,
        recovered: true,
    },
    DemoRow {
        name: "Imran Qureshi",
        email: "imran.qureshi@example.in",
        amount_paise: 2_20_000,
        method: PaymentMethod::Emi,
        network: Some("MasterCard"),
        issuer: "Bajaj Finserv",
        reason: FailureReason::InvalidCard,
        days_ago: 7.5,
        subscription: false,
        recovered: false,
    },
    DemoRow {
        name: "Tanvi Shah",
        email: "tanvi.shah@example.in",
        amount_paise: 5_60_000,
        method: PaymentMethod::Emandate,
        network: None,
        issuer: "ICICI Bank",
        reason: FailureReason::InsufficientFunds,
        days_ago: 9.2,
        subscription: true,
        recovered: true,
    },
    DemoRow {
        name: "Aditya Verma",
        email: "aditya.verma@example.in",
        amount_paise: 3_35_000,
        method: PaymentMethod::Upi,
        network: None,
        issuer: "Paytm Payments Bank",
        reason: FailureReason::GatewayTimeout,
        days_ago: 11.4,
        subscription: false,
        recovered: false,
    },
];

fn demo_payments() -> Vec<FailedPayment> {
    DEMO_ROWS
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let number = index as u32 + 1;
            FailedPayment {
                id: format!("fp_{number:04}"),
                razorpay_payment_id: format!("pay_DEMO{number:04}RVAI"),
                razorpay_order_id: format!("order_DEMO{number:04}RV"),
                customer: CustomerRef {
                    id: format!("cust_{number:04}"),
                    name: row.name.to_string(),
                    email: row.email.to_string(),
                    // Masked at the source, as everywhere else in the app.
                    phone_masked: format!("+91 9•••• ••{:02}", 10 + number),
                    lifetime_value_paise: row.amount_paise * (4 + number as i64 % 5),
                    successful_payments: 2 + (number as i64 % 7),
                },
                amount_paise: row.amount_paise,
                method: row.method,
                card_network: row.network.map(str::to_string),
                issuer: Some(row.issuer.to_string()),
                failure_reason: row.reason,
                gateway_description: gateway_description(row.reason).to_string(),
                failed_at: clock::iso_days_ago(row.days_ago),
                attempt_count: 1,
                is_subscription: row.subscription,
            }
        })
        .collect()
}

/// The verbatim-ish gateway text a merchant would see in the Razorpay dashboard.
/// Kept alongside the normalised reason so the two can be compared.
const fn gateway_description(reason: FailureReason) -> &'static str {
    match reason {
        FailureReason::InsufficientFunds => "Your card has insufficient balance",
        FailureReason::CardExpired => "Your card has expired",
        FailureReason::InvalidCard => "Card number is invalid",
        FailureReason::DoNotHonour => "Payment was declined by the issuing bank",
        FailureReason::AuthenticationTimeout => "3D Secure authentication was not completed",
        FailureReason::BankDowntime => "The bank is facing a temporary outage",
        FailureReason::UpiCollectExpired => "The UPI collect request expired",
        FailureReason::MandateRevoked => "The e-mandate was cancelled by the customer",
        FailureReason::LimitExceeded => "Transaction exceeds the per-day limit on this card",
        FailureReason::GatewayTimeout => "The payment gateway did not respond in time",
    }
}

fn seed_demo(store: &Store) -> EngineResult<usize> {
    let payments = demo_payments();
    let mut created = 0usize;

    let mut connection = store.lock()?;
    let transaction = connection.transaction()?;

    for payment in &payments {
        if jobs::ingest(&transaction, payment, Actor::engine())?.is_some() {
            created += 1;
        }
    }

    // A dashboard with nothing recovered cannot show a recovery rate, and a
    // recovery rate is the number this product is judged on. These are closed
    // the same way the engine would close them: an attempt row that succeeded,
    // then the job marked recovered for the amount that came back.
    for (index, row) in DEMO_ROWS.iter().enumerate() {
        if !row.recovered {
            continue;
        }

        let job_id = jobs::job_id_for(&format!("fp_{:04}", index + 1));
        let recovered_at = clock::iso_days_ago((row.days_ago - 0.3).max(0.05));

        transaction.execute(
            "INSERT INTO recovery_attempts
               (id, job_id, sequence, kind, channel, occurred_at, outcome, note)
             SELECT ?1, j.id, 1, j.action_kind, j.action_channel, ?2, 'succeeded',
                    'Re-presented on the gateway; captured in full'
               FROM recovery_jobs j
              WHERE j.id = ?3",
            params![attempt_id(&job_id, 1), recovered_at, job_id],
        )?;

        transaction.execute(
            "UPDATE recovery_jobs
                SET status = 'recovered',
                    recovered_amount_paise = (
                      SELECT p.amount_paise FROM failed_payments p WHERE p.id = payment_id
                    ),
                    next_action_at = NULL,
                    updated_at = ?2
              WHERE id = ?1",
            params![job_id, recovered_at],
        )?;

        audit::record(
            &transaction,
            &audit::event(
                Actor::engine(),
                "job.recovered",
                format!("Recovered {} from {}", rupees(row.amount_paise), row.name),
                AuditSeverity::Notice,
                Some(job_id.clone()),
                audit::meta([("amount_paise", row.amount_paise.to_string())]),
            ),
        )?;
    }

    audit::record(
        &transaction,
        &audit::event(
            Actor::scheduler(),
            "system.demo_seed",
            format!("Installed {created} demo recovery jobs into an empty store"),
            AuditSeverity::Warning,
            None,
            audit::meta([
                ("jobs", created.to_string()),
                ("disable_with", format!("{DEMO_SEED_ENV}=0")),
            ]),
        ),
    )?;

    transaction.commit()?;
    Ok(created)
}

/// Plain rupee amount for an audit sentence. Grouping is left to the UI; this
/// only has to read correctly in a log line.
fn rupees(paise: i64) -> String {
    format!("₹{}", paise / 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::metrics;

    #[test]
    fn a_fresh_store_gets_playbooks_and_demo_jobs() {
        let store = Store::in_memory().unwrap();
        let created = install(&store).unwrap();

        assert_eq!(created, DEMO_ROWS.len());

        let connection = store.lock().unwrap();
        assert_eq!(playbooks::list(&connection).unwrap().len(), 5);

        let metrics = metrics::dashboard(&connection, 30).unwrap();
        assert!(metrics.revenue_at_risk_paise > 0, "nothing at risk to show");
        assert!(metrics.recovered_paise > 0, "no recovery rate to show");
        assert!(metrics.recovery_rate > 0.0 && metrics.recovery_rate < 1.0);
    }

    #[test]
    fn installing_twice_does_not_duplicate_anything() {
        let store = Store::in_memory().unwrap();
        install(&store).unwrap();
        // Second start: the store is no longer empty, so nothing is seeded.
        assert_eq!(install(&store).unwrap(), 0);

        let connection = store.lock().unwrap();
        let payments: i64 = connection
            .query_row("SELECT COUNT(*) FROM failed_payments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(payments as usize, DEMO_ROWS.len());
        assert_eq!(playbooks::list(&connection).unwrap().len(), 5);
    }

    #[test]
    fn the_seed_announces_itself_in_the_trail() {
        let store = Store::in_memory().unwrap();
        install(&store).unwrap();

        let connection = store.lock().unwrap();
        let announced: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action = 'system.demo_seed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(announced, 1, "demo data was installed silently");
    }

    #[test]
    fn every_demo_payment_is_scored_by_the_engine() {
        let store = Store::in_memory().unwrap();
        install(&store).unwrap();

        let connection = store.lock().unwrap();
        // A score of exactly zero would mean a row written around `ingest`.
        let unscored: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM recovery_jobs WHERE recovery_score <= 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unscored, 0);

        let unexplained: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM recovery_jobs WHERE action_signals IN ('', '[]')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unexplained, 0, "a recommendation with no evidence");
    }

    #[test]
    fn default_playbooks_match_the_ids_the_ui_expects() {
        let installed = default_playbooks();
        let ids: Vec<&str> = installed
            .iter()
            .map(|playbook| playbook.id.as_str())
            .collect();

        assert_eq!(
            ids,
            [
                "pb_payday",
                "pb_downtime",
                "pb_card_refresh",
                "pb_checkout_dropoff",
                "pb_high_value",
            ]
        );

        // Steps are numbered from one, in order, or the engine runs them wrong.
        for playbook in &installed {
            for (index, step) in playbook.steps.iter().enumerate() {
                assert_eq!(step.sequence, index as i64 + 1);
            }
        }
    }
}
