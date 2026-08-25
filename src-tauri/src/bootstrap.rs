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
    RecoveryStatus,
};
use crate::error::EngineResult;

/// Set to `0` to start against a genuinely empty store.
pub const DEMO_SEED_ENV: &str = "RAZORRC_DEMO_SEED";

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
        id: env_string("RAZORRC_MERCHANT_ID").unwrap_or_else(|| "acc_KLm3RtNvQz".to_string()),
        name: env_string("RAZORRC_MERCHANT_NAME").unwrap_or_else(|| "Kettle & Co.".to_string()),
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

/// One row of the demo table: who, how much, how, why, how long ago, and how it
/// has gone since.
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
    /// Gateway attempts the customer made, which is also the length of the
    /// recovery ladder seeded below — the same single number the TypeScript
    /// fixture uses for both, so the two datasets read alike.
    attempts: u32,
    /// Where the job stands now. `Queued` means the engine has not acted yet,
    /// so no attempts are recorded against it.
    status: RecoveryStatus,
}

/// One rung of the ladder every 0.35 days, unless the failure is too recent to
/// fit them all in — see [`DemoRow::attempt_days_ago`].
const ATTEMPT_STEP_DAYS: f64 = 0.35;

/// The schema keeps four attempt buckets, so a longer ladder cannot be charted.
const MAX_LADDER: u32 = 4;

/// The operator the demo attributes human decisions to. Mirrors the name the
/// TypeScript fixture uses so a screenshot from either build reads the same.
const OPERATOR: &str = "Priya Menon";

impl DemoRow {
    /// How many attempts are on record. A queued job has not been touched yet.
    fn ladder(&self) -> u32 {
        if self.status == RecoveryStatus::Queued {
            0
        } else {
            self.attempts.min(MAX_LADDER)
        }
    }

    /// When attempt `sequence` of `total` happened, as days before now.
    ///
    /// The ladder walks *forward in time* from the failure — sequence 1 is the
    /// oldest — which is the whole point: the drawer timeline and the attempt
    /// buckets on the analytics page both read this order, and a ladder dated
    /// backwards shows a success before the failures that preceded it. The step
    /// is compressed when the failure is recent so that even a four-rung ladder
    /// on a payment that failed five hours ago stays strictly between the
    /// failure and now.
    fn attempt_days_ago(&self, sequence: u32, total: u32) -> f64 {
        let step = (self.days_ago / (total as f64 + 1.0)).min(ATTEMPT_STEP_DAYS);
        self.days_ago - sequence as f64 * step
    }

    /// What the last rung says. Everything before it failed, or there would
    /// have been no next attempt.
    fn outcome_at(&self, sequence: u32, total: u32) -> &'static str {
        if sequence < total {
            return "failed";
        }

        match self.status {
            RecoveryStatus::Recovered => "succeeded",
            RecoveryStatus::AwaitingCustomer => "delivered",
            RecoveryStatus::InProgress => "pending",
            RecoveryStatus::Suppressed => "skipped",
            _ => "failed",
        }
    }
}

