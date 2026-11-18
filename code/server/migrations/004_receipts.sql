ALTER TABLE dispatch.sheets ADD UNIQUE (account_id, trip_id, id, party_id);
CREATE INDEX sheets_by_party ON dispatch.sheets (account_id, party_id);

CREATE TABLE dispatch.opening_debts (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  party_id uuid NOT NULL,
  day date NOT NULL,
  cents bigint NOT NULL CHECK (cents BETWEEN 1 AND 9007199254740991),
  source text NOT NULL,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, id, party_id),
  UNIQUE (account_id, party_id, day, cents, source),
  FOREIGN KEY (account_id, party_id) REFERENCES dispatch.parties(account_id, id)
);

CREATE TABLE dispatch.receipts (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  party_id uuid NOT NULL,
  cents bigint NOT NULL CHECK (cents BETWEEN 1 AND 9007199254740991),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, id, party_id),
  FOREIGN KEY (account_id, party_id) REFERENCES dispatch.parties(account_id, id)
);
CREATE INDEX receipts_by_party ON dispatch.receipts (account_id, party_id, saved_at, id);

CREATE TABLE dispatch.receipt_allocations (
  account_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  party_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  cents bigint NOT NULL CHECK (cents BETWEEN 1 AND 9007199254740991),
  opening_id uuid,
  trip_id uuid,
  sheet_id text,
  CHECK ((opening_id IS NOT NULL AND trip_id IS NULL AND sheet_id IS NULL)
    OR (opening_id IS NULL AND trip_id IS NOT NULL AND sheet_id IS NOT NULL)),
  PRIMARY KEY (account_id, receipt_id, position),
  FOREIGN KEY (account_id, receipt_id, party_id) REFERENCES dispatch.receipts(account_id, id, party_id),
  FOREIGN KEY (account_id, opening_id, party_id) REFERENCES dispatch.opening_debts(account_id, id, party_id),
  FOREIGN KEY (account_id, trip_id, sheet_id, party_id) REFERENCES dispatch.sheets(account_id, trip_id, id, party_id)
);
CREATE INDEX receipt_allocations_by_sheet ON dispatch.receipt_allocations (account_id, trip_id, sheet_id)
  WHERE trip_id IS NOT NULL;

CREATE TABLE dispatch.ledger_previews (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  trip_id uuid NOT NULL,
  sheet_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'receipt')),
  payload jsonb NOT NULL,
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, trip_id, sheet_id) REFERENCES dispatch.sheets(account_id, trip_id, id)
);

DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['opening_debts','receipts','receipt_allocations','ledger_previews'] LOOP
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
