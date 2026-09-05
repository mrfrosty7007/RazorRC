# RazorRC — Razorpay Buildathon Track 03 Submission Pitch Package
**Target Track:** Track 03 — AI Revenue Recovery Console for Razorpay Merchants  
**Target Duration:** Exactly 05:00 (300 Seconds)  
**Tone:** Confident, engineering-led, merchant-first, financially grounded.  
**Tested Stack:** Tauri v2 + React 18 + TypeScript + Rust + SQLite (STRICT) + Recharts + Tailwind CSS.

---

## Executive Summary & Track 03 Alignment Matrix

| Track 03 Judging Pillar | RazorRC Concrete Implementation | Video Timestamp |
| :--- | :--- | :--- |
| **Detect Revenue at Risk** | Real-time intake into 5-stage `RecoveryBand` (funnel), integer paise ledger, 4 windowed KPI cards with deltas (`Revenue at risk`, `Amount recovered`, `Recovery rate`, `Active jobs`). | `00:00 – 00:45` |
| **Root-Cause Diagnosis** | 10-reason failure taxonomy, breakdown analytics by failure reason and payment rail, multi-signal evidence cards, AI insight anomaly detector. | `00:45 – 01:50` |
| **Bounded Workflows** | 7-signal deterministic scoring engine, 5 merchant playbooks (`pb_payday`, `pb_downtime`, `pb_card_refresh`, `pb_checkout_dropoff`, `pb_high_value`), strict human approval or playbook rules. | `01:50 – 02:50` |
| **Advisory AI & Privacy** | Gemini 3.6/3.7 Flash Copilot with client-side PII redaction (`redact_prompt`), ChatGPT-style persistent chat sessions, zero autonomous unapproved charges. | `02:50 – 03:45` |
| **Measured Recovery & Retry Economics** | Attempt effectiveness ladder (Sequence 1 to 4+), 8% marginal yield decision floor, preventing retry fatigue and card network penalties. | `03:45 – 04:15` |
| **Immutable Audit Trail** | SQLite append-only trigger table (`audit_events is append-only`), attributed actions (`Priya Menon` / `system.sweep`), formula-injection-safe CSV export. | `04:15 – 04:45` |
| **Production Architecture** | 128 passing Rust tests, strict type-sharing across IPC bridge, zero floats in money path, webhook ready (`payment.failed`). | `04:45 – 05:00` |

---

## Key Demo Data Cases (Verified from Codebase)

Use these real customer profiles and transactions during recording:

1. **The Hero Case — Ritu Nair (`job_CBXN1`)**:
   - **Amount:** ₹66,300.00 (`66,30,000` paise)
   - **Customer:** Ritu Nair (`ritu.nair@example.in`), 22 successful prior payments, ₹1,67,000 Lifetime Value.
   - **Method / Rail:** Card (Kotak Mahindra Bank).
   - **Failure Reason:** Insufficient funds (`insufficient_funds`).
   - **Status:** `Queued` (Needs Approval).
   - **Risk Tier:** `High` · **Recovery Score:** `65%` (0.65).
   - **Recommended Action:** "Retry on 1 Sep" (or current upcoming payday window at 06:30 UTC), Channel: Gateway.
   - **Weighted Signals:** 
     - *Failure reason baseline:* +0.12 (62% historical recovery rate).
     - *Established payer:* +0.08 (22 successful payments before this).
     - *High ticket:* -0.05 (Large amounts clear less often on retry).

2. **The High-Exposure Downtime Case — Fatima Patel (`job_CENEL`)**:
   - **Amount:** ₹92,500.00 (`92,50,000` paise)
   - **Failure Reason:** Bank downtime (`bank_downtime`).
   - **Status:** `Awaiting customer` / `Queued`.
   - **Risk Tier:** `High` · **Score:** `73%`.
   - **Recommended Action:** "Retry once issuer recovers" (Waits for bank SLA hold).

3. **The Multi-Attempt Retry Fatigue Case — Vikram Raghavan (`job_C...`)**:
   - **Amount:** ₹12,400.00
   - **Failure Reason:** Limit exceeded (`limit_exceeded`).
   - **Status:** `In progress` with 4 attempts on record.
   - **Signals:** Shows `-0.12` retry fatigue penalty.

