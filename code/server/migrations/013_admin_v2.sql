ALTER TABLE dispatch.accounts
  ADD COLUMN remark_name text NOT NULL DEFAULT '',
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN session_epoch integer NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  ADD COLUMN last_active_at timestamptz,
  ADD COLUMN catalog_revision integer NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0);

UPDATE dispatch.accounts SET activated_at = now() WHERE activated_at IS NULL;

ALTER TABLE dispatch.sessions ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;
CREATE INDEX sessions_account_id ON dispatch.sessions (account_id);

GRANT UPDATE (remark_name, activated_at, disabled_at, session_epoch, last_active_at, catalog_revision)
  ON dispatch.accounts TO dispatch_app;

CREATE TABLE dispatch.activation_codes (
  id uuid PRIMARY KEY,
  code_digest bytea NOT NULL UNIQUE CHECK (octet_length(code_digest) = 32),
  code_hint text NOT NULL DEFAULT '',
  remark_name text NOT NULL CHECK (btrim(remark_name) <> ''),
  request_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  redeemed_at timestamptz,
  redeemed_account_id uuid REFERENCES dispatch.accounts(id),
  CHECK ((redeemed_at IS NULL) = (redeemed_account_id IS NULL)),
  CHECK (NOT (revoked_at IS NOT NULL AND redeemed_at IS NOT NULL))
);
CREATE UNIQUE INDEX activation_codes_one_per_account ON dispatch.activation_codes (redeemed_account_id)
  WHERE redeemed_account_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE (revoked_at, redeemed_at, redeemed_account_id)
  ON dispatch.activation_codes TO dispatch_app;

CREATE TABLE dispatch.mistake_cases (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  turn_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('货品认错', '漏行多行', '价格没配上', '客户认错', '语音听错', '其他')),
  expected_outcome text NOT NULL CHECK (btrim(expected_outcome) <> ''),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  schema_version integer NOT NULL DEFAULT 1,
  case_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, turn_id),
  FOREIGN KEY (account_id, turn_id) REFERENCES dispatch.agent_turns(account_id, id)
);
ALTER TABLE dispatch.mistake_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.mistake_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.mistake_cases TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT, UPDATE (category, expected_outcome, note, status, updated_at)
  ON dispatch.mistake_cases TO dispatch_app;

ALTER TABLE dispatch.catalog_imports ADD COLUMN source text NOT NULL DEFAULT 'csv';
ALTER TABLE dispatch.catalog_products
  ADD COLUMN original_name text NOT NULL DEFAULT '',
  ADD COLUMN verification_status text NOT NULL DEFAULT '',
  ADD COLUMN remarks text NOT NULL DEFAULT '';

GRANT INSERT, UPDATE, DELETE ON dispatch.catalog_imports, dispatch.catalog_products,
  dispatch.catalog_variants, dispatch.catalog_aliases TO dispatch_app;

-- Existing delivery records keep their original data. Future delivery confirmations
-- record their timestamp when the business API makes the status transition.
ALTER TABLE dispatch.sheets ADD COLUMN delivery_completed_at timestamptz;
CREATE FUNCTION dispatch.record_delivery_completed_at() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
  IF NEW.delivery_completed AND NOT OLD.delivery_completed THEN
    NEW.delivery_completed_at := clock_timestamp();
  ELSIF NOT NEW.delivery_completed THEN
    NEW.delivery_completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sheet_delivery_completed_at BEFORE UPDATE OF delivery_completed ON dispatch.sheets
  FOR EACH ROW EXECUTE FUNCTION dispatch.record_delivery_completed_at();
