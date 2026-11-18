-- ============================================================================
-- ClassSphere Functions: 007_signup_functions.sql
-- Public self-service sign-up: a new academy owner creates their own workspace.
-- ============================================================================

-- Creates an academy, its Main Campus branch, plan subscription and the owner's TenantAdmin sign-in.
-- Unlike operator provisioning, an email that already has a sign-in is refused (the owner must sign in instead),
-- so a public caller can never attach an existing account to a new academy.
CREATE OR REPLACE FUNCTION tenant.fn_tenant_register(
    p_name VARCHAR(200),
    p_academy_type VARCHAR(50),
    p_plan_tier VARCHAR(50),
    p_admin_name VARCHAR(150),
    p_admin_email VARCHAR(255),
    p_admin_phone VARCHAR(50),
    p_admin_password_hash VARCHAR(255)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, identity_app, public
AS $$
DECLARE
    v_base TEXT;
    v_slug TEXT;
    v_result JSONB;
BEGIN
    IF EXISTS (SELECT 1 FROM identity_app.users WHERE lower(email) = lower(trim(p_admin_email))) THEN
        RAISE EXCEPTION 'An account with this email already exists. Sign in instead.' USING ERRCODE = '23505';
    END IF;

    -- Workspace slug from the academy name, with a short suffix when it is already taken
    v_base := left(trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), 60);
    IF v_base = '' THEN v_base := 'academy'; END IF;
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM tenant.organizations WHERE slug = v_slug) LOOP
        v_slug := v_base || '-' || substr(md5(random()::text), 1, 5);
    END LOOP;

    v_result := tenant.fn_tenant_create(trim(p_name), v_slug, p_academy_type, NULL, NULL, p_plan_tier,
                                        trim(p_admin_name), trim(p_admin_email), p_admin_password_hash, NULL);

    UPDATE identity_app.users SET phone = NULLIF(trim(p_admin_phone), '')
    WHERE user_id = (v_result->>'adminUserId')::UUID;
    UPDATE tenant.organizations
    SET settings = settings || jsonb_build_object('contact', jsonb_build_object(
            'name', trim(p_admin_name), 'email', lower(trim(p_admin_email)), 'phone', NULLIF(trim(p_admin_phone), '')))
    WHERE tenant_id = (v_result->>'tenantId')::UUID;

    RETURN v_result;
END;
$$;
