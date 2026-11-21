-- ============================================================================
-- ClassSphere Stored Functions: 003_billing_functions.sql
-- Traceability: TDD Section 10.4-10.5, 14, PLT-006, PLT-012, DECISION-008
-- Append-Only Financial Ledger & Idempotent Payments
-- ============================================================================

CREATE OR REPLACE FUNCTION billing.fn_invoice_generate_cycle(
    p_tenant_id UUID,
    p_cycle_date DATE,
    p_actor_id UUID,
    p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, academics, audit, integration, public
AS $$
DECLARE
    v_student RECORD;
    v_count INT := 0;
    v_seq INT;
    v_total_amount NUMERIC(10,2) := 0.00;
    v_inv_no VARCHAR(50);
    v_period VARCHAR(50);
    v_prefix VARCHAR(20);
BEGIN
    -- Idempotency check: Return prior result if repeated
    IF p_idempotency_key IS NOT NULL THEN
        SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
        INTO v_count, v_total_amount
        FROM billing.invoices
        WHERE tenant_id = p_tenant_id AND idempotency_key = p_idempotency_key;

        IF v_count > 0 THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotentReplay', true,
                'invoicesGenerated', v_count,
                'totalBilled', v_total_amount
            );
        END IF;
    END IF;

    v_period := TO_CHAR(p_cycle_date, 'Mon YYYY');
    v_prefix := 'INV-' || TO_CHAR(p_cycle_date, 'YYYYMM') || '-';
    SELECT COUNT(*) INTO v_seq FROM billing.invoices WHERE tenant_id = p_tenant_id AND invoice_number LIKE v_prefix || '%';

    -- Generate invoice for each actively enrolled student and course
    FOR v_student IN
        SELECT s.student_id, c.tuition_amount AS amount, c.title AS course_name
        FROM academics.students s
        JOIN academics.enrollments e ON e.student_id = s.student_id AND e.status = 'enrolled'
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        WHERE s.tenant_id = p_tenant_id AND s.status = 'active' AND c.tuition_amount > 0
    LOOP
        v_seq := v_seq + 1;
        v_inv_no := v_prefix || LPAD(v_seq::text, 4, '0');

        INSERT INTO billing.invoices (
            tenant_id, invoice_number, student_id, billing_period,
            subtotal_amount, total_amount, balance_amount, due_date,
            status, designation, idempotency_key
        ) VALUES (
            p_tenant_id, v_inv_no, v_student.student_id, v_period,
            v_student.amount, v_student.amount, v_student.amount, (p_cycle_date + INTERVAL '15 days')::DATE,
            'pending', v_student.course_name || ' Tuition — ' || v_period, p_idempotency_key
        );

        v_count := v_count + 1;
        v_total_amount := v_total_amount + v_student.amount;
    END LOOP;

    INSERT INTO integration.outbox_messages (tenant_id, correlation_id, event_type, payload)
    VALUES (
        p_tenant_id,
        COALESCE(p_idempotency_key, gen_random_uuid()::text),
        'billing.invoice_cycle_generated',
        jsonb_build_object('cycleDate', p_cycle_date, 'period', v_period, 'count', v_count, 'total', v_total_amount)
    );

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'billing.invoice_cycle_generated', 'invoice_cycle', v_period,
            COALESCE(p_idempotency_key, gen_random_uuid()::text),
            jsonb_build_object('invoices', v_count, 'total', v_total_amount));

    RETURN jsonb_build_object(
        'success', true,
        'invoicesGenerated', v_count,
        'totalBilled', v_total_amount,
        'billingPeriod', v_period
    );
END;
$$;

