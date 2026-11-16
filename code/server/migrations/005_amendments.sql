CREATE TABLE dispatch.amendment_previews (
  account_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  id uuid NOT NULL,
  sheet_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_id, trip_id, id),
  FOREIGN KEY (account_id, trip_id, sheet_id) REFERENCES dispatch.sheets(account_id, trip_id, id)
);

ALTER TABLE dispatch.amendment_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.amendment_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.amendment_previews TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT ON dispatch.amendment_previews TO dispatch_app;

ALTER TABLE dispatch.trip_versions ADD COLUMN amendment_id uuid;
ALTER TABLE dispatch.trip_versions ADD FOREIGN KEY (account_id, trip_id, amendment_id)
  REFERENCES dispatch.amendment_previews(account_id, trip_id, id);
CREATE UNIQUE INDEX trip_version_by_amendment ON dispatch.trip_versions (account_id, trip_id, amendment_id)
  WHERE amendment_id IS NOT NULL;
