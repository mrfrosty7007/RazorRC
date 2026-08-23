# ReviveAI — end-to-end validation report

Date: 24 August 2026 · Scope: the whole product, front to back · Verdict: **ship-ready on the web/seed path; the Windows desktop build still needs one run on Windows**

---

## 1. How this was tested, and what could not be run

The brief was "do not only review code, actually test the running application", so wherever something could be executed, it was. Four suites were built and run, **453 assertions in total, all passing**:

| Suite | What it exercises | Result |
| --- | --- | --- |
| Node data-layer harness | The `DataSource` contract, the seed store, every mutation, the deterministic rules engine, window arithmetic, filters, sorting, pagination | **268 / 268** |
| React render harness | Every page and drawer server-rendered against real and degenerate data, asserting on the emitted markup | **113 / 113** |
| SQLite harness | The SQL the Rust fixes changed, executed against real SQLite: migration, ingest, retry economics, KPI/trend agreement, schema guard | **46 / 46** |
| IPC wiring check | All 16 Tauri commands: defined = registered = called, argument names, `serde` casing on struct payloads | **26 / 26** |

The data-layer harness was re-run under `Asia/Calcutta`, `UTC`, `America/Los_Angeles`, `Pacific/Honolulu` and `Pacific/Kiritimati` — 268/268 in each. That sweep is not decoration; it is how two of the bugs below stopped being theoretical.

`tsc --noEmit` exits 0. `vite build` exits 0.

**What could not be executed here, stated plainly.** This environment has no Rust toolchain (`cargo` and `rustc` are absent) and no display, so `cargo test`, `cargo clippy` and `pnpm tauri build` were **never run**, and the packaged desktop window was **never opened**. The Rust changes were validated instead by (a) lifting their SQL verbatim into the SQLite harness and executing it, (b) writing the accompanying `#[test]` functions in the same commit so they run the moment you do have a toolchain, and (c) mechanical symbol-level verification of the command layer. That is good coverage of the part of a Rust change most likely to be wrong, and it is not a substitute for a compile. **You need to run `cargo test` and `pnpm tauri build` on Windows before you trust the installer.**

One caveat on the SQLite harness: the Python stdlib here links SQLite 3.37.2, while rusqlite bundles roughly 3.46. Nothing asserted depends on behaviour that changed between them.

---

## 2. Bugs found and fixed

Twenty-eight numbered entries, grouped by layer; a few of them bundle closely related fixes, so the true defect count is a little higher. Every one is fixed in the working tree — nothing is deferred, and nothing below is a "consider later".

### 2.1 Rust engine and store — 6

**1. The KPI cards and the trend chart measured different windows.** `metrics::dashboard` anchored on `iso_days_ago(days)`, a rolling instant, while `metrics::trend` bucketed by calendar day. A payment that failed in the small hours of the oldest day counted towards "Revenue at risk" but had no bar to sit in, so the card and the chart beneath it differed by a whole job with no way for a merchant to tell which one was lying. Fixed by introducing `clock::iso_window_start(days)` — midnight UTC at the head of a whole-calendar-day window — and routing the dashboard, both breakdowns and retry economics through it. *Files: `src-tauri/src/clock.rs`, `src-tauri/src/db/metrics.rs`.* Proven by SQLite harness §7, which plants a payment one millisecond before the window opens and asserts the trend sums to the at-risk KPI for 7D and 14D, and by the new `the_kpi_cards_and_the_trend_cover_the_same_window` Rust test.

**2. The trend's bucket keys and its range predicate came from separate clock reads.** Two `now()` calls that straddle midnight disagree about which day the window opens on — rare, but it presents as a chart that silently drops its oldest bar. Fixed with `clock::window_day_keys(days)`: one clock read produces the keys, and the predicate is derived from the oldest key rather than computed again. *File: `src-tauri/src/db/metrics.rs`.*