CREATE OR REPLACE FUNCTION billing.fn_payment_post(
    p_tenant_id UUID,
    p_invoice_id UUID,
    p_amount NUMERIC(10,2),
    p_payment_method VARCHAR(50),
    p_gateway_order_id VARCHAR(100),
    p_gateway_payment_id VARCHAR(100),
    p_idempotency_key TEXT,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, audit, integration, public
AS $$
DECLARE
    v_existing RECORD;
    v_inv RECORD;
    v_receipt_no VARCHAR(50);
    v_payment_id UUID;
    v_new_balance NUMERIC(10,2);
    v_new_status VARCHAR(30);
    v_new_overdue_status VARCHAR(30);
    v_allocated_late_fee NUMERIC(10,2) := 0.00;
    v_allocated_principal NUMERIC(10,2) := 0.00;
BEGIN
    -- Idempotency check: prevent duplicate charges or double posts
    IF p_idempotency_key IS NOT NULL THEN
        SELECT p.* INTO v_existing
        FROM billing.payments p
        WHERE p.tenant_id = p_tenant_id AND p.idempotency_key = p_idempotency_key;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotentReplay', true,
                'paymentId', v_existing.payment_id,
                'receiptNumber', v_existing.receipt_number
            );
        END IF;
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be positive' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_inv FROM billing.invoices WHERE tenant_id = p_tenant_id AND invoice_id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_inv.status = 'void' OR v_inv.balance_amount = 0 THEN
        RAISE EXCEPTION 'Invoice % has no outstanding balance', v_inv.invoice_number USING ERRCODE = '22023';
    END IF;
    IF p_amount > v_inv.balance_amount THEN
        RAISE EXCEPTION 'Payment exceeds outstanding balance of %', v_inv.balance_amount USING ERRCODE = '22023';
    END IF;

    -- ========================================================================
    -- PAYMENT ALLOCATION ORDER:
    -- 1. Outstanding Late Fee is satisfied first.
    -- 2. Remaining payment amount is allocated to the oldest due amount / tuition principal balance.
    -- Original invoice total_amount is never modified; balance_amount reflects remaining debt.
    -- ========================================================================
    IF COALESCE(v_inv.late_fee_amount, 0.00) > 0 THEN
        IF p_amount >= v_inv.late_fee_amount THEN
            v_allocated_late_fee := v_inv.late_fee_amount;
            v_allocated_principal := p_amount - v_inv.late_fee_amount;
        ELSE
            v_allocated_late_fee := p_amount;
            v_allocated_principal := 0.00;
        END IF;
    ELSE
        v_allocated_late_fee := 0.00;
        v_allocated_principal := p_amount;
    END IF;

    v_receipt_no := 'RCP-' || TO_CHAR(clock_timestamp(), 'YYYYMMDD') || '-' || UPPER(SUBSTRING(gen_random_uuid()::text, 1, 6));
    v_new_balance := v_inv.balance_amount - p_amount;
    v_new_status := CASE WHEN v_new_balance = 0.00 THEN 'paid' ELSE 'partially_paid' END;
    v_new_overdue_status := CASE WHEN v_new_balance = 0.00 THEN 'paid' ELSE v_inv.overdue_status END;

    UPDATE billing.invoices
    SET paid_amount = paid_amount + p_amount,
        balance_amount = v_new_balance,
        status = v_new_status,
        overdue_status = v_new_overdue_status,
        updated_at = clock_timestamp()
    WHERE invoice_id = p_invoice_id;

    INSERT INTO billing.payments (
        tenant_id, invoice_id, student_id, payment_reference,
        amount, payment_method, status, receipt_number,
        gateway_order_id, gateway_payment_id, idempotency_key, recorded_by_actor_id
    ) VALUES (
        p_tenant_id, p_invoice_id, v_inv.student_id, COALESCE(p_gateway_payment_id, 'MANUAL-' || UPPER(SUBSTRING(gen_random_uuid()::text, 1, 8))),
        p_amount, p_payment_method, 'posted', v_receipt_no,
        p_gateway_order_id, p_gateway_payment_id, p_idempotency_key, p_actor_id
    ) RETURNING payment_id INTO v_payment_id;

    INSERT INTO integration.outbox_messages (tenant_id, correlation_id, event_type, payload)
    VALUES (
        p_tenant_id,
        COALESCE(p_idempotency_key, gen_random_uuid()::text),
        'billing.payment_posted',
        jsonb_build_object('paymentId', v_payment_id, 'receiptNumber', v_receipt_no, 'amount', p_amount, 'invoiceId', p_invoice_id)
    );

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'billing.payment_posted', 'payment', v_payment_id::text,
            COALESCE(p_idempotency_key, gen_random_uuid()::text),
            jsonb_build_object('receipt', v_receipt_no, 'amount', p_amount, 'method', p_payment_method));

    RETURN jsonb_build_object(
        'success', true,
        'paymentId', v_payment_id,
        'receiptNumber', v_receipt_no,
        'amountPaid', p_amount,
        'remainingBalance', v_new_balance,
        'invoiceStatus', v_new_status
    );
END;
$$;

-- Invoice ledger with effective status (overdue derived from due date) and period summary
DROP FUNCTION IF EXISTS billing.fn_invoice_list(UUID);
DROP FUNCTION IF EXISTS billing.fn_payment_list(UUID);

CREATE OR REPLACE FUNCTION billing.fn_invoice_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
    WITH inv AS (
        SELECT i.*,
               s.first_name || ' ' || s.last_name AS student_name,
               CASE
                   WHEN i.status = 'void' THEN 'void'
                   WHEN i.balance_amount = 0 THEN 'paid'
                   WHEN i.overdue_status = 'waived' THEN 'waived'
                   WHEN i.due_date < CURRENT_DATE THEN 'overdue'
                   ELSE 'pending'
               END AS effective_status,
               (SELECT string_agg(b.name, ', ' ORDER BY b.name)
                FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE e.student_id = i.student_id AND e.status = 'enrolled') AS batches,
               (SELECT MAX(p.created_at) FROM billing.payments p WHERE p.invoice_id = i.invoice_id) AS paid_on
        FROM billing.invoices i
        JOIN academics.students s ON s.student_id = i.student_id
        WHERE i.tenant_id = p_tenant_id AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
    )
    SELECT jsonb_build_object(
        'invoices', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'invoice_id', invoice_id, 'invoice_number', invoice_number, 'student_id', student_id,
                'student_name', student_name, 'batches', batches, 'billing_period', billing_period,
                'designation', designation, 'total_amount', total_amount, 'paid_amount', paid_amount,
                'balance_amount', balance_amount, 'due_date', due_date, 'status', effective_status,
                'overdue_status', overdue_status, 'late_fee_amount', late_fee_amount, 'days_overdue', days_overdue,
                'waived_reason', waived_reason, 'waived_at', waived_at,
                'paid_on', paid_on, 'created_at', created_at,
                'items', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'item_id', it.item_id,
                        'item_type', it.item_type,
                        'description', it.description,
                        'amount', it.amount
                    ))
                    FROM billing.invoice_items it WHERE it.invoice_id = inv.invoice_id
                ), '[]'::jsonb),
                'payments', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'payment_id', p.payment_id,
                        'amount', p.amount,
                        'payment_method', p.payment_method,
                        'receipt_number', p.receipt_number,
                        'created_at', p.created_at
                    ) ORDER BY p.created_at ASC)
                    FROM billing.payments p
                    WHERE p.invoice_id = inv.invoice_id
                ), '[]'::jsonb)
            ) ORDER BY created_at DESC, invoice_number DESC) FROM inv
        ), '[]'::jsonb),
        'summary', (
            SELECT jsonb_build_object(
                'billed_this_month', COALESCE(SUM(total_amount) FILTER (WHERE effective_status <> 'void' AND date_trunc('month', created_at) = date_trunc('month', now())), 0),
                'billed_this_month_count', COUNT(*) FILTER (WHERE effective_status <> 'void' AND date_trunc('month', created_at) = date_trunc('month', now())),
                'billed_total', COALESCE(SUM(total_amount) FILTER (WHERE effective_status <> 'void'), 0),
                'collected_total', COALESCE(SUM(paid_amount) FILTER (WHERE effective_status <> 'void'), 0),
                'outstanding_amount', COALESCE(SUM(balance_amount) FILTER (WHERE effective_status IN ('pending', 'overdue')), 0),
                'outstanding_count', COUNT(*) FILTER (WHERE effective_status IN ('pending', 'overdue')),
                'overdue_amount', COALESCE(SUM(balance_amount) FILTER (WHERE effective_status = 'overdue'), 0),
                'overdue_count', COUNT(*) FILTER (WHERE effective_status = 'overdue'),
                'late_fees_total', COALESCE(SUM(late_fee_amount) FILTER (WHERE effective_status <> 'void'), 0)
            ) FROM inv
        )
    );
