CREATE TABLE dispatch.image_order_inputs (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  draft_id uuid NOT NULL,
  image_digest text NOT NULL CHECK (image_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (account_id, draft_id, image_digest)
);

ALTER TABLE dispatch.image_order_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.image_order_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.image_order_inputs TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT ON dispatch.image_order_inputs TO dispatch_app;
