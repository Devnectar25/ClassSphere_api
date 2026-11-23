-- ============================================================================
-- ClassSphere Stored Functions: 001_tenant_functions.sql
-- Traceability: TDD Section 10.4, PLT-006, DECISION-002
-- Strict SECURITY DEFINER, schema-qualified, parameterized contract
-- ============================================================================

CREATE OR REPLACE FUNCTION platform.fn_plan_list()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.sort_order), '[]'::jsonb)
    FROM platform.plans p;
$$;

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

DROP FUNCTION IF EXISTS tenant.fn_tenant_create(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, UUID);

-- Provisions an academy: organization, main branch, subscription and (optionally) its admin sign-in
CREATE OR REPLACE FUNCTION tenant.fn_tenant_create(
    p_name VARCHAR(200),
    p_slug VARCHAR(100),
    p_academy_type VARCHAR(50),
    p_currency VARCHAR(10),
    p_timezone VARCHAR(50),
    p_plan_tier VARCHAR(50),
    p_admin_name VARCHAR(150),
    p_admin_email VARCHAR(255),
    p_admin_password_hash VARCHAR(255),
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, platform, identity_app, audit, public
AS $$
DECLARE
    v_tenant_id UUID;
    v_branch_id UUID;
    v_admin_id UUID;
    v_plan RECORD;
BEGIN
    SELECT * INTO v_plan FROM platform.plans WHERE plan_tier = COALESCE(p_plan_tier, 'Starter');
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown plan tier %', p_plan_tier USING ERRCODE = '22023';
    END IF;

    INSERT INTO tenant.organizations (name, slug, academy_type, currency, timezone)
    VALUES (p_name, p_slug, COALESCE(p_academy_type, 'Tuition'), COALESCE(p_currency, 'INR'), COALESCE(p_timezone, 'Asia/Kolkata'))
    RETURNING tenant_id INTO v_tenant_id;

    INSERT INTO tenant.branches (tenant_id, name, code, is_primary)
    VALUES (v_tenant_id, 'Main Campus', 'MAIN', TRUE)
    RETURNING branch_id INTO v_branch_id;

    INSERT INTO platform.subscriptions (tenant_id, plan_tier, status, max_seats, max_branches, mrr)
    VALUES (v_tenant_id, v_plan.plan_tier, 'active', v_plan.max_seats, v_plan.max_branches, v_plan.price_monthly);

    IF p_admin_email IS NOT NULL THEN
        SELECT user_id INTO v_admin_id FROM identity_app.users WHERE lower(email) = lower(p_admin_email);
        IF v_admin_id IS NULL THEN
            IF p_admin_password_hash IS NULL THEN
                RAISE EXCEPTION 'A password is required for the new academy admin' USING ERRCODE = '22023';
            END IF;
            INSERT INTO identity_app.users (email, password_hash, full_name, email_verified_at)
            VALUES (lower(p_admin_email), p_admin_password_hash, COALESCE(p_admin_name, p_admin_email), clock_timestamp())
            RETURNING user_id INTO v_admin_id;
        END IF;
        INSERT INTO tenant.memberships (tenant_id, user_id, branch_id, role, title, permissions)
        VALUES (v_tenant_id, v_admin_id, NULL, 'TenantAdmin', 'Academy Administrator', ARRAY['*']);
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (v_tenant_id, p_actor_id, 'tenant.created', 'tenant', v_tenant_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'slug', p_slug, 'type', p_academy_type, 'plan', v_plan.plan_tier, 'admin', p_admin_email));

    RETURN jsonb_build_object(
        'success', true,
        'tenantId', v_tenant_id,
        'branchId', v_branch_id,
        'adminUserId', v_admin_id,
        'slug', p_slug,
        'planTier', v_plan.plan_tier
    );
END;
$$;

