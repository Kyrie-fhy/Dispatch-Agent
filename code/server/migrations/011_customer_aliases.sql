CREATE TABLE IF NOT EXISTS dispatch.customer_aliases (
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  alias text NOT NULL CHECK (alias <> ''),
  normalized_alias text NOT NULL CHECK (normalized_alias <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, normalized_alias),
  FOREIGN KEY (account_id, customer_id) REFERENCES dispatch.parties(account_id, id)
);

ALTER TABLE dispatch.customer_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.customer_aliases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_scope ON dispatch.customer_aliases;
CREATE POLICY account_scope ON dispatch.customer_aliases TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));

GRANT SELECT, INSERT, UPDATE (customer_id, alias, updated_at), DELETE ON dispatch.customer_aliases TO dispatch_app;
