# RazorRC

An AI revenue-recovery console for Razorpay merchants. Failed payments arrive as a worked queue rather than a CSV: a deterministic engine scores each failure, chooses the next action, schedules it, and records every decision in an append-only audit trail.

Built for the Razorpay AI Buildathon 2026, Track 3 — as an internal merchant tool would be built, not as a demo.

## Screenshots

**Merchant Dashboard** — revenue at risk, amount recovered, recovery rate and active jobs, each against the previous period, with the live recovery queue and the insight panel underneath.

![RazorRC merchant dashboard](docs/screenshots/dashboard.png)

**Recovery Queue** — every failed payment as a worked item: score, risk tier, recommended action and SLA, filterable by status, failure reason, method and risk tier.

![RazorRC recovery queue](docs/screenshots/recovery-queue.png)

**AI decision** — the job drawer, showing the signals that produced the score, the action the engine recommends, and the attempt history behind it.

![RazorRC AI recovery decision](docs/screenshots/ai-decision.png)

Images live in `docs/screenshots/`. They are captured from the app running against the demo dataset described below, so anything visible in them is reproducible on a fresh install.

## Demo video

**Walkthrough:** _link to be added before submission_ — `https://…`

Running order of the recording: a failed payment landing in the queue, the signal breakdown behind its recovery score, an operator approving the recommended action, and that same action appearing in the audit trail seconds later with the operator's name against it.

## Why RazorRC

Most failure tooling is a report. It tells a merchant that ₹4.2 lakh failed last week, which codes were involved, and roughly which methods are worst — and then leaves the actual recovery work to whoever opens the export. The failures that were never worth chasing sit next to the ones that would have converted on a single retry, and nothing records what anyone decided.

RazorRC is built to be the operator rather than the report. It takes a position on every failure: *this one is worth chasing, by this channel, at this hour, because of these seven signals* — and then it either does it or waits for a human to approve it. That difference shows up in four places.

It **triages instead of aggregating.** A score and a risk tier per payment, so the queue is ordered by expected recovery rather than by timestamp.

It **decides the next action, not just the diagnosis.** Insufficient funds near payday is a scheduled re-presentment; an expired card is a card-refresh nudge; a checkout drop-off is a reminder. The failure taxonomy exists precisely so a new gateway code cannot silently produce a new behaviour.

It **acts on a clock.** Actions are scheduled with delays, and a sweep thread starts what is due. Recovery windows are short, and a recommendation nobody executed is worth nothing.

It **is accountable.** Every score, approval, suppression, retry and automated action lands in an append-only trail, attributed and timestamped. A merchant can audit the engine's reasoning and overrule it — which is the point. An operator that cannot be questioned is not one you would let near live revenue.

The judgement itself is deliberately deterministic rather than generative. Revenue decisions have to be explainable to a finance team, reproducible in a test, and stable across runs, so the engine reasons in weighted signals and shows its work; the language model sits above it in the Copilot, answering questions about the data, never quietly deciding who gets charged again.

## What it does

A payment fails. Razorpay tells you the code and the amount, and that is where most dashboards stop. RazorRC takes it three steps further: it decides whether this failure is worth chasing, decides *how* to chase it, and remembers who decided what.

The recovery score is a rules engine, not a model — seven weighted signals over the payment, the customer's history and the failure taxonomy, each contributing a nudge in one direction or the other. Every recommendation carries the signals that produced it, so a merchant can disagree with the reasoning rather than with a number. The same determinism is what makes the engine testable: given a payment, the score and the recommended action are always the same, and the test suite asserts on them directly.

Five surfaces:

**Dashboard** — revenue at risk, amount recovered, recovery rate and active jobs, each with a period-over-period delta; the live recovery queue; an insight panel; and a recovery timeline.

**Recovery Queue** — filterable by status, failure reason, method and risk tier, with a drawer per job showing the signal breakdown, the attempt history, and the three actions an operator can take (approve the recommendation, retry now, suppress with a reason).

**AI Copilot** — a query surface over the merchant's own recovery data. There is deliberately no scripted chat: with no model provider configured the composer renders a "not connected" state instead of faking an answer.

**Analytics** — trend, failure mix, method mix, and attempt effectiveness, all windowed.

**Audit Trail** — every state transition, every operator action, every sweep that did something, searchable and filterable by severity.

## AI Recovery Workflow

```
        Payment Failed
              ↓
    Failure Classification
              ↓
    Recovery Score Engine
              ↓
 AI Recovery Recommendation
              ↓
Merchant Approval / Automation
              ↓
       Recovery Action
              ↓
   Audit Trail + Metrics
```

