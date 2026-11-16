CREATE TABLE dispatch.trip_previews (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision >= 0),
  preview jsonb NOT NULL,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, draft_id, draft_revision)
);

CREATE TABLE dispatch.parties (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  id uuid NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE dispatch.trips (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  id uuid NOT NULL,
  source_preview_id uuid NOT NULL,
  statuses jsonb NOT NULL CHECK (jsonb_typeof(statuses) = 'object'),
  status_revision integer NOT NULL DEFAULT 0 CHECK (status_revision >= 0),
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, source_preview_id) REFERENCES dispatch.trip_previews(account_id, id)
);

CREATE TABLE dispatch.trip_versions (
  account_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  customers jsonb NOT NULL CHECK (jsonb_typeof(customers) = 'array' AND jsonb_array_length(customers) > 0),
  total_cents bigint NOT NULL CHECK (total_cents > 0 AND total_cents <= 9007199254740991),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, trip_id, version),
  FOREIGN KEY (account_id, trip_id) REFERENCES dispatch.trips(account_id, id)
);

CREATE TABLE dispatch.sheets (
  account_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  id text NOT NULL,
  party_id uuid NOT NULL,
  reviewed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, trip_id, id),
  UNIQUE (account_id, trip_id, party_id),
  FOREIGN KEY (account_id, trip_id) REFERENCES dispatch.trips(account_id, id),
  FOREIGN KEY (account_id, party_id) REFERENCES dispatch.parties(account_id, id)
);

ALTER TABLE dispatch.workspaces ADD COLUMN current_trip_id uuid;
ALTER TABLE dispatch.workspaces ADD FOREIGN KEY (account_id, current_trip_id) REFERENCES dispatch.trips(account_id, id);

DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['trip_previews','parties','trips','trip_versions','sheets'] LOOP
    EXECUTE format('ALTER TABLE dispatch.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE dispatch.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format(
      'CREATE POLICY account_scope ON dispatch.%I TO dispatch_app
        USING (account_id::text = current_setting(''dispatch.account_id'', true))
        WITH CHECK (account_id::text = current_setting(''dispatch.account_id'', true))', relation);
    EXECUTE format('GRANT SELECT, INSERT ON dispatch.%I TO dispatch_app', relation);
  END LOOP;
END
$$;

GRANT UPDATE (draft_id, current_trip_id) ON dispatch.workspaces TO dispatch_app;