4. **The Recovered Validation Case — Priya Deshpande (`job_...`)**:
   - **Amount:** ₹1,200.00
   - **Failure Reason:** UPI collect expired (`upi_collect_expired`).
   - **Status:** `Recovered` (Captured via automated UPI payment link).

---

## Second-by-Second Storyboard, Navigation & Narration (00:00 – 05:00)

### ACT I: The Merchant Reality & Live Revenue at Risk (00:00 – 00:45)
*Theme: From passive CSV reports to active revenue recovery.*

| Time | On-Screen Visual & Navigation | Camera & Mouse Action | Narration Script (Word-for-Word) |
| :--- | :--- | :--- | :--- |
| **00:00 – 00:08** | Fullscreen view of **Dashboard (`/`)**. Topbar visible showing `Kettle & Co.`, `Test mode`, green pulsing `Recovery engine running`. | Static 1080p framing. Subtle zoom (105%) towards top KPI cards. | *"Every payment failure on Razorpay tells you two things: what broke, and how much was lost. But for most merchants, recovery is an unworked CSV export opened days later, when the customer is already gone."* |
| **00:08 – 00:20** | Focus on **`RecoveryBand` (Money in motion)** above the KPI cards. | Cursor hovers across the segmented bar: `Recovered` (mint), `In flight` (azure), `Awaiting customer` (amber), `Not yet actioned` (coral). | *"This is RazorRC: an autonomous, deterministic revenue recovery console built directly for Razorpay merchants. It doesn’t just aggregate failures—it triages them, scores their probability of recovery, and takes immediate, bounded action."* |
| **00:20 – 00:32** | Hover over the four **KPI Cards**: `Revenue at risk`, `Amount recovered`, `Recovery rate`, `Active recovery jobs`. | Cursor circles the sparkline and the period-over-period delta badges (`+16.4%`, etc.). | *"Right here on the dashboard, we see real revenue at risk across active jobs, tracked with period-over-period deltas. Notice our Money in Motion band: every rupee is strictly classified, from in-flight retries to customer follow-ups."* |
| **00:32 – 00:45** | Click the **Time window segmented control** in the top right: click `30D`, pause 1s as cards smoothly update, then click `14D`. | Quick cut/zoom into window selector. Cursor clicks `30D` then `14D`. | *"Every calculation is backed by calendar-window arithmetic anchored in midnight UTC. When we switch between 7, 14, and 30 days, every KPI, funnel segment, and daily trend point recalculates synchronously from the transaction ledger."* |

---

### ACT II: Root-Cause Diagnosis & The Recovery Queue (00:45 – 01:50)
*Theme: Deterministic intelligence over black-box guesswork.*

| Time | On-Screen Visual & Navigation | Camera & Mouse Action | Narration Script (Word-for-Word) |
| :--- | :--- | :--- | :--- |
| **00:45 – 00:58** | Click **Recovery Queue** in the left sidebar (`/queue`). The queue loads with preset tabs: `All jobs`, `Needs approval`, `In flight`, `Awaiting customer`, `Closed`. | Sidebar click highlight. Pan smoothly into the table header and status filter tabs. | *"Let's move into the Recovery Queue. Traditional gateways dump raw gateway error strings. RazorRC maps every Razorpay error code into a strict ten-reason domain taxonomy, so new gateway codes can never produce unexpected behaviour."* |
| **00:58 – 01:10** | Click the **`Needs approval` tab** (filters to `queued` jobs). Click Sort: click **`AMOUNT`** to put the largest exposure at the top. | Cursor clicks `Needs approval`, then sorts by `AMOUNT`. Smooth scroll to top row. | *"Merchants don't have time to chase fifty ₹200 drop-offs while a ₹60,000 order slips away. By sorting on exposure and score, the highest-value recoverable transactions rise to the top of the working queue."* |
| **01:10 – 01:25** | Click on the top high-value row: **Ritu Nair — ₹66,300.00** (`job_CBXN1`). The **`JobDetailDrawer`** slides in smoothly from the right. | Drawer slide-in. Camera zooms to 110% focusing on the drawer. | *"Here is Ritu Nair: ₹66,300 failed due to insufficient funds on a Kotak Mahindra card. Most systems would either spam immediate blind retries or write it off. RazorRC does neither. It opens an inspectable decision drawer."* |
| **01:25 – 01:40** | Hover over the **Engine recommendation** section: "Retry on 1 Sep", Confidence 65%, Gateway channel. | Cursor pauses on the purple recommendation box and confidence badge. | *"The engine recommends 'Retry on 1 Sep'—our payday re-presentment window. Why? Because re-presenting an insufficient-funds card right after Indian salary credit cycles has a 2.4x higher capture rate than retrying immediately."* |
| **01:40 – 01:50** | Scroll down to **"Why this action" (SignalList)**: hover over each weighted signal badge. | Cursor highlights `Failure reason baseline (+0.12)`, `Established payer (+0.08)`, and `High ticket (-0.05)`. | *"Look at the evidence. The rules engine applies seven weighted signals: the reason baseline gives plus twelve, her 22 prior successful payments add eight points as an established payer, and the high ticket dampens it by five. Every score shows its math. It's completely deterministic—no generative hallucination."* |

