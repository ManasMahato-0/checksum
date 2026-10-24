-- Money is ALWAYS stored as integer paise (BIGINT). Never floats.

CREATE TABLE accounts (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  bank          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per uploaded file. UNIQUE(account_id, file_hash) makes re-uploads idempotent.
-- Lifecycle: queued -> processing -> done | failed. The upload bytes are staged in
-- file_content so the queue only carries an id, and are cleared once processing finishes.
CREATE TABLE imports (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  file_hash      TEXT NOT NULL,
  filename       TEXT NOT NULL,
  bank           TEXT,
  status         TEXT NOT NULL CHECK (status IN ('queued','processing','done','failed')),
  file_content   BYTEA,
  attempts       INT NOT NULL DEFAULT 0,
  error          TEXT,
  rows_total     INT NOT NULL DEFAULT 0,
  rows_inserted  INT NOT NULL DEFAULT 0,
  rows_duplicate INT NOT NULL DEFAULT 0,
  opening_paise       BIGINT,
  closing_paise       BIGINT,
  total_debits_paise  BIGINT,
  total_credits_paise BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  UNIQUE (account_id, file_hash)
);
-- lets the stale-job sweeper find unfinished imports cheaply
CREATE INDEX idx_imports_unfinished ON imports (created_at) WHERE status IN ('queued','processing');

-- Raw rows are immutable audit data; derived fields live in `transactions`.
CREATE TABLE raw_rows (
  id            BIGSERIAL PRIMARY KEY,
  import_id     BIGINT NOT NULL REFERENCES imports(id),
  row_number    INT NOT NULL,
  raw           JSONB NOT NULL
);
CREATE INDEX idx_raw_rows_import ON raw_rows (import_id);

CREATE TABLE transactions (
  id               BIGSERIAL PRIMARY KEY,
  account_id       BIGINT NOT NULL REFERENCES accounts(id),
  import_id        BIGINT NOT NULL REFERENCES imports(id),
  fingerprint      TEXT NOT NULL,
  txn_date         DATE NOT NULL,
  narration        TEXT NOT NULL,
  channel          TEXT NOT NULL,
  merchant_key     TEXT,
  reference_no     TEXT,
  debit_paise      BIGINT NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise     BIGINT NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  balance_paise    BIGINT,
  category         TEXT NOT NULL,
  category_source  TEXT NOT NULL CHECK (category_source IN ('override','rule','none')),
  category_reason  TEXT,
  -- the dedupe guarantee lives in the database, not just in app code
  UNIQUE (account_id, fingerprint)
);
CREATE INDEX idx_txn_account_date ON transactions (account_id, txn_date);
CREATE INDEX idx_txn_account_category ON transactions (account_id, category);

-- User corrections the categorizer learns from.
CREATE TABLE merchant_overrides (
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  merchant_key  TEXT NOT NULL,
  category      TEXT NOT NULL,
  PRIMARY KEY (account_id, merchant_key)
);

CREATE TABLE reconciliation_breaks (
  id             BIGSERIAL PRIMARY KEY,
  import_id      BIGINT NOT NULL REFERENCES imports(id),
  row_number     INT NOT NULL,
  expected_paise BIGINT NOT NULL,
  actual_paise   BIGINT NOT NULL,
  diff_paise     BIGINT NOT NULL
);
CREATE INDEX idx_recon_breaks_import ON reconciliation_breaks (import_id);
