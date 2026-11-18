CREATE TABLE dispatch.materials (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  id uuid NOT NULL,
  request_id text NOT NULL,
  draft_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  received integer NOT NULL DEFAULT 0 CHECK (received BETWEEN 0 AND size),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, request_id)
);

CREATE TABLE dispatch.material_chunks (
  account_id uuid NOT NULL,
  material_id uuid NOT NULL,
  byte_offset integer NOT NULL CHECK (byte_offset >= 0 AND byte_offset % 262144 = 0),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 262144),
  PRIMARY KEY (account_id, material_id, byte_offset),
  FOREIGN KEY (account_id, material_id) REFERENCES dispatch.materials(account_id, id)
);

ALTER TABLE dispatch.materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.materials FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.materials TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT, UPDATE (received) ON dispatch.materials TO dispatch_app;

ALTER TABLE dispatch.material_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.material_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON dispatch.material_chunks TO dispatch_app
  USING (account_id::text = current_setting('dispatch.account_id', true))
  WITH CHECK (account_id::text = current_setting('dispatch.account_id', true));
GRANT SELECT, INSERT ON dispatch.material_chunks TO dispatch_app;
