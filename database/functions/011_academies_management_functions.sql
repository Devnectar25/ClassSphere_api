-- ============================================================================
-- ClassSphere Stored Functions: 011_academies_management_functions.sql
-- Comprehensive Academies Management: listing, 10-tab dossier,
-- verification/rejection/suspension workflows, and course publishing guards.
-- Requires migration 013_academies_management.sql.
-- ============================================================================

-- 1. Helper to match academy filter
CREATE OR REPLACE FUNCTION platform.fn_academy_matches_filter(
    p_org tenant.organizations,
    p_owner_name TEXT,
    p_owner_email TEXT,
    p_owner_phone TEXT,
    p_city TEXT,
    p_query TEXT,
    p_status TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT (p_query IS NULL OR btrim(p_query) = ''
            OR p_org.name ILIKE '%' || btrim(p_query) || '%'
            OR p_org.slug ILIKE '%' || btrim(p_query) || '%'
            OR COALESCE(p_org.academy_code, '') ILIKE '%' || btrim(p_query) || '%'
            OR p_org.tenant_id::text ILIKE btrim(p_query) || '%'
            OR p_org.academy_type ILIKE '%' || btrim(p_query) || '%'
            OR (p_owner_name IS NOT NULL AND p_owner_name ILIKE '%' || btrim(p_query) || '%')
            OR (p_owner_email IS NOT NULL AND p_owner_email ILIKE '%' || btrim(p_query) || '%')
            OR (p_owner_phone IS NOT NULL AND p_owner_phone ILIKE '%' || btrim(p_query) || '%')
            OR (p_city IS NOT NULL AND p_city ILIKE '%' || btrim(p_query) || '%'))
       AND (p_status IS NULL OR p_status = 'all'
            OR (p_status = 'pending' AND p_org.verification_status = 'pending' AND p_org.status <> 'suspended')
            OR (p_status = 'verified' AND p_org.verification_status = 'verified' AND p_org.status = 'active')
            OR (p_status = 'rejected' AND p_org.verification_status = 'rejected' AND p_org.status <> 'suspended')
            OR (p_status = 'suspended' AND (p_org.status = 'suspended' OR p_org.verification_status = 'suspended')));
$$;

-- 2. Academies Paged Listing with Subsection Counts
CREATE OR REPLACE FUNCTION platform.fn_academies_list(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenant, platform, academics, identity_app, public
AS $$
DECLARE
    v_total INT;
    v_academies JSONB;
    v_counts JSONB;
BEGIN
    IF p_status IS NOT NULL AND p_status NOT IN ('all', 'pending', 'verified', 'rejected', 'suspended') THEN
        RAISE EXCEPTION 'Invalid status filter: %. Use all, pending, verified, rejected, or suspended.', p_status USING ERRCODE = '22023';
    END IF;

    -- Tab Counts across all statuses matching the search query
    SELECT jsonb_build_object(
        'all', COUNT(*),
        'pending', COUNT(*) FILTER (WHERE o.verification_status = 'pending' AND o.status <> 'suspended'),
        'verified', COUNT(*) FILTER (WHERE o.verification_status = 'verified' AND o.status = 'active'),
        'rejected', COUNT(*) FILTER (WHERE o.verification_status = 'rejected' AND o.status <> 'suspended'),
        'suspended', COUNT(*) FILTER (WHERE o.status = 'suspended' OR o.verification_status = 'suspended')
    ) INTO v_counts
    FROM tenant.organizations o
    LEFT JOIN LATERAL (
        SELECT u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
        FROM tenant.memberships m
        JOIN identity_app.users u ON u.user_id = m.user_id
        WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin'
        ORDER BY m.created_at LIMIT 1
    ) ow ON true
    LEFT JOIN LATERAL (
        SELECT b.city FROM tenant.branches b
        WHERE b.tenant_id = o.tenant_id AND b.is_primary = true LIMIT 1
    ) loc ON true
    WHERE platform.fn_academy_matches_filter(o, ow.owner_name, ow.owner_email, ow.owner_phone, loc.city, p_query, 'all');

    -- Total matching current status filter
    SELECT COUNT(*) INTO v_total
    FROM tenant.organizations o
    LEFT JOIN LATERAL (
        SELECT u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
        FROM tenant.memberships m
        JOIN identity_app.users u ON u.user_id = m.user_id
        WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin'
        ORDER BY m.created_at LIMIT 1
    ) ow ON true
    LEFT JOIN LATERAL (
        SELECT b.city FROM tenant.branches b
        WHERE b.tenant_id = o.tenant_id AND b.is_primary = true LIMIT 1
    ) loc ON true
    WHERE platform.fn_academy_matches_filter(o, ow.owner_name, ow.owner_email, ow.owner_phone, loc.city, p_query, p_status);

    -- Paged rows
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_academies
    FROM (
        SELECT
            o.tenant_id,
            COALESCE(o.academy_code, 'AC-' || o.tenant_id::text) AS academy_code,
            o.name,
            o.slug,
            o.academy_type AS category,
            COALESCE(ow.owner_name, 'Academy Administrator') AS owner_name,
            ow.owner_email AS email,
            ow.owner_phone AS phone,
            ow.owner_user_id,
            COALESCE(NULLIF(loc.city, ''), o.settings->>'city', '—') AS location,
            loc.address,
            o.created_at AS registration_date,
            o.created_at,
            CASE
                WHEN o.status = 'suspended' OR o.verification_status = 'suspended' THEN 'suspended'
                WHEN o.verification_status = 'rejected' THEN 'rejected'
                WHEN o.verification_status = 'pending' THEN 'pending'
                ELSE 'verified'
            END AS verification_status,
            o.status,
            COALESCE(o.commission_rate, 10.00) AS commission_rate,
            o.rejection_reason,
            o.description,
            o.currency,
            o.timezone,
            COALESCE(sub.plan_tier, 'Starter') AS plan_tier,
            COALESCE(sub.mrr, 0) AS mrr,
            (SELECT COUNT(*) FROM academics.students st WHERE st.tenant_id = o.tenant_id AND st.status = 'active') AS active_students,
            (SELECT COUNT(*) FROM academics.courses c WHERE c.tenant_id = o.tenant_id) AS course_count,
            (SELECT COUNT(*) FROM academics.batches bt WHERE bt.tenant_id = o.tenant_id) AS batch_count,
            (SELECT COUNT(*) FROM tenant.branches br WHERE br.tenant_id = o.tenant_id) AS branch_count,
            jsonb_array_length(COALESCE(o.documents, '[]'::jsonb)) AS documents_count
        FROM tenant.organizations o
        LEFT JOIN LATERAL (
            SELECT u.user_id AS owner_user_id, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
            FROM tenant.memberships m
            JOIN identity_app.users u ON u.user_id = m.user_id
            WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin'
            ORDER BY m.created_at LIMIT 1
        ) ow ON true
        LEFT JOIN LATERAL (
            SELECT b.city, b.address, b.state, b.pincode
            FROM tenant.branches b
            WHERE b.tenant_id = o.tenant_id AND b.is_primary = true LIMIT 1
        ) loc ON true
        LEFT JOIN LATERAL (
            SELECT ps.plan_tier, ps.mrr FROM platform.subscriptions ps
            WHERE ps.tenant_id = o.tenant_id ORDER BY ps.created_at DESC LIMIT 1
        ) sub ON true
        WHERE platform.fn_academy_matches_filter(o, ow.owner_name, ow.owner_email, ow.owner_phone, loc.city, p_query, p_status)
        ORDER BY o.created_at DESC
        LIMIT GREATEST(LEAST(p_limit, 100), 1) OFFSET GREATEST(p_offset, 0)
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'counts', v_counts,
        'academies', v_academies
    );
END;
$$;

-- 3. Comprehensive 10-Tab Academy Dossier
CREATE OR REPLACE FUNCTION platform.fn_academy_detail(
    p_tenant_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenant, platform, academics, billing, identity_app, audit, public
AS $$
DECLARE
    v_org RECORD;
    v_owner RECORD;
    v_branch RECORD;
    v_sub RECORD;
    v_overview JSONB;
    v_owner_info JSONB;
    v_academy_info JSONB;
    v_documents JSONB;
    v_courses JSONB;
    v_batches JSONB;
    v_registrations JSONB;
    v_payments JSONB;
    v_payout_history JSONB;
    v_activity_history JSONB;
BEGIN
    SELECT * INTO v_org FROM tenant.organizations WHERE tenant_id = p_tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Academy % not found', p_tenant_id USING ERRCODE = '22023';
    END IF;

    -- Owner record
    SELECT u.user_id, COALESCE(u.user_code, 'USR-' || u.user_id::text) AS user_code, u.full_name, u.email, u.phone,
           (u.email_verified_at IS NOT NULL) AS email_verified,
           (u.phone_verified_at IS NOT NULL) AS phone_verified,
           CASE WHEN u.is_suspended THEN 'suspended' WHEN u.is_active THEN 'active' ELSE 'inactive' END AS account_status,
           m.title AS role_title, m.created_at AS joined_at
    INTO v_owner
    FROM tenant.memberships m
    JOIN identity_app.users u ON u.user_id = m.user_id
    WHERE m.tenant_id = p_tenant_id AND m.role = 'TenantAdmin'
    ORDER BY m.created_at LIMIT 1;

    -- Primary branch / location
    SELECT b.branch_id, b.name AS branch_name, b.code, b.address, b.city, b.state, b.pincode, b.phone, b.email
    INTO v_branch
    FROM tenant.branches b
    WHERE b.tenant_id = p_tenant_id AND b.is_primary = true LIMIT 1;

    -- Subscription
    SELECT s.plan_tier, s.status, s.mrr, s.max_seats, s.max_branches, s.current_period_end
    INTO v_sub
    FROM platform.subscriptions s
    WHERE s.tenant_id = p_tenant_id ORDER BY s.created_at DESC LIMIT 1;

    -- Tab 1: Overview
    v_overview := jsonb_build_object(
        'tenantId', v_org.tenant_id,
        'academyCode', COALESCE(v_org.academy_code, 'AC-' || v_org.tenant_id::text),
        'name', v_org.name,
        'slug', v_org.slug,
        'category', v_org.academy_type,
        'status', v_org.status,
        'verificationStatus', CASE
            WHEN v_org.status = 'suspended' OR v_org.verification_status = 'suspended' THEN 'suspended'
            ELSE v_org.verification_status
        END,
        'rejectionReason', v_org.rejection_reason,
        'commissionRate', COALESCE(v_org.commission_rate, 10.00),
        'planTier', COALESCE(v_sub.plan_tier, 'Starter'),
        'mrr', COALESCE(v_sub.mrr, 0),
        'currency', v_org.currency,
        'timezone', v_org.timezone,
        'totalStudents', (SELECT COUNT(*) FROM academics.students WHERE tenant_id = p_tenant_id),
        'activeStudents', (SELECT COUNT(*) FROM academics.students WHERE tenant_id = p_tenant_id AND status = 'active'),
        'totalCourses', (SELECT COUNT(*) FROM academics.courses WHERE tenant_id = p_tenant_id),
        'publishedCourses', (SELECT COUNT(*) FROM academics.courses WHERE tenant_id = p_tenant_id AND is_hidden IS NOT TRUE),
        'totalBatches', (SELECT COUNT(*) FROM academics.batches WHERE tenant_id = p_tenant_id),
        'activeBatches', (SELECT COUNT(*) FROM academics.batches WHERE tenant_id = p_tenant_id AND status = 'active'),
        'totalRegistrations', (SELECT COUNT(*) FROM academics.enrollments WHERE tenant_id = p_tenant_id),
        'totalRevenue', (SELECT COALESCE(SUM(amount), 0) FROM billing.payments WHERE tenant_id = p_tenant_id AND status IN ('posted', 'reconciled')),
        'branchCount', (SELECT COUNT(*) FROM tenant.branches WHERE tenant_id = p_tenant_id),
        'createdAt', v_org.created_at,
        'updatedAt', v_org.updated_at
    );

    -- Tab 2: Owner Information
    v_owner_info := jsonb_build_object(
        'userId', v_owner.user_id,
        'userCode', v_owner.user_code,
        'fullName', COALESCE(v_owner.full_name, 'Academy Administrator'),
        'email', v_owner.email,
        'phone', v_owner.phone,
        'emailVerified', COALESCE(v_owner.email_verified, false),
        'phoneVerified', COALESCE(v_owner.phone_verified, false),
        'accountStatus', COALESCE(v_owner.account_status, 'active'),
        'roleTitle', COALESCE(v_owner.role_title, 'Academy Owner & Administrator'),
        'joinedAt', v_owner.joined_at
    );

    -- Tab 3: Academy Information
    v_academy_info := jsonb_build_object(
        'name', v_org.name,
        'slug', v_org.slug,
        'category', v_org.academy_type,
        'description', v_org.description,
        'address', COALESCE(v_branch.address, v_org.settings->>'address'),
        'city', COALESCE(v_branch.city, v_org.settings->>'city'),
        'state', COALESCE(v_branch.state, v_org.settings->>'state'),
        'pincode', COALESCE(v_branch.pincode, v_org.settings->>'pincode'),
        'phone', COALESCE(v_branch.phone, v_org.settings->>'phone', v_owner.phone),
        'email', COALESCE(v_branch.email, v_org.settings->>'email', v_owner.email),
        'currency', v_org.currency,
        'timezone', v_org.timezone,
        'logoUrl', v_org.branding->>'logoUrl',
        'coverImage', v_org.cover_image,
        'tagline', v_org.branding->>'tagline',
        'primaryColor', v_org.branding->>'primaryColor'
    );

    -- Tab 4: Verification Documents
    v_documents := COALESCE(v_org.documents, '[]'::jsonb);

    -- Tab 5: Courses
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_courses
    FROM (
        SELECT crs.course_id, crs.title, crs.code, crs.category, crs.level, crs.duration_months,
               crs.tuition_amount, crs.billing_period, crs.description,
               (crs.is_hidden IS NOT TRUE) AS is_published,
               COALESCE(crs.is_hidden, false) AS is_hidden,
               crs.created_at,
               (SELECT COUNT(*) FROM academics.batches b WHERE b.course_id = crs.course_id) AS batch_count,
               (SELECT COUNT(*) FROM academics.enrollments en
                JOIN academics.batches b ON b.batch_id = en.batch_id
                WHERE b.course_id = crs.course_id AND en.status = 'enrolled') AS student_count
        FROM academics.courses crs
        WHERE crs.tenant_id = p_tenant_id
        ORDER BY crs.created_at DESC
    ) c;

    -- Tab 6: Batches
    SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.start_date DESC), '[]'::jsonb) INTO v_batches
    FROM (
        SELECT bt.batch_id, bt.name AS batch_name, crs.title AS course_title,
               br.name AS branch_name, bt.start_date, bt.end_date, bt.capacity,
               (SELECT COUNT(*) FROM academics.enrollments en WHERE en.batch_id = bt.batch_id AND en.status = 'enrolled') AS active_students,
               bt.status
        FROM academics.batches bt
        JOIN academics.courses crs ON crs.course_id = bt.course_id
        LEFT JOIN tenant.branches br ON br.branch_id = bt.branch_id
        WHERE bt.tenant_id = p_tenant_id
        ORDER BY bt.start_date DESC
    ) b;

    -- Tab 7: Registrations
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_registrations
    FROM (
        SELECT e.enrollment_id AS registration_id,
               s.first_name || ' ' || s.last_name AS learner_name,
               c.title AS course_title,
               b.name AS batch_name,
               COALESCE(c.tuition_amount, 0) AS amount,
               e.status,
               e.enrolled_at AS created_at
        FROM academics.enrollments e
        JOIN academics.students s ON s.student_id = e.student_id
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        WHERE e.tenant_id = p_tenant_id
        ORDER BY e.enrolled_at DESC
        LIMIT 50
    ) r;

    -- Tab 8: Payments
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.paid_at DESC), '[]'::jsonb) INTO v_payments
    FROM (
        SELECT pay.payment_id,
               COALESCE(pay.payment_reference, pay.payment_id::text) AS transaction_id,
               s.first_name || ' ' || s.last_name AS learner_name,
               c.title AS course_name,
               pay.amount AS gross_amount,
               round(pay.amount * COALESCE(v_org.commission_rate, 10.00) / 100.0, 2) AS platform_commission,
               round(pay.amount * (1.0 - COALESCE(v_org.commission_rate, 10.00) / 100.0), 2) AS academy_share,
               pay.status,
               pay.payment_method AS method,
               pay.created_at AS paid_at
        FROM billing.payments pay
        LEFT JOIN billing.invoices inv ON inv.invoice_id = pay.invoice_id
        LEFT JOIN academics.students s ON s.student_id = pay.student_id
        LEFT JOIN academics.enrollments e ON e.student_id = s.student_id AND e.tenant_id = pay.tenant_id
        LEFT JOIN academics.batches b ON b.batch_id = e.batch_id
        LEFT JOIN academics.courses c ON c.course_id = b.course_id
        WHERE pay.tenant_id = p_tenant_id
        ORDER BY pay.created_at DESC
        LIMIT 50
    ) p;

    -- Tab 9: Payout History
    SELECT COALESCE(jsonb_agg(to_jsonb(py) ORDER BY py.created_at DESC), '[]'::jsonb) INTO v_payout_history
    FROM (
        SELECT po.payout_id,
               to_char(po.expected_release_date, 'Mon YYYY') AS cycle_period,
               po.total_collected AS gross_amount,
               po.platform_commission AS commission_amount,
               po.net_academy_amount AS net_disbursed,
               po.status,
               COALESCE(po.payout_id::text, 'PO-SETTLE') AS bank_reference,
               po.released_at AS processed_at,
               po.created_at
        FROM platform.payouts po
        WHERE po.tenant_id = p_tenant_id
        ORDER BY po.created_at DESC
        LIMIT 50
    ) py;

    -- Tab 10: Activity History
    SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_activity_history
    FROM (
        SELECT l.log_id, l.action, l.correlation_id, l.details, l.created_at,
               COALESCE(u.full_name, 'Platform System') AS actor_name
        FROM audit.compliance_logs l
        LEFT JOIN identity_app.users u ON u.user_id = l.actor_id
        WHERE l.tenant_id = p_tenant_id
        ORDER BY l.created_at DESC
        LIMIT 50
    ) a;

    RETURN jsonb_build_object(
        'overview', v_overview,
        'owner', v_owner_info,
        'academy', v_academy_info,
        'documents', v_documents,
        'courses', v_courses,
        'batches', v_batches,
        'registrations', v_registrations,
        'payments', v_payments,
        'payoutHistory', v_payout_history,
        'activityHistory', v_activity_history
    );
