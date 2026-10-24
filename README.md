# Checksum

Bank-statement ingestion service: upload a statement, get back deduplicated, categorized
transactions and a balance reconciliation that tells you if rows are missing.

**Supported statements (CSV):** HDFC, SBI. SBI exports can be tab- or comma-delimited, oldest- or
newest-first. XLS/PDF exports are not supported yet. Adding a bank means one file implementing
`StatementParser` (see `src/parsers/`) plus any new narration patterns in `src/normalize/narration.ts`.

## Architecture

```
POST /accounts/:id/imports ──► stage file in Postgres (status=queued) ──► enqueue (BullMQ/Redis)
        │ 202 + statusUrl                                                     │
        ▼                                                                     ▼
GET  /accounts/:id/imports/:importId  ◄── status ◄── worker: parse → fingerprint → categorize → reconcile
   queued → processing → done | failed                          └─ one DB transaction, ON CONFLICT dedupe
```

Design decisions worth knowing:

- **Money is integer paise** everywhere. No floats.
- **Idempotency lives in the database**: `UNIQUE(account_id, file_hash)` for files and
  `UNIQUE(account_id, fingerprint)` for rows, so concurrent uploads can't double-insert.
- **Fingerprint includes the running balance**, so two genuine identical payments on one day
  stay distinct while the same row in two overlapping statements collapses.
- **Reconciliation** walks the running balance; a mismatch means a transaction is missing, and
  the diff says how much.
- **Retries**: transient errors retry with exponential backoff; malformed files (`PermanentError`)
  fail immediately. Exhausted jobs are dead-lettered and the import is marked `failed` with the reason.
- **Crash recovery**: the upload is durable in Postgres before it is enqueued; a sweeper in the
  worker re-enqueues anything stuck `queued`/`processing` for over 5 minutes.
- **Raw rows are never mutated**; derived data lives in `transactions`.

## Run it

```bash
npm install
npm test                      # in-memory + PGlite (real Postgres engine); no Docker needed
npm run dev                   # in-memory store, in-process queue: zero setup

# everything in containers: Postgres + Redis + API (:3000) + worker
docker compose up -d --build
docker compose up -d --build --scale worker=3   # more workers

# or infra in Docker, app from source
docker compose up -d postgres redis
export DATABASE_URL=postgres://ledger:ledger@localhost:5432/checksum REDIS_URL=redis://localhost:6379
npm run dev                   # API (enqueues only)
npm run worker                # one or more workers

# optional: run the whole suite against real servers
TEST_DATABASE_URL=$DATABASE_URL REDIS_URL=$REDIS_URL npm test   # WARNING: truncates tables
```

If you pulled an earlier version, recreate the DB (`docker compose down -v`): the schema changed.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/accounts/:id/imports` | multipart `file`; 202 queued, 200 duplicate file, 422 unknown format |
| GET | `/accounts/:id/imports?limit=` | history, newest first, with reconciliation status per import |
| GET | `/accounts/:id/imports/:importId` | status, attempts, error, row counts, reconciliation |
| GET | `/accounts/:id/transactions?category=` | |
| GET | `/accounts/:id/summary` | spend per month per category, in paise |
| PUT | `/accounts/:id/merchants/:merchant/category` | `{ "category": "..." }`; re-labels history |
| GET | `/categories` | categories the rules can assign |

## Frontend

`web/` is a React + Vite app: monthly overview (spend chart, category breakdown), searchable
transactions with one-click merchant relabelling, and an imports page with live processing status and
the reconciliation breakdown. It imports its API types from `src/import/records.ts`, so the two can't drift.

```bash
npm --prefix web install
npm run dev        # API on :3000
npm run web:dev    # UI on :5173, proxies API calls to :3000
```

In production the API serves `web/dist` itself (`npm run web:build`, then `npm start`), and the Docker
image builds it in, so `docker compose up -d --build` gives you the UI at http://localhost:3000.

## Synthetic data

`npm run gen:statement -- --bank sbi --seed 7 --days 30 --drop 2 > sample.csv` generates a fake
statement (`--bank hdfc|sbi`); `--drop N` removes rows so reconciliation has gaps to find, and
`--reverse` emits SBI newest-first. Never commit real statements.
