-- ============================================================================
-- ClassSphere Functions: 007_signup_functions.sql
-- Public self-service sign-up: a new academy owner creates their own workspace.
-- ============================================================================

-- Creates an academy, its Main Campus branch, plan subscription and the owner's TenantAdmin sign-in.
-- Unlike operator provisioning, an email or mobile number that already has a sign-in is refused (the owner must
-- sign in instead), so a public caller can never attach an existing account to a new academy.
-- The email is optional: without one, the owner signs in with their (verified) mobile number.
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
    v_email TEXT := NULLIF(lower(trim(p_admin_email)), '');
    v_phone TEXT := NULLIF(trim(p_admin_phone), '');
    v_base TEXT;
    v_slug TEXT;
    v_admin_id UUID;
    v_result JSONB;
BEGIN
    IF v_email IS NOT NULL AND EXISTS (SELECT 1 FROM identity_app.users WHERE lower(email) = v_email) THEN
        RAISE EXCEPTION 'An account with this email already exists. Sign in instead.' USING ERRCODE = '23505';
    END IF;
    IF v_phone IS NOT NULL AND EXISTS (
        SELECT 1 FROM identity_app.users
        WHERE phone IS NOT NULL
          AND right(regexp_replace(phone, '\D', '', 'g'), 10) = right(regexp_replace(v_phone, '\D', '', 'g'), 10)
    ) THEN
        RAISE EXCEPTION 'An account with this mobile number already exists. Sign in instead.' USING ERRCODE = '23505';
    END IF;

    -- Workspace slug from the academy name, with a short suffix when it is already taken
    v_base := left(trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), 60);
    IF v_base = '' THEN v_base := 'academy'; END IF;
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM tenant.organizations WHERE slug = v_slug) LOOP
        v_slug := v_base || '-' || substr(md5(random()::text), 1, 5);
    END LOOP;

    IF v_email IS NOT NULL THEN
        v_result := tenant.fn_tenant_create(trim(p_name), v_slug, p_academy_type, NULL, NULL, p_plan_tier,
                                            trim(p_admin_name), v_email, p_admin_password_hash, NULL);
        v_admin_id := (v_result->>'adminUserId')::UUID;
        UPDATE identity_app.users SET phone = v_phone WHERE user_id = v_admin_id;
    ELSE
        -- No email: create the workspace without an admin, then the mobile-only owner and their membership
        v_result := tenant.fn_tenant_create(trim(p_name), v_slug, p_academy_type, NULL, NULL, p_plan_tier,
                                            NULL, NULL, NULL, NULL);
        INSERT INTO identity_app.users (email, password_hash, full_name, phone)
        VALUES (NULL, p_admin_password_hash, trim(p_admin_name), v_phone)
        RETURNING user_id INTO v_admin_id;
        INSERT INTO tenant.memberships (tenant_id, user_id, branch_id, role, title, permissions)
        VALUES ((v_result->>'tenantId')::UUID, v_admin_id, NULL, 'TenantAdmin', 'Academy Administrator', ARRAY['*']);
        v_result := v_result || jsonb_build_object('adminUserId', v_admin_id);
    END IF;

    UPDATE tenant.organizations
    SET settings = settings || jsonb_build_object('contact', jsonb_build_object(
            'name', trim(p_admin_name), 'email', v_email, 'phone', v_phone))
    WHERE tenant_id = (v_result->>'tenantId')::UUID;

    RETURN v_result;
END;
$$;

-- Public directory of active academies for Student & Parent self-registration
CREATE OR REPLACE FUNCTION tenant.fn_public_academies_list()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, public
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'tenant_id', o.tenant_id,
        'name', o.name,
        'academy_type', o.academy_type,
        'slug', o.slug
    ) ORDER BY o.name), '[]'::jsonb)
    FROM tenant.organizations o
    WHERE o.status = 'active';
$$;