END;
$$;

-- 4. Full Verification / Suspension / Commission Lifecycle Mutation
CREATE OR REPLACE FUNCTION platform.fn_academy_action(
    p_tenant_id UUID,
    p_action TEXT,
    p_reason TEXT DEFAULT NULL,
    p_commission NUMERIC DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, academics, platform, identity_app, audit, public
AS $$
DECLARE
    v_name TEXT;
    v_admin_id UUID;
BEGIN
    SELECT name INTO v_name FROM tenant.organizations WHERE tenant_id = p_tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Academy % not found', p_tenant_id USING ERRCODE = '22023';
    END IF;

    -- Find the academy owner user id
    SELECT user_id INTO v_admin_id FROM tenant.memberships
    WHERE tenant_id = p_tenant_id AND role = 'TenantAdmin'
    ORDER BY created_at LIMIT 1;

    CASE p_action
        WHEN 'approve' THEN
            UPDATE tenant.organizations
            SET verification_status = 'verified',
                status = 'active',
                rejection_reason = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = p_tenant_id;

            -- Auto-verify the owner's credentials upon academy approval
            IF v_admin_id IS NOT NULL THEN
                UPDATE identity_app.users
                SET email_verified_at = COALESCE(email_verified_at, clock_timestamp()),
                    phone_verified_at = COALESCE(phone_verified_at, clock_timestamp())
                WHERE user_id = v_admin_id;
            END IF;

            -- Restore course visibility
            UPDATE academics.courses SET is_hidden = false WHERE tenant_id = p_tenant_id;

            INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
            VALUES (p_tenant_id, p_actor_id, 'academy.approved', 'academy', p_tenant_id::text, gen_random_uuid()::text,
                    jsonb_build_object('name', v_name, 'verificationStatus', 'verified', 'note', 'Academy verified and approved for publishing.'));

        WHEN 'reject' THEN
            IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
                RAISE EXCEPTION 'A mandatory rejection reason of at least 10 characters is required.' USING ERRCODE = '22023';
            END IF;

            UPDATE tenant.organizations
            SET verification_status = 'rejected',
                rejection_reason = trim(p_reason),
                updated_at = clock_timestamp()
            WHERE tenant_id = p_tenant_id;

            INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
            VALUES (p_tenant_id, p_actor_id, 'academy.rejected', 'academy', p_tenant_id::text, gen_random_uuid()::text,
                    jsonb_build_object('name', v_name, 'verificationStatus', 'rejected', 'reason', trim(p_reason)));

        WHEN 'suspend' THEN
            IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
                RAISE EXCEPTION 'A mandatory suspension reason of at least 10 characters is required.' USING ERRCODE = '22023';
            END IF;

            UPDATE tenant.organizations
            SET status = 'suspended',
                verification_status = 'suspended',
                rejection_reason = trim(p_reason),
                suspended_at = clock_timestamp(),
                suspended_by = p_actor_id,
                updated_at = clock_timestamp()
            WHERE tenant_id = p_tenant_id;

            -- Hide all courses from public discovery
            UPDATE academics.courses SET is_hidden = true WHERE tenant_id = p_tenant_id;

            INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
            VALUES (p_tenant_id, p_actor_id, 'academy.suspended', 'academy', p_tenant_id::text, gen_random_uuid()::text,
                    jsonb_build_object('name', v_name, 'reason', trim(p_reason), 'coursesHidden', true));

        WHEN 'reactivate' THEN
            UPDATE tenant.organizations
            SET status = 'active',
                verification_status = 'verified',
                rejection_reason = NULL,
                suspended_at = NULL,
                suspended_by = NULL,
                updated_at = clock_timestamp()
            WHERE tenant_id = p_tenant_id;

            -- Restore course visibility
            UPDATE academics.courses SET is_hidden = false WHERE tenant_id = p_tenant_id;

            INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
            VALUES (p_tenant_id, p_actor_id, 'academy.reactivated', 'academy', p_tenant_id::text, gen_random_uuid()::text,
                    jsonb_build_object('name', v_name, 'status', 'active', 'coursesRestored', true));

        WHEN 'commission' THEN
            IF p_commission IS NULL OR p_commission < 0 OR p_commission > 50 THEN
                RAISE EXCEPTION 'Commission rate must be between 0 and 50 percent.' USING ERRCODE = '22023';
            END IF;

            UPDATE tenant.organizations
            SET commission_rate = p_commission,
                updated_at = clock_timestamp()
            WHERE tenant_id = p_tenant_id;

            INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
            VALUES (p_tenant_id, p_actor_id, 'academy.commission_updated', 'academy', p_tenant_id::text, gen_random_uuid()::text,
                    jsonb_build_object('name', v_name, 'commissionRate', p_commission));

        ELSE
            RAISE EXCEPTION 'Unknown action: %. Use approve, reject, suspend, reactivate, or commission.', p_action USING ERRCODE = '22023';
    END CASE;

    RETURN jsonb_build_object(
        'success', true,
        'tenantId', p_tenant_id,
        'action', p_action
    );
END;
$$;

-- 5. Business Rule Guard: Course Publishing Authorization
-- Do not allow unverified or suspended academies to publish publicly available courses
CREATE OR REPLACE FUNCTION academics.fn_course_create(
    p_tenant_id UUID,
    p_title VARCHAR(200),
    p_code VARCHAR(50),
    p_category VARCHAR(100),
    p_level VARCHAR(100),
    p_duration_months INT,
    p_tuition_amount NUMERIC(10,2),
    p_billing_period VARCHAR(30),
    p_description TEXT,
    p_subjects TEXT[],
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, tenant, audit, public
AS $$
DECLARE
    v_course_id UUID;
    v_academy RECORD;
BEGIN
    SELECT status, verification_status INTO v_academy FROM tenant.organizations WHERE tenant_id = p_tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Academy % not found', p_tenant_id USING ERRCODE = '22023';
    END IF;

    IF v_academy.status = 'suspended' OR v_academy.verification_status <> 'verified' THEN
        RAISE EXCEPTION 'Academy is not verified or is suspended. Publishing and creating courses requires a verified and active academy status.' USING ERRCODE = '22023';
    END IF;

    IF length(trim(p_code)) < 1 OR length(trim(p_code)) > 30 THEN
        RAISE EXCEPTION 'Course code must be between 1 and 30 characters' USING ERRCODE = '22023';
    END IF;

    IF p_level IS NOT NULL AND length(trim(p_level)) > 50 THEN
        RAISE EXCEPTION 'Course level cannot exceed 50 characters' USING ERRCODE = '22023';
    END IF;

    IF p_tuition_amount IS NULL OR p_tuition_amount < 0 THEN
        RAISE EXCEPTION 'Tuition amount must be zero or more' USING ERRCODE = '22023';
    END IF;

    INSERT INTO academics.courses (tenant_id, title, code, category, level, duration_months, tuition_amount, billing_period, description)
    VALUES (p_tenant_id, p_title, upper(p_code), p_category, p_level, p_duration_months, p_tuition_amount, COALESCE(p_billing_period, 'monthly'), p_description)
    RETURNING course_id INTO v_course_id;

    INSERT INTO academics.course_subjects (tenant_id, course_id, name, sort_order)
    SELECT p_tenant_id, v_course_id, trim(name), ord
    FROM unnest(p_subjects) WITH ORDINALITY AS t(name, ord)
    WHERE trim(name) <> ''
    ON CONFLICT (course_id, name) DO NOTHING;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'course.created', 'course', v_course_id::text, gen_random_uuid()::text,
            jsonb_build_object('title', p_title, 'code', p_code, 'subjects', p_subjects));

    RETURN jsonb_build_object('courseId', v_course_id);
END;
$$;

-- 6. Academies Export Function for CSV Generation
CREATE OR REPLACE FUNCTION platform.fn_academies_export(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, platform, academics, identity_app, audit, public
AS $$
DECLARE
    v_academies JSONB;
BEGIN
    IF p_status IS NOT NULL AND p_status NOT IN ('all', 'pending', 'verified', 'rejected', 'suspended') THEN
        RAISE EXCEPTION 'Invalid status filter: %. Use all, pending, verified, rejected, or suspended.', p_status USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_academies
    FROM (
        SELECT
            o.tenant_id,
            COALESCE(o.academy_code, 'AC-' || o.tenant_id::text) AS academy_code,
            o.name,
            o.slug,
            o.academy_type AS category,
            COALESCE(ow.owner_name, 'Academy Administrator') AS owner_name,
            ow.owner_email AS email,
            ow.owner_phone AS phone,
            COALESCE(NULLIF(loc.city, ''), o.settings->>'city', '—') AS location,
            o.created_at AS registration_date,
            o.created_at,
            CASE
                WHEN o.status = 'suspended' OR o.verification_status = 'suspended' THEN 'suspended'
                WHEN o.verification_status = 'rejected' THEN 'rejected'
                WHEN o.verification_status = 'pending' THEN 'pending'
                ELSE 'verified'
            END AS verification_status,
            COALESCE(o.commission_rate, 10.00) AS commission_rate,
            COALESCE(sub.plan_tier, 'Starter') AS plan_tier,
            (SELECT COUNT(*) FROM academics.students st WHERE st.tenant_id = o.tenant_id AND st.status = 'active') AS active_students,
            (SELECT COUNT(*) FROM academics.courses c WHERE c.tenant_id = o.tenant_id) AS course_count,
            (SELECT COUNT(*) FROM academics.batches bt WHERE bt.tenant_id = o.tenant_id) AS batch_count
        FROM tenant.organizations o
        LEFT JOIN LATERAL (
            SELECT u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
            FROM tenant.memberships m
            JOIN identity_app.users u ON u.user_id = m.user_id
            WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin'
            ORDER BY m.created_at LIMIT 1
        ) ow ON true
        LEFT JOIN LATERAL (
            SELECT b.city FROM tenant.branches b
            WHERE b.tenant_id = o.tenant_id AND b.is_primary = true LIMIT 1
        ) loc ON true
        LEFT JOIN LATERAL (
            SELECT ps.plan_tier FROM platform.subscriptions ps
            WHERE ps.tenant_id = o.tenant_id ORDER BY ps.created_at DESC LIMIT 1
        ) sub ON true
        WHERE platform.fn_academy_matches_filter(o, ow.owner_name, ow.owner_email, ow.owner_phone, loc.city, p_query, p_status)
        ORDER BY o.created_at DESC
        LIMIT 10000
    ) r;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'academies.exported', 'academy', 'platform', gen_random_uuid()::text,
            jsonb_build_object('query', p_query, 'status', p_status, 'count', jsonb_array_length(v_academies)));

    RETURN jsonb_build_object('academies', v_academies);
END;
$$;
