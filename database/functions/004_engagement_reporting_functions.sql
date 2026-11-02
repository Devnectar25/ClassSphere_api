-- ============================================================================
-- ClassSphere Stored Functions: 004_engagement_reporting_functions.sql
-- Traceability: TDD Section 10.4, 15, 19, 20; PLT-006, PLT-009, PLT-011
-- ============================================================================

CREATE OR REPLACE FUNCTION engagement.fn_notice_publish(
    p_tenant_id UUID,
    p_title VARCHAR(255),
    p_content TEXT,
    p_notice_type VARCHAR(30),
    p_status VARCHAR(20),
    p_priority VARCHAR(20),
    p_target_audience VARCHAR(50),
    p_target_batch_id UUID,
    p_branch_id UUID,
    p_channels TEXT[],
    p_expires_at TIMESTAMPTZ,
    p_author_actor_id UUID,
    p_is_pinned BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = engagement, audit, integration, public
AS $$
DECLARE
    v_notice_id UUID;
    v_status VARCHAR(20) := COALESCE(p_status, 'published');
BEGIN
    INSERT INTO engagement.notices (
        tenant_id, title, content, notice_type, status, priority, target_audience, target_batch_id,
        branch_id, channels, expires_at, author_actor_id, is_pinned
    ) VALUES (
        p_tenant_id, p_title, p_content, COALESCE(p_notice_type, 'notice'), v_status, COALESCE(p_priority, 'normal'),
        COALESCE(p_target_audience, 'all'), p_target_batch_id, p_branch_id,
        COALESCE(p_channels, ARRAY['in-app']), p_expires_at, p_author_actor_id, COALESCE(p_is_pinned, false)
    ) RETURNING notice_id INTO v_notice_id;

    -- Only published notices are dispatched through the transactional outbox
    IF v_status = 'published' THEN
        INSERT INTO integration.outbox_messages (tenant_id, correlation_id, event_type, payload)
        VALUES (
            p_tenant_id,
            gen_random_uuid()::text,
            'engagement.notice_published',
            jsonb_build_object('noticeId', v_notice_id, 'title', p_title, 'target', p_target_audience, 'channels', p_channels)
        );
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_author_actor_id, 'notice.' || v_status, 'notice', v_notice_id::text, gen_random_uuid()::text,
            jsonb_build_object('title', p_title, 'targetAudience', p_target_audience));

    RETURN jsonb_build_object('success', true, 'noticeId', v_notice_id, 'status', v_status);
END;
$$;

DROP FUNCTION IF EXISTS engagement.fn_notice_list(UUID);
DROP FUNCTION IF EXISTS engagement.fn_achievement_list(UUID);
DROP FUNCTION IF EXISTS reporting.fn_fee_aging(UUID);
DROP FUNCTION IF EXISTS reporting.fn_dashboard_summary(UUID);
DROP FUNCTION IF EXISTS reporting.fn_collection_report(UUID);

CREATE OR REPLACE FUNCTION engagement.fn_notice_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = engagement, tenant, identity_app, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.is_pinned DESC, r.published_at DESC), '[]'::jsonb)
    FROM (
        SELECT n.notice_id, n.title, n.content, n.notice_type, n.status, n.priority, n.target_audience,
               n.channels, n.is_pinned, n.published_at, n.expires_at,
               COALESCE(b.name, 'All Branches') AS branch_name,
               u.full_name AS author_name
        FROM engagement.notices n
        LEFT JOIN tenant.branches b ON b.branch_id = n.branch_id
        LEFT JOIN identity_app.users u ON u.user_id = n.author_actor_id
        WHERE n.tenant_id = p_tenant_id AND (p_branch_id IS NULL OR n.branch_id IS NULL OR n.branch_id = p_branch_id)
    ) r;
$$;

CREATE OR REPLACE FUNCTION engagement.fn_achievement_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = engagement, academics, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.award_date DESC), '[]'::jsonb)
    FROM (
        SELECT a.achievement_id, a.student_id, s.first_name || ' ' || s.last_name AS student_name,
               a.title, a.category, a.level, a.visibility, a.award_date, a.issuer, a.grade, a.remarks,
               a.photo_file_key IS NOT NULL AS has_photo
        FROM engagement.achievements a
        JOIN academics.students s ON s.student_id = a.student_id
        WHERE a.tenant_id = p_tenant_id AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
    ) r;
$$;

