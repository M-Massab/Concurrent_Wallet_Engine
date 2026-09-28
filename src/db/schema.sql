-- =============================================================
-- DIGITAL WALLET SCHEMA
-- Every constraint here is a safety net for a specific failure:
--   CHECK (balance >= 0)         → Double-spend final defense
--   UNIQUE (idempotency_key)     → Duplicate TX final defense
--   CHECK (sender != receiver)   → Self-transfer protection
--   NUMERIC(18,2)                → No floating-point money bugs
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  username     VARCHAR(100) UNIQUE NOT NULL,
  email        VARCHAR(255) UNIQUE NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- WALLETS
-- One wallet per user per currency. balance can NEVER go negative
-- (the DB constraint is the last line of defence after our app-level checks).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance     NUMERIC(18,2)  NOT NULL DEFAULT 0.00
                             CONSTRAINT non_negative_balance CHECK (balance >= 0),
  currency    CHAR(3)        NOT NULL DEFAULT 'USD',
  is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
  version     INTEGER        NOT NULL DEFAULT 0,   -- for optimistic lock auditing
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT  unique_user_currency UNIQUE (user_id, currency)
);

-- ------------------------------------------------------------
-- TRANSACTIONS
-- This table serves two purposes:
--   1. Audit log of every transfer
--   2. Idempotency store — UNIQUE on idempotency_key means
--      even if two concurrent requests both pass the Redis
--      check, only ONE can INSERT here. The other gets a
--      duplicate key error which we catch and handle.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     VARCHAR(255)  UNIQUE NOT NULL,
  sender_wallet_id    UUID          NOT NULL REFERENCES wallets(id),
  receiver_wallet_id  UUID          NOT NULL REFERENCES wallets(id),
  amount              NUMERIC(18,2) NOT NULL CONSTRAINT positive_amount CHECK (amount > 0),
  currency            CHAR(3)       NOT NULL DEFAULT 'USD',
  status              VARCHAR(20)   NOT NULL DEFAULT 'COMPLETED'
                                    CHECK (status IN ('COMPLETED', 'FAILED')),
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  CONSTRAINT no_self_transfer CHECK (sender_wallet_id != receiver_wallet_id)
);

-- ------------------------------------------------------------
-- INDEXES — Critical for lock performance on hot rows
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_wallets_user_id         ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_sender      ON transactions(sender_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver    ON transactions(receiver_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at  ON transactions(created_at DESC);

-- ------------------------------------------------------------
-- AUTO-UPDATE updated_at ON wallets
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallets_updated_at ON wallets;
CREATE TRIGGER trg_wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