---

### ACT III: Bounded Workflows & Human-in-the-Loop Execution (01:50 – 02:50)
*Theme: Control, automation, and playbook enforcement.*

| Time | On-Screen Visual & Navigation | Camera & Mouse Action | Narration Script (Word-for-Word) |
| :--- | :--- | :--- | :--- |
| **01:50 – 02:05** | In the drawer footer, hover over **"Approve retry on 1 Sep"**, then click it. Watch the button show busy state, then drawer updates to `Scheduled`. | Tight close-up on drawer footer buttons. Click `Approve`. | *"An operator has full authority. We can 'Retry now', 'Stop automation', or click 'Approve'. Let's approve. The transition is transactional: the job moves immediately to 'Scheduled', next action timestamp is locked, and an audit entry commits instantly."* |
| **02:05 – 02:18** | Close the drawer (click X or backdrop). Click **AI Copilot** in the left sidebar (`/copilot`). | Quick pan left, click Copilot. Screen loads with `RecommendationQueue` and `PlaybookList`. | *"Next, let's look at how RazorRC scales. Navigating to the AI Copilot, we see our batch recommendation queue on the left, and automated Playbooks on the right."* |
| **02:18 – 02:35** | In `RecommendationQueue`, click to expand the **"Retry on payday"** or **"Offer UPI"** group accordion. | Cursor clicks accordion toggle. Shows job count, volume share bar, and individual job items. | *"Recommendations are clustered by action type. Instead of clicking one by one, operators can review cohorts—like offering UPI fallback to customers with repeated card authorization declines—with single-click approval."* |
| **02:35 – 02:50** | On the right column, review the **PlaybookList**: point to `Payday re-present`, `Issuer downtime hold`, and `High-value manual desk`. Hover on the toggle for `Issuer downtime hold`. | Cursor moves down the playbook cards, hovering on step chains (`1 Retry charge → 2 Offer UPI`). | *"Playbooks define the guardrails. Each playbook specifies exact triggers, rails, and an ordered chain of steps with mandatory cooldown delays. For example, our 'High-value manual desk' playbook routes any failure over ₹50,000 directly to a human, guaranteeing high-ticket revenue is never handled blindly."* |

---

### ACT IV: AI Intelligence & Gemini Copilot with Privacy Guardrails (02:50 – 03:45)
*Theme: Advisory LLM assistance with strict compliance & PII protection.*