-- Self-service registration for a Student or Parent/Guardian in an existing active academy
CREATE OR REPLACE FUNCTION tenant.fn_portal_register(
    p_tenant_id UUID,
    p_role VARCHAR(20),
    p_first_name VARCHAR(100),
    p_last_name VARCHAR(100),
    p_email VARCHAR(255),
    p_phone VARCHAR(50),
    p_password_hash VARCHAR(255),
    p_student_first_name VARCHAR(100),
    p_student_last_name VARCHAR(100),
    p_relationship VARCHAR(50)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, identity_app, academics, public
AS $$
DECLARE
    v_email TEXT := NULLIF(lower(trim(p_email)), '');
    v_phone TEXT := NULLIF(trim(p_phone), '');
    v_role TEXT := lower(trim(COALESCE(p_role, 'student')));
    v_full_name TEXT := trim(p_first_name) || ' ' || trim(p_last_name);
    v_stu_first TEXT := COALESCE(NULLIF(trim(p_student_first_name), ''), trim(p_first_name));
    v_stu_last TEXT := COALESCE(NULLIF(trim(p_student_last_name), ''), trim(p_last_name));
    v_rel TEXT := CASE WHEN v_role = 'student' THEN 'Self' ELSE COALESCE(NULLIF(trim(p_relationship), ''), 'Parent') END;
    v_user_id UUID;
    v_guardian_id UUID;
    v_student_id UUID;
    v_household_code TEXT;
    v_enrollment_no TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM tenant.organizations WHERE tenant_id = p_tenant_id AND status = 'active') THEN
        RAISE EXCEPTION 'Selected academy was not found or is inactive.' USING ERRCODE = '22023';
    END IF;

    IF v_email IS NOT NULL AND EXISTS (SELECT 1 FROM identity_app.users WHERE lower(email) = v_email) THEN
        RAISE EXCEPTION 'An account with this email already exists. Sign in instead.' USING ERRCODE = '23505';
    END IF;

    IF v_phone IS NOT NULL AND EXISTS (
        SELECT 1 FROM identity_app.users
        WHERE phone IS NOT NULL
          AND right(regexp_replace(phone, '\D', '', 'g'), 10) = right(regexp_replace(v_phone, '\D', '', 'g'), 10)
    ) THEN
        RAISE EXCEPTION 'An account with this mobile number already exists. Sign in instead.' USING ERRCODE = '23505';
    END IF;

    INSERT INTO identity_app.users (email, password_hash, full_name, phone)
    VALUES (v_email, p_password_hash, v_full_name, v_phone)
    RETURNING user_id INTO v_user_id;

    INSERT INTO tenant.memberships (tenant_id, user_id, branch_id, role, title, permissions)
    VALUES (
        p_tenant_id,
        v_user_id,
        NULL,
        'Guardian',
        CASE WHEN v_role = 'student' THEN 'Student' ELSE v_rel END,
        ARRAY['portal.read']
    );

    v_household_code := 'HH-' || upper(substr(md5(random()::text || v_user_id::text), 1, 6));
    INSERT INTO academics.guardians (tenant_id, user_id, household_code, first_name, last_name, relationship, phone, email)
    VALUES (
        p_tenant_id,
        v_user_id,
        v_household_code,
        trim(p_first_name),
        trim(p_last_name),
        v_rel,
        COALESCE(v_phone, ''),
        COALESCE(v_email, COALESCE(v_phone, 'member') || '@portal.classsphere.local')
    )
    RETURNING guardian_id INTO v_guardian_id;

    v_enrollment_no := 'STU-' || upper(substr(md5(random()::text || v_guardian_id::text), 1, 6));
    INSERT INTO academics.students (tenant_id, first_name, last_name, email, phone, enrollment_number, status, matriculation_year)
    VALUES (
        p_tenant_id,
        v_stu_first,
        v_stu_last,
        v_email,
        v_phone,
        v_enrollment_no,
        'active',
        to_char(CURRENT_DATE, 'YYYY')
    )
    RETURNING student_id INTO v_student_id;

    INSERT INTO academics.student_guardian_links (tenant_id, student_id, guardian_id, is_primary)
    VALUES (p_tenant_id, v_student_id, v_guardian_id, TRUE);

    RETURN jsonb_build_object(
        'success', true,
        'tenantId', p_tenant_id,
        'userId', v_user_id,
        'guardianId', v_guardian_id,
        'studentId', v_student_id,
        'enrollmentNumber', v_enrollment_no
    );
END;
$$;
