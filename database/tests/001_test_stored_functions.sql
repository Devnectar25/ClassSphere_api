-- ============================================================================
-- ClassSphere Database Test Suite: 001_test_stored_functions.sql
-- Traceability: TDD Section 10.6, 23; PLT-006, PLT-014
-- ============================================================================

BEGIN;

-- Test 1: Tenant Creation creates org, primary branch, subscription, and audit log
DO $$
DECLARE
    v_res JSONB;
    v_tenant_id UUID;
BEGIN
    v_res := tenant.fn_tenant_create(
        'Test Conservatory',
        'test-conservatory-' || SUBSTRING(gen_random_uuid()::text, 1, 6),
        'USD',
        'America/New_York',
        'Enterprise',
        NULL,
        gen_random_uuid()
    );

    IF (v_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 1 Failed: Tenant creation failed: %', v_res;
    END IF;

    v_tenant_id := (v_res->>'tenantId')::UUID;

    -- Verify branch created
    IF NOT EXISTS (SELECT 1 FROM tenant.branches WHERE tenant_id = v_tenant_id AND is_primary = true) THEN
        RAISE EXCEPTION 'Test 1 Failed: Primary branch was not created';
    END IF;

    -- Verify audit log emitted
    IF NOT EXISTS (SELECT 1 FROM audit.compliance_logs WHERE tenant_id = v_tenant_id AND action = 'tenant.created') THEN
        RAISE EXCEPTION 'Test 1 Failed: Compliance audit log was not recorded';
    END IF;

    RAISE NOTICE 'Test 1 Passed: fn_tenant_create contract verified.';
END $$;

-- Test 2: Invoices and Idempotent Payments Contract
DO $$
DECLARE
    v_tenant_id UUID;
    v_student_res JSONB;
    v_student_id UUID;
    v_inv_res JSONB;
    v_pay_res1 JSONB;
    v_pay_res2 JSONB;
    v_inv_id UUID;
BEGIN
    -- Create test tenant & student
    SELECT tenant_id INTO v_tenant_id FROM tenant.organizations LIMIT 1;
    v_student_res := academics.fn_student_create(v_tenant_id, 'Jane', 'Doe', 'jane.doe@example.com', '555-0199', '2010-05-15', NULL, NULL, NULL, NULL, gen_random_uuid());
    v_student_id := (v_student_res->>'studentId')::UUID;

    -- Insert test invoice
    INSERT INTO billing.invoices (
        tenant_id, invoice_number, student_id, billing_period,
        subtotal_amount, total_amount, balance_amount, due_date, status, designation
    ) VALUES (
        v_tenant_id, 'INV-TEST-001', v_student_id, 'Oct 2026',
        250.00, 250.00, 250.00, CURRENT_DATE + 10, 'pending', 'Monthly Tuition'
    ) RETURNING invoice_id INTO v_inv_id;

    -- Post payment with idempotency key
    v_pay_res1 := billing.fn_payment_post(
        v_tenant_id, v_inv_id, 250.00, 'UPI', 'ORD-TEST-1', 'PAY-TEST-1', 'IDEM-KEY-999', gen_random_uuid()
    );

    IF (v_pay_res1->>'remainingBalance')::numeric <> 0.00 THEN
        RAISE EXCEPTION 'Test 2 Failed: Invoice balance was not reconciled to 0.00';
    END IF;

    -- Re-post same payment with same idempotency key (must return idempotent replay)
    v_pay_res2 := billing.fn_payment_post(
        v_tenant_id, v_inv_id, 250.00, 'UPI', 'ORD-TEST-1', 'PAY-TEST-1', 'IDEM-KEY-999', gen_random_uuid()
    );

    IF (v_pay_res2->>'idempotentReplay')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 2 Failed: Idempotency was not preserved on duplicate payment post';
    END IF;

    RAISE NOTICE 'Test 2 Passed: fn_payment_post idempotency and financial invariants verified.';
END $$;

ROLLBACK;