CREATE OR REPLACE FUNCTION tenant.fn_branch_create(
    p_tenant_id UUID,
    p_name VARCHAR(150),
    p_code VARCHAR(50),
    p_address TEXT,
    p_phone VARCHAR(50),
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, audit, public
AS $$
DECLARE
    v_branch_id UUID;
BEGIN
    INSERT INTO tenant.branches (tenant_id, name, code, address, phone)
    VALUES (p_tenant_id, p_name, p_code, p_address, p_phone)
    RETURNING branch_id INTO v_branch_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'branch.created', 'branch', v_branch_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'code', p_code));

    RETURN jsonb_build_object('success', true, 'branchId', v_branch_id);
END;
$$;

CREATE OR REPLACE FUNCTION tenant.fn_branch_update(
    p_tenant_id UUID,
    p_branch_id UUID,
    p_name VARCHAR(150),
    p_code VARCHAR(50),
    p_address TEXT,
    p_phone VARCHAR(50),
    p_head_user_id UUID,
    p_is_primary BOOLEAN,
    p_is_active BOOLEAN,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, audit, public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM tenant.branches WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Branch not found' USING ERRCODE = 'P0002';
    END IF;

    IF trim(COALESCE(p_name, '')) = '' THEN
        RAISE EXCEPTION 'Branch name is required' USING ERRCODE = '22023';
    END IF;

    IF trim(COALESCE(p_code, '')) = '' THEN
        RAISE EXCEPTION 'Branch code is required' USING ERRCODE = '22023';
    END IF;

    -- Check unique code among other branches in this tenant
    IF EXISTS (
        SELECT 1 FROM tenant.branches
        WHERE tenant_id = p_tenant_id AND branch_id <> p_branch_id AND upper(code) = upper(trim(p_code))
    ) THEN
        RAISE EXCEPTION 'A branch with this code already exists' USING ERRCODE = '23505';
    END IF;

    -- If this branch is being marked as primary, unmark other branches
    IF p_is_primary = TRUE THEN
        UPDATE tenant.branches SET is_primary = FALSE WHERE tenant_id = p_tenant_id AND branch_id <> p_branch_id;
    END IF;

    UPDATE tenant.branches
    SET name = trim(p_name),
        code = upper(trim(p_code)),
        address = p_address,
        phone = p_phone,
        head_user_id = p_head_user_id,
        is_primary = COALESCE(p_is_primary, is_primary),
        is_active = COALESCE(p_is_active, is_active)
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'branch.updated', 'branch', p_branch_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'code', p_code, 'isPrimary', p_is_primary, 'isActive', p_is_active));

    RETURN jsonb_build_object('success', true, 'branchId', p_branch_id);
END;
$$;

CREATE OR REPLACE FUNCTION tenant.fn_branch_delete(
    p_tenant_id UUID,
    p_branch_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, academics, engagement, audit, public
AS $$
DECLARE
    v_branch RECORD;
    v_primary_branch_id UUID;
    v_reassigned_students INT := 0;
    v_reassigned_batches INT := 0;
BEGIN
    SELECT * INTO v_branch
    FROM tenant.branches
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Branch not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_branch.is_primary THEN
        RAISE EXCEPTION 'Primary campus branch cannot be deleted' USING ERRCODE = '22023';
    END IF;

    -- Locate the tenant primary campus branch to safely receive reassigned records
    SELECT branch_id INTO v_primary_branch_id
    FROM tenant.branches
    WHERE tenant_id = p_tenant_id AND is_primary = TRUE
    LIMIT 1;

    IF v_primary_branch_id IS NULL THEN
        SELECT branch_id INTO v_primary_branch_id
        FROM tenant.branches
        WHERE tenant_id = p_tenant_id AND branch_id <> p_branch_id
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;

    IF v_primary_branch_id IS NULL THEN
        RAISE EXCEPTION 'Cannot delete the only branch of the academy' USING ERRCODE = '22023';
    END IF;

    -- Reassign students whose home branch is this branch to primary branch
    UPDATE academics.students
    SET branch_id = v_primary_branch_id,
        updated_at = clock_timestamp()
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_reassigned_students = ROW_COUNT;

    -- Reassign batches belonging to this branch to primary branch
    UPDATE academics.batches
    SET branch_id = v_primary_branch_id
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_reassigned_batches = ROW_COUNT;

    -- Reassign staff memberships assigned to this branch
    UPDATE tenant.memberships
    SET branch_id = v_primary_branch_id
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;

    -- Reassign branch-specific notices
    UPDATE engagement.notices
    SET branch_id = v_primary_branch_id
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;

    -- Delete the branch record
    DELETE FROM tenant.branches
    WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id;

    -- Audit log
    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'branch.deleted', 'branch', p_branch_id::text, gen_random_uuid()::text,
            jsonb_build_object(
                'name', v_branch.name,
                'code', v_branch.code,
                'reassignedToBranchId', v_primary_branch_id,
                'reassignedStudents', v_reassigned_students,
                'reassignedBatches', v_reassigned_batches
            ));

    RETURN jsonb_build_object(
        'success', true,
        'deletedBranchId', p_branch_id,
        'reassignedToBranchId', v_primary_branch_id,
        'reassignedStudents', v_reassigned_students,
        'reassignedBatches', v_reassigned_batches
    );
