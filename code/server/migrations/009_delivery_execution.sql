ALTER TABLE dispatch.trip_versions DROP CONSTRAINT IF EXISTS trip_versions_total_cents_check;
ALTER TABLE dispatch.trip_versions ADD CONSTRAINT trip_versions_total_cents_check
  CHECK (total_cents >= 0 AND total_cents <= 9007199254740991);

ALTER TABLE dispatch.trips ADD COLUMN IF NOT EXISTS delivery_edits jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(delivery_edits) = 'object');
ALTER TABLE dispatch.sheets ADD COLUMN IF NOT EXISTS delivery_completed boolean NOT NULL DEFAULT false;
GRANT UPDATE (delivery_edits) ON dispatch.trips TO dispatch_app;
GRANT UPDATE (delivery_completed) ON dispatch.sheets TO dispatch_app;