**Payment Failed** — a failure enters the store as a `failed_payment` row plus a `recovery_job`, carrying the amount in paise, the method, the network, the issuer and the gateway's own description. In Phase 1 this is the demo ingest; in Phase 2 it is the `payment.failed` webhook.

**Failure Classification** — the gateway code is mapped onto a fixed ten-value taxonomy (`domain.rs`) at ingest. The rules engine never reasons about gateway vocabulary, so a new Razorpay code cannot invent a new behaviour without someone extending the taxonomy on purpose.

**Recovery Score Engine** — `recovery/rules.rs` applies seven weighted signals: the historical recovery rate for that failure reason, the customer's successful-payment history (or absence of one), retry fatigue, ticket size, whether a mandate is on file, and whether the rail is UPI. Output is a 0–100 score, a risk tier, and the `Signal[]` that produced them.

**AI Recovery Recommendation** — the same pass chooses an action kind and channel with a delay attached — re-present the mandate, retry now, refresh the card, send a reminder, or write it off — and the recommendation travels with its evidence, so the drawer can show *why* rather than just *what*.

**Merchant Approval / Automation** — an operator can approve, retry immediately, or suppress with a reason; a matching enabled playbook can schedule the action without asking. Both paths converge on the same command layer, so an automated action and a human one are recorded identically.

**Recovery Action** — the sweep thread wakes each minute, claims the jobs whose scheduled moment has arrived, and writes a `recovery_attempt`. Claiming is transactional: if an operator closed the job since the query, the human wins and the sweep skips it.

**Audit Trail + Metrics** — the attempt and its audit event commit in one transaction, then the dashboard, analytics and playbook statistics recompute from the same rows. Nothing in the product is a counter maintained by hand.

## Running It & Installation Guide

### Prerequisites