$$;

CREATE OR REPLACE FUNCTION billing.fn_payment_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
    WITH pay AS (
        SELECT p.*, s.first_name || ' ' || s.last_name AS student_name, i.invoice_number,
               p.payment_method NOT IN ('Cash', 'Cheque') AS is_online
        FROM billing.payments p
        JOIN academics.students s ON s.student_id = p.student_id
        JOIN billing.invoices i ON i.invoice_id = p.invoice_id
        WHERE p.tenant_id = p_tenant_id AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
    )
    SELECT jsonb_build_object(
        'payments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'payment_id', payment_id, 'invoice_id', invoice_id, 'invoice_number', invoice_number,
                'student_id', student_id, 'student_name', student_name, 'payment_reference', payment_reference,
                'amount', amount, 'payment_method', payment_method, 'is_online', is_online, 'status', status,
                'receipt_number', receipt_number, 'created_at', created_at
            ) ORDER BY created_at DESC) FROM pay
        ), '[]'::jsonb),
        'summary', (
            SELECT jsonb_build_object(
                'collected_this_month', COALESCE(SUM(amount) FILTER (WHERE status IN ('posted', 'reconciled') AND date_trunc('month', created_at) = date_trunc('month', now())), 0),
                'online_total', COALESCE(SUM(amount) FILTER (WHERE status IN ('posted', 'reconciled') AND is_online), 0),
                'offline_total', COALESCE(SUM(amount) FILTER (WHERE status IN ('posted', 'reconciled') AND NOT is_online), 0),
                'refund_total', COALESCE(SUM(amount) FILTER (WHERE status = 'refunded'), 0),
                'refund_count', COUNT(*) FILTER (WHERE status = 'refunded')
            ) FROM pay
        )
    );
$$;

CREATE OR REPLACE FUNCTION billing.fn_fee_structure_list(
    p_tenant_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
    SELECT jsonb_build_object(
        'fee_heads', COALESCE((
            SELECT jsonb_agg(to_jsonb(h) ORDER BY h.code)
            FROM (SELECT fee_head_id, code, name, frequency, is_active FROM billing.fee_heads WHERE tenant_id = p_tenant_id) h
        ), '[]'::jsonb),
        'fee_plans', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'plan_id', fp.plan_id,
                'name', fp.name,
                'discount_percent', fp.discount_percent,
                'tax_percent', fp.tax_percent,
                'is_active', fp.is_active,
                'applied_to', COALESCE(
                    (SELECT string_agg(b.name, ', ' ORDER BY b.name) FROM academics.batches b WHERE b.course_id = fp.course_id),
                    'Selected students'),
                'items', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('fee_head_id', h.fee_head_id, 'name', h.name, 'amount', it.amount) ORDER BY h.code)
                    FROM billing.fee_plan_items it JOIN billing.fee_heads h ON h.fee_head_id = it.fee_head_id
                    WHERE it.plan_id = fp.plan_id
                ), '[]'::jsonb)
            ) ORDER BY fp.name)
            FROM billing.fee_plans fp WHERE fp.tenant_id = p_tenant_id
        ), '[]'::jsonb)
    );
$$;


CREATE OR REPLACE FUNCTION billing.fn_fee_plan_update(
    p_tenant_id UUID,
    p_plan_id UUID,
    p_name VARCHAR(150),
    p_discount_percent NUMERIC,
    p_is_active BOOLEAN,
    p_items JSONB,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, audit, public
AS $$
DECLARE
    v_item JSONB;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM billing.fee_plans WHERE plan_id = p_plan_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Fee plan not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Plan name is required' USING ERRCODE = '22023';
    END IF;

    UPDATE billing.fee_plans
    SET name = trim(p_name),
        discount_percent = COALESCE(p_discount_percent, 0.00),
        is_active = COALESCE(p_is_active, true)
    WHERE plan_id = p_plan_id AND tenant_id = p_tenant_id;

    IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
        DELETE FROM billing.fee_plan_items WHERE plan_id = p_plan_id;
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
            IF (v_item->>'amount')::NUMERIC > 0 THEN
                INSERT INTO billing.fee_plan_items (
                    plan_id, fee_head_id, amount
                ) VALUES (
                    p_plan_id,
                    (v_item->>'feeHeadId')::UUID,
                    (v_item->>'amount')::NUMERIC
                ) ON CONFLICT (plan_id, fee_head_id) DO UPDATE SET amount = EXCLUDED.amount;
            END IF;
        END LOOP;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'fee_plan.updated', 'fee_plan', p_plan_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'planId', p_plan_id));

    RETURN jsonb_build_object('success', true, 'planId', p_plan_id);
END;
$$;