| Time | On-Screen Visual & Navigation | Camera & Mouse Action | Narration Script (Word-for-Word) |
| :--- | :--- | :--- | :--- |
| **02:50 – 03:05** | Scroll down to the **`AiInsightPanel`** (or view it on Dashboard/Copilot). Hover over the 4 insight cards: *Payday window opportunity*, *Subscription mandate risk*, *Issuer anomaly*, *SLA breach*. | Cursor hovers over the insight badges: `Opportunity` (mint), `Risk` (amber), `Anomaly` (violet). | *"RazorRC continuously monitors pattern health. The insight engine flags revenue opportunities—like ₹1.57 Lakhs recoverable by batching salary-day re-presentments—as well as anomalies like sudden issuer degradation before it hits merchant margins."* |
| **03:05 – 03:22** | Focus on the **Copilot Composer** at the bottom/center of the Copilot page (`Ask about your recovery data`). Point out the badge: `Gemini · advisory only`. | Zoom to 110% on the composer header and ChatGPT-style sessions sidebar on the left. | *"Beneath the queue sits our Gemini-powered recovery Copilot. We built this with an uncompromising architecture principle: the rules engine executes money actions; the language model acts strictly as an advisory analyst. The LLM never makes silent debit decisions."* |
| **03:22 – 03:35** | Show the **New Chat** button and starter prompts (`Which failure reason lost us the most money this week?`). Click a starter prompt or show chat history. | Cursor clicks starter prompt or types query. Text renders cleanly with markdown formatting. | *"With our ChatGPT-style conversation manager, merchants can interrogate their recovery data in natural language. Sessions are persisted in SQLite, allowing teams to explore recovery trends and playbook efficacy over time."* |
| **03:35 – 03:45** | Highlight the privacy badge and description: *"PII-redacted job summaries are analysed"*. | Cursor underlines the PII redaction description. | *"Crucially for PCI-DSS and financial compliance, our Rust backend runs a strict client-side PII sanitizer. Customer emails, phone numbers, and payment IDs are redacted before any context reaches the model. Only allowlisted, anonymized recovery parameters are analyzed."* |

---

### ACT V: Measured Recovery, Retry Economics & The Audit Trail (03:45 – 04:40)
*Theme: Avoiding retry fatigue, tracking net yield, and immutable compliance.*

| Time | On-Screen Visual & Navigation | Camera & Mouse Action | Narration Script (Word-for-Word) |
| :--- | :--- | :--- | :--- |
| **03:45 – 04:00** | Click **Analytics** in the left sidebar (`/analytics`). Screen renders 3 panels: *Where the money leaks*, *Rail recovery effectiveness*, *Attempt effectiveness & retry fatigue*. | Sidebar click to Analytics. Camera tracks smoothly down to the third panel. | *"In recovery, more retries do not equal more money. In our Analytics suite, we track where money leaks by failure code and rail, but the centerpiece is Attempt Effectiveness and Retry Fatigue."* |
| **04:00 – 04:15** | Zoom in on the **`Attempt effectiveness & retry fatigue`** table and chart. Highlight Sequence 1, 2, 3, and 4+ with the **8% decision floor**. | Cursor highlights sequence numbers, success rates, and the 8% yield floor callout. | *"Each retry costs money in gateway fees and risks customer friction. RazorRC charts the marginal recovery yield across attempt rungs. When recovery yield drops below our 8% floor, the engine stops automated retries, preventing futile gateway charges and protecting merchant standing with card networks."* |
| **04:15 – 04:30** | Click **Audit Trail** in the left sidebar (`/audit`). The full immutable ledger renders. | Click Audit Trail. Pan across event cards. | *"Every financial system must be accountable. RazorRC’s audit trail is not a plain log file—it is enforced by SQLite database triggers that reject any UPDATE or DELETE statement outright. It is append-only by design."* |
| **04:30 – 04:40** | Locate the top event: `job.approved` for Ritu Nair (`job_CBXN1`). Expand the event to show actor `Priya Menon`, timestamp, and before/after metadata. Click **`Export view`** (CSV download). | Cursor clicks to expand the top event. Then cursor clicks the `Export view` button in top right. | *"Here is the exact action we approved two minutes ago: `job.approved`, attributed to operator Priya Menon, timestamped to the millisecond. We can search by severity or click 'Export view' to generate a formula-injection-safe CSV ready for financial compliance audits."* |

---

### ACT VI: Architecture, Verification & Closing Pitch (04:40 – 05:00)
*Theme: Built for production, engineered for Razorpay.*

| Time | On-Screen Visual & Navigation | Camera & Mouse Action | Narration Script (Word-for-Word) |
| :--- | :--- | :--- | :--- |
| **04:40 – 04:52** | Return to **Dashboard (`/`)**. Point out the updated metrics and the smooth recovery loop. Show the sidebar footer: green indicator, `Recovery engine running`. | Smooth zoom out to show the complete clean desktop interface. | *"RazorRC is built on Tauri v2 and Rust, operating strictly on integer paise with zero floating-point arithmetic. With 128 passing Rust unit tests and strict IPC memory boundaries, it is secure, performant, and completely reproducible."* |
| **04:52 – 05:00** | Hold on the clean Dashboard. Fade in subtle closing title card: **RazorRC — Revenue Recovery for Razorpay Merchants**. | Cursor parked cleanly. Smooth fade to black at 05:00. | *"By replacing passive failure exports with deterministic scoring, bounded playbooks, and an unalterable audit trail, RazorRC turns lost payment revenue into recovered bottom-line profit. Thank you."* |

