-- ============================================================================
-- ClassSphere Functions: 008_registration_payment_functions.sql
-- Production Razorpay Payment & Autopay Subscription Lifecycle Functions
-- ============================================================================

-- 1. Create a pending registration payment order / subscription record
DROP FUNCTION IF EXISTS platform.fn_registration_order_create(VARCHAR, VARCHAR, VARCHAR, NUMERIC, VARCHAR, JSONB);
CREATE OR REPLACE FUNCTION platform.fn_registration_order_create(
    p_order_id VARCHAR(100),
    p_plan_tier VARCHAR(50),
    p_plan_name VARCHAR(100),
    p_amount NUMERIC(10,2),
    p_currency VARCHAR(10),
    p_payload JSONB,
    p_subscription_id VARCHAR(100) DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, public
AS $$
DECLARE
    v_reg_id UUID;
BEGIN
    INSERT INTO platform.registration_payments (
        order_id,
        subscription_id,
        plan_tier,
        plan_name,
        amount,
        currency,
        payment_status,
        registration_payload
    ) VALUES (
        p_order_id,
        p_subscription_id,
        p_plan_tier,
        p_plan_name,
        p_amount,
        COALESCE(p_currency, 'INR'),
        'pending',
        p_payload
    )
    RETURNING registration_id INTO v_reg_id;

    RETURN jsonb_build_object(
        'success', true,
        'registrationId', v_reg_id,
        'orderId', p_order_id,
        'subscriptionId', p_subscription_id,
        'paymentStatus', 'pending'
    );
END;
$$;

-- 2. Verify payment & atomically activate the academy
DROP FUNCTION IF EXISTS platform.fn_registration_payment_verify_and_activate(VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION platform.fn_registration_payment_verify_and_activate(
    p_order_id VARCHAR(100),
    p_payment_id VARCHAR(100),
    p_payment_method VARCHAR(50),
    p_transaction_date TIMESTAMPTZ,
    p_subscription_id VARCHAR(100) DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, tenant, identity_app, audit, public
AS $$
DECLARE
    v_reg RECORD;
    v_payload JSONB;
    v_result JSONB;
    v_tenant_id UUID;
    v_admin_id UUID;
    v_start TIMESTAMPTZ := COALESCE(p_transaction_date, clock_timestamp());
    v_end TIMESTAMPTZ := COALESCE(p_transaction_date, clock_timestamp()) + INTERVAL '30 days';
BEGIN
    SELECT * INTO v_reg FROM platform.registration_payments 
    WHERE (p_order_id IS NOT NULL AND order_id = p_order_id)
       OR (p_subscription_id IS NOT NULL AND subscription_id = p_subscription_id)
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration order % or subscription % not found', p_order_id, p_subscription_id USING ERRCODE = '22023';
    END IF;

    -- Idempotent check: if already processed and activated, return existing details
    IF v_reg.payment_status = 'success' AND v_reg.tenant_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'alreadyActivated', true,
            'tenantId', v_reg.tenant_id,
            'adminUserId', v_reg.admin_user_id,
            'planTier', v_reg.plan_tier,
            'paymentStatus', 'success'
        );
    END IF;

    v_payload := v_reg.registration_payload;

    -- Provision the academy workspace & TenantAdmin owner account with default address
    v_result := tenant.fn_tenant_register(
        v_payload->>'academyName',
        v_payload->>'academyType',
        v_reg.plan_tier,
        (v_payload->>'firstName') || ' ' || (v_payload->>'lastName'),
        v_payload->>'email',
        v_payload->>'phone',
        v_payload->>'passwordHash',
        COALESCE(v_payload->>'country', 'India'),
        v_payload->>'state',
        v_payload->>'city',
        v_payload->>'address',
        v_payload->>'location'
    );

    v_tenant_id := (v_result->>'tenantId')::UUID;
    v_admin_id := (v_result->>'adminUserId')::UUID;

    -- Update subscription record with gateway order, subscription and payment IDs
    UPDATE platform.subscriptions
    SET gateway_order_id = COALESCE(p_order_id, gateway_order_id),
        gateway_payment_id = p_payment_id,
        gateway_subscription_id = COALESCE(p_subscription_id, gateway_subscription_id),
        status = 'active',
        current_period_start = v_start,
        current_period_end = v_end,
        updated_at = clock_timestamp()
    WHERE tenant_id = v_tenant_id;

    -- Update registration payment record to success
    UPDATE platform.registration_payments
    SET payment_id = p_payment_id,
        subscription_id = COALESCE(p_subscription_id, subscription_id),
        payment_status = 'success',
        payment_method = p_payment_method,
        transaction_date = v_start,
        subscription_start_date = v_start,
        subscription_end_date = v_end,
        tenant_id = v_tenant_id,
        admin_user_id = v_admin_id,
        updated_at = clock_timestamp()
    WHERE registration_id = v_reg.registration_id;

    -- Log compliance audit trail
    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (
        v_tenant_id,
        v_admin_id,
        'billing.subscription.autopay_activated',
        'subscription',
        COALESCE(p_subscription_id, p_order_id),
        gen_random_uuid()::text,
        jsonb_build_object(
            'orderId', p_order_id,
            'subscriptionId', p_subscription_id,
            'paymentId', p_payment_id,
            'planTier', v_reg.plan_tier,
            'amount', v_reg.amount,
            'method', p_payment_method
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'alreadyActivated', false,
        'tenantId', v_tenant_id,
        'adminUserId', v_admin_id,
        'planTier', v_reg.plan_tier,
        'paymentStatus', 'success'
    );
END;
$$;

-- 3. Record payment failure or cancellation
CREATE OR REPLACE FUNCTION platform.fn_registration_payment_fail(
    p_order_id VARCHAR(100),
    p_error_message TEXT,
    p_status VARCHAR(30) DEFAULT 'failed'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, public
AS $$
BEGIN
    UPDATE platform.registration_payments
    SET payment_status = COALESCE(p_status, 'failed'),
        error_message = p_error_message,
        updated_at = clock_timestamp()
    WHERE (order_id = p_order_id OR subscription_id = p_order_id) AND payment_status != 'success';

    RETURN jsonb_build_object(
        'success', true,
        'orderId', p_order_id,
        'paymentStatus', COALESCE(p_status, 'failed')
    );
END;
$$;

-- 4. Get registration payment status
CREATE OR REPLACE FUNCTION platform.fn_registration_payment_status(
    p_order_id VARCHAR(100)
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
DECLARE
    v_reg RECORD;
BEGIN
    SELECT * INTO v_reg FROM platform.registration_payments 
    WHERE order_id = p_order_id OR subscription_id = p_order_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order or subscription not found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'registrationId', v_reg.registration_id,
        'orderId', v_reg.order_id,
        'subscriptionId', v_reg.subscription_id,
        'paymentId', v_reg.payment_id,
        'planTier', v_reg.plan_tier,
        'planName', v_reg.plan_name,
        'amount', v_reg.amount,
        'currency', v_reg.currency,
        'paymentStatus', v_reg.payment_status,
        'paymentMethod', v_reg.payment_method,
        'tenantId', v_reg.tenant_id,
        'adminUserId', v_reg.admin_user_id,
        'errorMessage', v_reg.error_message,
        'createdAt', v_reg.created_at
    );
END;
$$;
