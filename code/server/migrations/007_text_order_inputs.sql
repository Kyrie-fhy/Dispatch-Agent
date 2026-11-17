CREATE TABLE dispatch.text_order_inputs (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  draft_id uuid NOT NULL,
  text_digest bytea NOT NULL CHECK (octet_length(text_digest) = 32),
  PRIMARY KEY (account_id, draft_id, text_digest)
);

ALTER TABLE dispatch.text_order_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.text_order_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.text_order_inputs TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT ON dispatch.text_order_inputs TO dispatch_app;