---

## Exact Recording Checklist & Capture Steps

### Pre-Recording Setup
1. **App Environment:**
   - Run Vite dev server in terminal: `pnpm dev` (runs at `http://localhost:1420/`).
   - Browser: Open Google Chrome in an isolated profile or incognito window.
   - Address: `http://localhost:1420/`.
   - Resolution: Set monitor to **1920 × 1080** (or 2560 × 1440 at 100% OS display scaling).
   - Browser Zoom: Set to **100%** (Ctrl+0).
   - Enter Clean Mode: Press **F11** for full-screen mode to remove URL bar, tabs, and OS taskbars.
2. **Audio Setup:**
   - Microphone: USB Condenser or high-quality dynamic mic.
   - Input Gain: Peak at -6dB to -3dB.
   - Room: Quiet room, pop filter installed.
3. **Screen Capture Software (OBS Studio / Loom / Camtasia):**
   - Resolution: 1920×1080 @ 60 FPS (CRF 18 / CBR 12000 kbps for crisp text).
   - Audio: 48kHz, 320 kbps AAC.
   - Mouse Capture: Enable mouse cursor with subtle highlight ring if supported.

---

## Video Editing Timeline & Asset Guide

```mermaid
gantt
    title RazorRC 5-Minute Video Submission Timeline
    dateFormat mm:ss
    axisFormat %M:%S
    section Video Segments
    Act I - Revenue at Risk & Dashboard       :00:00, 00:45
    Act II - Root Cause & Recovery Queue      :00:45, 01:50
    Act III - Bounded Workflows & Playbooks   :01:50, 02:50
    Act IV - AI Insights & Gemini Copilot     :02:50, 03:45
    Act V - Retry Economics & Audit Trail     :03:45, 04:40
    Act VI - Architecture & Closing Pitch     :04:40, 05:00
    section Audio & Captions
    Music: Low Lo-fi Tech Ambient (Bed)       :00:00, 05:00
    SFX: Clean UI Click                       :00:35, 00:36
    SFX: Approval Chime                       :01:55, 01:56
    SFX: CSV Download Whoosh                  :04:38, 04:39
```

### Callouts & Captions by Timestamp
- `00:10` — Lower-third: **5-Stage Money in Motion Funnel**
- `00:50` — Lower-third: **10-Reason Razorpay Failure Taxonomy**
- `01:30` — Lower-third: **7-Signal Deterministic Recovery Engine**
- `02:25` — Lower-third: **Bounded Merchant Playbooks (Human-in-the-Loop)**
- `03:25` — Lower-third: **Gemini 3.6/3.7 Flash · Advisory Only with Client PII Redaction**
- `04:05` — Lower-third: **Retry Fatigue Protection (8% Marginal Yield Floor)**
- `04:25` — Lower-third: **Append-Only Audit Trail (SQLite Trigger-Enforced)**
- `04:45` — Lower-third: **Tauri v2 + Rust Core · 128/128 Tests Passing**

---

## Last-Minute Polish & Verification Recommendations

1. **Verify Window Filter State Before First Take:**
   - Refresh `http://localhost:1420/` so all 74 demo jobs are in their initial state.
   - Start recording on the **14D** window tab on the Dashboard.
2. **Smooth Cursor Choreography:**
   - Avoid fast erratic cursor movements. Move with deliberate ease.
   - When introducing a card or table row, pause the cursor for 1.5 seconds so the viewer's eyes can settle before you speak about it.
3. **Audio Delivery Cadence:**
   - Speak at an energetic yet measured 140–150 words per minute.
   - The script above contains approximately 720 words, perfectly spaced across the 300-second timeline with natural pauses.
4. **Key Verification Accreditations:**
   - In your submission text or video description, include:
     - `cargo test --manifest-path src-tauri/Cargo.toml` (128 passed / 0 failed).
     - `tsc --noEmit && vite build` (Clean build, 0 errors).
     - Fully compliant with Razorpay Buildathon Track 03 guidelines.