**3. Retry economics discarded exactly the successes it exists to measure.** `attempt_effectiveness` filtered on `p.failed_at`, the day the *payment* failed, when the panel's whole subject is the day the *attempt* ran. A fourth retry, or a card-update email answered a week later, happens long after the failure — so on a 7-day window the slowest and most patient strategies were the ones most likely to fall outside it, which is precisely backwards for a table meant to justify a retry budget. Fixed to `WHERE a.occurred_at >= ?1`, which also let two joins go. *File: `src-tauri/src/db/metrics.rs`.* SQLite harness §6 sets up a payment that failed 20 days ago and recovered yesterday: the old query returned `[]`, the fixed one counts it, and both agree on a 30-day window — the fix narrows nothing.

**4. Webhook ingest reported a dropped payment as a duplicate.** `jobs::ingest` used `INSERT OR IGNORE INTO failed_payments`, which ignores *every* constraint, `CHECK` included. A malformed payload — zero amount, negative amount, an unrecognised failure reason — was swallowed, reported zero rows affected, and was therefore classified as an already-seen redelivery. An ingest that turns lost revenue into a clean-looking no-op is the worst failure mode in the app. Fixed with an explicit `SELECT EXISTS (... razorpay_payment_id = ?1 OR id = ?2)` pre-check inside the same transaction, so a redelivery is recognised as a redelivery and a malformed payment raises. *File: `src-tauri/src/db/jobs.rs`.* SQLite harness §§3–5 cover all four redelivery shapes and three malformed shapes, and record the old `INSERT OR IGNORE` behaviour for the record.

**5. The customers write was an insert-then-update pair.** Replaced with a single `ON CONFLICT (id) DO UPDATE` upsert — one statement, one constraint, no window between the two. *File: `src-tauri/src/db/jobs.rs`.* Harness §2 confirms one row, refreshed lifetime value and refreshed payment count.

**6. An older build would silently open a newer build's database.** Migrations are forward-only, so an old binary run against a file a later release had migrated found every version it knew about already recorded, applied nothing, reported success, and then read and wrote the money ledger through a schema it did not understand. Fixed with `latest_version()` plus a guard in `apply` that refuses the file with an actionable message. Refusing to open is recoverable; the alternative is not. *File: `src-tauri/src/db/migrations.rs`.* Harness §8 plus a new Rust test.

*(A seventh, `sla_minutes` for `BankDowntime`, was found and fixed in an earlier pass and is already in the tree.)*

### 2.2 Seed data layer — 12

This layer matters more than "demo data" suggests. The desktop bundle is Windows-only, so `src/data/index.ts` falls back to the seed adapter for every Linux and macOS user — **this is production code for them**, and its defects are real defects.

**7. Every dashboard delta was a hardcoded constant.** Four literals (`-0.081`, `0.164`, `0.042`, `0.115`) meant all three window filters claimed identical movement and no card budged when you approved a recovery. A number that never moves after you act on it is worse than no number. Fixed: each delta is now measured against the previous equivalent window, computed from the same `WindowTotals` object as the card above it so the two can never describe different quantities, with a no-baseline case that reads as flat rather than as infinite growth.

**8. The recovery rate rose every time the team gave up.** The denominator was `recovered + at risk`, which excludes written-off money — so writing a job off *improved* the headline rate. Fixed to recovered over everything that failed in the window, matching `Totals::recovery_rate` on the Rust side.

**9. Reads came from the immutable fixture, not the mutated store.** `buildMetrics`, `buildTrend`, both breakdowns, retry economics, insights and engine status all closed over the original `JOBS` constant. Approving an action moved the queue row and left every number on the dashboard exactly where it was — the precise thing test area 2 asks about. All seven now take the live store as an argument.

**10. The trend chart was synthesised from a seeded RNG.** Weekend dips, a rising recovery rate, invented attempt counts — a plausible-looking curve with no relationship to the rows in the queue, contradicting the KPIs above it. Rebuilt from the actual jobs: money bucketed on the day the payment failed, attempts bucketed on the day they ran.

**11. Retry economics ignored the window and counted the wrong thing.** It took no `windowDays` at all and derived buckets from `payment.attemptCount` rather than from the attempts themselves. Rebuilt to walk real attempts, respect the window, and bucket on `sequence`.

**12. Both breakdown tables counted written-off money as at risk.** `status !== 'recovered'` should have been `isAtRisk`, so lost money inflated the at-risk column on the Analytics page.

