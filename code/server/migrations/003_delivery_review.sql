CREATE TABLE dispatch.delivery_previews (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  trip_id uuid NOT NULL,
  sheet_id text NOT NULL,
  preview jsonb NOT NULL,
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, trip_id, sheet_id) REFERENCES dispatch.sheets(account_id, trip_id, id)
);

ALTER TABLE dispatch.delivery_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.delivery_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.delivery_previews TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));

GRANT SELECT, INSERT ON dispatch.delivery_previews TO dispatch_app;
GRANT UPDATE (statuses, status_revision) ON dispatch.trips TO dispatch_app;
GRANT UPDATE (reviewed) ON dispatch.sheets TO dispatch_app;
