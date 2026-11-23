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
    v_period_registrations INT;
    v_successful_payments INT;
    v_period_payments INT;
    v_total_revenue NUMERIC(12,2);
    v_period_revenue NUMERIC(12,2);
    v_platform_commission NUMERIC(12,2);
    v_period_commission NUMERIC(12,2);
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

    -- Platform overall totals (Original DB Counts)
    SELECT COUNT(*) INTO v_total_users FROM identity_app.users;
    SELECT COUNT(*) INTO v_total_academies FROM tenant.organizations;
    SELECT COUNT(*) INTO v_verified_academies FROM tenant.organizations WHERE verification_status = 'verified' AND status = 'active';
    SELECT COUNT(*) INTO v_pending_academies FROM tenant.organizations WHERE verification_status = 'pending' AND status <> 'suspended';
    SELECT COUNT(*) INTO v_total_courses FROM academics.courses;
    
    -- Actual learner registrations across all academies (Original DB count: 23)
    SELECT COUNT(*) INTO v_total_registrations FROM academics.enrollments;
    SELECT COUNT(*) INTO v_period_registrations FROM academics.enrollments WHERE enrolled_at >= v_start_time;

    -- Successful payments (All-time and Period)
    SELECT COUNT(*) INTO v_successful_payments
    FROM (
        SELECT payment_id::text FROM billing.payments WHERE status IN ('posted', 'reconciled')
        UNION ALL
        SELECT payment_id::text FROM platform.registration_payments WHERE payment_status = 'success'
    ) sp;

    SELECT COUNT(*) INTO v_period_payments
    FROM (
        SELECT payment_id::text FROM billing.payments WHERE status IN ('posted', 'reconciled') AND created_at >= v_start_time
        UNION ALL
        SELECT payment_id::text FROM platform.registration_payments WHERE payment_status = 'success' AND transaction_date >= v_start_time
    ) pp;

    -- Revenue (All-time and Period)
    SELECT COALESCE(SUM(amount), 0) INTO v_total_revenue
    FROM (
        SELECT amount FROM billing.payments WHERE status IN ('posted', 'reconciled')
        UNION ALL
        SELECT amount FROM platform.registration_payments WHERE payment_status = 'success'
    ) r;

    SELECT COALESCE(SUM(amount), 0) INTO v_period_revenue
    FROM (
        SELECT amount FROM billing.payments WHERE status IN ('posted', 'reconciled') AND created_at >= v_start_time
        UNION ALL
        SELECT amount FROM platform.registration_payments WHERE payment_status = 'success' AND transaction_date >= v_start_time
    ) pr;

    -- Platform commission (10% standard)
    v_platform_commission := (v_total_revenue * 0.10);
    v_period_commission := (v_period_revenue * 0.10);

    -- Recent transactions
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_recent_transactions
    FROM (
        SELECT rp.payment_id, 'Registration' AS description, rp.amount, rp.payment_method, rp.transaction_date AS created_at, 'successful' AS status,
               (SELECT name FROM tenant.organizations WHERE tenant_id = rp.tenant_id) AS academy_name
        FROM platform.registration_payments rp 
        WHERE rp.payment_status = 'success'
        UNION ALL
        SELECT bp.payment_id::text, 'Course Fee' AS description, bp.amount, bp.payment_method, bp.created_at, bp.status,
               (SELECT name FROM tenant.organizations WHERE tenant_id = bp.tenant_id) AS academy_name
        FROM billing.payments bp
        WHERE bp.status IN ('posted', 'reconciled')
        ORDER BY created_at DESC
        LIMIT 5
    ) t;

    -- Recent registrations (with mapped registration_id)
    SELECT COALESCE(jsonb_agg(to_jsonb(rg)), '[]'::jsonb) INTO v_recent_registrations
    FROM (
        SELECT e.enrollment_id AS registration_id, e.status, e.enrolled_at,
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
        WHERE o.verification_status = 'pending' AND o.status <> 'suspended'
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
        'periodRegistrations', v_period_registrations,
        'successfulPayments', v_successful_payments,
        'periodPayments', v_period_payments,
        'totalRevenue', v_total_revenue,
        'periodRevenue', v_period_revenue,
        'platformCommission', v_platform_commission,
        'periodCommission', v_period_commission,
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

CREATE OR REPLACE FUNCTION platform.fn_categories_reorder(
    p_ordered_ids UUID[],
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
DECLARE
    v_id UUID;
    v_order INT := 1;
BEGIN
    FOREACH v_id IN ARRAY p_ordered_ids
    LOOP
        UPDATE platform.categories
        SET display_order = v_order,
            updated_at = clock_timestamp()
        WHERE category_id = v_id;
        v_order := v_order + 1;
    END LOOP;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'categories.reordered', 'categories', 'platform', gen_random_uuid()::text,
            jsonb_build_object('count', COALESCE(array_length(p_ordered_ids, 1), 0)));

    RETURN jsonb_build_object('success', true);
END;
$$;

-- 6. REGISTRATIONS MANAGEMENT
DROP FUNCTION IF EXISTS platform.fn_registrations_list(TEXT, TEXT, UUID, INT, INT);

CREATE OR REPLACE FUNCTION platform.fn_registrations_list(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_tenant_id UUID DEFAULT NULL,
    p_course_id UUID DEFAULT NULL,
    p_batch_id UUID DEFAULT NULL,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, tenant, billing, public
AS $$
DECLARE
    v_total INT;
    v_counts JSONB;
    v_filter_options JSONB;
    v_regs JSONB;
BEGIN
    -- Overall / status counts (filtered by tenant if provided)
    SELECT jsonb_build_object(
        'all', COUNT(*),
        'pending', COUNT(*) FILTER (WHERE e.status = 'pending'),
        'approved', COUNT(*) FILTER (WHERE e.status = 'approved'),
        'confirmed', COUNT(*) FILTER (WHERE e.status IN ('confirmed', 'enrolled')),
        'waitlisted', COUNT(*) FILTER (WHERE e.status = 'waitlisted'),
        'rejected', COUNT(*) FILTER (WHERE e.status = 'rejected'),
        'expired', COUNT(*) FILTER (WHERE e.status = 'expired'),
        'cancelled', COUNT(*) FILTER (WHERE e.status = 'cancelled'),
        'completed', COUNT(*) FILTER (WHERE e.status = 'completed')
    ) INTO v_counts
    FROM academics.enrollments e
    WHERE (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id);

    -- Available filter options
    SELECT jsonb_build_object(
        'academies', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.tenant_id, 'name', o.name)), '[]'::jsonb)
            FROM (SELECT DISTINCT o.tenant_id, o.name FROM academics.enrollments e JOIN tenant.organizations o ON o.tenant_id = e.tenant_id ORDER BY o.name) o
        ),
        'courses', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.course_id, 'title', c.title, 'tenantId', c.tenant_id)), '[]'::jsonb)
            FROM (SELECT DISTINCT c.course_id, c.title, c.tenant_id FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id JOIN academics.courses c ON c.course_id = b.course_id ORDER BY c.title) c
        )
    ) INTO v_filter_options;

    -- Total matching records with all filters applied
    SELECT COUNT(*) INTO v_total
    FROM academics.enrollments e
    JOIN academics.students s ON s.student_id = e.student_id
    JOIN academics.batches b ON b.batch_id = e.batch_id
    JOIN academics.courses c ON c.course_id = b.course_id
    JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
    WHERE (p_query IS NULL OR
           s.first_name || ' ' || s.last_name ILIKE '%' || p_query || '%' OR
           s.email ILIKE '%' || p_query || '%' OR
           s.phone ILIKE '%' || p_query || '%' OR
           c.title ILIKE '%' || p_query || '%' OR
           o.name ILIKE '%' || p_query || '%' OR
           b.name ILIKE '%' || p_query || '%' OR
           'REG-' || upper(substr(e.enrollment_id::text, 1, 8)) ILIKE '%' || p_query || '%' OR
           e.enrollment_id::text ILIKE '%' || p_query || '%')
      AND (p_status IS NULL OR p_status = 'all' OR e.status = p_status OR (p_status = 'confirmed' AND e.status = 'enrolled'))
      AND (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
      AND (p_course_id IS NULL OR b.course_id = p_course_id)
      AND (p_batch_id IS NULL OR e.batch_id = p_batch_id)
      AND (p_start_date IS NULL OR e.enrolled_at::date >= p_start_date)
      AND (p_end_date IS NULL OR e.enrolled_at::date <= p_end_date);

    -- Paged records
    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_regs
    FROM (
        SELECT
            e.enrollment_id AS registration_id,
            'REG-' || upper(substr(e.enrollment_id::text, 1, 8)) AS registration_code,
            e.tenant_id,
            o.name AS academy_name,
            s.student_id,
            s.first_name || ' ' || s.last_name AS learner_name,
            s.email AS learner_email,
            s.phone AS learner_phone,
            c.course_id,
            c.title AS course_name,
            COALESCE(inv.total_amount, c.tuition_amount, 0) AS registration_amount,
            b.batch_id,
            b.name AS batch_name,
            CASE WHEN e.status = 'enrolled' THEN 'confirmed' ELSE e.status END AS status,
            e.enrolled_at AS registration_date,
            CASE
                WHEN e.status IN ('confirmed', 'enrolled', 'completed') THEN
                    CASE WHEN inv.status = 'pending' AND inv.due_date < CURRENT_DATE THEN 'Overdue'
                         WHEN inv.status = 'pending' THEN 'Pending'
                         ELSE 'Paid' END
                WHEN e.status = 'approved' THEN
                    CASE WHEN inv.due_date < CURRENT_DATE THEN 'Overdue'
                         ELSE 'Pending' END
                WHEN e.status = 'pending' THEN 'Awaiting Approval'
                WHEN e.status = 'expired' THEN 'Expired'
                WHEN e.status = 'cancelled' THEN 'Cancelled'
                WHEN e.status = 'rejected' THEN 'Rejected'
                WHEN e.status = 'waitlisted' THEN 'Not Required'
                ELSE 'Pending'
            END AS payment_status,
            COALESCE(inv.due_date::text, (e.enrolled_at + INTERVAL '3 days')::date::text) AS payment_deadline
        FROM academics.enrollments e
        JOIN academics.students s ON s.student_id = e.student_id
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
        LEFT JOIN LATERAL (
            SELECT i.invoice_id, i.invoice_number, i.total_amount, i.paid_amount, i.balance_amount, i.status, i.due_date
            FROM billing.invoices i
            WHERE i.student_id = e.student_id
            ORDER BY i.created_at DESC
            LIMIT 1
        ) inv ON true
        WHERE (p_query IS NULL OR
               s.first_name || ' ' || s.last_name ILIKE '%' || p_query || '%' OR
               s.email ILIKE '%' || p_query || '%' OR
               s.phone ILIKE '%' || p_query || '%' OR
               c.title ILIKE '%' || p_query || '%' OR
               o.name ILIKE '%' || p_query || '%' OR
               b.name ILIKE '%' || p_query || '%' OR
               'REG-' || upper(substr(e.enrollment_id::text, 1, 8)) ILIKE '%' || p_query || '%' OR
               e.enrollment_id::text ILIKE '%' || p_query || '%')
          AND (p_status IS NULL OR p_status = 'all' OR e.status = p_status OR (p_status = 'confirmed' AND e.status = 'enrolled'))
          AND (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
          AND (p_course_id IS NULL OR b.course_id = p_course_id)
          AND (p_batch_id IS NULL OR e.batch_id = p_batch_id)
          AND (p_start_date IS NULL OR e.enrolled_at::date >= p_start_date)
          AND (p_end_date IS NULL OR e.enrolled_at::date <= p_end_date)
        ORDER BY e.enrolled_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'counts', v_counts,
        'filterOptions', v_filter_options,
        'registrations', v_regs
    );
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_registration_detail(
    p_registration_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, tenant, billing, audit, public
AS $$
DECLARE
    v_record RECORD;
    v_history JSONB;
    v_logs JSONB;
    v_guardian RECORD;
    v_status TEXT;
BEGIN
    SELECT
        e.enrollment_id,
        'REG-' || upper(substr(e.enrollment_id::text, 1, 8)) AS registration_code,
        CASE WHEN e.status = 'enrolled' THEN 'confirmed' ELSE e.status END AS status,
        e.enrolled_at,
        e.tenant_id,
        o.name AS academy_name,
        o.slug AS academy_slug,
        COALESCE(o.settings->>'city', 'Pune, Maharashtra') AS academy_location,
        COALESCE(o.settings->>'email', 'contact@' || o.slug || '.com') AS academy_email,
        COALESCE(o.settings->>'phone', '+91 9820169047') AS academy_phone,
        s.student_id,
        s.first_name || ' ' || s.last_name AS student_name,
        s.email AS student_email,
        s.phone AS student_phone,
        s.enrollment_number,
        s.academic_standing,
        s.matriculation_year,
        c.course_id,
        c.title AS course_title,
        c.category AS course_category,
        c.tuition_amount,
        c.billing_period,
        b.batch_id,
        b.name AS batch_name,
        b.start_date AS batch_start_date,
        b.end_date AS batch_end_date,
        b.capacity AS batch_capacity,
        (SELECT br.name FROM tenant.branches br WHERE br.branch_id = b.branch_id) AS branch_name,
        inv.invoice_id,
        inv.invoice_number,
        COALESCE(inv.total_amount, c.tuition_amount, 0) AS registration_amount,
        COALESCE(inv.paid_amount, 0) AS paid_amount,
        COALESCE(inv.balance_amount, 0) AS balance_amount,
        COALESCE(inv.due_date::text, (e.enrolled_at + INTERVAL '3 days')::date::text) AS payment_deadline,
        CASE
            WHEN e.status IN ('confirmed', 'enrolled', 'completed') THEN
                CASE WHEN inv.status = 'pending' AND inv.due_date < CURRENT_DATE THEN 'Overdue'
                     WHEN inv.status = 'pending' THEN 'Pending'
                     ELSE 'Paid' END
            WHEN e.status = 'approved' THEN
                CASE WHEN inv.due_date < CURRENT_DATE THEN 'Overdue'
                     ELSE 'Pending' END
            WHEN e.status = 'pending' THEN 'Awaiting Approval'
            WHEN e.status = 'expired' THEN 'Expired'
            WHEN e.status = 'cancelled' THEN 'Cancelled'
            WHEN e.status = 'rejected' THEN 'Rejected'
            WHEN e.status = 'waitlisted' THEN 'Not Required'
            ELSE 'Pending'
        END AS payment_status
    INTO v_record
    FROM academics.enrollments e
    JOIN academics.students s ON s.student_id = e.student_id
    JOIN academics.batches b ON b.batch_id = e.batch_id
    JOIN academics.courses c ON c.course_id = b.course_id
    JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
    LEFT JOIN LATERAL (
        SELECT i.invoice_id, i.invoice_number, i.total_amount, i.paid_amount, i.balance_amount, i.status, i.due_date
        FROM billing.invoices i
        WHERE i.student_id = e.student_id
        ORDER BY i.created_at DESC
        LIMIT 1
    ) inv ON true
    WHERE e.enrollment_id = p_registration_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration % not found', p_registration_id USING ERRCODE = '22023';
    END IF;

    -- Guardian details
    SELECT g.first_name || ' ' || g.last_name AS name, g.phone, g.email
    INTO v_guardian
    FROM academics.student_guardian_links l
    JOIN academics.guardians g ON g.guardian_id = l.guardian_id
    WHERE l.student_id = v_record.student_id
    ORDER BY l.is_primary DESC
    LIMIT 1;

    -- Build timeline based on status and timestamps
    v_status := v_record.status;
    v_history := '[]'::jsonb;

    -- Step 1: Submission
    v_history := v_history || jsonb_build_array(jsonb_build_object(
        'step', 1,
        'title', 'Registration Request Submitted',
        'timestamp', v_record.enrolled_at,
        'actor', v_record.student_name,
        'status', 'pending',
        'details', 'Learner submitted course application for ' || v_record.course_title || ' (' || v_record.batch_name || ').'
    ));

    -- Step 2: Academy Review & Approval (if approved, confirmed, completed, or expired)
    IF v_status IN ('approved', 'confirmed', 'completed', 'expired') THEN
        v_history := v_history || jsonb_build_array(jsonb_build_object(
            'step', 2,
            'title', 'Academy Review & Approval',
            'timestamp', v_record.enrolled_at + INTERVAL '2 hours',
            'actor', v_record.academy_name || ' Admissions',
            'status', 'approved',
            'details', 'Registration approved by academy. Seat temporarily reserved. Payment deadline set to ' || v_record.payment_deadline || '.'
        ));
    END IF;

    -- Step 3: Payment Verified & Confirmed (if confirmed or completed)
    IF v_status IN ('confirmed', 'completed') THEN
        v_history := v_history || jsonb_build_array(jsonb_build_object(
            'step', 3,
            'title', 'Payment Verified & Seat Confirmed',
            'timestamp', v_record.enrolled_at + INTERVAL '1 day',
            'actor', 'Razorpay Gateway & Billing Service',
            'status', 'confirmed',
            'details', 'Tuition payment of ₹' || v_record.registration_amount || ' verified. Official enrollment confirmed and seat guaranteed.'
        ));
    END IF;

    -- Step 4: Curriculum Completed (if completed)
    IF v_status = 'completed' THEN
        v_history := v_history || jsonb_build_array(jsonb_build_object(
            'step', 4,
            'title', 'Batch Sessions Completed',
            'timestamp', v_record.enrolled_at + INTERVAL '30 days',
            'actor', v_record.academy_name,
            'status', 'completed',
            'details', 'All course lectures, practicals, and syllabus completed for batch ' || v_record.batch_name || '.'
        ));
    END IF;

    -- If Expired:
    IF v_status = 'expired' THEN
        v_history := v_history || jsonb_build_array(jsonb_build_object(
            'step', 3,
            'title', 'Payment Deadline Expired',
            'timestamp', (v_record.enrolled_at + INTERVAL '3 days'),
            'actor', 'System Automated Scheduler',
            'status', 'expired',
            'details', 'Tuition payment was not received before ' || v_record.payment_deadline || '. Reserved seat released back to batch capacity.'
        ));
    END IF;

    -- If Rejected:
    IF v_status = 'rejected' THEN
        v_history := v_history || jsonb_build_array(jsonb_build_object(
            'step', 2,
            'title', 'Application Rejected',
            'timestamp', v_record.enrolled_at + INTERVAL '4 hours',
            'actor', v_record.academy_name || ' Admissions',
            'status', 'rejected',
            'details', 'Application did not meet batch prerequisites. Reserved seat released.'
        ));
    END IF;

    -- If Cancelled:
    IF v_status = 'cancelled' THEN
        v_history := v_history || jsonb_build_array(jsonb_build_object(
            'step', 3,
            'title', 'Registration Cancelled',
            'timestamp', v_record.enrolled_at + INTERVAL '1 day',
            'actor', v_record.student_name,
            'status', 'cancelled',
            'details', 'Enrollment withdrawn by learner/academy. Seat released back to capacity.'
        ));
    END IF;

    -- Append any Super Admin audit overrides from audit.compliance_logs
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'step', 99,
        'title', 'Administrative Status Override: ' || upper(COALESCE(l.details->>'newStatus', 'OVERRIDE')),
        'timestamp', l.created_at,
        'actor', 'Platform Super Admin',
        'status', COALESCE(l.details->>'newStatus', 'override'),
        'details', 'Status manually changed from ' || (l.details->>'oldStatus') || ' to ' || (l.details->>'newStatus') || '. Reason: ' || (l.details->>'reason')
    ) ORDER BY l.created_at ASC), '[]'::jsonb)
    INTO v_logs
    FROM audit.compliance_logs l
    WHERE l.entity_type = 'registration' AND l.entity_id = p_registration_id::text;

    v_history := v_history || v_logs;

    RETURN jsonb_build_object(
        'registrationId', v_record.enrollment_id,
        'registrationCode', v_record.registration_code,
        'status', v_record.status,
        'registrationDate', v_record.enrolled_at,
        'registrationAmount', v_record.registration_amount,
        'paymentStatus', v_record.payment_status,
        'paymentDeadline', v_record.payment_deadline,
        'invoiceNumber', v_record.invoice_number,
        'paidAmount', v_record.paid_amount,
        'balanceAmount', v_record.balance_amount,
        'student', jsonb_build_object(
            'studentId', v_record.student_id,
            'name', v_record.student_name,
            'email', v_record.student_email,
            'phone', v_record.student_phone,
            'enrollmentNumber', v_record.enrollment_number,
            'academicStanding', v_record.academic_standing,
            'matriculationYear', v_record.matriculation_year,
            'guardianName', v_guardian.name,
            'guardianPhone', v_guardian.phone,
            'guardianEmail', v_guardian.email
        ),
        'academy', jsonb_build_object(
            'tenantId', v_record.tenant_id,
            'name', v_record.academy_name,
            'slug', v_record.academy_slug,
            'location', v_record.academy_location,
            'email', v_record.academy_email,
            'phone', v_record.academy_phone
        ),
        'course', jsonb_build_object(
            'courseId', v_record.course_id,
            'title', v_record.course_title,
            'category', v_record.course_category,
            'tuitionAmount', v_record.tuition_amount,
            'billingPeriod', v_record.billing_period
        ),
        'batch', jsonb_build_object(
            'batchId', v_record.batch_id,
            'name', v_record.batch_name,
            'startDate', v_record.batch_start_date,
            'endDate', v_record.batch_end_date,
            'capacity', v_record.batch_capacity,
            'branchName', v_record.branch_name
        ),
        'history', v_history
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
        SELECT rp.registration_id::text AS id, rp.payment_id, rp.order_id, rp.amount, rp.payment_status AS status, rp.payment_method, 
               COALESCE(rp.transaction_date, rp.created_at) AS transaction_date, 
               COALESCE(o.name, rp.registration_payload->>'academyName', 'ClassSphere Platform') AS academy_name
        FROM platform.registration_payments rp
        LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
        UNION ALL
        SELECT bp.payment_id::text AS id, bp.gateway_payment_id AS payment_id, bp.gateway_order_id AS order_id, bp.amount, bp.status, bp.payment_method, 
               bp.created_at AS transaction_date, 
               COALESCE(o.name, 'ClassSphere Platform') AS academy_name
        FROM billing.payments bp
        LEFT JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
    ) p
    WHERE (p_query IS NULL OR p.payment_id ILIKE '%' || p_query || '%' OR p.order_id ILIKE '%' || p_query || '%' OR p.academy_name ILIKE '%' || p_query || '%')
      AND (p_status IS NULL OR p.status = p_status);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_payments
    FROM (
        SELECT p.id AS transaction_id, 
               p.payment_id, 
               p.order_id, 
               p.amount AS gross_amount,
               p.status, 
               p.payment_method, 
               p.transaction_date, 
               p.academy_name,
               p.transaction_type,
               p.plan_name,
               p.receipt_number,
               p.customer_name,
               p.customer_email,
               p.error_message,
               ROUND(p.amount * 0.10, 2) AS platform_commission,
               ROUND(p.amount * 0.10 * 0.18, 2) AS tax_on_commission,
               ROUND(p.amount * 0.02, 2) AS gateway_charges,
               ROUND(p.amount - (p.amount * 0.10) - (p.amount * 0.02), 2) AS academy_share
        FROM (
            SELECT 
                rp.registration_id::text AS id, 
                rp.payment_id, 
                rp.order_id, 
                rp.amount, 
                rp.payment_status AS status, 
                rp.payment_method, 
                COALESCE(rp.transaction_date, rp.created_at) AS transaction_date, 
                COALESCE(o.name, rp.registration_payload->>'academyName', 'ClassSphere Platform') AS academy_name,
                'Academy Subscription' AS transaction_type,
                rp.plan_name,
                NULL::text AS receipt_number,
                TRIM(COALESCE(rp.registration_payload->>'firstName', '') || ' ' || COALESCE(rp.registration_payload->>'lastName', '')) AS customer_name,
                rp.registration_payload->>'email' AS customer_email,
                rp.error_message
            FROM platform.registration_payments rp
            LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
            UNION ALL
            SELECT 
                bp.payment_id::text AS id, 
                bp.gateway_payment_id AS payment_id, 
                bp.gateway_order_id AS order_id, 
                bp.amount, 
                bp.status, 
                bp.payment_method, 
                bp.created_at AS transaction_date, 
                COALESCE(o.name, 'ClassSphere Platform') AS academy_name,
                'Course Fee Collection' AS transaction_type,
                NULL::text AS plan_name,
                bp.receipt_number,
                NULL::text AS customer_name,
                NULL::text AS customer_email,
                NULL::text AS error_message
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
    v_counts JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM platform.refunds rf
    WHERE (p_status IS NULL OR rf.status = p_status);

    SELECT jsonb_build_object(
        'all', COUNT(*),
        'requested', COUNT(*) FILTER (WHERE status = 'requested'),
        'under_review', COUNT(*) FILTER (WHERE status = 'under_review'),
        'refunded', COUNT(*) FILTER (WHERE status = 'refunded'),
        'rejected', COUNT(*) FILTER (WHERE status = 'rejected')
    ) INTO v_counts
    FROM platform.refunds;

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
        'counts', v_counts,
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
    v_counts JSONB;
    v_payouts JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM platform.payouts py
    WHERE (p_status IS NULL OR py.status = p_status);

    SELECT jsonb_build_object(
        'all', COUNT(*),
        'pending', COUNT(*) FILTER (WHERE py.status = 'pending'),
        'upcoming', COUNT(*) FILTER (WHERE py.status = 'upcoming'),
        'completed', COUNT(*) FILTER (WHERE py.status IN ('completed', 'released')),
        'held', COUNT(*) FILTER (WHERE py.status = 'held')
    ) INTO v_counts
    FROM platform.payouts py;

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
        'counts', v_counts,
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, public
AS $$
DECLARE
    v_res JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'templateId', t.template_id,
            'channel', t.channel,
            'title', t.title,
            'subject', t.subject,
            'content', t.content,
            'isActive', t.is_active,
            'isSystem', t.is_system,
            'updatedAt', t.updated_at
        ) ORDER BY t.title ASC
    ) INTO v_res
    FROM platform.notification_templates t;

    RETURN COALESCE(v_res, '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_notification_template_update(
    p_template_id VARCHAR(100),
    p_subject VARCHAR(255),
    p_content TEXT,
    p_channel VARCHAR(30) DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT TRUE,
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
        channel = COALESCE(p_channel, channel),
        is_active = COALESCE(p_is_active, is_active),
        updated_at = clock_timestamp()
    WHERE template_id = p_template_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Notification template % not found', p_template_id USING ERRCODE = '22023';
    END IF;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'notification_template.updated', 'template', p_template_id, gen_random_uuid()::text,
            jsonb_build_object('templateId', p_template_id, 'channel', p_channel, 'isActive', p_is_active));

    RETURN jsonb_build_object('success', true, 'templateId', p_template_id);
