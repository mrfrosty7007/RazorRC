# ReviveAI

An AI revenue-recovery console for Razorpay merchants. Failed payments arrive as a worked queue rather than a CSV: a deterministic engine scores each failure, chooses the next action, schedules it, and records every decision in an append-only audit trail.

Built for the Razorpay AI Buildathon 2026, Track 3 — as an internal merchant tool would be built, not as a demo.

## What it does

A payment fails. Razorpay tells you the code and the amount, and that is where most dashboards stop. ReviveAI takes it three steps further: it decides whether this failure is worth chasing, decides *how* to chase it, and remembers who decided what.

The recovery score is a rules engine, not a model — seven weighted signals over the payment, the customer's history and the failure taxonomy, each contributing a nudge in one direction or the other. Every recommendation carries the signals that produced it, so a merchant can disagree with the reasoning rather than with a number. The same determinism is what makes the engine testable: given a payment, the score and the recommended action are always the same, and the test suite asserts on them directly.

Five surfaces:

**Dashboard** — revenue at risk, amount recovered, recovery rate and active jobs, each with a period-over-period delta; the live recovery queue; an insight panel; and a recovery timeline.

**Recovery Queue** — filterable by status, failure reason, method and risk tier, with a drawer per job showing the signal breakdown, the attempt history, and the three actions an operator can take (approve the recommendation, retry now, suppress with a reason).

**AI Copilot** — a query surface over the merchant's own recovery data. There is deliberately no scripted chat: with no model provider configured the composer renders a "not connected" state instead of faking an answer.

**Analytics** — trend, failure mix, method mix, and attempt effectiveness, all windowed.

**Audit Trail** — every state transition, every operator action, every sweep that did something, searchable and filterable by severity.

## Running it

```bash
npm install
npm run app:dev      # Tauri shell + Vite dev server
```

The webview alone also runs, against the seeded browser dataset, which is useful for UI work:

```bash
npm run dev
```

To produce an installer:

```bash
npm run app:build    # runs `npm run build` first, then bundles
```

Copy `.env.example` to `.env` before the first run if you want to override the merchant identity, the operator name recorded in the audit trail, or the database location. Every value has a working default, and a missing `.env` is normal — the app starts without Razorpay credentials and says so in the sidebar rather than refusing to launch.

Useful scripts: `npm run typecheck` (`tsc --noEmit`), `npm run lint`, and on the Rust side `cargo test --manifest-path src-tauri/Cargo.toml`, which exercises the engine, the store and the migrations without a webview.

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

On first run against an empty store the engine ingests twelve failed payments and closes four of them as recovered. Every row goes through the real `jobs::ingest` path, so the scores, risk tiers, recommended actions and signals on screen are the engine's own output rather than fixtures — and the seeding announces itself in the audit trail as `system.demo_seed`. Set `REVIVEAI_DEMO_SEED=0` to start empty.

## Verification status

`cargo` and `npm` were unavailable in the environment this was authored in, so the Rust crate and the TypeScript app have been verified by static review and scripted consistency checks rather than by a build: the sixteen `generate_handler!` names match the adapter's command list exactly; every `module::item` call resolves to a declared public item; every table and column named in SQL exists in the schema; and the serde field names on every Rust struct match the TypeScript interface it crosses the bridge as. Run `npm install && npm run build` and `cargo test` first on a machine with toolchains before trusting it further.

## Phase 2

Razorpay Test Mode ingestion (a `payment.failed` webhook with HMAC verification, plus a backfill over the Payments API), real action delivery for the retry and reminder channels, and a model provider behind the Copilot. The credential names those need are already in `.env.example`, and the transport boundary is the only thing that has to change: the rules engine, the store and the audit trail are already the shape they need to be.