**13. Reads handed out live references.** `settle()` resolved the store's own objects, so a component could mutate the store in place — and the seed build would then behave differently from the packaged app, where the Tauri bridge serialises every result. Now `structuredClone`.

**14. Mutations threw synchronously on an unknown id.** Not being `async`, they raised before a promise existed, so a caller that only attached `.catch` took the whole page down. Now `async`, and `approveRecommendedAction` validates the id up front instead of silently substituting a 15-minute delay for a job it could not find.

**15. Audit event ids were derived from list length.** `evt_local_${auditEvents.length + 1}` collides the moment the list changes for any other reason. Replaced with a monotonic sequence.

**16. Seeded failures only spanned about 13.5 days.** The 14D and 30D filters returned identical figures, which reads as a broken filter rather than a quiet month. Widened to 29.5 days.

**17. The payday label drifted with the browser's ICU build.** `Intl.DateTimeFormat('en-IN', { month: 'short' })` renders September as **"Sept"** in current ICU, so the browser recommended "Retry on 1 Sept" where the Rust engine said "Retry on 1 Sep" — the same payment yielding two different recommendations depending on which runtime loaded the page, in a module whose entire claim is determinism.

**18. The payday label named the day before the retry actually fires.** The same formatter worked in the *runtime's* timezone while the retry is scheduled in UTC. Anywhere west of UTC-6:30 a retry scheduled for 1 Sep 06:30 UTC was labelled "Retry on 31 Aug" — the label contradicting its own schedule. Both are fixed together: `paydayPlan` now returns the delay and the instant it lands on from one calculation, and `dayMonthLabel` formats it with `getUTC*` against a hardcoded `MONTHS` table mirroring `clock::month_abbreviation`. *Files: `src/data/seed/fixtures.ts`, `src/data/adapters/seedAdapter.ts`, `src/data/seed/rulesEngine.ts`.*

Bugs 17 and 18 were caught by running the suite under five timezones rather than by reading the code; a regression check against the pre-fix implementation fails 2 of 4 label assertions under `Asia/Calcutta` and 4 of 4 under `America/Los_Angeles`.

### 2.3 React surfaces — 10

**19. The dashboard drawer held a stale snapshot of the row you clicked.** It stored the whole `RecoveryJob` in state, so after approving an action the drawer still offered "Approve" on a job that was already scheduled — an invitation to a duplicate charge. Now it holds the id and reads the job through `useQuery`, so the drawer reflects the store.

**20. A write refreshed some panels and not others.** The dashboard's `refreshAll` refetched metrics, priority and activity but not the trend, the insights or the open drawer. The subtler kind of stale: the KPI moved and the chart above it did not. All six now refetch.

**21. A failed "Retry now" or "Stop automation" looked exactly like a success.** Both drawers passed only `approveState` down, discarding the pending and error state of the other two writes. Fixed on the dashboard and the recovery queue: whichever write is in flight or has just failed is the one reported.

**22. The queue's filter count read the wrong source.** It counted `filters.search`, but the page merges the debounced term in on its way to the query and never writes it back — so the count was one short and the "Reset" button stayed hidden for anyone whose only filter was a search. Now counts `searchDraft`.

**23. Money and percentages could render as `₹NaN` and `NaN%`.** A malformed IPC payload or a divide-by-zero reaching `formatINR`, `formatPercent`, `formatCount`, `formatPointDelta` or `formatSignedPercent` printed nonsense next to real figures, which destroys trust in every other number on the screen. All seven formatters now degrade a non-finite input to an em dash.

**24. One unparseable timestamp took down the whole page.** `Intl.DateTimeFormat.format` throws `RangeError: Invalid time value`, and these formatters are called deep inside table cells and timelines. A single bad row from the gateway would blank the screen. `formatTime`, `formatDay`, `formatDayTime` and `formatRelative` now return an em dash for a date they cannot read.

**25. `NaN` reached the DOM as `aria-valuenow="NaN"` and `width: NaN%`.** `Math.min`/`Math.max` propagate `NaN`. `Meter` and `ScoreTicks` now guard with `Number.isFinite` and draw an unreadable rate as an empty bar.

**26. An empty table collapsed to zero pixels.** `DataTable` rendered nothing at all when given no rows and no `empty` prop, which reads as a broken page rather than an empty result. It now falls back to a line of text, and both Analytics tables got window-aware empty states so the panels keep their height.

