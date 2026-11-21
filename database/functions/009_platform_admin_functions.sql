-- ============================================================================
-- ClassSphere / ClassShare Stored Functions: 009_platform_admin_functions.sql
-- Backend functions supporting the 14 Platform Admin Modules
-- ============================================================================

-- 1. DASHBOARD TELEMETRY
DROP FUNCTION IF EXISTS platform.fn_dashboard_telemetry();
DROP FUNCTION IF EXISTS platform.fn_dashboard_telemetry(TEXT);
DROP FUNCTION IF EXISTS platform.fn_dashboard_telemetry(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID);
CREATE OR REPLACE FUNCTION platform.fn_dashboard_telemetry(
    p_timeframe TEXT DEFAULT 'month'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, tenant, identity_app, academics, billing, audit, public
AS $$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_total_users INT;
    v_total_academies INT;
    v_verified_academies INT;
    v_pending_academies INT;
    v_total_courses INT;
    v_total_registrations INT;
    v_successful_payments INT;
    v_total_revenue NUMERIC(12,2);
    v_platform_commission NUMERIC(12,2);
    v_recent_transactions JSONB;
    v_recent_registrations JSONB;
    v_recent_activities JSONB;
    v_pending_verifications JSONB;
BEGIN
    -- Determine timeframe boundary
    v_start_time := CASE LOWER(COALESCE(p_timeframe, 'month'))
        WHEN 'today' THEN CURRENT_DATE::TIMESTAMPTZ
        WHEN 'week'  THEN (NOW() - INTERVAL '7 days')
        WHEN 'month' THEN (NOW() - INTERVAL '30 days')
        WHEN 'year'  THEN (NOW() - INTERVAL '365 days')
        ELSE (NOW() - INTERVAL '30 days')
    END;

    -- Platform overall totals
    SELECT COUNT(*) INTO v_total_users FROM identity_app.users;
    SELECT COUNT(*) INTO v_total_academies FROM tenant.organizations;
    SELECT COUNT(*) INTO v_verified_academies FROM tenant.organizations WHERE verification_status = 'verified';
    SELECT COUNT(*) INTO v_pending_academies FROM tenant.organizations WHERE verification_status = 'pending';
    SELECT COUNT(*) INTO v_total_courses FROM academics.courses;
    
    -- Period-filtered registrations
    v_total_registrations := (
        SELECT COUNT(*) FROM academics.enrollments WHERE enrolled_at >= v_start_time
    ) + (
        SELECT COUNT(*) FROM platform.registration_payments WHERE payment_status = 'success' AND transaction_date >= v_start_time
    );

    -- Period-filtered successful payments
    v_successful_payments := (
        SELECT COUNT(*) FROM billing.payments WHERE status IN ('posted', 'reconciled') AND created_at >= v_start_time
    ) + (
        SELECT COUNT(*) FROM platform.registration_payments WHERE payment_status = 'success' AND transaction_date >= v_start_time
    );

    -- Period-filtered revenue
    SELECT COALESCE(SUM(amount), 0) INTO v_total_revenue
    FROM (
        SELECT amount FROM billing.payments WHERE status IN ('posted', 'reconciled') AND created_at >= v_start_time
        UNION ALL
        SELECT amount FROM platform.registration_payments WHERE payment_status = 'success' AND transaction_date >= v_start_time
    ) r;

    -- Period-filtered platform commission (10% standard)
    v_platform_commission := (v_total_revenue * 0.10);

    -- Period-filtered recent transactions
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_recent_transactions
    FROM (
        SELECT rp.payment_id, 'Registration' AS description, rp.amount, rp.payment_method, rp.transaction_date AS created_at, 'successful' AS status,
               (SELECT name FROM tenant.organizations WHERE tenant_id = rp.tenant_id) AS academy_name
        FROM platform.registration_payments rp 
        WHERE rp.payment_status = 'success' AND rp.transaction_date >= v_start_time
        UNION ALL
        SELECT bp.payment_id::text, 'Course Fee' AS description, bp.amount, bp.payment_method, bp.created_at, bp.status,
               (SELECT name FROM tenant.organizations WHERE tenant_id = bp.tenant_id) AS academy_name
        FROM billing.payments bp
        WHERE bp.created_at >= v_start_time
        ORDER BY created_at DESC
        LIMIT 5
    ) t;

    -- Fallback to all-time recent if no transactions within this strict timeframe
    IF jsonb_array_length(v_recent_transactions) = 0 THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_recent_transactions
        FROM (
            SELECT rp.payment_id, 'Registration' AS description, rp.amount, rp.payment_method, rp.transaction_date AS created_at, 'successful' AS status,
                   (SELECT name FROM tenant.organizations WHERE tenant_id = rp.tenant_id) AS academy_name
            FROM platform.registration_payments rp WHERE rp.payment_status = 'success'
            UNION ALL
            SELECT bp.payment_id::text, 'Course Fee' AS description, bp.amount, bp.payment_method, bp.created_at, bp.status,
                   (SELECT name FROM tenant.organizations WHERE tenant_id = bp.tenant_id) AS academy_name
            FROM billing.payments bp
            ORDER BY created_at DESC
            LIMIT 5
        ) t;
    END IF;

    -- Period-filtered recent registrations
    SELECT COALESCE(jsonb_agg(to_jsonb(rg)), '[]'::jsonb) INTO v_recent_registrations
    FROM (
        SELECT e.enrollment_id, e.status, e.enrolled_at,
               s.first_name || ' ' || s.last_name AS learner_name,
               c.title AS course_name,
               o.name AS academy_name
        FROM academics.enrollments e
        JOIN academics.students s ON s.student_id = e.student_id
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
        WHERE e.enrolled_at >= v_start_time
        ORDER BY e.enrolled_at DESC
        LIMIT 5
    ) rg;

    IF jsonb_array_length(v_recent_registrations) = 0 THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(rg)), '[]'::jsonb) INTO v_recent_registrations
        FROM (
            SELECT e.enrollment_id, e.status, e.enrolled_at,
                   s.first_name || ' ' || s.last_name AS learner_name,
                   c.title AS course_name,
                   o.name AS academy_name
            FROM academics.enrollments e
            JOIN academics.students s ON s.student_id = e.student_id
            JOIN academics.batches b ON b.batch_id = e.batch_id
            JOIN academics.courses c ON c.course_id = b.course_id
            JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
            ORDER BY e.enrolled_at DESC
            LIMIT 5
        ) rg;
    END IF;

    -- Recent activities from audit logs
    SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_recent_activities
    FROM (
        SELECT log_id, action, entity_type, correlation_id, created_at,
               COALESCE((SELECT full_name FROM identity_app.users WHERE user_id = l.actor_id), 'System Operator') AS actor_name
        FROM audit.compliance_logs l
        ORDER BY created_at DESC
        LIMIT 6
    ) a;

    -- Pending academy verifications
    SELECT COALESCE(jsonb_agg(to_jsonb(pv)), '[]'::jsonb) INTO v_pending_verifications
    FROM (
        SELECT o.tenant_id, o.name, o.academy_type, o.created_at, o.documents,
               (SELECT u.email FROM tenant.memberships m JOIN identity_app.users u ON u.user_id = m.user_id WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin' LIMIT 1) AS admin_email
        FROM tenant.organizations o
        WHERE o.verification_status = 'pending'
        ORDER BY o.created_at DESC
        LIMIT 5
    ) pv;

    RETURN jsonb_build_object(
        'timeframe', p_timeframe,
        'totalUsers', v_total_users,
        'totalAcademies', v_total_academies,
        'verifiedAcademies', v_verified_academies,
        'pendingAcademies', v_pending_academies,
        'totalCourses', v_total_courses,
        'totalRegistrations', v_total_registrations,
        'successfulPayments', v_successful_payments,
        'totalRevenue', v_total_revenue,
        'platformCommission', v_platform_commission,
        'recentTransactions', v_recent_transactions,
        'recentRegistrations', v_recent_registrations,
        'recentActivities', v_recent_activities,
        'pendingVerifications', v_pending_verifications
    );
END;
$$;

-- 2. USERS MANAGEMENT
-- platform.fn_users_list, fn_users_export, fn_user_detail and fn_user_status_update live in 010_user_management_functions.sql

-- 3. ACADEMY MANAGEMENT & VERIFICATION
CREATE OR REPLACE FUNCTION platform.fn_academy_verification_update(
    p_tenant_id UUID,
    p_status VARCHAR(30),
    p_reason TEXT DEFAULT NULL,
    p_commission_rate NUMERIC(5,2) DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenant, academics, audit, public
AS $$
BEGIN
    IF p_status = 'rejected' AND (p_reason IS NULL OR trim(p_reason) = '') THEN
        RAISE EXCEPTION 'A reason is mandatory when rejecting an academy' USING ERRCODE = '22023';
    END IF;

    IF p_status = 'suspended' AND (p_reason IS NULL OR trim(p_reason) = '') THEN
        RAISE EXCEPTION 'A reason is mandatory when suspending an academy' USING ERRCODE = '22023';
    END IF;

    IF p_commission_rate IS NOT NULL AND (p_commission_rate < 0 OR p_commission_rate > 50) THEN
        RAISE EXCEPTION 'Commission rate must be between 0 and 50 percent' USING ERRCODE = '22023';
    END IF;

    UPDATE tenant.organizations
    SET verification_status = CASE WHEN p_status IN ('verified', 'rejected', 'pending') THEN p_status ELSE verification_status END,
        rejection_reason = CASE WHEN p_status IN ('rejected', 'suspended') THEN p_reason WHEN p_status = 'verified' THEN NULL ELSE rejection_reason END,
        commission_rate = COALESCE(p_commission_rate, commission_rate),
        status = CASE WHEN p_status = 'suspended' THEN 'suspended' WHEN p_status = 'verified' THEN 'active' ELSE status END,
        updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Academy % not found', p_tenant_id USING ERRCODE = '22023';
    END IF;

    -- Architecture Rule Section 7.4: When academy is suspended, its courses are hidden
    IF p_status = 'suspended' THEN
        UPDATE academics.courses SET is_hidden = true WHERE tenant_id = p_tenant_id;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'academy.verification_' || p_status, 'academy', p_tenant_id::text, gen_random_uuid()::text,
            jsonb_build_object('verificationStatus', p_status, 'reason', p_reason, 'commissionRate', p_commission_rate));

    RETURN jsonb_build_object('success', true, 'tenantId', p_tenant_id, 'verificationStatus', p_status);
END;
$$;

-- 4. COURSES MANAGEMENT & MODERATION
CREATE OR REPLACE FUNCTION platform.fn_courses_list(
    p_query TEXT DEFAULT NULL,
    p_category TEXT DEFAULT NULL,
    p_tenant_id UUID DEFAULT NULL,
    p_is_hidden BOOLEAN DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, tenant, public
AS $$
DECLARE
    v_total INT;
    v_courses JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM academics.courses c
    JOIN tenant.organizations o ON o.tenant_id = c.tenant_id
    WHERE (p_query IS NULL OR c.title ILIKE '%' || p_query || '%' OR c.code ILIKE '%' || p_query || '%' OR o.name ILIKE '%' || p_query || '%')
      AND (p_category IS NULL OR c.category = p_category)
      AND (p_tenant_id IS NULL OR c.tenant_id = p_tenant_id)
      AND (p_is_hidden IS NULL OR c.is_hidden = p_is_hidden);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_courses
    FROM (
        SELECT c.course_id, c.tenant_id, o.name AS academy_name, c.title, c.code, c.description, c.category,
               c.level, c.tuition_amount, c.billing_period, c.is_active, c.is_hidden, c.is_featured, c.created_at,
               (SELECT COUNT(*) FROM academics.batches b WHERE b.course_id = c.course_id) AS batch_count
        FROM academics.courses c
        JOIN tenant.organizations o ON o.tenant_id = c.tenant_id
        WHERE (p_query IS NULL OR c.title ILIKE '%' || p_query || '%' OR c.code ILIKE '%' || p_query || '%' OR o.name ILIKE '%' || p_query || '%')
          AND (p_category IS NULL OR c.category = p_category)
          AND (p_tenant_id IS NULL OR c.tenant_id = p_tenant_id)
          AND (p_is_hidden IS NULL OR c.is_hidden = p_is_hidden)
        ORDER BY c.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'courses', v_courses
    );
END;
$$;

DROP FUNCTION IF EXISTS platform.fn_course_visibility_update(UUID, BOOLEAN, BOOLEAN, UUID);
CREATE OR REPLACE FUNCTION platform.fn_course_visibility_update(
    p_course_id UUID,
    p_is_hidden BOOLEAN,
    p_is_featured BOOLEAN,
    p_reason TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_tenant_id UUID;
    v_action TEXT;
BEGIN
    SELECT tenant_id INTO v_tenant_id FROM academics.courses WHERE course_id = p_course_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Course % not found', p_course_id USING ERRCODE = '22023';
    END IF;

    UPDATE academics.courses
    SET is_hidden = COALESCE(p_is_hidden, is_hidden),
        is_featured = COALESCE(p_is_featured, is_featured)
    WHERE course_id = p_course_id;

    v_action := CASE
        WHEN p_is_hidden IS TRUE THEN 'course.hidden_by_admin'
        WHEN p_is_hidden IS FALSE THEN 'course.unhidden_by_admin'
        WHEN p_is_featured IS TRUE THEN 'course.featured'
        ELSE 'course.unfeatured'
    END;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (v_tenant_id, p_actor_id, v_action, 'course', p_course_id::text, gen_random_uuid()::text,
            jsonb_build_object('courseId', p_course_id, 'isHidden', p_is_hidden, 'isFeatured', p_is_featured, 'reason', p_reason));

    RETURN jsonb_build_object('success', true, 'courseId', p_course_id, 'isHidden', p_is_hidden, 'isFeatured', p_is_featured);
END;
$$;

-- 5. CATEGORIES MANAGEMENT
CREATE OR REPLACE FUNCTION platform.fn_categories_list()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = platform, academics, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.display_order ASC), '[]'::jsonb)
    FROM (
        SELECT c.category_id, c.name, c.description, c.icon, c.display_order, c.is_active, c.created_at,
               (SELECT COUNT(*) FROM academics.courses cr WHERE cr.category = c.name) AS course_count
        FROM platform.categories c
    ) r;
$$;

CREATE OR REPLACE FUNCTION platform.fn_category_upsert(
    p_category_id UUID DEFAULT NULL,
    p_name VARCHAR(100) DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_icon VARCHAR(100) DEFAULT 'BookOpen',
    p_display_order INT DEFAULT 0,
    p_is_active BOOLEAN DEFAULT TRUE,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
DECLARE
    v_id UUID;
    v_record RECORD;
BEGIN
    IF p_category_id IS NOT NULL THEN
        UPDATE platform.categories
        SET name = COALESCE(p_name, name),
            description = COALESCE(p_description, description),
            icon = COALESCE(p_icon, icon),
            display_order = COALESCE(p_display_order, display_order),
            is_active = COALESCE(p_is_active, is_active),
            updated_at = clock_timestamp()
        WHERE category_id = p_category_id
        RETURNING * INTO v_record;
        v_id := p_category_id;
    ELSE
        INSERT INTO platform.categories (name, description, icon, display_order, is_active)
        VALUES (p_name, p_description, p_icon, p_display_order, p_is_active)
        RETURNING * INTO v_record;
        v_id := v_record.category_id;
    END IF;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'category.upserted', 'category', v_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'displayOrder', p_display_order, 'isActive', p_is_active));

    RETURN to_jsonb(v_record);
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_category_delete(
    p_category_id UUID,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, academics, audit, public
AS $$
DECLARE
    v_name VARCHAR(100);
    v_courses INT;
BEGIN
    SELECT name INTO v_name FROM platform.categories WHERE category_id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Category not found' USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*) INTO v_courses FROM academics.courses WHERE category = v_name;
    IF v_courses > 0 THEN
        RAISE EXCEPTION 'Cannot delete category "%" because it is assigned to % courses. Deactivate it instead.', v_name, v_courses USING ERRCODE = '23503';
    END IF;

    DELETE FROM platform.categories WHERE category_id = p_category_id;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'category.deleted', 'category', p_category_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', v_name));

    RETURN jsonb_build_object('success', true, 'deletedId', p_category_id);
END;
$$;

-- 6. REGISTRATIONS MANAGEMENT
CREATE OR REPLACE FUNCTION platform.fn_registrations_list(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_tenant_id UUID DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, tenant, public
AS $$
DECLARE
    v_total INT;
    v_regs JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM academics.enrollments e
    JOIN academics.students s ON s.student_id = e.student_id
    JOIN academics.batches b ON b.batch_id = e.batch_id
    JOIN academics.courses c ON c.course_id = b.course_id
    JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
    WHERE (p_query IS NULL OR s.first_name ILIKE '%' || p_query || '%' OR s.last_name ILIKE '%' || p_query || '%' OR c.title ILIKE '%' || p_query || '%' OR o.name ILIKE '%' || p_query || '%')
      AND (p_status IS NULL OR e.status = p_status)
      AND (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_regs
    FROM (
        SELECT e.enrollment_id AS registration_id, e.tenant_id, o.name AS academy_name,
               s.student_id, s.first_name || ' ' || s.last_name AS learner_name, s.email AS learner_email, s.phone AS learner_phone,
               c.course_id, c.title AS course_name, c.tuition_amount AS registration_amount,
               b.batch_id, b.name AS batch_name,
               e.status, e.enrolled_at AS registration_date
        FROM academics.enrollments e
        JOIN academics.students s ON s.student_id = e.student_id
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
        WHERE (p_query IS NULL OR s.first_name ILIKE '%' || p_query || '%' OR s.last_name ILIKE '%' || p_query || '%' OR c.title ILIKE '%' || p_query || '%' OR o.name ILIKE '%' || p_query || '%')
          AND (p_status IS NULL OR e.status = p_status)
          AND (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
        ORDER BY e.enrolled_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'registrations', v_regs
    );
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_registration_status_override(
    p_registration_id UUID,
    p_new_status VARCHAR(30),
    p_reason TEXT,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_old_status VARCHAR(30);
    v_tenant_id UUID;
    v_target_status VARCHAR(30);
BEGIN
    v_target_status := lower(trim(p_new_status));
    IF v_target_status NOT IN ('waitlisted', 'pending', 'approved', 'confirmed', 'completed', 'rejected', 'expired', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid registration status: %. Must be one of: waitlisted, pending, approved, confirmed, completed, rejected, expired, cancelled', p_new_status USING ERRCODE = '22023';
    END IF;

    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'A mandatory justification reason (min 5 characters) is required for registration status override' USING ERRCODE = '22023';
    END IF;

    SELECT status, tenant_id INTO v_old_status, v_tenant_id FROM academics.enrollments WHERE enrollment_id = p_registration_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration % not found', p_registration_id USING ERRCODE = '22023';
    END IF;

    UPDATE academics.enrollments
    SET status = v_target_status
    WHERE enrollment_id = p_registration_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (v_tenant_id, p_actor_id, 'registration.status_overridden', 'registration', p_registration_id::text, gen_random_uuid()::text,
            jsonb_build_object('registrationId', p_registration_id, 'oldStatus', v_old_status, 'newStatus', v_target_status, 'reason', p_reason));

    RETURN jsonb_build_object('success', true, 'registrationId', p_registration_id, 'previousStatus', v_old_status, 'newStatus', v_target_status);
END;
$$;

-- 7. PAYMENTS MANAGEMENT
CREATE OR REPLACE FUNCTION platform.fn_payments_list(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_tenant_id UUID DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, billing, tenant, public
AS $$
DECLARE
    v_total INT;
    v_payments JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM (
        SELECT rp.registration_id::text AS id, rp.payment_id, rp.order_id, rp.amount, rp.payment_status AS status, rp.payment_method, rp.transaction_date, o.name AS academy_name
        FROM platform.registration_payments rp
        LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
        UNION ALL
        SELECT bp.payment_id::text AS id, bp.gateway_payment_id AS payment_id, bp.gateway_order_id AS order_id, bp.amount, bp.status, bp.payment_method, bp.created_at AS transaction_date, o.name AS academy_name
        FROM billing.payments bp
        LEFT JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
    ) p
    WHERE (p_query IS NULL OR p.payment_id ILIKE '%' || p_query || '%' OR p.order_id ILIKE '%' || p_query || '%' OR p.academy_name ILIKE '%' || p_query || '%')
      AND (p_status IS NULL OR p.status = p_status);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_payments
    FROM (
        SELECT p.id AS transaction_id, p.payment_id, p.order_id, p.amount AS gross_amount,
               (p.amount * 0.10) AS platform_commission,
               (p.amount * 0.10 * 0.18) AS tax_on_commission,
               (p.amount * 0.02) AS gateway_charges,
               (p.amount - (p.amount * 0.10) - (p.amount * 0.02)) AS academy_share,
               p.status, p.payment_method, p.transaction_date, p.academy_name
        FROM (
            SELECT rp.registration_id::text AS id, rp.payment_id, rp.order_id, rp.amount, rp.payment_status AS status, rp.payment_method, rp.transaction_date, o.name AS academy_name
            FROM platform.registration_payments rp
            LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
            UNION ALL
            SELECT bp.payment_id::text AS id, bp.gateway_payment_id AS payment_id, bp.gateway_order_id AS order_id, bp.amount, bp.status, bp.payment_method, bp.created_at AS transaction_date, o.name AS academy_name
            FROM billing.payments bp
            LEFT JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
        ) p
        WHERE (p_query IS NULL OR p.payment_id ILIKE '%' || p_query || '%' OR p.order_id ILIKE '%' || p_query || '%' OR p.academy_name ILIKE '%' || p_query || '%')
          AND (p_status IS NULL OR p.status = p_status)
        ORDER BY p.transaction_date DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'payments', v_payments
    );
END;
$$;

-- 8. REFUNDS MANAGEMENT
CREATE OR REPLACE FUNCTION platform.fn_refunds_list(
    p_status TEXT DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
DECLARE
    v_total INT;
    v_refunds JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM platform.refunds rf
    WHERE (p_status IS NULL OR rf.status = p_status);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_refunds
    FROM (
        SELECT rf.refund_id, rf.tenant_id, rf.academy_name, rf.payment_id, rf.registration_id,
               rf.learner_name, rf.course_name, rf.amount, rf.reason, rf.status, rf.rejection_reason,
               rf.gateway_refund_id, rf.created_at AS request_date, rf.processed_at
        FROM platform.refunds rf
        WHERE (p_status IS NULL OR rf.status = p_status)
        ORDER BY rf.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'refunds', v_refunds
    );
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_refund_process(
    p_refund_id UUID,
    p_action VARCHAR(20), -- 'approve', 'reject'
    p_reason TEXT DEFAULT NULL,
    p_gateway_refund_id VARCHAR(100) DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
DECLARE
    v_ref RECORD;
BEGIN
    SELECT * INTO v_ref FROM platform.refunds WHERE refund_id = p_refund_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refund request % not found', p_refund_id USING ERRCODE = '22023';
    END IF;

    IF p_action = 'approve' THEN
        UPDATE platform.refunds
        SET status = 'refunded',
            gateway_refund_id = COALESCE(p_gateway_refund_id, 'rfnd_' || substr(gen_random_uuid()::text, 1, 14)),
            reviewed_by = p_actor_id,
            processed_at = clock_timestamp()
        WHERE refund_id = p_refund_id;
    ELSIF p_action = 'reject' THEN
        UPDATE platform.refunds
        SET status = 'rejected',
            rejection_reason = p_reason,
            reviewed_by = p_actor_id,
            processed_at = clock_timestamp()
        WHERE refund_id = p_refund_id;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (v_ref.tenant_id, p_actor_id, 'refund.' || p_action || 'd', 'refund', p_refund_id::text, gen_random_uuid()::text,
            jsonb_build_object('refundId', p_refund_id, 'action', p_action, 'amount', v_ref.amount, 'reason', p_reason));

    RETURN jsonb_build_object('success', true, 'refundId', p_refund_id, 'status', CASE WHEN p_action = 'approve' THEN 'refunded' ELSE 'rejected' END);
END;
$$;

-- 9. PAYOUTS & SETTLEMENTS
CREATE OR REPLACE FUNCTION platform.fn_payouts_list(
    p_status TEXT DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
DECLARE
    v_total INT;
    v_payouts JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM platform.payouts py
    WHERE (p_status IS NULL OR py.status = p_status);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_payouts
    FROM (
        SELECT py.payout_id, py.tenant_id, py.academy_name, py.total_collected, py.platform_commission,
               py.tax_on_commission, py.gateway_charges, py.net_academy_amount, py.expected_release_date,
               py.status, py.hold_reason, py.released_at, py.created_at
        FROM platform.payouts py
        WHERE (p_status IS NULL OR py.status = p_status)
        ORDER BY py.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'payouts', v_payouts
    );
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_payout_status_update(
    p_payout_id UUID,
    p_action VARCHAR(20), -- 'release', 'hold'
    p_hold_reason TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
DECLARE
    v_py RECORD;
BEGIN
    SELECT * INTO v_py FROM platform.payouts WHERE payout_id = p_payout_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout % not found', p_payout_id USING ERRCODE = '22023';
    END IF;

    IF p_action = 'release' THEN
        UPDATE platform.payouts
        SET status = 'completed',
            released_at = clock_timestamp(),
            hold_reason = NULL
        WHERE payout_id = p_payout_id;
    ELSIF p_action = 'hold' THEN
        UPDATE platform.payouts
        SET status = 'held',
            hold_reason = p_hold_reason
        WHERE payout_id = p_payout_id;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (v_py.tenant_id, p_actor_id, 'payout.' || p_action || 'd', 'payout', p_payout_id::text, gen_random_uuid()::text,
            jsonb_build_object('payoutId', p_payout_id, 'action', p_action, 'amount', v_py.net_academy_amount, 'holdReason', p_hold_reason));

    RETURN jsonb_build_object('success', true, 'payoutId', p_payout_id, 'status', CASE WHEN p_action = 'release' THEN 'completed' ELSE 'held' END);
END;
$$;

-- 10. PLATFORM SETTINGS
CREATE OR REPLACE FUNCTION platform.fn_settings_get()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
    SELECT COALESCE(jsonb_object_agg(s.setting_key, s.value), '{}'::jsonb)
    FROM platform.settings s;
$$;

CREATE OR REPLACE FUNCTION platform.fn_settings_update(
    p_key VARCHAR(100),
    p_value JSONB,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
BEGIN
    UPDATE platform.settings
    SET value = p_value,
        updated_at = clock_timestamp(),
        updated_by = p_actor_id
    WHERE setting_key = p_key;

    IF NOT FOUND THEN
        INSERT INTO platform.settings (setting_key, value, updated_by)
        VALUES (p_key, p_value, p_actor_id);
    END IF;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'platform_settings.updated', 'settings', p_key, gen_random_uuid()::text,
            jsonb_build_object('settingKey', p_key, 'newValue', p_value));

    RETURN jsonb_build_object('success', true, 'settingKey', p_key, 'value', p_value);
END;
$$;

-- 11. NOTIFICATIONS MANAGEMENT
CREATE OR REPLACE FUNCTION platform.fn_notification_templates_list()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.template_id), '[]'::jsonb)
    FROM platform.notification_templates t;
$$;

CREATE OR REPLACE FUNCTION platform.fn_notification_template_update(
    p_template_id VARCHAR(100),
    p_subject VARCHAR(255),
    p_content TEXT,
    p_is_active BOOLEAN,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
BEGIN
    UPDATE platform.notification_templates
    SET subject = COALESCE(p_subject, subject),
        content = COALESCE(p_content, content),
        is_active = COALESCE(p_is_active, is_active),
        updated_at = clock_timestamp()
    WHERE template_id = p_template_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Notification template % not found', p_template_id USING ERRCODE = '22023';
    END IF;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'notification_template.updated', 'template', p_template_id, gen_random_uuid()::text,
            jsonb_build_object('templateId', p_template_id, 'subject', p_subject));

    RETURN jsonb_build_object('success', true, 'templateId', p_template_id);
END;
$$;

-- 12. ADMIN ROLES & PERMISSIONS
CREATE OR REPLACE FUNCTION platform.fn_admin_users_list()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = platform, identity_app, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb)
    FROM (
        SELECT a.admin_id, a.user_id, u.email, u.full_name, a.role, a.is_active, a.two_factor_enabled, a.permissions, a.created_at
        FROM platform.admin_users a
        JOIN identity_app.users u ON u.user_id = a.user_id
    ) r;
$$;

CREATE OR REPLACE FUNCTION platform.fn_admin_user_upsert(
    p_admin_id UUID DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_email VARCHAR(255) DEFAULT NULL,
    p_full_name VARCHAR(150) DEFAULT NULL,
    p_role VARCHAR(50) DEFAULT 'SupportAdmin',
    p_permissions TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, identity_app, audit, public
AS $$
DECLARE
    v_user_id UUID := p_user_id;
    v_admin_id UUID := p_admin_id;
BEGIN
    -- If user_id not provided, find or create in identity_app.users
    IF v_user_id IS NULL AND p_email IS NOT NULL THEN
        SELECT user_id INTO v_user_id FROM identity_app.users WHERE lower(email) = lower(p_email);
        IF v_user_id IS NULL THEN
            INSERT INTO identity_app.users (email, full_name, is_active)
            VALUES (lower(p_email), COALESCE(p_full_name, p_email), TRUE)
            RETURNING user_id INTO v_user_id;
        END IF;
    END IF;

    IF v_admin_id IS NOT NULL THEN
        UPDATE platform.admin_users
        SET role = p_role,
            permissions = p_permissions,
            updated_at = clock_timestamp()
        WHERE admin_id = v_admin_id;
    ELSE
        INSERT INTO platform.admin_users (user_id, role, permissions)
        VALUES (v_user_id, p_role, p_permissions)
        ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions
        RETURNING admin_id INTO v_admin_id;
    END IF;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'admin_role.assigned', 'admin_user', v_admin_id::text, gen_random_uuid()::text,
            jsonb_build_object('userId', v_user_id, 'role', p_role, 'permissions', p_permissions));

    RETURN jsonb_build_object('success', true, 'adminId', v_admin_id, 'userId', v_user_id, 'role', p_role);
END;
$$;
