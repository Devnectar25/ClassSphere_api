-- ============================================================================
-- ClassSphere Migration: 020_flexible_installments.sql
-- Half-yearly plans, the original installment beside the updated one, and failed online attempts. Idempotent.
-- Adjustment history uses the existing billing.fee_audit and billing.invoice_items.
-- ============================================================================

ALTER TABLE billing.enrollment_fee_plans DROP CONSTRAINT IF EXISTS enrollment_fee_plans_frequency_check;
ALTER TABLE billing.enrollment_fee_plans ADD CONSTRAINT enrollment_fee_plans_frequency_check
    CHECK (frequency IN ('monthly', 'every_2_months', 'quarterly', 'half_yearly', 'custom'));

ALTER TABLE billing.payment_orders
ADD COLUMN IF NOT EXISTS failure_reason TEXT,
ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE billing.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE billing.payment_orders ADD CONSTRAINT payment_orders_status_check CHECK (status IN ('created', 'paid', 'failed'));
CREATE INDEX IF NOT EXISTS idx_payment_orders_invoice ON billing.payment_orders (invoice_id, created_at);

-- What the installment was first scheduled as; never changed by later adjustments
ALTER TABLE billing.invoices
ADD COLUMN IF NOT EXISTS original_amount NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS original_due_date DATE;

CREATE OR REPLACE FUNCTION billing.fn_invoice_original_set() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = billing, public
AS $$
BEGIN
    NEW.original_amount := COALESCE(NEW.original_amount, NEW.total_amount);
    NEW.original_due_date := COALESCE(NEW.original_due_date, NEW.due_date);
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_invoice_original_set ON billing.invoices;
CREATE TRIGGER trg_invoice_original_set BEFORE INSERT ON billing.invoices
FOR EACH ROW EXECUTE FUNCTION billing.fn_invoice_original_set();

-- Existing invoices: the scheduled amount before any balance was carried in or out
UPDATE billing.invoices i
SET original_amount = i.total_amount - COALESCE((
        SELECT SUM(it.amount) FROM billing.invoice_items it WHERE it.invoice_id = i.invoice_id AND it.item_type = 'carry_forward'), 0),
    original_due_date = i.due_date
WHERE i.original_amount IS NULL;