CREATE OR REPLACE FUNCTION billing.fn_fee_head_create(
    p_tenant_id UUID,
    p_code VARCHAR(50),
    p_name VARCHAR(150),
    p_frequency VARCHAR(30),
    p_is_active BOOLEAN,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, audit, public
AS $$
DECLARE
    v_fee_head_id UUID;
BEGIN
    IF trim(COALESCE(p_name, '')) = '' THEN
        RAISE EXCEPTION 'Fee head name is required' USING ERRCODE = '22023';
    END IF;
    IF trim(COALESCE(p_code, '')) = '' THEN
        RAISE EXCEPTION 'Fee head code is required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO billing.fee_heads (tenant_id, code, name, frequency, is_active)
    VALUES (p_tenant_id, upper(trim(p_code)), trim(p_name), COALESCE(p_frequency, 'one-time'), COALESCE(p_is_active, true))
    RETURNING fee_head_id INTO v_fee_head_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'fee_head.created', 'fee_head', v_fee_head_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'code', p_code));

    RETURN jsonb_build_object('success', true, 'feeHeadId', v_fee_head_id);
END;
$$;

CREATE OR REPLACE FUNCTION billing.fn_fee_head_update(
    p_tenant_id UUID,
    p_fee_head_id UUID,
    p_code VARCHAR(50),
    p_name VARCHAR(150),
    p_frequency VARCHAR(30),
    p_is_active BOOLEAN,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, audit, public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM billing.fee_heads WHERE fee_head_id = p_fee_head_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Fee head not found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE billing.fee_heads
    SET name = trim(p_name),
        code = upper(trim(p_code)),
        frequency = COALESCE(p_frequency, frequency),
        is_active = COALESCE(p_is_active, is_active)
    WHERE fee_head_id = p_fee_head_id AND tenant_id = p_tenant_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'fee_head.updated', 'fee_head', p_fee_head_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'feeHeadId', p_fee_head_id));

    RETURN jsonb_build_object('success', true, 'feeHeadId', p_fee_head_id);
END;
$$;

CREATE OR REPLACE FUNCTION billing.fn_fee_plan_create(
    p_tenant_id UUID,
    p_name VARCHAR(150),
    p_course_id UUID,
    p_discount_percent NUMERIC,
    p_due_day INT,
    p_is_active BOOLEAN,
    p_items JSONB,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, audit, public
AS $$
DECLARE
    v_plan_id UUID;
    v_item JSONB;
BEGIN
    IF trim(COALESCE(p_name, '')) = '' THEN
        RAISE EXCEPTION 'Fee plan name is required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO billing.fee_plans (
        tenant_id, name, course_id, discount_percent, due_day_of_month, is_active
    ) VALUES (
        p_tenant_id, trim(p_name), p_course_id, COALESCE(p_discount_percent, 0.00), COALESCE(p_due_day, 5), COALESCE(p_is_active, true)
    ) RETURNING plan_id INTO v_plan_id;

    IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
            IF (v_item->>'amount')::NUMERIC > 0 THEN
                INSERT INTO billing.fee_plan_items (plan_id, fee_head_id, amount)
                VALUES (v_plan_id, (v_item->>'feeHeadId')::UUID, (v_item->>'amount')::NUMERIC);
            END IF;
        END LOOP;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'fee_plan.created', 'fee_plan', v_plan_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'planId', v_plan_id));

    RETURN jsonb_build_object('success', true, 'planId', v_plan_id);
END;
$$;


-- ============================================================================
-- FEE OVERDUE MANAGEMENT & LATE FEE STORED FUNCTIONS
-- ============================================================================

-- 1. Upsert Late Fee Rule (Tenant Default or Branch Override)
CREATE OR REPLACE FUNCTION billing.fn_late_fee_rule_upsert(
    p_tenant_id UUID,
    p_branch_id UUID,
    p_calc_method VARCHAR(30),
    p_value NUMERIC(10,2),
    p_grace_days INT,
    p_cap_amount NUMERIC(10,2),
    p_is_active BOOLEAN,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, tenant, audit, public
AS $$
DECLARE
    v_rule_id UUID;
    v_method VARCHAR(30);
BEGIN
    v_method := lower(trim(COALESCE(p_calc_method, '')));
    IF v_method NOT IN ('flat', 'percent', 'per_day') THEN
        RAISE EXCEPTION 'Invalid calc_method. Must be flat, percent, or per_day' USING ERRCODE = '22023';
    END IF;

    IF p_value IS NULL OR p_value < 0 THEN
        RAISE EXCEPTION 'Late fee value must be non-negative' USING ERRCODE = '22023';
    END IF;

    IF p_grace_days IS NULL OR p_grace_days < 0 THEN
        RAISE EXCEPTION 'Grace days must be non-negative' USING ERRCODE = '22023';
    END IF;

    IF p_cap_amount IS NOT NULL AND p_cap_amount < 0 THEN
        RAISE EXCEPTION 'Cap amount cannot be negative' USING ERRCODE = '22023';
    END IF;

    IF p_branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant.branches WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id
    ) THEN
        RAISE EXCEPTION 'Branch not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_branch_id IS NULL THEN
        INSERT INTO billing.late_fee_rules (
            tenant_id, branch_id, calc_method, value, grace_days, cap_amount, is_active, updated_at
        ) VALUES (
            p_tenant_id, NULL, v_method, p_value, COALESCE(p_grace_days, 0), p_cap_amount, COALESCE(p_is_active, TRUE), clock_timestamp()
        )
        ON CONFLICT (tenant_id) WHERE branch_id IS NULL
        DO UPDATE SET
            calc_method = EXCLUDED.calc_method,
            value = EXCLUDED.value,
            grace_days = EXCLUDED.grace_days,
            cap_amount = EXCLUDED.cap_amount,
            is_active = EXCLUDED.is_active,
            updated_at = clock_timestamp()
        RETURNING rule_id INTO v_rule_id;
    ELSE
        INSERT INTO billing.late_fee_rules (
            tenant_id, branch_id, calc_method, value, grace_days, cap_amount, is_active, updated_at
        ) VALUES (
            p_tenant_id, p_branch_id, v_method, p_value, COALESCE(p_grace_days, 0), p_cap_amount, COALESCE(p_is_active, TRUE), clock_timestamp()
        )
        ON CONFLICT (tenant_id, branch_id) WHERE branch_id IS NOT NULL
        DO UPDATE SET
            calc_method = EXCLUDED.calc_method,
            value = EXCLUDED.value,
            grace_days = EXCLUDED.grace_days,
            cap_amount = EXCLUDED.cap_amount,
            is_active = EXCLUDED.is_active,
            updated_at = clock_timestamp()
        RETURNING rule_id INTO v_rule_id;
    END IF;

    INSERT INTO audit.compliance_logs (
        tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details
    ) VALUES (
        p_tenant_id, p_actor_id, 'billing.late_fee_rule_upserted', 'late_fee_rule', v_rule_id::text,
        gen_random_uuid()::text,
        jsonb_build_object('ruleId', v_rule_id, 'branchId', p_branch_id, 'method', v_method, 'value', p_value, 'graceDays', p_grace_days, 'capAmount', p_cap_amount)
    );

    RETURN jsonb_build_object('success', true, 'ruleId', v_rule_id);