CREATE OR REPLACE FUNCTION reporting.fn_fee_aging(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
DECLARE
    v_summary JSONB;
    v_overdue_list JSONB;
BEGIN
    SELECT jsonb_build_object(
        'current', COALESCE(SUM(balance_amount) FILTER (WHERE age <= 0), 0),
        'days1To30', COALESCE(SUM(balance_amount) FILTER (WHERE age BETWEEN 1 AND 30), 0),
        'days31To60', COALESCE(SUM(balance_amount) FILTER (WHERE age BETWEEN 31 AND 60), 0),
        'days61Plus', COALESCE(SUM(balance_amount) FILTER (WHERE age > 60), 0),
        'totalOutstanding', COALESCE(SUM(balance_amount), 0),
        'counts', jsonb_build_object(
            'current', COUNT(*) FILTER (WHERE age <= 0),
            'days1To30', COUNT(*) FILTER (WHERE age BETWEEN 1 AND 30),
            'days31To60', COUNT(*) FILTER (WHERE age BETWEEN 31 AND 60),
            'days61Plus', COUNT(*) FILTER (WHERE age > 60)
        )
    ) INTO v_summary
    FROM (
        SELECT balance_amount, (CURRENT_DATE - due_date) AS age
        FROM billing.invoices
        WHERE tenant_id = p_tenant_id AND balance_amount > 0 AND status <> 'void' AND (p_branch_id IS NULL OR student_id IN (SELECT st.student_id FROM academics.students st WHERE st.branch_id = p_branch_id))
    ) i;

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_overdue_list
    FROM (
        SELECT i.invoice_id, i.invoice_number, i.billing_period, i.balance_amount, i.due_date,
               (CURRENT_DATE - i.due_date) AS days_overdue,
               s.first_name || ' ' || s.last_name AS student_name,
               s.enrollment_number,
               (SELECT string_agg(b.name, ', ' ORDER BY b.name)
                FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE e.student_id = i.student_id AND e.status = 'enrolled') AS batches
        FROM billing.invoices i
        JOIN academics.students s ON s.student_id = i.student_id
        WHERE i.tenant_id = p_tenant_id AND i.balance_amount > 0 AND i.status <> 'void' AND i.due_date < CURRENT_DATE
          AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
        ORDER BY i.due_date ASC
        LIMIT 20
    ) r;

    RETURN v_summary || jsonb_build_object('overdueInvoices', v_overdue_list);
END;
$$;

CREATE OR REPLACE FUNCTION reporting.fn_audit_search(
    p_tenant_id UUID DEFAULT NULL,
    p_action VARCHAR(100) DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = audit, identity_app, public
AS $$
DECLARE
    v_results JSONB;
    v_total INT;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM audit.compliance_logs l
    WHERE (p_tenant_id IS NULL OR l.tenant_id = p_tenant_id)
      AND (p_action IS NULL OR l.action ILIKE '%' || p_action || '%');

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_results
    FROM (
        SELECT l.log_id, l.tenant_id, l.actor_id, u.full_name AS actor_name, l.action, l.entity_type,
               l.entity_id, l.ip_address, l.correlation_id, l.details, l.created_at
        FROM audit.compliance_logs l
        LEFT JOIN identity_app.users u ON u.user_id = l.actor_id
        WHERE (p_tenant_id IS NULL OR l.tenant_id = p_tenant_id)
          AND (p_action IS NULL OR l.action ILIKE '%' || p_action || '%')
        ORDER BY l.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'logs', v_results
    );
END;
$$;

CREATE OR REPLACE FUNCTION integration.fn_outbox_claim(
    p_batch_size INT DEFAULT 20
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = integration, public
AS $$
    WITH claimed AS (
        SELECT message_id
        FROM integration.outbox_messages
        WHERE processed_at IS NULL AND retry_count < 5
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT p_batch_size
    ), updated AS (
        UPDATE integration.outbox_messages m
        SET retry_count = m.retry_count + 1
        FROM claimed
        WHERE m.message_id = claimed.message_id
        RETURNING m.message_id, m.tenant_id, m.correlation_id, m.event_type, m.payload, m.retry_count, m.created_at
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at), '[]'::jsonb) FROM updated u;
$$;

CREATE OR REPLACE FUNCTION integration.fn_outbox_mark_processed(
    p_message_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integration, public
AS $$
BEGIN
    UPDATE integration.outbox_messages SET processed_at = clock_timestamp(), error_message = NULL
    WHERE message_id = p_message_id AND processed_at IS NULL;

    RETURN jsonb_build_object('success', FOUND);
END;
$$;

CREATE OR REPLACE FUNCTION reporting.fn_platform_metrics()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, platform, academics, billing, audit, integration, public
AS $$
    SELECT jsonb_build_object(
        'totalTenants', (SELECT COUNT(*) FROM tenant.organizations),
        'activeTenants', (SELECT COUNT(*) FROM tenant.organizations WHERE status = 'active'),
        'totalMrr', (SELECT COALESCE(SUM(mrr), 0) FROM platform.subscriptions WHERE status = 'active'),
        'totalStudents', (SELECT COUNT(*) FROM academics.students WHERE status = 'active'),
        'totalRevenue', (SELECT COALESCE(SUM(amount), 0) FROM billing.payments WHERE status IN ('posted', 'reconciled')),
        'totalInvoices', (SELECT COUNT(*) FROM billing.invoices),
        'pendingOutboxMessages', (SELECT COUNT(*) FROM integration.outbox_messages WHERE processed_at IS NULL),
        'auditEvents24h', (SELECT COUNT(*) FROM audit.compliance_logs WHERE created_at > now() - INTERVAL '24 hours')
    );
$$;

-- Tenant overview dashboard: KPIs, trends, capacity, overdue, activity and upcoming events
CREATE OR REPLACE FUNCTION reporting.fn_dashboard_summary(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, engagement, audit, public
AS $$
    WITH months AS (
        SELECT date_trunc('month', CURRENT_DATE) - (n || ' months')::interval AS month_start
        FROM generate_series(5, 0, -1) n
    ), paid AS (
        SELECT amount, payment_method, created_at FROM billing.payments
        WHERE tenant_id = p_tenant_id AND status IN ('posted', 'reconciled') AND (p_branch_id IS NULL OR student_id IN (SELECT st.student_id FROM academics.students st WHERE st.branch_id = p_branch_id))
    ), open_inv AS (
        SELECT * FROM billing.invoices WHERE tenant_id = p_tenant_id AND status <> 'void' AND balance_amount > 0 AND (p_branch_id IS NULL OR student_id IN (SELECT st.student_id FROM academics.students st WHERE st.branch_id = p_branch_id))
    )
    SELECT jsonb_build_object(
        'stats', jsonb_build_object(
            'revenue_this_month', (SELECT COALESCE(SUM(amount), 0) FROM paid WHERE created_at >= date_trunc('month', now())),
            'revenue_last_month', (SELECT COALESCE(SUM(amount), 0) FROM paid
                                   WHERE created_at >= date_trunc('month', now()) - INTERVAL '1 month' AND created_at < date_trunc('month', now())),
            'outstanding_amount', (SELECT COALESCE(SUM(balance_amount), 0) FROM open_inv),
            'outstanding_count', (SELECT COUNT(*) FROM open_inv),
            'overdue_amount', (SELECT COALESCE(SUM(balance_amount), 0) FROM open_inv WHERE due_date < CURRENT_DATE),
            'overdue_count', (SELECT COUNT(*) FROM open_inv WHERE due_date < CURRENT_DATE),
            'active_students', (SELECT COUNT(*) FROM academics.students WHERE tenant_id = p_tenant_id AND status = 'active' AND (p_branch_id IS NULL OR branch_id = p_branch_id)),
            'new_students_this_month', (SELECT COUNT(*) FROM academics.students WHERE tenant_id = p_tenant_id AND created_at >= date_trunc('month', now()) AND (p_branch_id IS NULL OR branch_id = p_branch_id)),
            'classes_today', (SELECT COUNT(*) FROM academics.batch_schedules s JOIN academics.batches b ON b.batch_id = s.batch_id
                              WHERE s.tenant_id = p_tenant_id AND b.status = 'active' AND s.weekday = EXTRACT(ISODOW FROM CURRENT_DATE)
                                AND (p_branch_id IS NULL OR b.branch_id = p_branch_id)),
            'collection_rate', (SELECT CASE WHEN SUM(total_amount) > 0 THEN ROUND(SUM(paid_amount) * 100 / SUM(total_amount)) ELSE 0 END
                                FROM billing.invoices WHERE tenant_id = p_tenant_id AND status <> 'void' AND (p_branch_id IS NULL OR student_id IN (SELECT st.student_id FROM academics.students st WHERE st.branch_id = p_branch_id)))
        ),
        'revenue_trend', (
            SELECT jsonb_agg(jsonb_build_object(
                'month', to_char(m.month_start, 'Mon'),
                'collected', (SELECT COALESCE(SUM(amount), 0) FROM paid WHERE date_trunc('month', created_at) = m.month_start),
                'pending', (SELECT COALESCE(SUM(balance_amount), 0) FROM open_inv WHERE date_trunc('month', due_date) = m.month_start)
            ) ORDER BY m.month_start) FROM months m
        ),
        'payment_modes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('name', payment_method, 'value', total) ORDER BY total DESC)
            FROM (SELECT payment_method, SUM(amount) AS total FROM paid
                  WHERE created_at >= date_trunc('month', now()) GROUP BY payment_method) pm
        ), '[]'::jsonb),
        'batch_capacity', COALESCE((
            SELECT jsonb_agg(to_jsonb(bc) ORDER BY bc.students DESC)
            FROM (
                SELECT b.name, b.capacity,
                       (SELECT COUNT(*) FROM academics.enrollments e WHERE e.batch_id = b.batch_id AND e.status = 'enrolled') AS students
                FROM academics.batches b WHERE b.tenant_id = p_tenant_id AND b.status = 'active' AND (p_branch_id IS NULL OR b.branch_id = p_branch_id)
                ORDER BY students DESC LIMIT 5
            ) bc
        ), '[]'::jsonb),
        'recent_activity', COALESCE((
            SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC)
            FROM (
                SELECT action, entity_type, details, created_at FROM audit.compliance_logs
                WHERE tenant_id = p_tenant_id ORDER BY created_at DESC LIMIT 6
            ) a
        ), '[]'::jsonb),
        'upcoming', COALESCE((
            SELECT jsonb_agg(to_jsonb(ev) ORDER BY ev.starts_at)
            FROM (
                SELECT event_id, title, event_type, starts_at FROM engagement.events
                WHERE tenant_id = p_tenant_id AND starts_at >= now() AND starts_at < now() + INTERVAL '30 days'
                ORDER BY starts_at LIMIT 5
            ) ev
        ), '[]'::jsonb)
    );
$$;

-- Reports & analytics: collections by channel, refunds and enrollment trend for the last 6 months
CREATE OR REPLACE FUNCTION reporting.fn_collection_report(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, academics, public
AS $$
    WITH months AS (
        SELECT date_trunc('month', CURRENT_DATE) - (n || ' months')::interval AS month_start
        FROM generate_series(5, 0, -1) n
    ), pay AS (
        SELECT amount, status, created_at, payment_method NOT IN ('Cash', 'Cheque') AS is_online
        FROM billing.payments WHERE tenant_id = p_tenant_id AND (p_branch_id IS NULL OR student_id IN (SELECT st.student_id FROM academics.students st WHERE st.branch_id = p_branch_id))
    )
    SELECT jsonb_build_object(
        'monthly_collection', (
            SELECT jsonb_agg(jsonb_build_object(
                'month', to_char(m.month_start, 'Mon'),
                'online', (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE is_online AND status IN ('posted', 'reconciled') AND date_trunc('month', created_at) = m.month_start),
                'offline', (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE NOT is_online AND status IN ('posted', 'reconciled') AND date_trunc('month', created_at) = m.month_start),
                'refunds', (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE status = 'refunded' AND date_trunc('month', created_at) = m.month_start)
            ) ORDER BY m.month_start) FROM months m
        ),
        'enrollment_trend', (
            SELECT jsonb_agg(jsonb_build_object(
                'month', to_char(m.month_start, 'Mon'),
                'active', (SELECT COUNT(*) FROM academics.students s WHERE s.tenant_id = p_tenant_id AND s.status = 'active' AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
                           AND s.created_at < m.month_start + INTERVAL '1 month'),
                'inquiry', (SELECT COUNT(*) FROM academics.students s WHERE s.tenant_id = p_tenant_id AND s.status = 'inquiry' AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
                            AND date_trunc('month', s.created_at) = m.month_start)
            ) ORDER BY m.month_start) FROM months m
        ),
        'summary', jsonb_build_object(
            'total_collected', (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE status IN ('posted', 'reconciled')),
            'collected_last_6_months', (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE status IN ('posted', 'reconciled')
                                        AND created_at >= (SELECT MIN(month_start) FROM months)),
            'total_refunds', (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE status = 'refunded'),
            'collection_rate', (SELECT CASE WHEN SUM(total_amount) > 0 THEN ROUND(SUM(paid_amount) * 100 / SUM(total_amount), 1) ELSE 0 END
                                FROM billing.invoices WHERE tenant_id = p_tenant_id AND status <> 'void' AND (p_branch_id IS NULL OR student_id IN (SELECT st.student_id FROM academics.students st WHERE st.branch_id = p_branch_id)))
        )
    );
$$;

-- Parent & student portal household: guardian profile with each linked ward's academic and billing record.
-- Resolves the guardian by id (staff preview) or by the guardian's own user id.
CREATE OR REPLACE FUNCTION reporting.fn_guardian_household(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, billing, engagement, tenant, identity_app, public
AS $$
DECLARE
    v_guardian RECORD;
    v_wards JSONB;
BEGIN
    SELECT g.* INTO v_guardian
    FROM academics.guardians g
    WHERE g.tenant_id = p_tenant_id
      AND ((p_guardian_id IS NOT NULL AND g.guardian_id = p_guardian_id)
        OR (p_guardian_id IS NULL AND p_user_id IS NOT NULL AND g.user_id = p_user_id)
        OR (p_guardian_id IS NULL AND p_user_id IS NULL))
    ORDER BY g.user_id IS NULL, g.last_name, g.first_name -- staff preview defaults to a guardian with portal access
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guardian household not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(jsonb_agg(w ORDER BY w->>'name'), '[]'::jsonb) INTO v_wards
    FROM (
        SELECT jsonb_build_object(
            'id', s.student_id,
            'branch_name', (SELECT name FROM tenant.branches WHERE branch_id = s.branch_id),
            'attendance_history', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'date', a.session_date, 'batch', b.name, 'status', a.status, 'remarks', a.remarks
                ) ORDER BY a.session_date DESC)
                FROM (SELECT * FROM academics.attendance_records ar WHERE ar.student_id = s.student_id
                      ORDER BY ar.session_date DESC LIMIT 30) a
                JOIN academics.batches b ON b.batch_id = a.batch_id
            ), '[]'::jsonb),
            'test_results', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'test', rep->'test', 'subjects', rep->'subjects', 'max_total', rep->'max_total',
                    'summary', rep->'summary', 'result', mine
                ) ORDER BY (rep->'test'->>'test_date') DESC)
                FROM academics.tests tst
                JOIN academics.enrollments te ON te.batch_id = tst.batch_id AND te.student_id = s.student_id
                CROSS JOIN LATERAL (SELECT academics.fn_test_report(p_tenant_id, tst.test_id) AS rep) r
                CROSS JOIN LATERAL (
                    SELECT jsonb_path_query_first(r.rep, '$.students[*] ? (@.student_id == $sid)',
                                                  jsonb_build_object('sid', s.student_id)) AS mine
                ) m
                WHERE tst.status = 'published' AND tst.tenant_id = p_tenant_id
            ), '[]'::jsonb),
            'payments', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'payment_id', p.payment_id, 'receipt_number', p.receipt_number, 'paid_at', p.created_at,
                    'amount', p.amount, 'payment_method', p.payment_method, 'reference', p.payment_reference,
                    'status', p.status, 'invoice_number', i.invoice_number, 'designation', i.designation,
                    'billing_period', i.billing_period
                ) ORDER BY p.created_at DESC)
                FROM billing.payments p JOIN billing.invoices i ON i.invoice_id = p.invoice_id
                WHERE p.student_id = s.student_id
            ), '[]'::jsonb),
            'name', s.first_name || ' ' || s.last_name,
            'preferred_name', COALESCE(s.preferred_name, s.first_name),
            'division', COALESCE(s.profile->>'division', '—'),
            'track', COALESCE(s.profile->>'track', '—'),
            'matriculation_year', COALESCE(s.matriculation_year, '—'),
            'standing', COALESCE(s.academic_standing, '—'),
            'standing_roster', COALESCE(s.profile->>'standingRoster', '—'),
            'jury_status', COALESCE(s.profile->>'juryStatus', '—'),
            'jury_date', COALESCE(s.profile->>'juryDate', '—'),
            'practice_suite', COALESCE(s.profile->'practiceSuite', '{"room": "—", "schedule": "—"}'::jsonb),
            'practice_hours', COALESCE(pr.total_hours, 0),
            'practice_cohort_diff', CASE
                WHEN cohort.avg_hours IS NULL OR cohort.avg_hours = 0 THEN 'No cohort data yet'
                ELSE CASE WHEN COALESCE(pr.total_hours, 0) >= cohort.avg_hours THEN '+' ELSE '' END
                     || ROUND((COALESCE(pr.total_hours, 0) - cohort.avg_hours) * 100 / cohort.avg_hours) || '% vs. Cohort Average'
            END,
            'practice_streak_days', COALESCE((
                WITH d AS (
                    SELECT DISTINCT log_date FROM engagement.practice_logs WHERE student_id = s.student_id
                ), anchor AS (
                    SELECT MAX(log_date) AS last_day FROM d HAVING MAX(log_date) >= CURRENT_DATE - 1
                )
                SELECT COUNT(*) FROM (
                    SELECT log_date, ROW_NUMBER() OVER (ORDER BY log_date DESC) AS rn FROM d
                ) x, anchor WHERE x.log_date = anchor.last_day - (x.rn - 1)::int
            ), 0),
            'weekly_practice', (
                SELECT jsonb_agg(jsonb_build_object(
                    'day', trim(to_char(wd, 'Day')),
                    'short_day', left(to_char(wd, 'Dy'), 1),
                    'hours', (SELECT COALESCE(SUM(hours), 0) FROM engagement.practice_logs pl
                              WHERE pl.student_id = s.student_id AND pl.log_date = wd::date)
                ) ORDER BY wd)
                FROM generate_series(date_trunc('week', CURRENT_DATE), date_trunc('week', CURRENT_DATE) + INTERVAL '6 days', INTERVAL '1 day') wd
            ),
            'enrolled_units', enr.unit_count || CASE WHEN enr.unit_count = 1 THEN ' Unit' ELSE ' Units' END,
            'enrolled_subjects', COALESCE(enr.subjects, '—'),
            'balance', COALESCE(bal.balance, 0),
            'next_draft_amount', COALESCE(nxt.balance_amount, 0),
            'next_draft_date', COALESCE(to_char(nxt.due_date, 'Mon DD, YYYY'), '—'),
            'payment_method', COALESCE(lastpay.payment_method, 'Pending Manual Settlement'),
            'attendance_rate', COALESCE(att.rate, 100),
            'sessions_completed', COALESCE(att.attended, 0),
            'sessions_total', COALESCE(att.total, 0),
            'excused_absences', COALESCE(att.excused, 0) + COALESCE(absreq.cnt, 0),
            'absence_note', COALESCE(absreq.note, CASE WHEN COALESCE(att.missed, 0) = 0 THEN 'Perfect Attendance Record'
                                                  ELSE att.missed || ' missed session(s) on record' END),
            'next_class_time', COALESCE(nextclass.label, 'No upcoming sessions'),
            'primary_mentor', mentor.info,
            'featured_event', ev.info,
            'timetable', COALESCE(tt.items, '[]'::jsonb),
            'distinctions', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', a.achievement_id, 'title', a.title, 'issuer', a.issuer,
                    'grade', COALESCE(a.grade, a.level),
                    'type', CASE WHEN a.category = 'Distinction' THEN 'gold' ELSE 'primary' END
                ) ORDER BY a.award_date DESC)
                FROM engagement.achievements a WHERE a.student_id = s.student_id AND a.visibility <> 'private'
            ), '[]'::jsonb),
            'invoices', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', i.invoice_id,
                    'invoice_number', i.invoice_number,
                    'billing_period', i.billing_period,
                    'designation', i.designation,
                    'subtitle', 'Due ' || to_char(i.due_date, 'Mon DD, YYYY'),
                    'amount', i.total_amount,
                    'balance', i.balance_amount,
                    'payment_method', COALESCE(p.payment_method, 'Pending Online Checkout'),
                    'status', CASE WHEN i.balance_amount = 0 THEN 'settled'
                                   WHEN i.due_date < CURRENT_DATE THEN 'overdue' ELSE 'pending' END,
                    'receipt_number', COALESCE(p.receipt_number, '')
                ) ORDER BY i.due_date DESC)
                FROM billing.invoices i
                LEFT JOIN LATERAL (
                    SELECT payment_method, receipt_number FROM billing.payments bp
                    WHERE bp.invoice_id = i.invoice_id ORDER BY bp.created_at DESC LIMIT 1
                ) p ON true
                WHERE i.student_id = s.student_id AND i.status <> 'void'
            ), '[]'::jsonb)
        ) AS w
        FROM academics.student_guardian_links l
        JOIN academics.students s ON s.student_id = l.student_id
        LEFT JOIN LATERAL (
            SELECT SUM(hours) AS total_hours FROM engagement.practice_logs WHERE student_id = s.student_id
        ) pr ON true
        LEFT JOIN LATERAL (
            SELECT AVG(t) AS avg_hours FROM (
                SELECT SUM(hours) AS t FROM engagement.practice_logs WHERE tenant_id = p_tenant_id GROUP BY student_id
            ) x
        ) cohort ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS unit_count, string_agg(DISTINCT c.title, ', ') AS subjects
            FROM academics.enrollments e
            JOIN academics.batches b ON b.batch_id = e.batch_id
            JOIN academics.courses c ON c.course_id = b.course_id
            WHERE e.student_id = s.student_id AND e.status = 'enrolled'
        ) enr ON true
        LEFT JOIN LATERAL (
            SELECT SUM(balance_amount) AS balance FROM billing.invoices WHERE student_id = s.student_id AND status <> 'void'
        ) bal ON true
        LEFT JOIN LATERAL (
            SELECT balance_amount, due_date FROM billing.invoices
            WHERE student_id = s.student_id AND status <> 'void' AND balance_amount > 0
            ORDER BY due_date LIMIT 1
        ) nxt ON true
        LEFT JOIN LATERAL (
            SELECT payment_method FROM billing.payments WHERE student_id = s.student_id ORDER BY created_at DESC LIMIT 1
        ) lastpay ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status IN ('present', 'late')) AS attended,
                   COUNT(*) FILTER (WHERE status = 'excused') AS excused,
                   COUNT(*) FILTER (WHERE status = 'absent') AS missed,
                   CASE WHEN COUNT(*) > 0
                        THEN ROUND(COUNT(*) FILTER (WHERE status IN ('present', 'late')) * 100.0 / COUNT(*)) END AS rate
            FROM academics.attendance_records WHERE student_id = s.student_id
        ) att ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*) OVER () AS cnt,
                   'Absence on ' || to_char(absence_date, 'Mon DD') || ' (' || reason || ')'
                       || CASE WHEN makeup_requested THEN ' - Makeup requested' ELSE '' END AS note
            FROM academics.absence_requests WHERE student_id = s.student_id
            ORDER BY created_at DESC LIMIT 1
        ) absreq ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(item ORDER BY next_date, start_time) AS items,
                   MIN(next_date + start_time) AS next_at
            FROM (
                SELECT jsonb_build_object(
                           'id', sc.schedule_id,
                           'day', to_char(nd.next_date, 'Dy'),
                           'date_num', EXTRACT(DAY FROM nd.next_date)::int,
                           'time', to_char(sc.start_time, 'HH12:MI AM') || ' – ' || to_char(sc.end_time, 'HH12:MI AM'),
                           'studio', COALESCE(b.room, br.name),
                           'subject', c.title,
                           'faculty', COALESCE(u.full_name, 'Faculty TBA') || ' • ' || b.name,
                           'type', sc.session_type
                       ) AS item, nd.next_date, sc.start_time
                FROM academics.enrollments e
                JOIN academics.batches b ON b.batch_id = e.batch_id AND b.status = 'active'
                JOIN academics.courses c ON c.course_id = b.course_id
                JOIN tenant.branches br ON br.branch_id = b.branch_id
                JOIN academics.batch_schedules sc ON sc.batch_id = b.batch_id
                LEFT JOIN identity_app.users u ON u.user_id = b.instructor_user_id
                CROSS JOIN LATERAL (
                    SELECT CURRENT_DATE + ((sc.weekday - EXTRACT(ISODOW FROM CURRENT_DATE)::int + 7) % 7) AS next_date
                ) nd
                WHERE e.student_id = s.student_id AND e.status = 'enrolled'
            ) x
        ) tt ON true
        LEFT JOIN LATERAL (
            SELECT to_char(tt.next_at, 'FMDay, HH12:MI AM') AS label
        ) nextclass ON tt.next_at IS NOT NULL
        LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
                'user_id', u.user_id,
                'name', u.full_name,
                'email', u.email,
                'title', COALESCE(m.title, 'Faculty'),
                'office', COALESCE(m.profile->>'office', b.room, '—'),
                'distinction', COALESCE(m.profile->>'distinction', ''),
                'avatar', m.profile->>'avatarUrl'
            ) AS info
            FROM academics.enrollments e
            JOIN academics.batches b ON b.batch_id = e.batch_id
            JOIN identity_app.users u ON u.user_id = b.instructor_user_id
            LEFT JOIN tenant.memberships m ON m.user_id = u.user_id AND m.tenant_id = p_tenant_id AND m.role = 'Instructor'
            WHERE e.student_id = s.student_id AND e.status = 'enrolled'
            ORDER BY e.enrolled_at LIMIT 1
        ) mentor ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
                'event_id', ev.event_id,
                'title', ev.title,
                'date', to_char(ev.starts_at, 'FMDay, FMMonth DD, YYYY • FMHH12:MI AM'),
                'venue', COALESCE(ev.venue, '—'),
                'description', COALESCE(ev.description, ''),
                'soloist', COALESCE(ep.role_label, s.first_name || ' ' || s.last_name),
                'program', COALESCE(ep.program, '—'),
                'box', COALESCE(ep.seating, '—'),
                'guaranteed_seats', ep.guaranteed_seats,
                'seats_claimed', ep.seats_claimed_at IS NOT NULL
            ) AS info
            FROM engagement.event_participants ep
            JOIN engagement.events ev ON ev.event_id = ep.event_id
            WHERE ep.student_id = s.student_id AND ev.starts_at >= now()
            ORDER BY ev.starts_at LIMIT 1
        ) ev ON true
        WHERE l.guardian_id = v_guardian.guardian_id AND l.tenant_id = p_tenant_id
    ) wards;

    RETURN jsonb_build_object(
        'guardian_id', v_guardian.guardian_id,
        'household_id', v_guardian.household_code,
        'academic_session', COALESCE((SELECT settings->>'academicSession' FROM tenant.organizations WHERE tenant_id = p_tenant_id), ''),
        'organization_name', (SELECT name FROM tenant.organizations WHERE tenant_id = p_tenant_id),
        'currency', (SELECT currency FROM tenant.organizations WHERE tenant_id = p_tenant_id),
        'academy_type', (SELECT academy_type FROM tenant.organizations WHERE tenant_id = p_tenant_id),
        'logo_url', (SELECT branding->>'logoUrl' FROM tenant.organizations WHERE tenant_id = p_tenant_id),
        'notices', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'notice_id', n.notice_id, 'title', n.title, 'content', n.content, 'notice_type', n.notice_type,
                'priority', n.priority, 'published_at', n.published_at, 'is_pinned', n.is_pinned,
                'branch_name', COALESCE(br.name, 'All Branches')
            ) ORDER BY n.is_pinned DESC, n.published_at DESC)
            FROM engagement.notices n
            LEFT JOIN tenant.branches br ON br.branch_id = n.branch_id
            WHERE n.tenant_id = p_tenant_id AND n.status = 'published' AND n.published_at <= now()
              AND (n.expires_at IS NULL OR n.expires_at > now())
              AND n.target_audience IN ('all', 'guardians', 'students')
              AND (n.branch_id IS NULL OR n.branch_id IN (
                  SELECT st.branch_id FROM academics.students st
                  JOIN academics.student_guardian_links gl ON gl.student_id = st.student_id
                  WHERE gl.guardian_id = v_guardian.guardian_id))
        ), '[]'::jsonb),
        'achievement_board', COALESCE((
            SELECT jsonb_agg(to_jsonb(ab) ORDER BY ab.award_date DESC)
            FROM (
                SELECT a.achievement_id, st.first_name || ' ' || st.last_name AS student_name, a.title,
                       a.category, a.level, a.award_date, a.issuer
                FROM engagement.achievements a
                JOIN academics.students st ON st.student_id = a.student_id
                WHERE a.tenant_id = p_tenant_id AND a.visibility = 'public'
                ORDER BY a.award_date DESC LIMIT 12
            ) ab
        ), '[]'::jsonb),
        'guardian_name', v_guardian.first_name || ' ' || v_guardian.last_name,
        'guardian_email', v_guardian.email,
        'guardian_phone', v_guardian.phone,
        'wards', v_wards
    );
