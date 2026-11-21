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

    v_receipt_no := 'RCP-' || TO_CHAR(clock_timestamp(), 'YYYYMMDD') || '-' || UPPER(SUBSTRING(gen_random_uuid()::text, 1, 6));
    v_new_balance := v_inv.balance_amount - p_amount;
    v_new_status := CASE WHEN v_new_balance = 0.00 THEN 'paid' ELSE 'partially_paid' END;

    UPDATE billing.invoices
    SET paid_amount = paid_amount + p_amount,
        balance_amount = v_new_balance,
        status = v_new_status,
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
                'paid_on', paid_on, 'created_at', created_at,
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
                'overdue_count', COUNT(*) FILTER (WHERE effective_status = 'overdue')
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
