-- ----------------------------------------------------------------------------
-- @strav/stripe — append-only enforcement
-- ----------------------------------------------------------------------------
-- Blocks UPDATE and DELETE on the ledger and hold-event tables at the DB
-- layer. Corrections happen by INSERTing a reversing entry, never by mutation.
--
-- Apply once per environment after the corresponding tables are created:
--   psql $DATABASE_URL -f stubs/migrations/strav_stripe_ledger_triggers.sql
--
-- Idempotent: safe to re-run.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION strav_stripe_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only. Use a reversing entry instead of % on row id=%.',
    TG_TABLE_NAME, TG_OP, COALESCE(OLD.id::text, 'unknown')
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- strav_stripe_ledger ---------------------------------------------------------

DROP TRIGGER IF EXISTS strav_stripe_ledger_no_update ON strav_stripe_ledger;
CREATE TRIGGER strav_stripe_ledger_no_update
  BEFORE UPDATE ON strav_stripe_ledger
  FOR EACH ROW EXECUTE FUNCTION strav_stripe_block_mutation();

DROP TRIGGER IF EXISTS strav_stripe_ledger_no_delete ON strav_stripe_ledger;
CREATE TRIGGER strav_stripe_ledger_no_delete
  BEFORE DELETE ON strav_stripe_ledger
  FOR EACH ROW EXECUTE FUNCTION strav_stripe_block_mutation();

-- strav_stripe_hold_event -----------------------------------------------------

DROP TRIGGER IF EXISTS strav_stripe_hold_event_no_update ON strav_stripe_hold_event;
CREATE TRIGGER strav_stripe_hold_event_no_update
  BEFORE UPDATE ON strav_stripe_hold_event
  FOR EACH ROW EXECUTE FUNCTION strav_stripe_block_mutation();

DROP TRIGGER IF EXISTS strav_stripe_hold_event_no_delete ON strav_stripe_hold_event;
CREATE TRIGGER strav_stripe_hold_event_no_delete
  BEFORE DELETE ON strav_stripe_hold_event
  FOR EACH ROW EXECUTE FUNCTION strav_stripe_block_mutation();
