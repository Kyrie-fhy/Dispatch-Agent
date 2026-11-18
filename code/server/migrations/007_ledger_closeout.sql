CREATE INDEX trip_versions_by_issue ON dispatch.trip_versions (account_id, saved_at DESC, trip_id DESC)
  WHERE version = 1;

ALTER TABLE dispatch.receipts ADD COLUMN pending_cents bigint NOT NULL DEFAULT 0
  CHECK (pending_cents BETWEEN 0 AND cents);

ALTER TABLE dispatch.ledger_previews DROP CONSTRAINT ledger_previews_kind_check;
ALTER TABLE dispatch.ledger_previews ADD CHECK (kind IN ('opening', 'receipt', 'receipt-correction'));

CREATE TABLE dispatch.receipt_reversals (
  account_id uuid NOT NULL,
  party_id uuid NOT NULL,
  original_receipt_id uuid NOT NULL,
  replacement_receipt_id uuid NOT NULL,
  PRIMARY KEY (account_id, original_receipt_id),
  UNIQUE (account_id, replacement_receipt_id),
  CHECK (original_receipt_id <> replacement_receipt_id),
  FOREIGN KEY (account_id, original_receipt_id, party_id) REFERENCES dispatch.receipts(account_id, id, party_id),
  FOREIGN KEY (account_id, replacement_receipt_id, party_id) REFERENCES dispatch.receipts(account_id, id, party_id)
);
ALTER TABLE dispatch.receipt_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.receipt_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.receipt_reversals TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT ON dispatch.receipt_reversals TO dispatch_app;