END;
$$;

CREATE OR REPLACE FUNCTION engagement.fn_practice_log_create(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_student_id UUID,
    p_log_date DATE,
    p_hours NUMERIC(4,1),
    p_piece VARCHAR(255),
    p_notes TEXT,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = engagement, academics, audit, public
AS $$
DECLARE
    v_log_id UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM academics.student_guardian_links
        WHERE tenant_id = p_tenant_id AND guardian_id = p_guardian_id AND student_id = p_student_id
    ) THEN
        RAISE EXCEPTION 'Student is not linked to this guardian' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO engagement.practice_logs (tenant_id, student_id, log_date, hours, piece, notes, recorded_by_actor_id)
    VALUES (p_tenant_id, p_student_id, COALESCE(p_log_date, CURRENT_DATE), p_hours, p_piece, p_notes, p_actor_id)
    RETURNING log_id INTO v_log_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'practice.logged', 'student', p_student_id::text, gen_random_uuid()::text,
            jsonb_build_object('hours', p_hours, 'piece', p_piece));

    RETURN jsonb_build_object(
        'success', true,
        'logId', v_log_id,
        'totalHours', (SELECT SUM(hours) FROM engagement.practice_logs WHERE student_id = p_student_id)
    );
END;
$$;

CREATE OR REPLACE FUNCTION engagement.fn_event_seats_claim(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_student_id UUID,
    p_event_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = engagement, academics, audit, public
AS $$
DECLARE
    v_seats INT;
    v_title VARCHAR(255);
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM academics.student_guardian_links
        WHERE tenant_id = p_tenant_id AND guardian_id = p_guardian_id AND student_id = p_student_id
    ) THEN
        RAISE EXCEPTION 'Student is not linked to this guardian' USING ERRCODE = 'P0002';
    END IF;

    UPDATE engagement.event_participants ep
    SET seats_claimed_at = COALESCE(ep.seats_claimed_at, clock_timestamp())
    FROM engagement.events ev
    WHERE ev.event_id = ep.event_id AND ep.event_id = p_event_id AND ep.student_id = p_student_id
      AND ep.tenant_id = p_tenant_id
    RETURNING ep.guaranteed_seats, ev.title INTO v_seats, v_title;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Event participation not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'event.seats_claimed', 'event', p_event_id::text, gen_random_uuid()::text,
            jsonb_build_object('studentId', p_student_id, 'seats', v_seats));

    RETURN jsonb_build_object('success', true, 'guaranteedSeats', v_seats, 'title', v_title);
