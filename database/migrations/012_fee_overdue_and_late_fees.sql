-- ============================================================================
-- ClassSphere Migration: 012_fee_overdue_and_late_fees.sql
-- Goal: Fee Overdue Management and Late Fees in the billing module
-- Traceability: PLT-006, PLT-012, DECISION-008
-- ============================================================================

-- 1. Extend billing.invoices with overdue tracking and late fee attributes
ALTER TABLE billing.invoices
    ADD COLUMN IF NOT EXISTS overdue_status VARCHAR(30) NOT NULL DEFAULT 'upcoming',
    ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS days_overdue INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS waived_reason TEXT,
    ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS waived_by_actor_id UUID;

-- Constrain overdue_status to allowed business states
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_overdue_status'
    ) THEN
        ALTER TABLE billing.invoices
            ADD CONSTRAINT chk_invoices_overdue_status
            CHECK (overdue_status IN ('upcoming', 'due', 'in_grace', 'overdue', 'paid', 'waived', 'cancelled'));
    END IF;
END $$;

-- 2. Late Fee Rules table per tenant with optional branch override
CREATE TABLE IF NOT EXISTS billing.late_fee_rules (
    rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    branch_id UUID REFERENCES tenant.branches(branch_id) ON DELETE CASCADE,
    calc_method VARCHAR(30) NOT NULL CHECK (calc_method IN ('flat', 'percent', 'per_day')),
    value NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (value >= 0),
    grace_days INT NOT NULL DEFAULT 0 CHECK (grace_days >= 0),
    cap_amount NUMERIC(10,2) CHECK (cap_amount IS NULL OR cap_amount >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Partial unique indexes: one tenant-wide default (branch_id IS NULL) and one override per branch
CREATE UNIQUE INDEX IF NOT EXISTS uq_late_fee_rules_tenant_default
    ON billing.late_fee_rules(tenant_id)
    WHERE branch_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_late_fee_rules_tenant_branch
    ON billing.late_fee_rules(tenant_id, branch_id)
    WHERE branch_id IS NOT NULL;

-- 3. Invoice Line Items table: store late fees as separate line items without modifying original total_amount
CREATE TABLE IF NOT EXISTS billing.invoice_items (
    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES billing.invoices(invoice_id) ON DELETE CASCADE,
    item_type VARCHAR(50) NOT NULL DEFAULT 'tuition', -- 'tuition', 'late_fee', 'equipment', 'tax', etc.
    description VARCHAR(255) NOT NULL,
    amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON billing.invoice_items(invoice_id);

-- 4. Fee Audit Ledger: tracks all late fee adjustments, assessments, and waivers
CREATE TABLE IF NOT EXISTS billing.fee_audit (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES billing.invoices(invoice_id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'rule_upserted', 'late_fee_assessed', 'late_fee_waived', 'overdue_recalculated'
    old_value JSONB,
    new_value JSONB,
    user_id UUID,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_fee_audit_invoice_id ON billing.fee_audit(invoice_id);
CREATE INDEX IF NOT EXISTS idx_fee_audit_tenant_id ON billing.fee_audit(tenant_id);

-- 5. Backfill line items for existing invoices that don't have items yet
INSERT INTO billing.invoice_items (tenant_id, invoice_id, item_type, description, amount, created_at)
SELECT i.tenant_id, i.invoice_id, 'tuition', i.designation, i.total_amount, i.created_at
FROM billing.invoices i
WHERE NOT EXISTS (
    SELECT 1 FROM billing.invoice_items it WHERE it.invoice_id = i.invoice_id
);

-- Backfill initial overdue status for existing invoices
UPDATE billing.invoices
SET overdue_status = CASE
    WHEN balance_amount = 0.00 THEN 'paid'
    WHEN status = 'void' THEN 'cancelled'
    WHEN due_date < CURRENT_DATE THEN 'overdue'
    WHEN due_date = CURRENT_DATE THEN 'due'
    ELSE 'upcoming'
END,
days_overdue = CASE
    WHEN balance_amount > 0.00 AND due_date < CURRENT_DATE THEN (CURRENT_DATE - due_date)
    ELSE 0
END
WHERE overdue_status = 'upcoming' AND (balance_amount = 0.00 OR due_date <= CURRENT_DATE);
