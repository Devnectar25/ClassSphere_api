CREATE OR REPLACE FUNCTION platform.fn_platform_reports(
    p_timeframe TEXT DEFAULT 'month',
    p_start_date TIMESTAMPTZ DEFAULT NULL,
    p_end_date TIMESTAMPTZ DEFAULT NULL,
    p_tenant_id UUID DEFAULT NULL,
    p_course_id UUID DEFAULT NULL,
    p_registration_status TEXT DEFAULT NULL,
    p_payment_status TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = platform, tenant, academics, billing, identity_app, audit, public
AS $func$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_end_time TIMESTAMPTZ;
    v_admin_role TEXT := 'SuperAdmin';
    v_allowed_reports JSONB;
    v_filter_academies JSONB;
    v_filter_courses JSONB;
    
    -- Academy stats
    v_acad_total INT;
    v_acad_verified INT;
    v_acad_pending INT;
    v_acad_rejected INT;
    v_acad_suspended INT;
    v_acad_records JSONB;
    v_acad_growth_trends JSONB;

    -- Registration stats
    v_reg_total INT;
    v_reg_pending INT;
    v_reg_approved INT;
    v_reg_confirmed INT;
    v_reg_waitlisted INT;
    v_reg_rejected INT;
    v_reg_expired INT;
    v_reg_cancelled INT;
    v_reg_completed INT;
    v_reg_conversion_rate NUMERIC(5,2);
    v_reg_records JSONB;
    v_reg_trends JSONB;

    -- Payment stats
    v_pay_total INT;
    v_pay_successful INT;
    v_pay_pending INT;
    v_pay_failed INT;
    v_pay_gross_volume NUMERIC(12,2);
    v_pay_refunded_amount NUMERIC(12,2);
    v_pay_records JSONB;
    v_pay_trends JSONB;

    -- Revenue & Commission
    v_rev_gross NUMERIC(12,2);
    v_rev_commission NUMERIC(12,2);
    v_rev_gst NUMERIC(12,2);
    v_rev_gateway NUMERIC(12,2);
    v_rev_academy_share NUMERIC(12,2);
    v_rev_records JSONB;
    v_rev_trends JSONB;

    -- Tax stats
    v_tax_records JSONB;
BEGIN
    -- 1. Determine Admin Role & Allowed Report Permissions
    IF p_actor_id IS NOT NULL THEN
        SELECT role INTO v_admin_role FROM platform.admin_users WHERE user_id = p_actor_id LIMIT 1;
        IF v_admin_role IS NULL THEN
            v_admin_role := 'SuperAdmin';
        END IF;
    END IF;

    IF v_admin_role = 'FinanceAdmin' THEN
        v_allowed_reports := '["payments", "revenue", "tax", "payouts"]'::jsonb;
    ELSIF v_admin_role = 'SupportAdmin' THEN
        v_allowed_reports := '["academies", "registrations", "activity"]'::jsonb;
    ELSE
        v_allowed_reports := '["all", "academies", "registrations", "payments", "revenue", "tax", "payouts"]'::jsonb;
    END IF;

    -- 2. Determine Date Window
    IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
        v_start_time := p_start_date;
        v_end_time := p_end_date;
    ELSE
        v_end_time := clock_timestamp();
        v_start_time := CASE LOWER(COALESCE(p_timeframe, 'month'))
            WHEN 'today' THEN date_trunc('day', clock_timestamp())
            WHEN 'week'  THEN (clock_timestamp() - INTERVAL '7 days')
            WHEN 'year'  THEN (clock_timestamp() - INTERVAL '365 days')
            ELSE (clock_timestamp() - INTERVAL '30 days')
        END;
    END IF;

    -- 3. Filter Options (Academies & Courses)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.tenant_id, 'name', o.name) ORDER BY o.name), '[]'::jsonb)
    INTO v_filter_academies
    FROM tenant.organizations o;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.course_id, 'title', c.title, 'tenantId', c.tenant_id) ORDER BY c.title), '[]'::jsonb)
    INTO v_filter_courses
    FROM academics.courses c
    WHERE (p_tenant_id IS NULL OR c.tenant_id = p_tenant_id);

    -- 4. Academy Reports
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE verification_status = 'verified' AND status = 'active'),
        COUNT(*) FILTER (WHERE verification_status = 'pending'),
        COUNT(*) FILTER (WHERE verification_status = 'rejected'),
        COUNT(*) FILTER (WHERE status = 'suspended')
    INTO v_acad_total, v_acad_verified, v_acad_pending, v_acad_rejected, v_acad_suspended
    FROM tenant.organizations o
    WHERE (p_tenant_id IS NULL OR o.tenant_id = p_tenant_id);

    SELECT COALESCE(jsonb_agg(to_jsonb(ar)), '[]'::jsonb)
    INTO v_acad_records
    FROM (
        SELECT 
            o.tenant_id,
            o.name AS academy_name,
            COALESCE(o.academy_type, 'General') AS academy_type,
            o.status,
            o.verification_status,
            o.created_at,
            (SELECT COUNT(*) FROM academics.courses c WHERE c.tenant_id = o.tenant_id) AS total_courses,
            (SELECT COUNT(*) FROM academics.students s WHERE s.tenant_id = o.tenant_id) AS total_students,
            (SELECT u.email FROM tenant.memberships m JOIN identity_app.users u ON u.user_id = m.user_id WHERE m.tenant_id = o.tenant_id AND m.role = 'TenantAdmin' LIMIT 1) AS contact_email
        FROM tenant.organizations o
        WHERE (p_tenant_id IS NULL OR o.tenant_id = p_tenant_id)
        ORDER BY o.created_at DESC
        LIMIT 50
    ) ar;

    -- Academy Growth Trends (Cumulative & Monthly)
    SELECT COALESCE(jsonb_agg(to_jsonb(agt)), '[]'::jsonb)
    INTO v_acad_growth_trends
    FROM (
        SELECT 
            to_char(date_trunc('month', o.created_at), 'Mon YYYY') AS label,
            date_trunc('month', o.created_at) AS date,
            COUNT(*) AS new_count,
            COUNT(*) FILTER (WHERE o.verification_status = 'verified') AS verified_count
        FROM tenant.organizations o
        GROUP BY date_trunc('month', o.created_at)
        ORDER BY date ASC
    ) agt;

    -- 5. Registration Reports
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE e.status = 'pending'),
        COUNT(*) FILTER (WHERE e.status = 'approved'),
        COUNT(*) FILTER (WHERE e.status IN ('confirmed', 'enrolled')),
        COUNT(*) FILTER (WHERE e.status = 'waitlisted'),
        COUNT(*) FILTER (WHERE e.status = 'rejected'),
        COUNT(*) FILTER (WHERE e.status = 'expired'),
        COUNT(*) FILTER (WHERE e.status = 'cancelled'),
        COUNT(*) FILTER (WHERE e.status = 'completed')
    INTO v_reg_total, v_reg_pending, v_reg_approved, v_reg_confirmed, v_reg_waitlisted, v_reg_rejected, v_reg_expired, v_reg_cancelled, v_reg_completed
    FROM academics.enrollments e
    JOIN academics.batches b ON b.batch_id = e.batch_id
    WHERE (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
      AND (p_course_id IS NULL OR b.course_id = p_course_id)
      AND (p_registration_status IS NULL OR p_registration_status = '' OR p_registration_status = 'all' OR e.status = p_registration_status OR (p_registration_status = 'confirmed' AND e.status = 'enrolled'))
      AND (e.enrolled_at >= v_start_time AND e.enrolled_at <= v_end_time);

    IF v_reg_total > 0 THEN
        v_reg_conversion_rate := ROUND(((v_reg_confirmed + v_reg_completed)::NUMERIC / v_reg_total::NUMERIC) * 100.0, 1);
    ELSE
        v_reg_conversion_rate := 0.0;
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(rr)), '[]'::jsonb)
    INTO v_reg_records
    FROM (
        SELECT 
            e.enrollment_id AS registration_id,
            'REG-' || upper(substr(e.enrollment_id::text, 1, 8)) AS registration_code,
            s.first_name || ' ' || s.last_name AS learner_name,
            s.email AS learner_email,
            s.phone AS learner_phone,
            c.title AS course_name,
            o.name AS academy_name,
            e.status,
            e.enrolled_at,
            COALESCE(c.tuition_amount, 0) AS amount
        FROM academics.enrollments e
        JOIN academics.students s ON s.student_id = e.student_id
        JOIN academics.batches b ON b.batch_id = e.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
        WHERE (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
          AND (p_course_id IS NULL OR b.course_id = p_course_id)
          AND (p_registration_status IS NULL OR p_registration_status = '' OR p_registration_status = 'all' OR e.status = p_registration_status OR (p_registration_status = 'confirmed' AND e.status = 'enrolled'))
          AND (e.enrolled_at >= v_start_time AND e.enrolled_at <= v_end_time)
        ORDER BY e.enrolled_at DESC
        LIMIT 50
    ) rr;

    -- Registration Trends (daily/weekly interval)
    SELECT COALESCE(jsonb_agg(to_jsonb(rt)), '[]'::jsonb)
    INTO v_reg_trends
    FROM (
        SELECT 
            to_char(date_trunc('day', e.enrolled_at), 'DD Mon') AS label,
            date_trunc('day', e.enrolled_at) AS date,
            COUNT(*) AS count,
            COUNT(*) FILTER (WHERE e.status IN ('confirmed', 'enrolled', 'completed')) AS confirmed_count
        FROM academics.enrollments e
        JOIN academics.batches b ON b.batch_id = e.batch_id
        WHERE (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
          AND (p_course_id IS NULL OR b.course_id = p_course_id)
          AND (e.enrolled_at >= v_start_time AND e.enrolled_at <= v_end_time)
        GROUP BY date_trunc('day', e.enrolled_at)
        ORDER BY date ASC
    ) rt;

    -- 6. Payment Reports (Combined Registration Payments & Billing Payments)
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE p.status IN ('success', 'posted', 'reconciled')),
        COUNT(*) FILTER (WHERE p.status = 'pending'),
        COUNT(*) FILTER (WHERE p.status IN ('failed', 'cancelled')),
        COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('success', 'posted', 'reconciled')), 0)
    INTO v_pay_total, v_pay_successful, v_pay_pending, v_pay_failed, v_pay_gross_volume
    FROM (
        SELECT rp.registration_id::text AS id, rp.payment_id, rp.tenant_id, rp.amount, rp.payment_status AS status, 
               COALESCE(rp.transaction_date, rp.created_at) AS created_at
        FROM platform.registration_payments rp
        UNION ALL
        SELECT bp.payment_id::text AS id, bp.gateway_payment_id AS payment_id, bp.tenant_id, bp.amount, bp.status,
               bp.created_at
        FROM billing.payments bp
    ) p
    WHERE (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
      AND (p_payment_status IS NULL OR p_payment_status = '' OR p_payment_status = 'all' OR p.status = p_payment_status)
      AND (p.created_at >= v_start_time AND p.created_at <= v_end_time);

    -- Total Refunded Amount
    SELECT COALESCE(SUM(rf.amount), 0)
    INTO v_pay_refunded_amount
    FROM platform.refunds rf
    WHERE (p_tenant_id IS NULL OR rf.tenant_id = p_tenant_id)
      AND rf.status = 'refunded'
      AND (rf.created_at >= v_start_time AND rf.created_at <= v_end_time);

    -- Payment Records
    SELECT COALESCE(jsonb_agg(to_jsonb(pr)), '[]'::jsonb)
    INTO v_pay_records
    FROM (
        SELECT 
            p.id AS transaction_id,
            p.payment_id,
            p.order_id,
            p.amount,
            p.status,
            p.payment_method,
            p.created_at,
            p.academy_name,
            p.description
        FROM (
            SELECT 
                rp.registration_id::text AS id,
                COALESCE(rp.payment_id, 'PAY-DIR-REG') AS payment_id,
                COALESCE(rp.order_id, 'ORD-DIRECT') AS order_id,
                rp.amount,
                rp.payment_status AS status,
                rp.payment_method,
                COALESCE(rp.transaction_date, rp.created_at) AS created_at,
                COALESCE(o.name, rp.registration_payload->>'academyName', 'ClassSphere Direct') AS academy_name,
                COALESCE(rp.plan_name, 'Registration Fee') AS description,
                rp.tenant_id
            FROM platform.registration_payments rp
            LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
            UNION ALL
            SELECT 
                bp.payment_id::text AS id,
                COALESCE(bp.gateway_payment_id, 'PAY-INV-' || substr(bp.payment_id::text, 1, 6)) AS payment_id,
                COALESCE(bp.gateway_order_id, 'ORD-INV-' || substr(bp.payment_id::text, 1, 6)) AS order_id,
                bp.amount,
                bp.status,
                bp.payment_method,
                bp.created_at,
                COALESCE(o.name, 'ClassSphere Academy') AS academy_name,
                'Course Fee Invoice' AS description,
                bp.tenant_id
            FROM billing.payments bp
            LEFT JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
        ) p
        WHERE (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
          AND (p_payment_status IS NULL OR p_payment_status = '' OR p_payment_status = 'all' OR p.status = p_payment_status)
          AND (p.created_at >= v_start_time AND p.created_at <= v_end_time)
        ORDER BY p.created_at DESC
        LIMIT 50
    ) pr;

    -- Payment Trends (volume & count by day)
    SELECT COALESCE(jsonb_agg(to_jsonb(pt)), '[]'::jsonb)
    INTO v_pay_trends
    FROM (
        SELECT 
            to_char(date_trunc('day', p.created_at), 'DD Mon') AS label,
            date_trunc('day', p.created_at) AS date,
            COUNT(*) AS count,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('success', 'posted', 'reconciled')), 0) AS volume
        FROM (
            SELECT rp.amount, rp.payment_status AS status, COALESCE(rp.transaction_date, rp.created_at) AS created_at, rp.tenant_id
            FROM platform.registration_payments rp
            UNION ALL
            SELECT bp.amount, bp.status, bp.created_at, bp.tenant_id
            FROM billing.payments bp
        ) p
        WHERE (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
          AND (p.created_at >= v_start_time AND p.created_at <= v_end_time)
        GROUP BY date_trunc('day', p.created_at)
        ORDER BY date ASC
    ) pt;

    -- 7. Revenue & Commission Calculations (10% platform, 18% GST, 2% Gateway, Net 88% Academy)
    v_rev_gross := v_pay_gross_volume;
    v_rev_commission := ROUND(v_rev_gross * 0.10, 2);
    v_rev_gst := ROUND(v_rev_commission * 0.18, 2);
    v_rev_gateway := ROUND(v_rev_gross * 0.02, 2);
    v_rev_academy_share := ROUND(v_rev_gross - v_rev_commission - v_rev_gst - v_rev_gateway, 2);

    -- Revenue records grouped by Academy
    SELECT COALESCE(jsonb_agg(to_jsonb(rv)), '[]'::jsonb)
    INTO v_rev_records
    FROM (
        SELECT 
            COALESCE(p.academy_name, 'Platform Direct') AS academy_name,
            COUNT(*) AS transaction_count,
            SUM(p.amount) AS gross_sales,
            ROUND(SUM(p.amount) * 0.10, 2) AS platform_commission,
            ROUND(SUM(p.amount) * 0.10 * 0.18, 2) AS gst_tax,
            ROUND(SUM(p.amount) * 0.02, 2) AS gateway_charges,
            ROUND(SUM(p.amount) - (SUM(p.amount) * 0.10) - (SUM(p.amount) * 0.10 * 0.18) - (SUM(p.amount) * 0.02), 2) AS academy_share
        FROM (
            SELECT rp.amount, COALESCE(o.name, rp.registration_payload->>'academyName', 'ClassSphere Direct') AS academy_name,
                   COALESCE(rp.transaction_date, rp.created_at) AS created_at, rp.tenant_id
            FROM platform.registration_payments rp
            LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
            WHERE rp.payment_status = 'success'
            UNION ALL
            SELECT bp.amount, COALESCE(o.name, 'ClassSphere Academy') AS academy_name,
                   bp.created_at, bp.tenant_id
            FROM billing.payments bp
            LEFT JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
            WHERE bp.status IN ('posted', 'reconciled')
        ) p
        WHERE (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
          AND (p.created_at >= v_start_time AND p.created_at <= v_end_time)
        GROUP BY p.academy_name
        ORDER BY gross_sales DESC
    ) rv;

    -- Revenue Trends (gross vs commission vs academy share)
    SELECT COALESCE(jsonb_agg(to_jsonb(rtrend)), '[]'::jsonb)
    INTO v_rev_trends
    FROM (
        SELECT 
            to_char(date_trunc('day', p.created_at), 'DD Mon') AS label,
            date_trunc('day', p.created_at) AS date,
            SUM(p.amount) AS gross,
            ROUND(SUM(p.amount) * 0.10, 2) AS commission,
            ROUND(SUM(p.amount) * 0.88, 2) AS academy_share
        FROM (
            SELECT rp.amount, COALESCE(rp.transaction_date, rp.created_at) AS created_at, rp.tenant_id
            FROM platform.registration_payments rp
            WHERE rp.payment_status = 'success'
            UNION ALL
            SELECT bp.amount, bp.created_at, bp.tenant_id
            FROM billing.payments bp
            WHERE bp.status IN ('posted', 'reconciled')
        ) p
        WHERE (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
          AND (p.created_at >= v_start_time AND p.created_at <= v_end_time)
        GROUP BY date_trunc('day', p.created_at)
        ORDER BY date ASC
    ) rtrend;

    -- 8. Tax Reports (GST Invoices & Facilitation Ledger)
    SELECT COALESCE(jsonb_agg(to_jsonb(tr)), '[]'::jsonb)
    INTO v_tax_records
    FROM (
        SELECT 
            p.id AS reference_id,
            'TX-GST-' || upper(substr(md5(p.id::text), 1, 8)) AS tax_invoice_no,
            p.academy_name,
            p.amount AS gross_transaction_amount,
            ROUND(p.amount * 0.10, 2) AS taxable_commission,
            ROUND(p.amount * 0.10 * 0.09, 2) AS cgst_amount,
            ROUND(p.amount * 0.10 * 0.09, 2) AS sgst_amount,
            ROUND(p.amount * 0.10 * 0.18, 2) AS total_gst_tax,
            '18% Standard GST' AS tax_rate,
            'Collected & Reconciled' AS filing_status,
            p.created_at
        FROM (
            SELECT rp.registration_id::text AS id, rp.amount,
                   COALESCE(o.name, rp.registration_payload->>'academyName', 'ClassSphere Platform') AS academy_name,
                   COALESCE(rp.transaction_date, rp.created_at) AS created_at, rp.tenant_id
            FROM platform.registration_payments rp
            LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
            WHERE rp.payment_status = 'success'
            UNION ALL
            SELECT bp.payment_id::text AS id, bp.amount,
                   COALESCE(o.name, 'ClassSphere Platform') AS academy_name,
                   bp.created_at, bp.tenant_id
            FROM billing.payments bp
            LEFT JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
            WHERE bp.status IN ('posted', 'reconciled')
        ) p
        WHERE (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
          AND (p.created_at >= v_start_time AND p.created_at <= v_end_time)
        ORDER BY p.created_at DESC
        LIMIT 50
    ) tr;

    -- 9. Return Combined Reports Schema
    RETURN jsonb_build_object(
        'meta', jsonb_build_object(
            'timeframe', p_timeframe,
            'startDate', v_start_time,
            'endDate', v_end_time,
            'adminRole', v_admin_role,
            'allowedReports', v_allowed_reports
        ),
        'filterOptions', jsonb_build_object(
            'academies', v_filter_academies,
            'courses', v_filter_courses
        ),
        'academyReport', jsonb_build_object(
            'total', v_acad_total,
            'verified', v_acad_verified,
            'pending', v_acad_pending,
            'rejected', v_acad_rejected,
            'suspended', v_acad_suspended,
            'records', v_acad_records,
            'growthTrends', v_acad_growth_trends
        ),
        'registrationReport', jsonb_build_object(
            'total', v_reg_total,
            'pending', v_reg_pending,
            'approved', v_reg_approved,
            'confirmed', v_reg_confirmed,
            'waitlisted', v_reg_waitlisted,
            'rejected', v_reg_rejected,
            'expired', v_reg_expired,
            'cancelled', v_reg_cancelled,
            'completed', v_reg_completed,
            'conversionRate', v_reg_conversion_rate,
            'records', v_reg_records,
            'trends', v_reg_trends
        ),
        'paymentReport', jsonb_build_object(
            'totalCount', v_pay_total,
            'successfulCount', v_pay_successful,
            'pendingCount', v_pay_pending,
            'failedCount', v_pay_failed,
            'totalGrossVolume', v_pay_gross_volume,
            'totalRefundedAmount', v_pay_refunded_amount,
            'records', v_pay_records,
            'trends', v_pay_trends
        ),
        'revenueReport', jsonb_build_object(
            'grossSales', v_rev_gross,
            'platformCommission', v_rev_commission,
            'gstTaxOnCommission', v_rev_gst,
            'gatewayCharges', v_rev_gateway,
            'academyShare', v_rev_academy_share,
            'records', v_rev_records,
            'trends', v_rev_trends
        ),
        'taxReport', jsonb_build_object(
            'taxableCommission', v_rev_commission,
            'totalGst', v_rev_gst,
            'cgst', ROUND(v_rev_commission * 0.09, 2),
            'sgst', ROUND(v_rev_commission * 0.09, 2),
            'records', v_tax_records
        )
    );
END;
$func$;
