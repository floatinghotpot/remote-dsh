-- 0016: relay billing watermark (31-relay-billing).
-- One row per (user, host, date, instance). Billing is a byte DELTA over the
-- last-reported cumulative bytes (last_up/last_down), so the watermark is
-- rate-independent: changing bytesPerCredit never retro-charges history.
-- charged_micro accumulates the micro actually deducted for this instance-day
-- (for the consumption query and reconciliation).
CREATE TABLE IF NOT EXISTS relay_charge (
  user_id bigint NOT NULL REFERENCES users(id),
  host_id text NOT NULL,
  date text NOT NULL,
  instance_id text NOT NULL,
  last_up bigint NOT NULL DEFAULT 0,
  last_down bigint NOT NULL DEFAULT 0,
  charged_micro bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, host_id, date, instance_id)
);