- **Node.js 20 or newer** (`node -v`)
- **pnpm 9+ or npm** (`pnpm -v` / `npm -v`)
- **Rust toolchain** (1.77+) via [rustup](https://rustup.rs) (`cargo --version` & `rustc --version`)
- **Windows Build Tools** (on Windows): Microsoft C++ Build Tools with "Desktop development with C++" workload, and WebView2 Runtime (pre-installed on Windows 10/11).

### Step-by-Step Quickstart

#### Option 1: Instant Web Mode (Zero-Config Preview)
The frontend web application runs out of the box with the deterministic simulated merchant dataset:

```bash
# 1. Clone the repository
git clone https://github.com/mrfrosty7007/RazorRC.git
cd RazorRC

# 2. Install dependencies
pnpm install

# 3. Start the local development server
pnpm dev
```
Open **`http://localhost:1420/`** in your browser. All five surfaces, filters, metrics, and deterministic rules calculations are fully functional.

#### Option 2: Native Desktop Shell (Tauri v2 + Rust Core + SQLite)
Run the native desktop application with local transactional SQLite storage and background sweep thread:

```bash
# 1. Ensure Rust toolchain is active
rustup default stable-msvc

# 2. Launch Tauri desktop app + Vite dev server
pnpm app:dev
```

#### Option 3: Production NSIS Installer Build
To compile the optimized, standalone Windows installer (`.exe`):

```bash
pnpm app:build
```
The installer lands in `src-tauri\target\release\bundle\nsis\RazorRC_1.0.0_x64-setup.exe`. It installs per-user without administrator prompts.

### Environment Configuration

Copy `.env.example` to `.env` to configure your keys:

```bash
cp .env.example .env
```

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `COPILOT_API_KEY` | Google Gemini API key for natural language Copilot chat | Optional (Copilot is advisory) |
| `COPILOT_MODEL` | Gemini model identifier | `gemini-3.7-flash` |
| `RAZORPAY_KEY_ID` | Razorpay Key ID (`rzp_test_...` or `rzp_live_...`) | Optional (defaults to test mode) |
| `RAZORPAY_KEY_SECRET`| Razorpay Key Secret | Optional |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook secret for HMAC signature verification | Optional |
| `RAZORRC_MERCHANT_NAME` | Merchant business name shown in Topbar | `Kettle & Co.` |

---

## How to Use RazorRC: Feature Walkthrough

### 1. Merchant Dashboard (`/`)
- **Money in Motion Funnel:** Review the 5-stage continuous recovery band (`Recovered`, `In flight`, `Awaiting customer`, `Not yet actioned`, `Written off`).
- **Window Switching:** Toggle between **7D**, **14D**, and **30D** whole-calendar windows to watch KPIs, deltas, and the daily trend chart synchronously recompute.
- **AI Insight Panel:** Review proactive opportunities (e.g. batching salary-day re-presentments for a 2.4x capture lift) and issuer anomaly alerts.

### 2. Recovery Queue (`/queue`)
- **Triage & Filter:** Switch views using presets (`Needs approval`, `In flight`, `Awaiting customer`, `Closed`) or filter by payment method, failure reason, and risk tier.
- **Sort by Exposure:** Click **AMOUNT** to place high-ticket failures (e.g., ₹66,300) at the top of the working queue.
- **Decision Drawer:** Click any transaction row to open the side drawer. Inspect the **7-signal deterministic recovery score** (failure baseline, customer payment history, retry fatigue, ticket size, mandate status, rail speed, and payday proximity).

### 3. Human-in-the-Loop Actions
Inside any open job drawer, operators have three explicit actions:
- **Approve Recommendation:** Confirms the scheduled action (e.g., "Retry on 1 Sep" for payday re-presentment, "Request new card", or "Offer UPI"). Immediately updates status to `Scheduled`.
- **Retry Now:** Immediately triggers a manual retry attempt.
- **Stop Automation:** Suppresses automated retries with a mandatory reason, clearing future scheduled steps.

### 4. AI Copilot & Automation Playbooks (`/copilot`)
- **Recommendation Queue:** Review batch recommendations clustered by action type with average confidence scores and volume share bars.
- **Automated Playbooks:** Toggle and audit rule sets:
  - *Payday re-present* (`pb_payday`): Holds insufficient-funds failures until salary credit windows.
  - *Issuer downtime hold* (`pb_downtime`): Halts retries during bank outages and drains in small batches upon recovery.
  - *Card refresh* (`pb_card_refresh`): Requests updated card details when dead instruments fail.
  - *Checkout drop-off rescue* (`pb_checkout_dropoff`): Sends fresh hosted checkout links within minutes of OTP abandonment.
  - *High-value manual desk* (`pb_high_value`): Automatically gates any failure over ₹50,000 for human review.
- **Gemini Advisory Chat:** Ask free-form questions about your recovery data. Customer PII (emails, phone numbers, card digits) is **strictly redacted client-side** before any context reaches the model.

### 5. Analytics & Retry Economics (`/analytics`)
- **Where the Money Leaks:** Failure reason rankings and revenue loss distribution.
- **Rail Effectiveness:** Capture rates across Cards, UPI, Netbanking, e-Mandates, and Wallets.
- **Attempt Effectiveness & Retry Fatigue:** Evaluates marginal recovery yield across attempt rungs (Sequence 1 to 4+) against the **8% decision floor**, preventing futile charges, gateway fee waste, and card network penalties.

### 6. Append-Only Audit Trail (`/audit`)
- **Unalterable Compliance:** Backed by SQLite database triggers that reject any `UPDATE` or `DELETE` statement.
- **Full Attribution:** Every human approval, automated sweep, and playbook toggle is stamped with operator identity, timestamp, and metadata.
- **Audit Export:** Click **Export view** to download a clean CSV with formula-injection protection and RFC-compliant CRLF line endings.

---

## Buildathon Submission Video & Pitch Package

The complete second-by-second storyboard, camera cues, and word-for-word narration script for the 5-minute submission video are located in:
👉 [`docs/SUBMISSION_PITCH_PACKAGE.md`](docs/SUBMISSION_PITCH_PACKAGE.md)

---

## Download a Build (GitHub Releases)

Pre-built binaries are attached to releases: [`https://github.com/mrfrosty7007/RazorRC/releases`](https://github.com/mrfrosty7007/RazorRC/releases)

| Platform | Artifact |
| :--- | :--- |
| Windows 10/11 (x64) | `RazorRC_1.0.0_x64-setup.exe` — NSIS installer |
| macOS, Linux | Web version (`pnpm dev` or `pnpm build`) |

### Windows Build Requirements
Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload and [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Then:
```powershell
rustup default stable-msvc
pnpm install
pnpm app:build
```

### Developing on Linux or macOS
Install standard Tauri v2 system packages (`libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev` on Debian/Ubuntu; Xcode Command Line Tools on macOS), then run `pnpm app:dev` or `pnpm dev`.

## Built With

**React 18** and **TypeScript** — the console is a lot of stateful tables, drawers and filters, and strict TypeScript is what keeps the paise-versus-rupees and status-taxonomy mistakes from reaching the screen. Every Rust struct that crosses the bridge has a matching interface in `src/domain/types.ts`.

**Tauri v2** — a desktop shell with a per-command permission model. The webview is granted `core:default` and nothing else, so the frontend cannot touch the filesystem, spawn a shell or make an HTTP request; the only way to the database is through the sixteen audited commands. That is a security property Electron would not have given for free.

**Rust** — the recovery engine, the scoring rules, the sweep thread and the store. Determinism and an append-only trail are the product claims, and both are easier to guarantee in a typed language with real transactions and a test suite that runs without a UI.

**SQLite** (rusqlite, bundled) — local, transactional and inspectable. `STRICT` tables, WAL journaling, foreign keys on, and triggers that make `audit_events` reject updates and deletes outright.

**Tailwind CSS** — a small set of semantic tokens (`canvas`, `surface`, `raised`, `hairline`, `content`, `azure`, `mint`, `amber`, `coral`) rather than ad-hoc hex values, which is what keeps the dark fintech theme coherent across five pages.

**Recharts** — the trend, mix and effectiveness charts, themed against the same tokens so the visualisations do not look bolted on.

**Vite** — dev server and bundler, with the Tauri dev URL wired to port 1420.

## Architecture

The React app never talks to SQLite. It talks to a `DataSource` — six repository interfaces defined in `src/data/repositories.ts` — and `src/data/index.ts` picks the implementation once, at module load: the Tauri adapter when running inside the desktop shell, the seed adapter otherwise. Set `VITE_FORCE_SEED=1` to keep the seeded data while running the shell. Every page is written against the interface, so no component knows or cares which side of the bridge its data came from.

On the Rust side, `AppState` exposes exactly two ways to reach the database, `read` and `write`. A write opens a transaction, and the change and its audit event commit together or not at all. There is no third path, which is what makes "every action is in the trail" a property of the code rather than a promise in this README. The webview cannot bypass it either: `capabilities/default.json` grants only `core:default`, so there is no filesystem, shell or HTTP access in the frontend at all.

```
src/
  app/            router and route metadata
  components/     ui primitives, domain components, charts, layout
  data/           repositories, seed adapter, tauri adapter, fixtures
  domain/         shared types, formatting, taxonomy labels
  features/       one folder per page
  hooks/          useQuery / useAction against the DataSource
src-tauri/src/
  domain.rs       the shared model, mirrored field-for-field in TypeScript
  db/             store, migrations, jobs, audit, metrics, playbooks
  recovery/       rules (scoring), engine (sweep thread), insights
  state.rs        read / write — the only two doors to the database
  commands.rs     the sixteen commands the adapter calls
  bootstrap.rs    default playbooks and the demo dataset
```

Money is stored and moved as integer paise; there is no float anywhere in the money path. Timestamps are fixed-width ISO-8601 UTC millisecond strings, so a `TEXT` column sorts chronologically and SQLite can do the ordering. Schema tables are `STRICT`, `audit_events` is append-only by trigger — an `UPDATE` or `DELETE` against it raises `audit_events is append-only` — and the engine writes nothing on a sweep that finds nothing, because sixty empty events an hour would bury the merchant's own actions.

## The demo dataset

On first run against an empty store the engine ingests 26 failed payments across three chronological cohorts and closes eight of them as recovered. Every row goes through the real `jobs::ingest` path, so the scores, risk tiers, recommended actions and signals on screen are the engine's own output rather than fixtures — and the seeding announces itself in the audit trail as `system.demo_seed`. Set `RAZORRC_DEMO_SEED=0` to start empty.

## Verification status

The application has been extensively validated across both **Windows 11** and **Linux**:
- **Rust Engine & Store Tests:** `128 passed / 0 failed / 0 ignored` across rules, transactions, scheduler, and migrations (`cargo test --manifest-path src-tauri/Cargo.toml`).
- **Data Layer & Consistency Harness:** `503 passed / 0 failed` across five timezones, asserting synchronous agreement between KPI cards, window totals, and trend points.
- **Frontend Type & Bundle Integrity:** `tsc --noEmit` exits `0`, `vite build` bundles cleanly.
- **IPC Contract Parity:** All 16 Tauri commands match the `DataSource` TypeScript signatures field-for-field with camelCase serde serialization.

## Phase 2

Razorpay Test Mode ingestion (a `payment.failed` webhook with HMAC verification, plus a backfill over the Payments API), real action delivery for the retry and reminder channels, and a model provider behind the Copilot. The credential names those need are already in `.env.example`, and the transport boundary is the only thing that has to change: the rules engine, the store and the audit trail are already the shape they need to be.