/// Shaped like a mid-size Indian D2C merchant's month: insufficient funds
/// dominates, one issuer is having a rough week, and the long tail is mandates.
///
/// Three properties this table has to keep, each of which has been broken here
/// before:
///
/// * **It spans the widest window the UI offers.** A dataset that only covers a
///   fortnight makes the 14D and 30D filters return byte-identical figures,
///   which reads as a broken filter rather than a quiet month.
/// * **Every window differs on every card.** Older cohorts are further along —
///   more of them recovered, more of them written off — so the recovery *rate*
///   moves between 7D, 14D and 30D instead of just the totals. Active jobs are
///   spread across the cohorts for the same reason.
/// * **`days_ago` stays away from the window edges.** A window is N whole
///   calendar days, so its start is between N-1 and N days back depending on
///   the hour. Rows in (6,7), (13,14) and (29,30) would drift in and out of a
///   window over the course of a day and make the demo irreproducible.
const DEMO_ROWS: &[DemoRow] = &[
    // ----- The last week: dense, mostly still in play. --------------------
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
        attempts: 1,
        status: RecoveryStatus::Scheduled,
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
        attempts: 1,
        status: RecoveryStatus::Queued,
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
        attempts: 2,
        status: RecoveryStatus::Recovered,
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
        attempts: 2,
        status: RecoveryStatus::AwaitingCustomer,
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
        attempts: 2,
        status: RecoveryStatus::AwaitingCustomer,
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
        attempts: 1,
        status: RecoveryStatus::Queued,
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
        attempts: 2,
        status: RecoveryStatus::Recovered,
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
        attempts: 4,
        status: RecoveryStatus::InProgress,
    },
    DemoRow {
        name: "Divya Pillai",
        email: "divya.pillai@example.in",
        amount_paise: 99_000,
        method: PaymentMethod::Card,
        network: Some("VISA"),
        issuer: "HDFC Bank",
        reason: FailureReason::AuthenticationTimeout,
        days_ago: 5.6,
        subscription: false,
        attempts: 3,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Farhan Ali",
        email: "farhan.ali@example.in",
        amount_paise: 6_30_000,
        method: PaymentMethod::Wallet,
        network: None,
        issuer: "Amazon Pay",
        reason: FailureReason::GatewayTimeout,
        days_ago: 5.9,
        subscription: false,
        attempts: 2,
        status: RecoveryStatus::Failed,
    },
    // ----- Seven to thirteen days: the fortnight the 14D filter adds. -----
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
        attempts: 2,
        status: RecoveryStatus::Failed,
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
        attempts: 3,
        status: RecoveryStatus::Recovered,
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
        attempts: 2,
        status: RecoveryStatus::AwaitingCustomer,
    },
    DemoRow {
        name: "Fatima Sheikh",
        email: "fatima.sheikh@example.in",
        amount_paise: 1_45_000,
        method: PaymentMethod::Upi,
        network: None,
        issuer: "Yes Bank",
        reason: FailureReason::InsufficientFunds,
        days_ago: 12.2,
        subscription: false,
        attempts: 2,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Nikhil Joshi",
        email: "nikhil.joshi@example.in",
        amount_paise: 6_80_000,
        method: PaymentMethod::Card,
        network: Some("VISA"),
        issuer: "IDFC FIRST Bank",
        reason: FailureReason::AuthenticationTimeout,
        days_ago: 12.6,
        subscription: false,
        attempts: 3,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Rakesh Iyengar",
        email: "rakesh.iyengar@example.in",
        amount_paise: 18_60_000,
        method: PaymentMethod::Card,
        network: Some("MasterCard"),
        issuer: "Axis Bank",
        reason: FailureReason::DoNotHonour,
        days_ago: 12.8,
        subscription: false,
        attempts: 4,
        status: RecoveryStatus::WrittenOff,
    },
    // ----- Two to four weeks: worked through, mostly closed. --------------
    DemoRow {
        name: "Karthik Rao",
        email: "karthik.rao@example.in",
        amount_paise: 27_90_000,
        method: PaymentMethod::Netbanking,
        network: None,
        issuer: "State Bank of India",
        reason: FailureReason::DoNotHonour,
        days_ago: 15.2,
        subscription: false,
        attempts: 3,
        status: RecoveryStatus::WrittenOff,
    },
    DemoRow {
        name: "Ritu Malhotra",
        email: "ritu.malhotra@example.in",
        amount_paise: 4_20_000,
        method: PaymentMethod::Card,
        network: Some("RuPay"),
        issuer: "Bank of Baroda",
        reason: FailureReason::CardExpired,
        days_ago: 16.9,
        subscription: true,
        attempts: 3,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Sandeep Nayak",
        email: "sandeep.nayak@example.in",
        amount_paise: 89_000,
        method: PaymentMethod::Upi,
        network: None,
        issuer: "Paytm Payments Bank",
        reason: FailureReason::GatewayTimeout,
        days_ago: 18.1,
        subscription: false,
        attempts: 1,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Lakshmi Subramanian",
        email: "lakshmi.subramanian@example.in",
        amount_paise: 9_75_000,
        method: PaymentMethod::Emandate,
        network: None,
        issuer: "ICICI Bank",
        reason: FailureReason::InsufficientFunds,
        days_ago: 19.4,
        subscription: true,
        attempts: 4,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Zoya Khan",
        email: "zoya.khan@example.in",
        amount_paise: 2_65_000,
        method: PaymentMethod::Card,
        network: Some("MasterCard"),
        issuer: "Axis Bank",
        reason: FailureReason::InsufficientFunds,
        days_ago: 20.8,
        subscription: false,
        attempts: 2,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Harish Bhatt",
        email: "harish.bhatt@example.in",
        amount_paise: 15_20_000,
        method: PaymentMethod::Card,
        network: Some("VISA"),
        issuer: "HDFC Bank",
        reason: FailureReason::LimitExceeded,
        days_ago: 22.3,
        subscription: false,
        attempts: 4,
        status: RecoveryStatus::AwaitingCustomer,
    },
    DemoRow {
        name: "Neha Chawla",
        email: "neha.chawla@example.in",
        amount_paise: 3_95_000,
        method: PaymentMethod::Netbanking,
        network: None,
        issuer: "Kotak Mahindra Bank",
        reason: FailureReason::BankDowntime,
        days_ago: 23.7,
        subscription: false,
        attempts: 2,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Devansh Trivedi",
        email: "devansh.trivedi@example.in",
        amount_paise: 1_10_000,
        method: PaymentMethod::Upi,
        network: None,
        issuer: "State Bank of India",
        reason: FailureReason::UpiCollectExpired,
        days_ago: 24.9,
        subscription: false,
        attempts: 2,
        status: RecoveryStatus::Recovered,
    },
    DemoRow {
        name: "Aisha Merchant",
        email: "aisha.merchant@example.in",
        amount_paise: 7_40_000,
        method: PaymentMethod::Emandate,
        network: None,
        issuer: "HDFC Bank",
        reason: FailureReason::MandateRevoked,
        days_ago: 26.2,
        subscription: true,
        attempts: 1,
        status: RecoveryStatus::Suppressed,
    },
    DemoRow {
        name: "Manoj Pillai",
        email: "manoj.pillai@example.in",
        amount_paise: 34_60_000,
        method: PaymentMethod::Card,
        network: Some("MasterCard"),
        issuer: "ICICI Bank",
        reason: FailureReason::DoNotHonour,
        days_ago: 28.6,
        subscription: false,
        attempts: 4,
        status: RecoveryStatus::WrittenOff,
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
                attempt_count: row.attempts.max(1) as i64,
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

/// What the attempt row says happened. The wording matches
/// `buildAttempts` in `src/data/seed/fixtures.ts` so the same job reads the same
/// way whether the app is running on SQLite or on the browser fixtures.
fn attempt_note(row: &DemoRow, sequence: u32, outcome: &str, index: usize) -> String {
    match outcome {
        "succeeded" => format!(
            "Captured pay_DEMO{:04}RVAI on retry {sequence}",
            index + 1
        ),
        "delivered" => "Message delivered, awaiting customer action".to_string(),
        "pending" => "Charge submitted, awaiting gateway confirmation".to_string(),
        "skipped" => "Held back by contact-frequency cap".to_string(),
        _ => gateway_description(row.reason).to_string(),
    }
}

/// The one audit line that explains where a demo job ended up, and who decided
/// it — a write-off is a human's call, the rest are the engine's.
///
/// `job.suppressed` and `job.action.due` are written by the live engine too;
/// the three closing actions are not, because nothing in the app settles a job
/// yet — a webhook-driven settle path should reuse these strings rather than
/// invent new ones, or the trail will read differently for seeded and real work.
fn closing_event(row: &DemoRow, attempts: u32) -> (Actor, &'static str, AuditSeverity, String) {
    match row.status {
        RecoveryStatus::Recovered => (
            Actor::engine(),
            "job.recovered",
            AuditSeverity::Notice,
            format!("Recovered {} from {}", rupees(row.amount_paise), row.name),
        ),
        RecoveryStatus::Failed => (
            Actor::engine(),
            "job.failed",
            AuditSeverity::Warning,
            format!("Exhausted {attempts} attempts on {}", row.name),
        ),
        RecoveryStatus::WrittenOff => (
            Actor::operator(OPERATOR),
            "job.written_off",
            AuditSeverity::Warning,
            format!("Wrote off {} from {}", rupees(row.amount_paise), row.name),
        ),
        RecoveryStatus::Suppressed => (
            Actor::engine(),
            "job.suppressed",
            AuditSeverity::Warning,
            format!("Held {} back under the contact-frequency cap", row.name),
        ),
        _ => (
            Actor::scheduler(),
            "job.action.due",
            AuditSeverity::Info,
            format!("Ran attempt {attempts} for {}", row.name),
        ),
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
    // recovery rate is the number this product is judged on. Nothing is written
    // straight to the totals: each job is walked forward the way the engine
    // would walk it — an attempt row per rung of the ladder, then the job moved
    // to where those attempts left it — so every figure on the screen is still
    // derived from attempt and job rows rather than asserted.
    for (index, row) in DEMO_ROWS.iter().enumerate() {
        let job_id = jobs::job_id_for(&format!("fp_{:04}", index + 1));
        let total = row.ladder();

        if total == 0 {
            continue;
        }

        let mut last_touch = clock::iso_days_ago(row.days_ago);

        for sequence in 1..=total {
            let occurred_at = clock::iso_days_ago(row.attempt_days_ago(sequence, total));
            let outcome = row.outcome_at(sequence, total);

            transaction.execute(
                // The first rung is the gateway re-presentment the engine tries
                // on its own; later rungs are whatever this job's recommended
                // action turned out to be. A job the engine sent to a human is
                // never depicted as having auto-retried.
                "INSERT INTO recovery_attempts
                   (id, job_id, sequence, kind, channel, occurred_at, outcome, note)
                 SELECT ?1, j.id, ?2,
                        CASE WHEN ?2 = 1 AND j.action_kind <> 'human_review'
                             THEN 'auto_retry' ELSE j.action_kind END,
                        CASE WHEN ?2 = 1 AND j.action_kind <> 'human_review'
                             THEN 'gateway' ELSE j.action_channel END,
                        ?3, ?4, ?5
                   FROM recovery_jobs j
                  WHERE j.id = ?6",
                params![
                    attempt_id(&job_id, sequence as i64),
                    sequence as i64,
                    occurred_at,
                    outcome,
                    attempt_note(row, sequence, outcome, index),
                    job_id,
                ],
            )?;

            last_touch = occurred_at;
        }

        // Closed jobs have nothing scheduled; open ones are still owed an
        // action, and it has to be in the *future* — `ingest` set it relative to
        // the failure, which for a three-week-old job is long past.
        let next_action_at = if row.status.is_closed() {
            None
        } else {
            Some(clock::iso_minutes_from_now(35 + (index as i64 % 7) * 190))
        };

        transaction.execute(
            "UPDATE recovery_jobs
                SET status = ?2,
                    recovered_amount_paise = CASE WHEN ?2 = 'recovered' THEN (
                      SELECT p.amount_paise FROM failed_payments p WHERE p.id = payment_id
                    ) END,
                    next_action_at = ?3,
                    updated_at = ?4,
                    assigned_to = CASE WHEN ?2 IN ('suppressed', 'written_off')
                                       THEN ?5 END
              WHERE id = ?1",
            params![job_id, row.status, next_action_at, last_touch, OPERATOR],
        )?;

        let (actor, action, severity, summary) = closing_event(row, total);

        audit::record(
            &transaction,
            &audit::event(
                actor,
                action,
                summary,
                severity,
                Some(job_id.clone()),
                audit::meta([
                    ("amount_paise", row.amount_paise.to_string()),
                    ("attempts", total.to_string()),
                ]),
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

    /// The dataset has to reach the end of the widest window the UI offers, and
    /// it has to stay clear of the window edges. A window is N whole calendar
    /// days, so its first instant sits between N-1 and N days back depending on
    /// the time of day — a row at 13.5 days would be inside the 14D window this
    /// morning and outside it tonight, which makes the demo unreproducible and
    /// any assertion about it flaky.
    #[test]
    fn the_demo_spans_the_widest_window_the_ui_offers() {
        let oldest = DEMO_ROWS
            .iter()
            .map(|row| row.days_ago)
            .fold(f64::MIN, f64::max);

        assert!(
            oldest > 28.0 && oldest < 29.0,
            "demo data spans {oldest:.1} days; the 30D filter needs close to 29 \
             without touching the edge"
        );

        for row in DEMO_ROWS {
            for window in [7u32, 14, 30] {
                let edge = f64::from(window - 1)..f64::from(window);
                assert!(
                    !edge.contains(&row.days_ago),
                    "{} sits at {:.1} days, inside the {window}D window's edge",
                    row.name,
                    row.days_ago
                );
            }
        }
    }

    /// The bug this guards against: every window returning the same figures, so
    /// the 7D/14D/30D control looks broken. It is a data problem, not a query
    /// problem, which is why it belongs here rather than in `metrics`.
    #[test]
    fn each_window_reports_different_figures() {
        let store = Store::in_memory().unwrap();
        install(&store).unwrap();
        let connection = store.lock().unwrap();

        let week = metrics::dashboard(&connection, 7).unwrap();
        let fortnight = metrics::dashboard(&connection, 14).unwrap();
        let month = metrics::dashboard(&connection, 30).unwrap();

        // A wider window can only contain more failures, so every total grows.
        assert!(
            week.revenue_at_risk_paise < fortnight.revenue_at_risk_paise,
            "7D and 14D report the same money at risk"
        );
        assert!(
            fortnight.revenue_at_risk_paise < month.revenue_at_risk_paise,
            "14D and 30D report the same money at risk"
        );

        assert!(week.recovered_paise < fortnight.recovered_paise);
        assert!(fortnight.recovered_paise < month.recovered_paise);

        // The rate is the one that catches a lazily widened dataset: adding rows
        // that are all still at risk moves the totals but leaves the rate alone.
        // Older cohorts here are further along, so the rate moves too.
        assert!(
            week.recovery_rate < fortnight.recovery_rate,
            "7D and 14D report the same recovery rate"
        );
        assert!(
            fortnight.recovery_rate < month.recovery_rate,
            "14D and 30D report the same recovery rate"
        );

        // Open work is spread across the cohorts, so the count moves as well.
        assert!(week.active_jobs < fortnight.active_jobs);
        assert!(fortnight.active_jobs < month.active_jobs);

        // The trend is the same window definition, one point per day.
        for (window, metrics) in [(7u32, &week), (14, &fortnight), (30, &month)] {
            let trend = metrics::trend(&connection, window).unwrap();
            assert_eq!(trend.len(), window as usize, "{window}D trend is misshaped");

            let recovered: i64 = trend.iter().map(|point| point.recovered_paise).sum();
            assert_eq!(
                recovered, metrics.recovered_paise,
                "{window}D card and trend disagree about what was recovered"
            );

            let at_risk: i64 = trend.iter().map(|point| point.at_risk_paise).sum();
            assert_eq!(
                at_risk, metrics.revenue_at_risk_paise,
                "{window}D card and trend disagree about what is at risk"
            );
        }
    }

    /// Attempts are what the drawer timeline and the analytics buckets read. A
    /// ladder dated backwards shows the success before the failures that led to
    /// it, and one collapsed onto a single instant cannot be bucketed by day.
    #[test]
    fn the_attempt_ladder_runs_forwards_from_the_failure() {
        let store = Store::in_memory().unwrap();
        install(&store).unwrap();
        let connection = store.lock().unwrap();

        let mut statement = connection
            .prepare(
                "SELECT a.job_id, a.sequence, a.occurred_at, p.failed_at
                   FROM recovery_attempts a
                   JOIN recovery_jobs j ON j.id = a.job_id
                   JOIN failed_payments p ON p.id = j.payment_id
                  ORDER BY a.job_id, a.sequence",
            )
            .unwrap();

        let rows: Vec<(String, i64, String, String)> = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert!(rows.len() > 40, "only {} attempts seeded", rows.len());

        let now = clock::now_iso();
        let mut previous: Option<(String, String)> = None;

        for (job_id, sequence, occurred_at, failed_at) in rows {
            assert!(
                occurred_at > failed_at,
                "{job_id} attempt {sequence} is dated before the failure"
            );
            assert!(
                occurred_at < now,
                "{job_id} attempt {sequence} is dated in the future"
            );

            if let Some((last_job, last_at)) = previous {
                if last_job == job_id {
                    assert!(
                        occurred_at > last_at,
                        "{job_id} attempt {sequence} is not after the one before it"
                    );
                }
            }

            previous = Some((job_id, occurred_at));
        }
    }

    /// Retry economics is four buckets. With one attempt per job, three of them
    /// are empty and the panel claims every recovery lands first time.
    #[test]
    fn every_attempt_bucket_has_something_in_it() {
        let store = Store::in_memory().unwrap();
        install(&store).unwrap();
        let connection = store.lock().unwrap();

        let buckets = metrics::attempt_effectiveness(&connection, 30).unwrap();
        assert_eq!(buckets.len(), 4);

        for bucket in &buckets {
            assert!(
                bucket.attempted > 0,
                "attempt bucket {} is empty, so the panel has a hole in it",
                bucket.attempt
            );
        }

        let recovered: i64 = buckets.iter().map(|bucket| bucket.recovered).sum();
        assert!(recovered > 0, "no bucket ever succeeded");
        assert!(
            buckets[0].recovery_rate < 1.0,
            "every recovery is claimed on the first attempt"
        );
    }

    /// Every failure reason and every payment method has to appear, or the
    /// analytics breakdowns ship with gaps a reviewer will read as missing data.
    #[test]
    fn the_demo_covers_every_reason_and_method() {
        for reason in FailureReason::ALL {
            assert!(
                DEMO_ROWS.iter().any(|row| row.reason == *reason),
                "no demo row fails with {}",
                reason.as_str()
            );
        }

        for method in PaymentMethod::ALL {
            assert!(
                DEMO_ROWS.iter().any(|row| row.method == *method),
                "no demo row pays by {}",
                method.as_str()
            );
        }
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