END;
$$;

CREATE OR REPLACE FUNCTION engagement.fn_advisory_book(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_student_id UUID,
    p_slot_at TIMESTAMPTZ,
    p_topic TEXT,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = engagement, academics, identity_app, audit, public
AS $$
DECLARE
    v_booking_id UUID;
    v_mentor_id UUID;
    v_mentor_name VARCHAR(150);
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM academics.student_guardian_links
        WHERE tenant_id = p_tenant_id AND guardian_id = p_guardian_id AND student_id = p_student_id
    ) THEN
        RAISE EXCEPTION 'Student is not linked to this guardian' USING ERRCODE = 'P0002';
    END IF;
    IF p_slot_at <= now() THEN
        RAISE EXCEPTION 'Advisory slot must be in the future' USING ERRCODE = '22023';
    END IF;

    SELECT u.user_id, u.full_name INTO v_mentor_id, v_mentor_name
    FROM academics.enrollments e
    JOIN academics.batches b ON b.batch_id = e.batch_id
    JOIN identity_app.users u ON u.user_id = b.instructor_user_id
    WHERE e.student_id = p_student_id AND e.status = 'enrolled'
    ORDER BY e.enrolled_at LIMIT 1;

    INSERT INTO engagement.advisory_bookings (tenant_id, student_id, mentor_user_id, slot_at, topic, requested_by_actor_id)
    VALUES (p_tenant_id, p_student_id, v_mentor_id, p_slot_at, p_topic, p_actor_id)
    RETURNING booking_id INTO v_booking_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'advisory.booked', 'student', p_student_id::text, gen_random_uuid()::text,
            jsonb_build_object('slotAt', p_slot_at, 'topic', p_topic));

    RETURN jsonb_build_object('success', true, 'bookingId', v_booking_id, 'mentorName', COALESCE(v_mentor_name, 'the faculty advisor'));
END;
$$;
