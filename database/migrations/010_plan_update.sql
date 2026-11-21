-- ============================================================================
-- ClassSphere Migration: 010_plan_update.sql
-- Function to allow Platform Operator to update subscription plan parameters
-- ============================================================================

CREATE OR REPLACE FUNCTION platform.fn_plan_update(
    p_plan_tier VARCHAR(50),
    p_description TEXT,
    p_price_monthly NUMERIC(10,2),
    p_currency VARCHAR(10),
    p_max_seats INT,
    p_max_branches INT,
    p_features TEXT[],
    p_is_popular BOOLEAN,
    p_razorpay_plan_id VARCHAR(100) DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, public
AS $$
DECLARE
    v_plan RECORD;
BEGIN
    IF p_is_popular IS TRUE THEN
        UPDATE platform.plans SET is_popular = FALSE WHERE plan_tier <> p_plan_tier;
    END IF;

    UPDATE platform.plans
    SET description = COALESCE(p_description, description),
        price_monthly = COALESCE(p_price_monthly, price_monthly),
        currency = COALESCE(p_currency, currency),
        max_seats = COALESCE(p_max_seats, max_seats),
        max_branches = COALESCE(p_max_branches, max_branches),
        features = COALESCE(p_features, features),
        is_popular = COALESCE(p_is_popular, is_popular),
        razorpay_plan_id = COALESCE(p_razorpay_plan_id, razorpay_plan_id)
    WHERE plan_tier = p_plan_tier
    RETURNING * INTO v_plan;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan tier % not found', p_plan_tier USING ERRCODE = '22023';
    END IF;

    RETURN to_jsonb(v_plan);
END;
$$;