END;
$$;

-- 2. Get Late Fee Rules for Tenant (Default, Branch Overrides, and Resolved Effective Rule)
CREATE OR REPLACE FUNCTION billing.fn_late_fee_rule_get(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, tenant, public
AS $$
    SELECT jsonb_build_object(
        'tenant_rule', (
            SELECT to_jsonb(r)
            FROM billing.late_fee_rules r
            WHERE r.tenant_id = p_tenant_id AND r.branch_id IS NULL
        ),
        'branch_rules', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'rule_id', r.rule_id,
                'branch_id', r.branch_id,
                'branch_name', b.name,
                'calc_method', r.calc_method,
                'value', r.value,
                'grace_days', r.grace_days,
                'cap_amount', r.cap_amount,
                'is_active', r.is_active,
                'created_at', r.created_at,
                'updated_at', r.updated_at
            ) ORDER BY b.name)
            FROM billing.late_fee_rules r
            JOIN tenant.branches b ON b.branch_id = r.branch_id
            WHERE r.tenant_id = p_tenant_id AND r.branch_id IS NOT NULL
        ), '[]'::jsonb),
        'effective_rule', (
            SELECT to_jsonb(r)
            FROM billing.late_fee_rules r
            WHERE r.tenant_id = p_tenant_id
              AND (
                (p_branch_id IS NOT NULL AND r.branch_id = p_branch_id)
                OR (r.branch_id IS NULL)
              )
              AND r.is_active = TRUE
            ORDER BY (r.branch_id IS NOT NULL) DESC
            LIMIT 1
        )
    );
$$;