END;
$$;

CREATE OR REPLACE FUNCTION tenant.fn_entitlement_check(
    p_tenant_id UUID,
    p_metric VARCHAR(50)
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenant, platform, public
AS $$
DECLARE
    v_sub RECORD;
    v_allowed BOOLEAN := true;
    v_current_count INT := 0;
    v_max_allowed INT := 0;
BEGIN
    SELECT * INTO v_sub FROM platform.subscriptions WHERE tenant_id = p_tenant_id AND status = 'active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'No active subscription found');
    END IF;

    IF p_metric = 'seats' THEN
        SELECT COUNT(*) INTO v_current_count FROM academics.students WHERE tenant_id = p_tenant_id AND status = 'active';
        v_max_allowed := v_sub.max_seats;
        v_allowed := (v_current_count < v_max_allowed);
    ELSIF p_metric = 'branches' THEN
        SELECT COUNT(*) INTO v_current_count FROM tenant.branches WHERE tenant_id = p_tenant_id AND is_active = true;
        v_max_allowed := v_sub.max_branches;
        v_allowed := (v_current_count < v_max_allowed);
    END IF;

    RETURN jsonb_build_object(
        'allowed', v_allowed,
        'current', v_current_count,
        'maximum', v_max_allowed,
        'planTier', v_sub.plan_tier
    );
END;
$$;

-- Workspace profile for the signed-in actor: organization, subscription, branches and entitlements
CREATE OR REPLACE FUNCTION tenant.fn_tenant_get(
    p_tenant_id UUID,
    p_user_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, platform, academics, identity_app, public
AS $$
    SELECT jsonb_build_object(
        'organization', to_jsonb(o),
        'subscription', (
            SELECT to_jsonb(s) FROM platform.subscriptions s
            WHERE s.tenant_id = o.tenant_id ORDER BY s.created_at DESC LIMIT 1
        ),
        'actor', (
            SELECT jsonb_build_object('user_id', u.user_id, 'full_name', u.full_name, 'email', u.email,
                                      'role', m.role, 'title', m.title)
            FROM identity_app.users u
            LEFT JOIN tenant.memberships m ON m.user_id = u.user_id AND m.tenant_id = o.tenant_id
            WHERE u.user_id = p_user_id
            LIMIT 1
        ),
        'branches', COALESCE((
            SELECT jsonb_agg(to_jsonb(b) ORDER BY b.is_primary DESC, b.name)
            FROM (
                SELECT br.branch_id, br.name, br.code, br.address, br.city, br.state, br.country, br.location, br.pincode, br.phone, br.email,
                       br.is_primary, br.is_active, hu.full_name AS head_name,
                       (SELECT COUNT(*) FROM academics.batches bt WHERE bt.branch_id = br.branch_id) AS batch_count,
                       (SELECT COUNT(DISTINCT s.student_id)
                        FROM academics.students s
                        WHERE s.tenant_id = o.tenant_id
                          AND s.status <> 'withdrawn'
                          AND (
                              s.branch_id = br.branch_id
                              OR (s.branch_id IS NULL AND s.student_id IN (
                                  SELECT e.student_id FROM academics.enrollments e
                                  JOIN academics.batches bt ON bt.batch_id = e.batch_id
                                  WHERE bt.branch_id = br.branch_id AND e.status = 'enrolled'
                              ))
                          )) AS student_count
                FROM tenant.branches br
                LEFT JOIN identity_app.users hu ON hu.user_id = br.head_user_id
                WHERE br.tenant_id = o.tenant_id
            ) b
        ), '[]'::jsonb),
        'entitlements', jsonb_build_object(
            'seats', tenant.fn_entitlement_check(o.tenant_id, 'seats'),
            'branches', tenant.fn_entitlement_check(o.tenant_id, 'branches')
        )
    )
    FROM tenant.organizations o
    WHERE o.tenant_id = p_tenant_id;
$$;

CREATE OR REPLACE FUNCTION tenant.fn_tenant_settings_update(
    p_tenant_id UUID,
    p_name VARCHAR(200),
    p_currency VARCHAR(10),
    p_timezone VARCHAR(50),
    p_branding JSONB,
    p_settings JSONB,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, audit, public
AS $$
BEGIN
    UPDATE tenant.organizations
    SET name = COALESCE(p_name, name),
        academy_type = COALESCE(NULLIF(p_settings->>'category', ''), academy_type),
        currency = COALESCE(p_currency, currency),
        timezone = COALESCE(p_timezone, timezone),
        branding = branding || COALESCE(p_branding, '{}'::jsonb),
        settings = settings || COALESCE(p_settings, '{}'::jsonb),
        updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
    END IF;

    -- Synchronize primary branch address fields if provided in settings
    IF p_settings IS NOT NULL THEN
        UPDATE tenant.branches
        SET address = COALESCE(NULLIF(p_settings->>'address', ''), address),
            city = COALESCE(NULLIF(p_settings->>'city', ''), city),
            state = COALESCE(NULLIF(p_settings->>'state', ''), state),
            country = COALESCE(NULLIF(p_settings->>'country', ''), country),
            location = COALESCE(NULLIF(p_settings->>'location', ''), location),
            pincode = COALESCE(NULLIF(p_settings->>'location', ''), pincode),
            phone = COALESCE(NULLIF(p_settings->>'phone', ''), phone),
            email = COALESCE(NULLIF(p_settings->>'email', ''), email)
        WHERE tenant_id = p_tenant_id AND is_primary = true;

        -- Synchronize owner contact details in identity_app.users if provided
        IF p_settings->'contact' IS NOT NULL THEN
            UPDATE identity_app.users u
            SET full_name = COALESCE(NULLIF(p_settings->'contact'->>'name', ''), u.full_name),
                email = COALESCE(NULLIF(p_settings->'contact'->>'email', ''), u.email),
                phone = COALESCE(NULLIF(p_settings->'contact'->>'phone', ''), u.phone)
            FROM tenant.memberships m
            WHERE m.tenant_id = p_tenant_id AND m.role = 'TenantAdmin' AND m.user_id = u.user_id;
        END IF;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'tenant.settings_updated', 'tenant', p_tenant_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'branding', p_branding, 'settings', p_settings));

    RETURN jsonb_build_object('success', true);
END;
$$;

-- Platform operator tenant search (TDD Appendix A: GET /api/v1/platform/tenants)
CREATE OR REPLACE FUNCTION tenant.fn_tenant_search(
    p_query TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, platform, academics, identity_app, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb)
    FROM (
        SELECT o.tenant_id, o.name, o.slug, o.academy_type, o.status, o.verification_status, o.rejection_reason,
               o.commission_rate, o.documents, o.cover_image, o.description, o.currency, o.timezone, o.branding, o.created_at,
               (SELECT u.email FROM tenant.memberships m JOIN identity_app.users u ON u.user_id = m.user_id
                WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin' ORDER BY m.created_at LIMIT 1) AS admin_email,
               s.plan_tier, s.status AS subscription_status, s.mrr,
               (SELECT COUNT(*) FROM academics.students st WHERE st.tenant_id = o.tenant_id AND st.status = 'active') AS active_students,
               (SELECT COUNT(*) FROM tenant.branches b WHERE b.tenant_id = o.tenant_id) AS branch_count
        FROM tenant.organizations o
        LEFT JOIN LATERAL (
            SELECT * FROM platform.subscriptions ps WHERE ps.tenant_id = o.tenant_id ORDER BY ps.created_at DESC LIMIT 1
        ) s ON true
        WHERE p_query IS NULL OR o.name ILIKE '%' || p_query || '%' OR o.slug ILIKE '%' || p_query || '%'
    ) r;
$$;


DROP FUNCTION IF EXISTS tenant.fn_staff_list(UUID);

-- Staff & role assignments; with a branch, members of that branch plus academy-wide members
CREATE OR REPLACE FUNCTION tenant.fn_staff_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, identity_app, academics, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.full_name), '[]'::jsonb)
    FROM (
        SELECT m.membership_id, u.user_id, u.full_name, u.email, u.phone, u.last_login_at,
               m.role, m.title, m.is_active, m.branch_id, b.name AS branch_name,
               (SELECT string_agg(bt.name, ', ' ORDER BY bt.name)
                FROM academics.batches bt
                WHERE bt.tenant_id = m.tenant_id AND bt.instructor_user_id = u.user_id) AS batches
        FROM tenant.memberships m
        JOIN identity_app.users u ON u.user_id = m.user_id
        LEFT JOIN tenant.branches b ON b.branch_id = m.branch_id
        WHERE m.tenant_id = p_tenant_id AND m.role <> 'Guardian'
          AND (p_branch_id IS NULL OR m.branch_id IS NULL OR m.branch_id = p_branch_id)
    ) r;