**27. The audit CSV export could produce an empty file, and its escaping was too narrow.** The object URL was revoked in the same tick as the click, which cancels the write in some WebView builds, and the anchor was never in the document. Fixed: the anchor is appended, clicked, removed, and the URL revoked on the next tick. The quoting moved to a testable `src/lib/csv.ts` that adds CRLF line endings and a spreadsheet formula-injection guard — an audit export is the one artefact that leaves this app, and a merchant may hand it to an auditor or open it in Excel.

**28. Four smaller trust defects.** Clicking an audit event whose job had been purged did nothing at all, reading as a broken link; it now explains that the job is gone and the event is still its record. A render crash anywhere blanked the entire app; there is now a route-keyed `ErrorBoundary` inside the shell, so a crash on one page clears when you navigate. The topbar's "Switch merchant account" button announced itself to screen readers and did nothing — the console is scoped to the account whose keys are in the local config, so it is now a label, not a control. And the funnel stage "Still at risk" sat beside a "Revenue at risk" KPI that counts a *different* set of jobs; it is now "Not yet actioned", because two different numbers under near-identical labels is a reconciliation trap.

---

## 3. The ten test areas, and how each was covered

**Startup and database initialisation** — the migration applies cleanly to an empty file, all five tables exist, `failed_payments` is `STRICT`, and the newer-schema guard behaves. Executed against real SQLite. The *window* opening was not observed; that needs Windows.

**Dashboard** — all four KPIs, their deltas, the funnel and the trend are asserted against the store they are derived from, and the "does the dashboard move when data changes" requirement is now covered by construction: three bugs (7, 9, 20) all had the shape "the number does not follow the action", and each has an assertion that would catch its return.

**Recovery queue** — search, every filter axis, sorting, pagination and the drawer are covered by the data harness and rendered by the SSR harness. All seven failure types named in the brief, plus the three the engine also handles, are asserted through the rules engine: correct action, tier, channel, confidence and delay for each of the nine decision rows.

**Recovery actions** — approve, retry now and stop are each asserted to change the job's status, set or clear `nextActionAt`, and append exactly one audit event with the right actor and severity, with the UI state that reports them now wired for all three (bug 21).

**Scheduler** — the due/scheduled/completed/failed transitions are covered at the store level. Wall-clock firing inside a running app is not observable here.

**Copilot** — verified deterministic: same input, same recommendation, across 268 checks and five timezones, including an 84-case sweep over the payday rule. Playbook toggles are asserted to persist and to write an audit event. Nothing is randomised and there is no model call anywhere in the path.

**Analytics** — both breakdowns and retry economics are asserted to agree with the rows they summarise, over each window, with the two bucketing bugs (3, 11) and the at-risk miscount (12) fixed.

**Audit trail** — every mutation appends an event; the Rust path writes the mutation and its event in one transaction; the table is append-only by schema; search and export are exercised, and export now round-trips through a tested CSV writer.

**Persistence** — asserted at the SQL layer (the schema, the migration bookkeeping, the append-only ledger). An actual quit-and-relaunch was not performed and remains on your list.

**Error handling** — the SSR harness renders every page against an empty store, and the formatter and boundary fixes above are exactly the "invalid data" and "fails gracefully" requirements. Offline and missing-credential behaviour is handled by the seed fallback and the engine-status surface; a live Razorpay outage was not simulated.

---

## 4. A correction to the record

Earlier in this pass I told you that my own first fix to `jobs::ingest` — `ON CONFLICT (razorpay_payment_id) DO NOTHING` — was itself broken, on the reasoning that a webhook redelivery repeats the primary key too and would raise on a constraint the upsert does not name. **I was wrong, and executing it is what showed me.** SQLite tests the upsert's conflict target *before* the table's other unique indexes, so a redelivery repeating both keys is absorbed; and `CHECK` constraints are evaluated before uniqueness, so a malformed payload still raises. That form would have worked.

The explicit pre-check is still what ships, for reasons that survive the correction: it does not lean on an ordering that is an implementation detail rather than a documented guarantee (and the app links a different SQLite build than the one I could test), it also absorbs a reused row id under a new natural key, and it says plainly what it is doing in the file that is the money ledger. But the code comments asserted the false reason, so I rewrote them.

