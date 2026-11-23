CREATE TABLE dispatch.catalog_imports (
  account_id uuid NOT NULL REFERENCES dispatch.accounts(id),
  id uuid NOT NULL,
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, sha256)
);

CREATE TABLE dispatch.catalog_products (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  product_code text NOT NULL CHECK (product_code <> ''),
  category text NOT NULL,
  product text NOT NULL CHECK (product <> ''),
  brand text NOT NULL,
  import_id uuid NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, product_code),
  FOREIGN KEY (account_id, import_id) REFERENCES dispatch.catalog_imports(account_id, id)
);

CREATE TABLE dispatch.catalog_variants (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_code text NOT NULL CHECK (variant_code <> ''),
  packaging text NOT NULL,
  flavor_or_grade text,
  canonical_spec text NOT NULL,
  unit text CHECK (unit <> ''),
  price_cents bigint NOT NULL CHECK (price_cents BETWEEN 1 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('active', 'discontinued')),
  import_id uuid NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, product_id, variant_code),
  FOREIGN KEY (account_id, product_id) REFERENCES dispatch.catalog_products(account_id, id),
  FOREIGN KEY (account_id, import_id) REFERENCES dispatch.catalog_imports(account_id, id)
);

CREATE TABLE dispatch.catalog_aliases (
  account_id uuid NOT NULL,
  product_id uuid NOT NULL,
  normalized_alias text NOT NULL CHECK (normalized_alias <> ''),
  alias text NOT NULL CHECK (alias <> ''),
  PRIMARY KEY (account_id, product_id, normalized_alias),
  FOREIGN KEY (account_id, product_id) REFERENCES dispatch.catalog_products(account_id, id)
);

DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['catalog_imports', 'catalog_products', 'catalog_variants', 'catalog_aliases'] LOOP
    EXECUTE format('ALTER TABLE dispatch.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE dispatch.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY account_scope ON dispatch.%I
      USING (account_id::text = current_setting(''dispatch.account_id'', true))
      WITH CHECK (account_id::text = current_setting(''dispatch.account_id'', true))', relation);
    EXECUTE format('REVOKE ALL ON dispatch.%I FROM PUBLIC, dispatch_app', relation);
    EXECUTE format('GRANT SELECT ON dispatch.%I TO dispatch_app', relation);
  END LOOP;
END $$;