$$;

-- Creates an academy user with a role (re-uses an existing sign-in with the same email)
CREATE OR REPLACE FUNCTION tenant.fn_staff_create(
    p_tenant_id UUID,
    p_full_name VARCHAR(150),
    p_email VARCHAR(255),
    p_phone VARCHAR(50),
    p_password_hash VARCHAR(255),
    p_role VARCHAR(50),
    p_branch_id UUID,
    p_title VARCHAR(150),
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, identity_app, audit, public
AS $$
DECLARE
    v_user_id UUID;
    v_membership_id UUID;
BEGIN
    IF p_role NOT IN ('TenantAdmin', 'BranchManager', 'Finance', 'Instructor', 'Staff') THEN
        RAISE EXCEPTION 'Unknown role %', p_role USING ERRCODE = '22023';
    END IF;
    IF p_role = 'BranchManager' AND p_branch_id IS NULL THEN
        RAISE EXCEPTION 'A branch manager must be assigned to a branch' USING ERRCODE = '22023';
    END IF;
    IF p_branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant.branches WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id
    ) THEN
        RAISE EXCEPTION 'Branch not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT user_id INTO v_user_id FROM identity_app.users WHERE lower(email) = lower(p_email);
    IF v_user_id IS NULL THEN
        INSERT INTO identity_app.users (email, password_hash, full_name, phone, email_verified_at, phone_verified_at)
        VALUES (
            lower(p_email),
            p_password_hash,
            p_full_name,
            p_phone,
            CASE WHEN p_email IS NOT NULL THEN clock_timestamp() ELSE NULL END,
            CASE WHEN p_phone IS NOT NULL THEN clock_timestamp() ELSE NULL END
        )
        RETURNING user_id INTO v_user_id;
    END IF;

    INSERT INTO tenant.memberships (tenant_id, user_id, branch_id, role, title)
    VALUES (p_tenant_id, v_user_id, p_branch_id, p_role, p_title)
    RETURNING membership_id INTO v_membership_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'staff.created', 'membership', v_membership_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_full_name, 'email', p_email, 'role', p_role));

    RETURN jsonb_build_object('success', true, 'membershipId', v_membership_id, 'userId', v_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION tenant.fn_membership_set_active(
    p_tenant_id UUID,
    p_membership_id UUID,
    p_is_active BOOLEAN,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, audit, public
AS $$
BEGIN
    UPDATE tenant.memberships SET is_active = p_is_active
    WHERE membership_id = p_membership_id AND tenant_id = p_tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Staff member not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, CASE WHEN p_is_active THEN 'staff.activated' ELSE 'staff.deactivated' END,
            'membership', p_membership_id::text, gen_random_uuid()::text, '{}'::jsonb);

    RETURN jsonb_build_object('success', true, 'isActive', p_is_active);
END;
$$;

-- Sign-in lookup (by email, or by user id when switching academy): credentials plus active memberships
DROP FUNCTION IF EXISTS identity_app.fn_user_auth_lookup(VARCHAR);

CREATE OR REPLACE FUNCTION identity_app.fn_user_auth_lookup(
    p_email VARCHAR(255),
    p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = identity_app, tenant, public
AS $$
DECLARE
    v_user_id UUID;
    v_clean_phone TEXT;
    v_result JSONB;
BEGIN
    IF p_user_id IS NOT NULL THEN
        v_user_id := p_user_id;
    ELSIF p_email IS NOT NULL AND position('@' IN p_email) > 0 THEN
        SELECT user_id INTO v_user_id
        FROM identity_app.users
        WHERE lower(email) = lower(p_email)
        ORDER BY created_at
        LIMIT 1;
    ELSIF p_email IS NOT NULL THEN
        v_clean_phone := right(regexp_replace(p_email, '\D', '', 'g'), 10);
        IF length(v_clean_phone) = 10 THEN
            SELECT user_id INTO v_user_id
            FROM identity_app.users
            WHERE phone IS NOT NULL AND right(regexp_replace(phone, '\D', '', 'g'), 10) = v_clean_phone
            ORDER BY created_at
            LIMIT 1;
        END IF;
    END IF;

    IF v_user_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT jsonb_build_object(
        'user_id', u.user_id,
        'full_name', u.full_name,
        'email', u.email,
        'password_hash', u.password_hash,
        'is_active', u.is_active,
        'is_platform_admin', u.is_platform_admin,
        'is_suspended', COALESCE(u.is_suspended, FALSE),
        'memberships', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'tenant_id', o.tenant_id, 'tenant_name', o.name, 'academy_type', o.academy_type,
                'role', m.role, 'branch_id', m.branch_id,
                'org_status', o.status,
                'verification_status', o.verification_status,
                'rejection_reason', o.rejection_reason
            ) ORDER BY (o.status = 'active') DESC, m.role = 'Guardian', o.name)
            FROM tenant.memberships m
            JOIN tenant.organizations o ON o.tenant_id = m.tenant_id
            WHERE m.user_id = u.user_id AND m.is_active
        ), '[]'::jsonb)
    ) INTO v_result
    FROM identity_app.users u
    WHERE u.user_id = v_user_id;

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION identity_app.fn_user_login_record(
    p_user_id UUID,
    p_tenant_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity_app, audit, public
AS $$
BEGIN
    UPDATE identity_app.users
    SET last_login_at = clock_timestamp(),
        email_verified_at = CASE WHEN email IS NOT NULL THEN COALESCE(email_verified_at, clock_timestamp()) ELSE NULL END,
        phone_verified_at = CASE WHEN phone IS NOT NULL THEN COALESCE(phone_verified_at, clock_timestamp()) ELSE NULL END
    WHERE user_id = p_user_id;
    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_user_id, 'auth.login', 'user', p_user_id::text, gen_random_uuid()::text, '{}'::jsonb);
    RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION identity_app.fn_user_password_reset(
    p_user_id UUID,
    p_password_hash VARCHAR(255)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity_app, public
AS $$
BEGIN
    UPDATE identity_app.users
    SET password_hash = p_password_hash,
        updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND is_active = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account not found or inactive.' USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;
