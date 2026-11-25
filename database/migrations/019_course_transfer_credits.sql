-- ============================================================================
-- ClassSphere Migration: 019_course_transfer_credits.sql
-- Course transfer, credit ledger and per-enrollment installment plans. Idempotent.
--
-- The earlier transfer flow kept credit only as invoice_items ('credit_adjustment') plus JSON in the audit
-- log, so a balance could not be carried forward or checked. This migration gives that same credit a ledger;
-- 'credit_adjustment' line items remain how an applied credit appears on an invoice.
-- ============================================================================

-- 1. Transfer columns already present on deployed databases
ALTER TABLE academics.enrollments
ADD COLUMN IF NOT EXISTS transfer_reason TEXT,
ADD COLUMN IF NOT EXISTS remarks TEXT,
ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;

-- 2. Fee plan chosen for one enrollment (billing.fee_plans stays the academy-wide template)
CREATE TABLE IF NOT EXISTS billing.enrollment_fee_plans (
    enrollment_plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id),
    enrollment_id UUID NOT NULL REFERENCES academics.enrollments(enrollment_id),
    template_plan_id UUID REFERENCES billing.fee_plans(plan_id),
    transfer_id UUID,
    payment_mode VARCHAR(20) NOT NULL CHECK (payment_mode IN ('one_time', 'installment')),
    frequency VARCHAR(20) CHECK (frequency IN ('monthly', 'every_2_months', 'quarterly', 'custom')),
    installment_count INT NOT NULL CHECK (installment_count > 0),
    credit_allocation VARCHAR(20) NOT NULL DEFAULT 'spread' CHECK (credit_allocation IN ('spread', 'sequential')),
    course_fee NUMERIC(10,2) NOT NULL CHECK (course_fee >= 0),
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    net_fee NUMERIC(10,2) NOT NULL CHECK (net_fee >= 0),
    credit_applied NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (credit_applied >= 0),
    payable_amount NUMERIC(10,2) NOT NULL CHECK (payable_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (net_fee = course_fee - discount_amount),
    CHECK (payable_amount = net_fee - credit_applied)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_fee_plans_active ON billing.enrollment_fee_plans (enrollment_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enrollment_fee_plans_student ON billing.enrollment_fee_plans (tenant_id, student_id);

-- 3. Every invoice (installment) belongs to one enrollment
ALTER TABLE billing.invoices
ADD COLUMN IF NOT EXISTS enrollment_id UUID REFERENCES academics.enrollments(enrollment_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS enrollment_plan_id UUID REFERENCES billing.enrollment_fee_plans(enrollment_plan_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS installment_number INT,
ADD COLUMN IF NOT EXISTS credit_applied NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (credit_applied >= 0);
CREATE INDEX IF NOT EXISTS idx_invoices_enrollment ON billing.invoices (tenant_id, enrollment_id);

-- 4. Course transfers and their Finance review
CREATE TABLE IF NOT EXISTS billing.course_transfers (
    transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id),
    from_enrollment_id UUID NOT NULL REFERENCES academics.enrollments(enrollment_id),
    to_enrollment_id UUID NOT NULL REFERENCES academics.enrollments(enrollment_id),
    transfer_date TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    remarks TEXT,
    -- Position of the old enrollment, captured at transfer and refreshed at review
    old_course_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    old_paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    old_outstanding_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    unused_ceiling NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    consumed_amount NUMERIC(10,2) CHECK (consumed_amount >= 0), -- NULL until Finance confirms it
    eligible_credit NUMERIC(10,2) CHECK (eligible_credit >= 0),
    approved_credit NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (approved_credit >= 0),
    credit_status VARCHAR(20) NOT NULL DEFAULT 'pending_review'
        CHECK (credit_status IN ('pending_review', 'approved', 'rejected', 'no_credit', 'not_applicable')),
    fee_plan_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (fee_plan_status IN ('pending', 'configured', 'carried_over')),
    review_notes TEXT,
    reviewed_by_actor_id UUID,
    reviewed_at TIMESTAMPTZ,
    created_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (approved_credit <= COALESCE(eligible_credit, 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_course_transfers_pending ON billing.course_transfers (from_enrollment_id) WHERE credit_status = 'pending_review';
CREATE INDEX IF NOT EXISTS idx_course_transfers_student ON billing.course_transfers (tenant_id, student_id);

-- 5. Credit ledger: append-only; the balance is the running sum and can never be negative
CREATE TABLE IF NOT EXISTS billing.credit_ledger (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id),
    entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN ('transfer_credit', 'advance_payment', 'legacy_credit', 'credit_applied')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount <> 0),
    balance_after NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (balance_after >= 0),
    source_enrollment_id UUID REFERENCES academics.enrollments(enrollment_id),
    target_enrollment_id UUID REFERENCES academics.enrollments(enrollment_id),
    transfer_id UUID REFERENCES billing.course_transfers(transfer_id),
    invoice_id UUID REFERENCES billing.invoices(invoice_id),
    payment_id UUID REFERENCES billing.payments(payment_id),
    reason TEXT,
    actor_id UUID,
    idempotency_key VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, idempotency_key),
    CHECK ((entry_type = 'credit_applied') = (amount < 0))
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_student ON billing.credit_ledger (tenant_id, student_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_transfer ON billing.credit_ledger (transfer_id) WHERE entry_type = 'transfer_credit';
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_payment ON billing.credit_ledger (payment_id) WHERE entry_type = 'advance_payment';

CREATE OR REPLACE FUNCTION billing.fn_credit_ledger_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Serialises all credit movements of one student
        PERFORM 1 FROM academics.students WHERE student_id = NEW.student_id AND tenant_id = NEW.tenant_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0002';
        END IF;
        SELECT COALESCE(SUM(amount), 0) + NEW.amount INTO NEW.balance_after
        FROM billing.credit_ledger WHERE tenant_id = NEW.tenant_id AND student_id = NEW.student_id;
        IF NEW.balance_after < 0 THEN
            RAISE EXCEPTION 'Credit applied exceeds the available credit balance' USING ERRCODE = '22023';
        END IF;
        RETURN NEW;
    END IF;
    -- Deletes are allowed only as part of removing the whole academy (cascade)
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Credit ledger entries cannot be changed or deleted' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_credit_ledger_guard ON billing.credit_ledger;
CREATE TRIGGER trg_credit_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON billing.credit_ledger
FOR EACH ROW EXECUTE FUNCTION billing.fn_credit_ledger_guard();

-- 6. Online fee orders: binds a gateway order to one student, course and amount so it can be captured once
CREATE TABLE IF NOT EXISTS billing.payment_orders (
    order_id VARCHAR(100) PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id),
    enrollment_id UUID REFERENCES academics.enrollments(enrollment_id),
    invoice_id UUID REFERENCES billing.invoices(invoice_id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) NOT NULL,
    gateway VARCHAR(20) NOT NULL CHECK (gateway IN ('razorpay', 'simulation')),
    status VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
    gateway_payment_id VARCHAR(100),
    result JSONB,
    created_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    paid_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_payment ON billing.payment_orders (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;

-- 7. A repeated submission can never post a second payment
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency ON billing.payments (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 8. Resolves the enrollment an invoice belongs to; returns NULL whenever that is ambiguous
CREATE OR REPLACE FUNCTION billing.fn_invoice_enrollment_resolve(
    p_tenant_id UUID,
    p_student_id UUID,
    p_designation TEXT,
    p_prefer_active BOOLEAN
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
DECLARE
    v_ids UUID[];
    v_text TEXT := lower(COALESCE(p_designation, ''));
BEGIN
    -- The course an invoice names is the longest catalogue title in its designation ("Master Science" over "Science").
    -- An invoice naming a course the student is not enrolled in stays unlinked; one naming no course falls back to a sole enrollment.
    WITH named AS (
        SELECT MAX(length(trim(title))) AS len FROM academics.courses
        WHERE tenant_id = p_tenant_id AND trim(title) <> '' AND position(lower(trim(title)) IN v_text) > 0
    ), enr AS (
        SELECT e.enrollment_id, lower(trim(c.title)) AS title, lower(trim(b.name)) AS batch,
               e.status IN ('enrolled', 'confirmed', 'active', 'approved') AS is_active
        FROM academics.enrollments e
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        WHERE e.student_id = p_student_id AND e.tenant_id = p_tenant_id
          AND e.status NOT IN ('rejected', 'cancelled', 'expired', 'waitlisted', 'pending')
    ), matched AS (
        SELECT * FROM enr WHERE position(title IN v_text) > 0
    ), best AS (
        SELECT *, bool_or(position('(' || batch || ')' IN v_text) > 0) OVER () AS any_batch,
               position('(' || batch || ')' IN v_text) > 0 AS batch_match,
               bool_or(is_active) OVER () AS any_active
        FROM matched WHERE length(title) = (SELECT len FROM named)
    ), candidates AS (
        SELECT enrollment_id FROM best
        WHERE (NOT any_batch OR batch_match) AND (any_batch OR NOT p_prefer_active OR NOT any_active OR is_active)
        UNION ALL
        SELECT enrollment_id FROM enr
        WHERE (SELECT len FROM named) IS NULL
          AND (NOT p_prefer_active OR is_active OR NOT EXISTS (SELECT 1 FROM enr x WHERE x.is_active))
    )
    SELECT array_agg(enrollment_id) INTO v_ids FROM candidates;

    IF array_length(v_ids, 1) = 1 THEN
        RETURN v_ids[1];
    END IF;
    RETURN NULL;
END;
$$;

-- New invoices from any path (registration, add course, billing cycle) are linked when inserted
CREATE OR REPLACE FUNCTION billing.fn_invoice_enrollment_link() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
BEGIN
    IF NEW.enrollment_id IS NULL THEN
        NEW.enrollment_id := billing.fn_invoice_enrollment_resolve(NEW.tenant_id, NEW.student_id, NEW.designation, TRUE);
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_invoice_enrollment_link ON billing.invoices;
CREATE TRIGGER trg_invoice_enrollment_link BEFORE INSERT ON billing.invoices
FOR EACH ROW EXECUTE FUNCTION billing.fn_invoice_enrollment_link();

-- Existing invoices: link only the unambiguous ones (amounts are never touched)
UPDATE billing.invoices i
SET enrollment_id = r.enrollment_id
FROM (
    SELECT invoice_id, billing.fn_invoice_enrollment_resolve(tenant_id, student_id, designation, FALSE) AS enrollment_id
    FROM billing.invoices WHERE enrollment_id IS NULL
) r
WHERE r.invoice_id = i.invoice_id AND i.enrollment_id IS NULL AND r.enrollment_id IS NOT NULL;

-- 9. Credit applied by the earlier transfer flow: record it as earned and spent (net zero) so that it is never granted again
UPDATE billing.invoices i
SET credit_applied = x.credit
FROM (
    SELECT invoice_id, SUM(ABS(amount)) AS credit FROM billing.invoice_items WHERE item_type = 'credit_adjustment' GROUP BY invoice_id
) x
WHERE x.invoice_id = i.invoice_id AND i.credit_applied = 0 AND i.enrollment_plan_id IS NULL;

INSERT INTO billing.credit_ledger (tenant_id, student_id, entry_type, amount, source_enrollment_id, target_enrollment_id, invoice_id, reason, idempotency_key)
SELECT i.tenant_id, i.student_id, t.entry_type, ABS(it.amount) * t.sign,
       billing.fn_invoice_enrollment_resolve(i.tenant_id, i.student_id, regexp_replace(it.description, '^Prepaid Credit Transfer from ', ''), FALSE),
       i.enrollment_id, i.invoice_id, it.description, t.prefix || it.item_id::text
FROM billing.invoice_items it
JOIN billing.invoices i ON i.invoice_id = it.invoice_id
CROSS JOIN (VALUES (1, 'legacy_credit', 1, 'legacy-earn-'), (2, 'credit_applied', -1, 'legacy-use-')) AS t(ord, entry_type, sign, prefix)
WHERE it.item_type = 'credit_adjustment' AND it.amount <> 0 AND i.enrollment_plan_id IS NULL
  AND it.description LIKE 'Prepaid Credit Transfer from %'
  AND NOT EXISTS (SELECT 1 FROM billing.credit_ledger l WHERE l.tenant_id = i.tenant_id AND l.idempotency_key = t.prefix || it.item_id::text)
ORDER BY i.created_at, it.item_id, t.ord;
