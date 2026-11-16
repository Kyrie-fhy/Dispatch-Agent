DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dispatch_app') THEN
    CREATE ROLE dispatch_app NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA dispatch FROM PUBLIC;
GRANT USAGE ON SCHEMA dispatch TO dispatch_app;

CREATE TABLE dispatch.accounts (
  id uuid PRIMARY KEY,
  identity_provider text NOT NULL,
  identity_subject text NOT NULL,
  UNIQUE (identity_provider, identity_subject)
);

CREATE TABLE dispatch.sessions (
  token_digest bytea PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_at ON dispatch.sessions (expires_at);

CREATE TABLE dispatch.workspaces (
  account_id uuid PRIMARY KEY REFERENCES dispatch.accounts(id),
  draft_id uuid NOT NULL UNIQUE,
  draft_revision integer NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  draft_customers jsonb NOT NULL CHECK (
    jsonb_typeof(draft_customers) = 'array' AND jsonb_array_length(draft_customers) > 0
  )
);

CREATE TABLE dispatch.request_results (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  request_id text NOT NULL,
  input_digest bytea NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (account_id, request_id)
);

ALTER TABLE dispatch.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE dispatch.request_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.request_results FORCE ROW LEVEL SECURITY;

CREATE POLICY account_workspace ON dispatch.workspaces
  TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));

CREATE POLICY account_request_result ON dispatch.request_results
  TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));

GRANT SELECT, INSERT ON dispatch.accounts TO dispatch_app;
GRANT SELECT, INSERT, DELETE ON dispatch.sessions TO dispatch_app;
GRANT SELECT, INSERT, UPDATE (draft_revision, draft_customers) ON dispatch.workspaces TO dispatch_app;
GRANT SELECT, INSERT ON dispatch.request_results TO dispatch_app;