---

## 5. The 30D window filter returning 14D's numbers

The report was that picking 30D on the dashboard produced the same four figures as 14D. Tracing the whole path — button, state, IPC, SQL, render — found **every hop already correct**, and the fault one layer below all of them, in the data.

`SegmentedControl`'s `onChange` sets `windowDays`; `useQuery` lists `[windowDays]` in its dependencies and re-runs on change, dropping any superseded response; `tauriAdapter` passes `{ windowDays }`, which Tauri maps onto `window_days: u32`; `commands.rs` hands that to `metrics::dashboard`, `trend`, `failure_breakdown`, `method_breakdown` and `attempt_effectiveness`, each of which derives its floor from the single shared `clock::iso_window_start(days)`. Nothing discards the argument.

What was wrong is that **the demo dataset was younger than the widest filter.** `DEMO_ROWS` held 12 payments spanning 0.2 to 11.4 days old. Every one of them sits inside the 14-day window, so the 14D and 30D queries selected byte-identical row sets and correctly returned identical answers. The filter worked; there was simply nothing in the fourth week to find. The screen was telling the truth about a dataset that could not distinguish the two.

Three defects were fixed:

**The demo dataset did not span the widest window it offers.** `DEMO_ROWS` is now 26 payments from 0.2 to 28.6 days old, in three cohorts, with older cohorts further along their recovery ladder so the *rate* moves between windows and not just the totals. No row's age falls in a `(N-1, N)` band, because a calendar window's first instant moves with the clock and a row in that band would drift in and out of the window over the course of a day — the figures now hold at every hour.

**Every demo payment claimed exactly one attempt.** `attempt_count` was hardcoded to `1` and attempt rows were seeded only for recovered jobs, so three of the four retry-economics buckets were permanently empty and the panel asserted a 100% first-attempt success rate. Each job now has its ladder laid rung by rung, with the outcome of the last rung matching where the job ended up; the 30D buckets run `[24, 21, 10, 5]`.

**`isoDaysAgo` could not express a fraction of a day.** It used `d.setUTCDate(d.getUTCDate() - days)`, and `setUTCDate` truncates its argument to an integer — so `isoDaysAgo(0.35)`, `isoDaysAgo(0.4)` and `isoDaysAgo(0.7)` all returned the same instant, exactly 24 hours back. Every fractional timestamp in the TypeScript fixture was silently quantised: a retry ladder spaced 0.35 days apart collapsed onto one instant, and a ladder rung on a payment that failed five hours ago landed *before* the failure it was responding to. It is now exact duration arithmetic, matching `clock::iso_days_ago`'s `f64` seconds. Whole-day callers — `windowStart`, the trend bucket keys, the playbook and audit timestamps — are unaffected, confirmed byte-identical across 2,005 comparisons spanning month, year and leap-day boundaries.

One harness expectation was also wrong and had been masked by that truncation: it counted the 30D breakdown against a rolling 30×24h age test while the app uses a calendar window opening at midnight. Those differ by up to a day, so with genuinely fractional ages it disagreed with the app by one job for part of every day. It now uses the app's own rule.

### What the three windows now return

The Rust store, replayed through the real KPI, trend and bucket SQL:

```
 window |      at risk |    recovered |    rate | active | jobs | attempts/seq
     7D |   10,049,000 |      404,000 |   3.86% |      6 |   10 | [8, 7, 2, 1]
    14D |   10,604,000 |    1,789,000 |  12.55% |      7 |   16 | [14, 13, 5, 2]
    30D |   12,864,000 |    4,043,000 |  16.16% |      8 |   26 | [24, 21, 10, 5]
```

The seed adapter, which is what a non-Windows user actually runs:

```
 window |        at risk |    recovered |    rate | active | trend pts | attempts/seq
     7D |         83,996 |       58,599 |  41.09% |      8 |         7 | [19, 9, 3, 3]
    14D |       2,75,891 |     1,23,297 |  30.77% |     22 |        14 | [39, 17, 9, 3]
    30D |       3,98,888 |     3,32,496 |  44.48% |     33 |        30 | [70, 32, 17, 5]
```

