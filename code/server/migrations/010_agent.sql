CREATE TABLE IF NOT EXISTS dispatch.agent_turns (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  id uuid NOT NULL,
  draft_id uuid NOT NULL,
  start_revision integer NOT NULL,
  end_revision integer NOT NULL,
  before_customers jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_one_running ON dispatch.agent_turns (account_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS agent_draft_turns ON dispatch.agent_turns (account_id, draft_id, created_at);

CREATE TABLE IF NOT EXISTS dispatch.agent_messages (
  account_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  material_ids uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, turn_id, role),
  FOREIGN KEY (account_id, turn_id) REFERENCES dispatch.agent_turns(account_id, id)
);

CREATE TABLE IF NOT EXISTS dispatch.agent_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  draft_id uuid NOT NULL,
  turn_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, turn_id) REFERENCES dispatch.agent_turns(account_id, id)
);
CREATE INDEX IF NOT EXISTS agent_turn_events ON dispatch.agent_events (account_id, turn_id, seq);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['agent_turns', 'agent_messages', 'agent_events'] LOOP
    EXECUTE format('ALTER TABLE dispatch.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE dispatch.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS account_scope ON dispatch.%I', table_name);
    EXECUTE format('CREATE POLICY account_scope ON dispatch.%I TO dispatch_app
      USING (account_id::text = current_setting(''dispatch.account_id'', true))
      WITH CHECK (account_id::text = current_setting(''dispatch.account_id'', true))', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON dispatch.%I TO dispatch_app', table_name);
  END LOOP;
END $$;

GRANT UPDATE (end_revision, status, undone) ON dispatch.agent_turns TO dispatch_app;
GRANT DELETE ON dispatch.image_order_inputs TO dispatch_app;