END;
$$;

-- Delivery History List
CREATE OR REPLACE FUNCTION platform.fn_notification_deliveries_list(
    p_status TEXT DEFAULT NULL,
    p_channel TEXT DEFAULT NULL,
    p_search TEXT DEFAULT NULL,
    p_from_date TIMESTAMPTZ DEFAULT NULL,
    p_to_date TIMESTAMPTZ DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = integration, public
AS $$
DECLARE
    v_total INT;
    v_counts JSONB;
    v_records JSONB;
BEGIN
    SELECT jsonb_build_object(
        'all', COUNT(*),
        'delivered', COUNT(*) FILTER (WHERE m.processed_at IS NOT NULL),
        'failed', COUNT(*) FILTER (WHERE m.error_message IS NOT NULL),
        'pending', COUNT(*) FILTER (WHERE m.processed_at IS NULL AND m.error_message IS NULL)
    ) INTO v_counts
    FROM integration.outbox_messages m;

    SELECT COUNT(*) INTO v_total
    FROM integration.outbox_messages m
    WHERE (p_status IS NULL OR p_status = '' OR (
            CASE 
                WHEN p_status = 'delivered' THEN m.processed_at IS NOT NULL
                WHEN p_status = 'failed' THEN m.error_message IS NOT NULL
                WHEN p_status = 'pending' THEN m.processed_at IS NULL AND m.error_message IS NULL
                ELSE TRUE 
            END
          ))
      AND (p_channel IS NULL OR p_channel = '' OR lower(COALESCE(m.payload->>'channel', 'email')) = lower(p_channel))
      AND (p_search IS NULL OR p_search = '' OR (
            m.message_id::text ILIKE '%' || p_search || '%'
            OR m.event_type ILIKE '%' || p_search || '%'
            OR COALESCE(m.payload->>'recipientName', '') ILIKE '%' || p_search || '%'
            OR COALESCE(m.payload->>'recipientEmail', '') ILIKE '%' || p_search || '%'
            OR COALESCE(m.payload->>'subject', '') ILIKE '%' || p_search || '%'
          ))
      AND (p_from_date IS NULL OR m.created_at >= p_from_date)
      AND (p_to_date IS NULL OR m.created_at <= p_to_date);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_records
    FROM (
        SELECT 
            m.message_id AS "notificationId",
            COALESCE(m.payload->>'recipientName', m.payload->>'studentName', m.payload->>'name', 'System Contact') AS "recipientName",
            COALESCE(m.payload->>'recipientEmail', m.payload->>'email', '—') AS "recipientEmail",
            COALESCE(m.payload->>'recipientPhone', m.payload->>'phone', '—') AS "recipientPhone",
            replace(replace(m.event_type, 'notification.', ''), '_', ' ') AS "notificationEvent",
            m.event_type AS "rawEventType",
            lower(COALESCE(m.payload->>'channel', 'email')) AS "channel",
            COALESCE(m.payload->>'subject', 'Notification') AS "subject",
            COALESCE(m.payload->>'body', m.payload->>'content', '') AS "body",
            m.created_at AS "sentDate",
            m.processed_at AS "deliveredDate",
            m.retry_count AS "attemptCount",
            m.error_message AS "failureReason",
            CASE 
                WHEN m.processed_at IS NOT NULL THEN 'delivered'
                WHEN m.error_message IS NOT NULL THEN 'failed'
                ELSE 'pending'
            END AS "status",
            m.payload AS "payload"
        FROM integration.outbox_messages m
        WHERE (p_status IS NULL OR p_status = '' OR (
                CASE 
                    WHEN p_status = 'delivered' THEN m.processed_at IS NOT NULL
                    WHEN p_status = 'failed' THEN m.error_message IS NOT NULL
                    WHEN p_status = 'pending' THEN m.processed_at IS NULL AND m.error_message IS NULL
                    ELSE TRUE 
                END
              ))
          AND (p_channel IS NULL OR p_channel = '' OR lower(COALESCE(m.payload->>'channel', 'email')) = lower(p_channel))
          AND (p_search IS NULL OR p_search = '' OR (
                m.message_id::text ILIKE '%' || p_search || '%'
                OR m.event_type ILIKE '%' || p_search || '%'
                OR COALESCE(m.payload->>'recipientName', '') ILIKE '%' || p_search || '%'
                OR COALESCE(m.payload->>'recipientEmail', '') ILIKE '%' || p_search || '%'
                OR COALESCE(m.payload->>'subject', '') ILIKE '%' || p_search || '%'
              ))
          AND (p_from_date IS NULL OR m.created_at >= p_from_date)
          AND (p_to_date IS NULL OR m.created_at <= p_to_date)
        ORDER BY m.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'counts', v_counts,
        'records', v_records
    );
END;
$$;

-- Failed Notifications List
CREATE OR REPLACE FUNCTION platform.fn_failed_notifications_list(
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = integration, public
AS $$
DECLARE
    v_total INT;
    v_records JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM integration.outbox_messages m
    WHERE m.error_message IS NOT NULL OR (m.retry_count > 0 AND m.processed_at IS NULL);

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_records
    FROM (
        SELECT 
            m.message_id AS "notificationId",
            COALESCE(m.payload->>'recipientName', m.payload->>'studentName', m.payload->>'name', 'System Contact') AS "recipientName",
            COALESCE(m.payload->>'recipientEmail', m.payload->>'email', '—') AS "recipientEmail",
            COALESCE(m.payload->>'recipientPhone', m.payload->>'phone', '—') AS "recipientPhone",
            replace(replace(m.event_type, 'notification.', ''), '_', ' ') AS "notificationType",
            m.event_type AS "rawEventType",
            lower(COALESCE(m.payload->>'channel', 'email')) AS "channel",
            COALESCE(m.payload->>'subject', 'Notification') AS "subject",
            COALESCE(m.payload->>'body', m.payload->>'content', '') AS "body",
            m.created_at AS "sentDate",
            m.retry_count AS "attemptCount",
            COALESCE(m.error_message, 'Delivery timeout (exceeded retry threshold)') AS "failureReason",
            'failed' AS "status",
            m.created_at AS "lastAttemptDate"
        FROM integration.outbox_messages m
        WHERE m.error_message IS NOT NULL OR (m.retry_count > 0 AND m.processed_at IS NULL)
        ORDER BY m.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'records', v_records
    );
END;
$$;

-- Retry Failed Notification
CREATE OR REPLACE FUNCTION platform.fn_notification_retry(
    p_message_id UUID,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integration, audit, public
AS $$
DECLARE
    v_msg RECORD;
BEGIN
    SELECT * INTO v_msg FROM integration.outbox_messages
    WHERE message_id = p_message_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Notification message % not found', p_message_id USING ERRCODE = '22023';
    END IF;

    IF v_msg.processed_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'alreadyDelivered', true,
            'message', 'Notification has already been delivered successfully.'
        );
    END IF;

    UPDATE integration.outbox_messages
    SET retry_count = retry_count + 1,
        processed_at = clock_timestamp(),
        error_message = NULL
    WHERE message_id = p_message_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (
        v_msg.tenant_id,
        p_actor_id,
        'notification.retried',
        'notification',
        p_message_id::text,
        v_msg.correlation_id,
        jsonb_build_object('messageId', p_message_id, 'attempt', v_msg.retry_count + 1, 'event', v_msg.event_type)
    );

    RETURN jsonb_build_object(
        'success', true,
        'messageId', p_message_id,
        'status', 'delivered',
        'attemptCount', v_msg.retry_count + 1
    );
END;
$$;

-- Announcements List
CREATE OR REPLACE FUNCTION platform.fn_announcements_list(
    p_status TEXT DEFAULT NULL,
    p_target TEXT DEFAULT NULL,
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
    v_records JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM platform.announcements a
    WHERE (p_status IS NULL OR p_status = '' OR lower(a.status) = lower(p_status))
      AND (p_target IS NULL OR p_target = '' OR lower(a.target_audience) = lower(p_target));

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_records
    FROM (
        SELECT 
            a.announcement_id AS "announcementId",
            a.title,
            a.message,
            a.target_audience AS "targetAudience",
            a.start_date AS "startDate",
            a.expiry_date AS "expiryDate",
            CASE 
                WHEN a.status = 'deactivated' THEN 'deactivated'
                WHEN a.status = 'draft' THEN 'draft'
                WHEN a.expiry_date IS NOT NULL AND a.expiry_date < clock_timestamp() THEN 'expired'
                WHEN a.start_date > clock_timestamp() THEN 'scheduled'
                ELSE 'published'
            END AS "status",
            a.created_at AS "createdAt",
            a.updated_at AS "updatedAt"
        FROM platform.announcements a
        WHERE (p_status IS NULL OR p_status = '' OR lower(a.status) = lower(p_status))
          AND (p_target IS NULL OR p_target = '' OR lower(a.target_audience) = lower(p_target))
        ORDER BY a.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'announcements', v_records
    );
END;
$$;

-- Announcement Upsert
CREATE OR REPLACE FUNCTION platform.fn_announcement_upsert(
    p_announcement_id UUID,
    p_title TEXT,
    p_message TEXT,
    p_target_audience TEXT,
    p_start_date TIMESTAMPTZ,
    p_expiry_date TIMESTAMPTZ DEFAULT NULL,
    p_status TEXT DEFAULT 'published',
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_announcement_id IS NOT NULL THEN
        UPDATE platform.announcements
        SET title = p_title,
            message = p_message,
            target_audience = p_target_audience,
            start_date = COALESCE(p_start_date, start_date),
            expiry_date = p_expiry_date,
            status = COALESCE(p_status, status),
            updated_at = clock_timestamp()
        WHERE announcement_id = p_announcement_id
        RETURNING announcement_id INTO v_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Announcement % not found', p_announcement_id USING ERRCODE = '22023';
        END IF;

        INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
        VALUES (p_actor_id, 'announcement.updated', 'announcement', v_id::text, gen_random_uuid()::text,
                jsonb_build_object('title', p_title, 'target', p_target_audience, 'status', p_status));
    ELSE
        INSERT INTO platform.announcements (title, message, target_audience, start_date, expiry_date, status, created_by)
        VALUES (p_title, p_message, p_target_audience, COALESCE(p_start_date, clock_timestamp()), p_expiry_date, COALESCE(p_status, 'published'), p_actor_id)
        RETURNING announcement_id INTO v_id;

        INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
        VALUES (p_actor_id, 'announcement.created', 'announcement', v_id::text, gen_random_uuid()::text,
                jsonb_build_object('title', p_title, 'target', p_target_audience, 'status', p_status));
    END IF;

    RETURN jsonb_build_object('success', true, 'announcementId', v_id);
END;
$$;

-- Announcement Actions
CREATE OR REPLACE FUNCTION platform.fn_announcement_action(
    p_announcement_id UUID,
    p_action TEXT,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, audit, public
AS $$
BEGIN
    IF p_action = 'delete' THEN
        DELETE FROM platform.announcements WHERE announcement_id = p_announcement_id;
    ELSIF p_action = 'publish' THEN
        UPDATE platform.announcements SET status = 'published', updated_at = clock_timestamp() WHERE announcement_id = p_announcement_id;
    ELSIF p_action = 'schedule' THEN
        UPDATE platform.announcements SET status = 'scheduled', updated_at = clock_timestamp() WHERE announcement_id = p_announcement_id;
    ELSIF p_action = 'deactivate' THEN
        UPDATE platform.announcements SET status = 'deactivated', updated_at = clock_timestamp() WHERE announcement_id = p_announcement_id;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Announcement % not found', p_announcement_id USING ERRCODE = '22023';
    END IF;

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'announcement.' || p_action, 'announcement', p_announcement_id::text, gen_random_uuid()::text,
            jsonb_build_object('announcementId', p_announcement_id, 'action', p_action));

    RETURN jsonb_build_object('success', true, 'announcementId', p_announcement_id, 'action', p_action);
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
