-- Credit consumption primitives: holds are reservations, not ledger entries.
ALTER TABLE users
  ALTER COLUMN purchased_credits TYPE bigint,
  ALTER COLUMN bonus_carried TYPE bigint,
  ALTER COLUMN bonus_current TYPE bigint;

ALTER TABLE credits_ledger
  ALTER COLUMN delta TYPE bigint;

CREATE TABLE IF NOT EXISTS credit_holds (
  id text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  scope_type text NOT NULL,
  scope_id text,
  request_id text NOT NULL UNIQUE,
  amount_micro bigint NOT NULL,
  settled_micro bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_holds_user_status ON credit_holds(user_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_holds_expires ON credit_holds(status, expires_at);