-- 3. Idempotent Invoice Overdue Recalculation & Automated Parent Notifications
CREATE OR REPLACE FUNCTION billing.fn_invoice_overdue_recalculate(
    p_tenant_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, tenant, academics, engagement, audit, public
AS $$
DECLARE
    v_tenant RECORD;
    v_inv RECORD;
    v_rule RECORD;
    v_timezone VARCHAR(50);
    v_today DATE;
    v_days_diff INT;
    v_grace_days INT;
    v_calc_late_fee NUMERIC(10,2);
    v_status VARCHAR(30);
    v_days INT;
    v_fee_diff NUMERIC(10,2);
    v_updated_count INT := 0;
    v_notices_sent INT := 0;
    v_event_key TEXT;
    v_notice_title TEXT;
    v_notice_body TEXT;
BEGIN
    FOR v_tenant IN
        SELECT tenant_id, name, timezone
        FROM tenant.organizations
        WHERE (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
          AND is_active = TRUE
    LOOP
        v_timezone := COALESCE(NULLIF(trim(v_tenant.timezone), ''), 'Asia/Kolkata');
        BEGIN
            v_today := (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::DATE;
        EXCEPTION WHEN OTHERS THEN
            v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE;
        END;

        FOR v_inv IN
            SELECT DISTINCT ON (i.invoice_id)
                i.invoice_id,
                i.tenant_id,
                i.student_id,
                i.invoice_number,
                i.billing_period,
                i.total_amount,
                i.paid_amount,
                i.balance_amount,
                i.due_date,
                i.status,
                i.overdue_status,
                COALESCE(i.late_fee_amount, 0.00) AS late_fee_amount,
                COALESCE(i.days_overdue, 0) AS days_overdue,
                i.waived_at,
                i.waived_reason,
                s.branch_id,
                s.first_name || ' ' || s.last_name AS student_name
            FROM billing.invoices i
            JOIN academics.students s ON s.student_id = i.student_id
            WHERE i.tenant_id = v_tenant.tenant_id
              AND i.status NOT IN ('void', 'cancelled')
              AND i.balance_amount > 0
            ORDER BY i.invoice_id, i.due_date ASC
        LOOP
            v_days_diff := v_today - v_inv.due_date;

            -- 1. Check if late fee was already waived by an administrator
            IF v_inv.overdue_status = 'waived' OR v_inv.waived_at IS NOT NULL THEN
                v_status := 'waived';
                v_calc_late_fee := 0.00;
                v_days := GREATEST(0, v_days_diff);
            ELSE
                -- 2. Normal overdue & late fee evaluation
                IF v_today < v_inv.due_date THEN
                    v_status := 'upcoming';
                    v_days := 0;
                    v_calc_late_fee := 0.00;
                ELSIF v_today = v_inv.due_date THEN
                    v_status := 'due';
                    v_days := 0;
                    v_calc_late_fee := 0.00;
                ELSE
                    -- v_today > due_date: check active late fee rule (branch override first, then tenant default)
                    SELECT * INTO v_rule
                    FROM billing.late_fee_rules
                    WHERE tenant_id = v_tenant.tenant_id
                      AND branch_id = v_inv.branch_id
                      AND is_active = TRUE
                    LIMIT 1;

                    IF NOT FOUND THEN
                        SELECT * INTO v_rule
                        FROM billing.late_fee_rules
                        WHERE tenant_id = v_tenant.tenant_id
                          AND branch_id IS NULL
                          AND is_active = TRUE
                        LIMIT 1;
                    END IF;

                    v_grace_days := COALESCE(v_rule.grace_days, 0);

                    IF v_days_diff <= v_grace_days THEN
                        v_status := 'in_grace';
                        v_days := v_days_diff;
                        v_calc_late_fee := 0.00;
                    ELSE
                        v_status := 'overdue';
                        v_days := v_days_diff;

                        IF v_rule.rule_id IS NOT NULL THEN
                            IF v_rule.calc_method = 'flat' THEN
                                v_calc_late_fee := v_rule.value;
                            ELSIF v_rule.calc_method = 'percent' THEN
                                -- Percentage of original invoice total_amount, rounded to minor units
                                v_calc_late_fee := ROUND((v_inv.total_amount * v_rule.value / 100.0), 2);
                            ELSIF v_rule.calc_method = 'per_day' THEN
                                -- Per day charge for each day past grace period
                                v_calc_late_fee := ROUND((v_days_diff - v_grace_days) * v_rule.value, 2);
                            ELSE
                                v_calc_late_fee := 0.00;
                            END IF;

                            -- Apply cap if configured
                            IF v_rule.cap_amount IS NOT NULL AND v_rule.cap_amount > 0 AND v_calc_late_fee > v_rule.cap_amount THEN
                                v_calc_late_fee := v_rule.cap_amount;
                            END IF;
                        ELSE
                            v_calc_late_fee := 0.00;
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- 3. Idempotent check & line item synchronization
            v_fee_diff := v_calc_late_fee - v_inv.late_fee_amount;

            IF v_fee_diff <> 0.00 OR v_status <> v_inv.overdue_status OR v_days <> v_inv.days_overdue THEN
                -- Sync invoice line items (never modify original invoice amount!)
                IF v_calc_late_fee > 0.00 THEN
                    IF EXISTS (SELECT 1 FROM billing.invoice_items WHERE invoice_id = v_inv.invoice_id AND item_type = 'late_fee') THEN
                        UPDATE billing.invoice_items
                        SET amount = v_calc_late_fee,
                            description = 'Late Fee (' || COALESCE(v_rule.calc_method, 'rule') || ')',
                            updated_at = clock_timestamp()
                        WHERE invoice_id = v_inv.invoice_id AND item_type = 'late_fee';
                    ELSE
                        INSERT INTO billing.invoice_items (
                            tenant_id, invoice_id, item_type, description, amount
                        ) VALUES (
                            v_tenant.tenant_id, v_inv.invoice_id, 'late_fee',
                            'Late Fee (' || COALESCE(v_rule.calc_method, 'rule') || ')',
                            v_calc_late_fee
                        );
                    END IF;
                ELSE
                    DELETE FROM billing.invoice_items
                    WHERE invoice_id = v_inv.invoice_id AND item_type = 'late_fee';
                END IF;

                -- Update invoice state
                UPDATE billing.invoices
                SET late_fee_amount = v_calc_late_fee,
                    balance_amount = balance_amount + v_fee_diff,
                    overdue_status = v_status,
                    days_overdue = v_days,
                    updated_at = clock_timestamp()
                WHERE invoice_id = v_inv.invoice_id;

                -- Audit trail
                INSERT INTO billing.fee_audit (
                    tenant_id, invoice_id, action, old_value, new_value, user_id, reason
                ) VALUES (
                    v_tenant.tenant_id, v_inv.invoice_id, 'overdue_recalculated',
                    jsonb_build_object('late_fee', v_inv.late_fee_amount, 'status', v_inv.overdue_status, 'days_overdue', v_inv.days_overdue),
                    jsonb_build_object('late_fee', v_calc_late_fee, 'status', v_status, 'days_overdue', v_days),
                    p_actor_id,
                    'Automated overdue recalculation'
                );

                v_updated_count := v_updated_count + 1;
            END IF;

            -- 4. Automated Parent Engagement Notices:
            -- Reminder 2 days before due date, on due date, and when overdue (+3 days)
            v_event_key := NULL;
            IF v_today = (v_inv.due_date - INTERVAL '2 days')::DATE THEN
                v_event_key := 'notice_due_minus_2_' || v_inv.invoice_id::text;
                v_notice_title := 'Reminder: Fee Due in 2 Days — Invoice #' || v_inv.invoice_number;
                v_notice_body := 'Invoice #' || v_inv.invoice_number || ' for ' || v_inv.student_name || ' is due on ' || TO_CHAR(v_inv.due_date, 'Mon DD, YYYY') || '. Outstanding amount: ' || (v_inv.balance_amount + v_fee_diff)::text || '.';
            ELSIF v_today = v_inv.due_date THEN
                v_event_key := 'notice_due_today_' || v_inv.invoice_id::text;
                v_notice_title := 'Fee Due Today — Invoice #' || v_inv.invoice_number;
                v_notice_body := 'Invoice #' || v_inv.invoice_number || ' for ' || v_inv.student_name || ' is due today (' || TO_CHAR(v_inv.due_date, 'Mon DD, YYYY') || '). Outstanding balance: ' || (v_inv.balance_amount + v_fee_diff)::text || '.';
            ELSIF v_today = (v_inv.due_date + INTERVAL '3 days')::DATE THEN
                v_event_key := 'notice_overdue_plus_3_' || v_inv.invoice_id::text;
                v_notice_title := 'Important: Fee Overdue — Invoice #' || v_inv.invoice_number;
                v_notice_body := 'Invoice #' || v_inv.invoice_number || ' for ' || v_inv.student_name || ' is overdue by 3 days. Please settle the outstanding balance of ' || (v_inv.balance_amount + v_fee_diff)::text || ' to avoid further late fees.';
            END IF;

            IF v_event_key IS NOT NULL THEN
                -- Deduplicate: ensure notice is not issued repeatedly for the same milestone
                IF NOT EXISTS (
                    SELECT 1 FROM audit.compliance_logs
                    WHERE tenant_id = v_tenant.tenant_id AND entity_id = v_event_key AND action = 'engagement.fee_reminder_sent'
                ) THEN
                    PERFORM engagement.fn_notice_publish(
                        v_tenant.tenant_id,
                        v_notice_title,
                        v_notice_body,
                        'fee_reminder',
                        'published',
                        'high',
                        'guardians',
                        NULL,
                        v_inv.branch_id,
                        ARRAY['in-app', 'email'],
                        (clock_timestamp() + INTERVAL '30 days'),
                        COALESCE(p_actor_id, gen_random_uuid()),
                        FALSE
                    );

                    INSERT INTO audit.compliance_logs (
                        tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details
                    ) VALUES (
                        v_tenant.tenant_id, COALESCE(p_actor_id, gen_random_uuid()), 'engagement.fee_reminder_sent',
                        'invoice', v_event_key, gen_random_uuid()::text,
                        jsonb_build_object('invoiceId', v_inv.invoice_id, 'studentName', v_inv.student_name, 'dueDate', v_inv.due_date)
                    );

                    v_notices_sent := v_notices_sent + 1;
                END IF;
            END IF;
        END LOOP;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'invoicesUpdated', v_updated_count,
        'noticesSent', v_notices_sent
    );
END;
$$;

-- 4. Waive Late Fee (Reason strictly required)
CREATE OR REPLACE FUNCTION billing.fn_invoice_late_fee_waive(
    p_tenant_id UUID,
    p_invoice_id UUID,
    p_reason TEXT,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, audit, public
AS $$
DECLARE
    v_inv RECORD;
    v_waived_amount NUMERIC(10,2);
    v_new_balance NUMERIC(10,2);
    v_new_status VARCHAR(30);
BEGIN
    IF p_reason IS NULL OR trim(p_reason) = '' THEN
        RAISE EXCEPTION 'A reason is required to waive a late fee' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_inv
    FROM billing.invoices
    WHERE invoice_id = p_invoice_id AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_inv.status IN ('void', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot waive late fee for a void or cancelled invoice' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(v_inv.late_fee_amount, 0.00) <= 0.00 THEN
        RAISE EXCEPTION 'Invoice % has no active late fee to waive', v_inv.invoice_number USING ERRCODE = '22023';
    END IF;

    v_waived_amount := v_inv.late_fee_amount;
    v_new_balance := GREATEST(0.00, v_inv.balance_amount - v_waived_amount);
    v_new_status := CASE WHEN v_new_balance = 0.00 THEN 'paid' ELSE v_inv.status END;

    -- Remove late fee item from line items
    DELETE FROM billing.invoice_items
    WHERE invoice_id = p_invoice_id AND item_type = 'late_fee';

    -- Update invoice: original total_amount is NEVER modified!
    UPDATE billing.invoices
    SET late_fee_amount = 0.00,
        balance_amount = v_new_balance,
        overdue_status = 'waived',
        waived_reason = trim(p_reason),
        waived_at = clock_timestamp(),
        waived_by_actor_id = p_actor_id,
        status = v_new_status,
        updated_at = clock_timestamp()
    WHERE invoice_id = p_invoice_id;

    -- Record in fee_audit
    INSERT INTO billing.fee_audit (
        tenant_id, invoice_id, action, old_value, new_value, user_id, reason
    ) VALUES (
        p_tenant_id, p_invoice_id, 'late_fee_waived',
        jsonb_build_object('late_fee_amount', v_waived_amount, 'balance_amount', v_inv.balance_amount, 'overdue_status', v_inv.overdue_status),
        jsonb_build_object('late_fee_amount', 0.00, 'balance_amount', v_new_balance, 'overdue_status', 'waived'),
        p_actor_id,
        trim(p_reason)
    );

    -- Record in compliance_logs
    INSERT INTO audit.compliance_logs (
        tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details
    ) VALUES (
        p_tenant_id, p_actor_id, 'billing.late_fee_waived', 'invoice', p_invoice_id::text,
        gen_random_uuid()::text,
        jsonb_build_object('invoiceNumber', v_inv.invoice_number, 'waivedAmount', v_waived_amount, 'reason', trim(p_reason))
    );

    RETURN jsonb_build_object(
        'success', true,
        'invoiceId', p_invoice_id,
        'waivedAmount', v_waived_amount,
        'remainingBalance', v_new_balance,
        'status', v_new_status
    );
END;
$$;

-- 5. List Overdue Invoices with Multi-Parameter Filtering
CREATE OR REPLACE FUNCTION billing.fn_overdue_list(
    p_tenant_id UUID,
    p_branch_id UUID,
    p_course_id UUID,
    p_batch_id UUID,
    p_min_days_overdue INT
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, tenant, public
AS $$
    WITH over_inv AS (
        SELECT DISTINCT ON (i.invoice_id)
            i.invoice_id,
            i.invoice_number,
            i.student_id,
            s.first_name || ' ' || s.last_name AS student_name,
            s.email AS student_email,
            s.phone AS student_phone,
            s.branch_id,
            br.name AS branch_name,
            c.course_id,
            c.title AS course_name,
            b.batch_id,
            b.name AS batch_name,
            i.billing_period,
            i.designation,
            i.total_amount AS original_amount,
            i.late_fee_amount,
            i.paid_amount,
            i.balance_amount,
            i.due_date,
            i.days_overdue,
            i.overdue_status,
            i.status,
            i.waived_reason,
            i.waived_at,
            i.created_at
        FROM billing.invoices i
        JOIN academics.students s ON s.student_id = i.student_id
        LEFT JOIN tenant.branches br ON br.branch_id = s.branch_id
        LEFT JOIN academics.enrollments e ON e.student_id = s.student_id AND e.status = 'enrolled'
        LEFT JOIN academics.batches b ON b.batch_id = e.batch_id
        LEFT JOIN academics.courses c ON c.course_id = b.course_id
        WHERE i.tenant_id = p_tenant_id
          AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
          AND (p_course_id IS NULL OR c.course_id = p_course_id)
          AND (p_batch_id IS NULL OR b.batch_id = p_batch_id)
          AND (p_min_days_overdue IS NULL OR i.days_overdue >= p_min_days_overdue)
          AND (
            i.overdue_status IN ('overdue', 'in_grace', 'due')
            OR (i.balance_amount > 0 AND i.due_date <= CURRENT_DATE)
            OR i.overdue_status = 'waived'
          )
          AND i.status NOT IN ('void', 'cancelled')
        ORDER BY i.invoice_id, i.days_overdue DESC, i.due_date ASC
    )
    SELECT jsonb_build_object(
        'items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'invoice_id', invoice_id,
                'invoice_number', invoice_number,
                'student_id', student_id,
                'student_name', student_name,
                'student_email', student_email,
                'student_phone', student_phone,
                'branch_id', branch_id,
                'branch_name', branch_name,
                'course_id', course_id,
                'course_name', course_name,
                'batch_id', batch_id,
                'batch_name', batch_name,
                'billing_period', billing_period,
                'designation', designation,
                'original_amount', original_amount,
                'late_fee_amount', late_fee_amount,
                'paid_amount', paid_amount,
                'balance_amount', balance_amount,
                'due_date', due_date,
                'days_overdue', days_overdue,
                'overdue_status', overdue_status,
                'status', status,
                'waived_reason', waived_reason,
                'waived_at', waived_at,
                'created_at', created_at
            ) ORDER BY days_overdue DESC, due_date ASC)
            FROM over_inv
        ), '[]'::jsonb),
        'summary', (
            SELECT jsonb_build_object(
                'total_overdue_count', COUNT(*) FILTER (WHERE overdue_status = 'overdue' OR balance_amount > 0),
                'total_overdue_amount', COALESCE(SUM(balance_amount) FILTER (WHERE overdue_status = 'overdue' OR balance_amount > 0), 0),
                'total_late_fees', COALESCE(SUM(late_fee_amount), 0),
                'total_waived_count', COUNT(*) FILTER (WHERE overdue_status = 'waived'),
                'total_in_grace_count', COUNT(*) FILTER (WHERE overdue_status = 'in_grace')
            ) FROM over_inv
        )
    );
$$;

-- 6. Overdue Summary with Per-Branch Breakdown and Aging
CREATE OR REPLACE FUNCTION billing.fn_overdue_summary(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, tenant, public
AS $$
DECLARE
    v_summary JSONB;
    v_branches JSONB;
BEGIN
    SELECT jsonb_build_object(
        'total_overdue_count', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.overdue_status = 'overdue' OR (i.balance_amount > 0 AND i.due_date < CURRENT_DATE)),
        'total_overdue_amount', COALESCE(SUM(i.balance_amount) FILTER (WHERE i.overdue_status = 'overdue' OR (i.balance_amount > 0 AND i.due_date < CURRENT_DATE)), 0),
        'total_late_fees_assessed', COALESCE(SUM(i.late_fee_amount), 0),
        'total_in_grace_count', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.overdue_status = 'in_grace'),
        'total_waived_count', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.overdue_status = 'waived'),
        'aging_1_to_30_days', COALESCE(SUM(i.balance_amount) FILTER (WHERE i.days_overdue BETWEEN 1 AND 30 AND i.balance_amount > 0), 0),
        'aging_31_to_60_days', COALESCE(SUM(i.balance_amount) FILTER (WHERE i.days_overdue BETWEEN 31 AND 60 AND i.balance_amount > 0), 0),
        'aging_61_plus_days', COALESCE(SUM(i.balance_amount) FILTER (WHERE i.days_overdue > 60 AND i.balance_amount > 0), 0),
        'count_1_to_30_days', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.days_overdue BETWEEN 1 AND 30 AND i.balance_amount > 0),
        'count_31_to_60_days', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.days_overdue BETWEEN 31 AND 60 AND i.balance_amount > 0),
        'count_61_plus_days', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.days_overdue > 60 AND i.balance_amount > 0)
    ) INTO v_summary
    FROM billing.invoices i
    JOIN academics.students s ON s.student_id = i.student_id
    WHERE i.tenant_id = p_tenant_id
      AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
      AND i.status NOT IN ('void', 'cancelled');

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'branch_id', br.branch_id,
        'branch_name', br.name,
        'overdue_count', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.overdue_status = 'overdue' OR (i.balance_amount > 0 AND i.due_date < CURRENT_DATE)),
        'overdue_amount', COALESCE(SUM(i.balance_amount) FILTER (WHERE i.overdue_status = 'overdue' OR (i.balance_amount > 0 AND i.due_date < CURRENT_DATE)), 0),
        'late_fees_amount', COALESCE(SUM(i.late_fee_amount), 0),
        'in_grace_count', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.overdue_status = 'in_grace'),
        'waived_count', COUNT(DISTINCT i.invoice_id) FILTER (WHERE i.overdue_status = 'waived')
    ) ORDER BY br.name), '[]'::jsonb) INTO v_branches
    FROM tenant.branches br
    LEFT JOIN academics.students s ON s.branch_id = br.branch_id AND s.tenant_id = p_tenant_id
    LEFT JOIN billing.invoices i ON i.student_id = s.student_id AND i.tenant_id = p_tenant_id AND i.status NOT IN ('void', 'cancelled')
    WHERE br.tenant_id = p_tenant_id
      AND (p_branch_id IS NULL OR br.branch_id = p_branch_id)
    GROUP BY br.branch_id, br.name;

    RETURN jsonb_build_object(
        'summary', v_summary,
        'branches', v_branches
    );
END;
$$;