Synchronization is asserted per window, not eyeballed: the trend has exactly `windowDays` points; the trend's at-risk and recovered columns each sum to the matching KPI card; the failure and method breakdowns sum to the same at-risk total and count the same jobs; the funnel's segments sum to its own total; and the 14D trend is a suffix of the 30D trend. Both datasets were replayed across the hours of the day — the Rust demo at nine hours, the seed adapter at nine hours × three timezones — to prove none of it depends on when it runs.

### Two things this fix does not do

**An existing database will not pick up the new demo rows.** `seed_demo` runs only when the store has never seen a payment, which is the right rule — it must never overwrite real merchant data. But it means installing this build over an earlier one leaves the old 12-row dataset in place and **the 30D filter will still look broken**. To see the fix, either delete `%APPDATA%\com.reviveai.desktop\recovery.sqlite3` and relaunch, or point the app at a throwaway file with `REVIVEAI_DB_PATH`.

**Nothing in the app settles a job.** `jobs.rs` writes `scheduled`, `suppressed` and `in_progress`, and no code path writes `recovered`, `failed` or `written_off` — the demo seeder is their only author. The recovery rate is therefore real for demo data and would sit at 0% forever on a store fed only by live webhooks. That is a missing feature rather than a regression, it is out of scope for this bug, and `closing_event` in `bootstrap.rs` names the three audit actions a future settle path should reuse.

---

## 6. Remaining risks

**The Rust side has never been compiled.** This is the largest open risk and it is not reducible from here. The SQL is executed and the tests are written, but a type error, a borrow error or a `clippy` denial would only surface on your machine. Run `cargo test` first, then `cargo clippy --all-targets`, then the build.

**The installer has never been produced.** `pnpm tauri build` needs to run on Windows to confirm `ReviveAI_1.0.0_x64-setup.exe`.

**The desktop window has never been opened.** Everything asserted about the React surfaces comes from server-rendered markup, which catches crashes, empty states and formatting but says nothing about layout, focus behaviour, scroll containers or how the dark theme actually looks in a WebView2 window. Walk the five pages once by hand.

**The live Razorpay path is unexercised.** No real webhook has been ingested and no real charge retried. Credentials live in `.env`, and only placeholders are committed. The ingest logic is well covered against synthetic payloads; the HTTP client and signature verification are not covered by execution.

**Two adapters, one rules engine.** `rulesEngine.ts` mirrors `rules.rs`, and two of this pass's bugs were parity drift in that mirror. The harness now pins all nine decision rows and the payday arithmetic on the TypeScript side, and `rules.rs` has the equivalent tests, but nothing *mechanically* enforces that the two stay in step. If you touch one, run both suites.

**The bundle is one 727 kB chunk.** 208 kB gzipped, so it loads fine, but the >500 kB advisory from Vite stands. Not worth code-splitting a desktop app before the demo; worth knowing.

**Documentation placeholders.** The three `docs/screenshots/*.png` and the demo-video link are still placeholders.

---

## 7. Final build status

```
tsc --noEmit ......................... exit 0
vite build ........................... exit 0   (727 kB / 209 kB gzip, one chunk-size advisory)
Node data-layer harness .............. 318 passed / 0 failed   (× 9 hours × 3 timezones = 27 replays)
React render harness ................. 113 passed / 0 failed
SQLite harness (Rust SQL) ............ 46 passed / 0 failed
Rust demo-window replay .............. 0 failed              (× 9 hours of the day)
Tauri IPC wiring ..................... 26 passed / 0 failed
                                       ---
                                       503 passed / 0 failed

cargo test ........................... NOT RUN — no Rust toolchain in this environment
cargo clippy ......................... NOT RUN — same
pnpm tauri build ..................... NOT RUN — Windows-only target, no toolchain
```

Working tree: 21 files modified (+1,421 / −249), plus three new files — `src/components/layout/ErrorBoundary.tsx`, `src/lib/csv.ts` and this report. **Nothing has been committed and no tag has been created** — commits and tags are yours.

Green on everything that can be executed here. The three commands that cannot be are named above, and they are the only thing between this and a signed-off release.
