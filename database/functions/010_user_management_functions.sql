-- ============================================================================
-- ClassSphere Functions: 010_user_management_functions.sql
-- Platform Users Management: listing, details, export, access checks and
-- suspension / reactivation with permission checks, history, notification and audit.
-- Requires migration 012_user_management.sql.
-- ============================================================================

-- Students a user account is linked to: through a guardian record of the user,
-- or a student row carrying the same email (self-registered learners).
CREATE OR REPLACE FUNCTION identity_app.fn_user_student_ids(
    p_user_id UUID
) RETURNS TABLE (student_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity_app, academics, public
AS $$
    SELECT l.student_id
    FROM academics.guardians g
    JOIN academics.student_guardian_links l ON l.guardian_id = g.guardian_id
    WHERE g.user_id = p_user_id
    UNION
    SELECT s.student_id
    FROM academics.students s
    JOIN identity_app.users u ON u.user_id = p_user_id
    WHERE u.email IS NOT NULL AND lower(s.email) = lower(u.email);
$$;

-- Shared filter for listing and export
CREATE OR REPLACE FUNCTION identity_app.fn_user_matches_filter(
    p_user identity_app.users,
    p_query TEXT,
    p_status TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT (p_query IS NULL OR btrim(p_query) = ''
            OR p_user.full_name ILIKE '%' || btrim(p_query) || '%'
            OR p_user.email ILIKE '%' || btrim(p_query) || '%'
            OR p_user.phone ILIKE '%' || btrim(p_query) || '%'
            OR p_user.user_id::text ILIKE btrim(p_query) || '%')
       AND (p_status IS NULL OR p_status = 'all'
            OR (p_status = 'suspended' AND p_user.is_suspended)
            OR (p_status = 'active' AND NOT p_user.is_suspended AND p_user.is_active));
$$;

-- One listing row (also used by the export)
CREATE OR REPLACE FUNCTION identity_app.fn_user_row(
    p_user identity_app.users
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity_app, tenant, academics, public
AS $$
    SELECT jsonb_build_object(
        'user_id', p_user.user_id,
        'full_name', p_user.full_name,
        'email', p_user.email,
        'phone', p_user.phone,
        'email_verified', p_user.email_verified_at IS NOT NULL,
        'email_verified_at', p_user.email_verified_at,
        'phone_verified', p_user.phone_verified_at IS NOT NULL,
        'phone_verified_at', p_user.phone_verified_at,
        'is_active', p_user.is_active,
        'is_suspended', p_user.is_suspended,
        'is_platform_admin', p_user.is_platform_admin,
        'suspension_reason', p_user.suspension_reason,
        'suspended_at', p_user.suspended_at,
        'account_status', CASE WHEN p_user.is_suspended THEN 'suspended' WHEN p_user.is_active THEN 'active' ELSE 'inactive' END,
        'created_at', p_user.created_at,
        'last_login_at', p_user.last_login_at,
        'last_activity_at', p_user.last_activity_at,
        'enrollment_count', (
            SELECT COUNT(*) FROM academics.enrollments e
            WHERE e.student_id IN (SELECT student_id FROM identity_app.fn_user_student_ids(p_user.user_id))
        ),
        'academy_membership_count', (SELECT COUNT(*) FROM tenant.memberships m WHERE m.user_id = p_user.user_id)
    );
$$;

CREATE OR REPLACE FUNCTION platform.fn_users_list(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = identity_app, tenant, academics, public
AS $$
DECLARE
    v_total INT;
    v_users JSONB;
    v_counts JSONB;
BEGIN
    IF p_status IS NOT NULL AND p_status NOT IN ('all', 'active', 'suspended') THEN
        RAISE EXCEPTION 'Invalid status filter: %. Use all, active or suspended.', p_status USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*) INTO v_total
    FROM identity_app.users u
    WHERE identity_app.fn_user_matches_filter(u, p_query, p_status);

    SELECT COALESCE(jsonb_agg(identity_app.fn_user_row(u) ORDER BY u.created_at DESC), '[]'::jsonb) INTO v_users
    FROM identity_app.users u
    WHERE u.user_id IN (
        SELECT f.user_id FROM identity_app.users f
        WHERE identity_app.fn_user_matches_filter(f, p_query, p_status)
        ORDER BY f.created_at DESC
        LIMIT GREATEST(LEAST(p_limit, 100), 1) OFFSET GREATEST(p_offset, 0)
    );

    -- Tab counts honour the search text but not the status filter
    SELECT jsonb_build_object(
        'all', COUNT(*),
        'active', COUNT(*) FILTER (WHERE NOT u.is_suspended AND u.is_active),
        'suspended', COUNT(*) FILTER (WHERE u.is_suspended)
    ) INTO v_counts
    FROM identity_app.users u
    WHERE identity_app.fn_user_matches_filter(u, p_query, NULL);

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'counts', v_counts,
        'users', v_users
    );
END;
$$;

DROP FUNCTION IF EXISTS platform.fn_users_export(TEXT, TEXT);

CREATE OR REPLACE FUNCTION platform.fn_users_export(
    p_query TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity_app, tenant, academics, audit, public
AS $$
DECLARE
    v_users JSONB;
BEGIN
    IF p_status IS NOT NULL AND p_status NOT IN ('all', 'active', 'suspended') THEN
        RAISE EXCEPTION 'Invalid status filter: %. Use all, active or suspended.', p_status USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(jsonb_agg(identity_app.fn_user_row(u) ORDER BY u.created_at DESC), '[]'::jsonb) INTO v_users
    FROM identity_app.users u
    WHERE u.user_id IN (
        SELECT f.user_id FROM identity_app.users f
        WHERE identity_app.fn_user_matches_filter(f, p_query, p_status)
        ORDER BY f.created_at DESC
        LIMIT 10000
    );

    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'user.exported', 'user', NULL, gen_random_uuid()::text,
            jsonb_build_object('query', p_query, 'status', COALESCE(p_status, 'all'), 'rowCount', jsonb_array_length(v_users)));

    RETURN jsonb_build_object('users', v_users, 'exportedAt', clock_timestamp());
END;
$$;

CREATE OR REPLACE FUNCTION platform.fn_user_detail(
    p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = identity_app, tenant, academics, billing, platform, audit, public
AS $$
DECLARE
    v_user identity_app.users;
BEGIN
    SELECT * INTO v_user FROM identity_app.users WHERE user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', p_user_id USING ERRCODE = 'P0002';
    END IF;

    RETURN jsonb_build_object(
        'user', identity_app.fn_user_row(v_user) || jsonb_build_object(
            'suspended_by_name', (SELECT full_name FROM identity_app.users WHERE user_id = v_user.suspended_by),
            'updated_at', v_user.updated_at
        ),
        'verification', jsonb_build_object(
            'email_verified', v_user.email_verified_at IS NOT NULL,
            'email_verified_at', v_user.email_verified_at,
            'phone_verified', v_user.phone_verified_at IS NOT NULL,
            'phone_verified_at', v_user.phone_verified_at,
            'mfa_enabled', v_user.is_mfa_enabled
        ),

        -- Account sign-up, academy memberships and academy (plan) registrations, newest first
        'registration_history', COALESCE((
            SELECT jsonb_agg(h ORDER BY h->>'occurred_at' DESC)
            FROM (
                SELECT jsonb_build_object('type', 'account', 'title', 'Account created',
                    'detail', COALESCE(v_user.email, v_user.phone), 'status', 'completed', 'occurred_at', v_user.created_at) AS h
                UNION ALL
                SELECT jsonb_build_object('type', 'membership', 'title', 'Joined ' || o.name,
                    'detail', COALESCE(m.title, m.role), 'status', CASE WHEN m.is_active THEN 'active' ELSE 'inactive' END,
                    'occurred_at', m.created_at)
                FROM tenant.memberships m
                JOIN tenant.organizations o ON o.tenant_id = m.tenant_id
                WHERE m.user_id = p_user_id
                UNION ALL
                SELECT jsonb_build_object('type', 'academy_registration', 'title', 'Academy registration — ' || rp.plan_name,
                    'detail', COALESCE(rp.registration_payload->>'academyName', rp.registration_payload->>'name', rp.order_id),
                    'status', rp.payment_status, 'occurred_at', rp.created_at)
                FROM platform.registration_payments rp
                WHERE rp.admin_user_id = p_user_id
            ) x
        ), '[]'::jsonb),

        'payments', COALESCE((
            SELECT jsonb_agg(p ORDER BY p->>'paid_at' DESC)
            FROM (
                SELECT jsonb_build_object('payment_id', bp.payment_id, 'type', 'course_fee',
                    'reference', COALESCE(bp.gateway_payment_id, bp.receipt_number), 'description', i.designation,
                    'academy_name', o.name, 'amount', bp.amount, 'method', bp.payment_method, 'status', bp.status,
                    'paid_at', bp.created_at) AS p
                FROM billing.payments bp
                JOIN billing.invoices i ON i.invoice_id = bp.invoice_id
                JOIN tenant.organizations o ON o.tenant_id = bp.tenant_id
                WHERE bp.student_id IN (SELECT student_id FROM identity_app.fn_user_student_ids(p_user_id))
                UNION ALL
                SELECT jsonb_build_object('payment_id', rp.registration_id, 'type', 'academy_subscription',
                    'reference', COALESCE(rp.payment_id, rp.order_id), 'description', rp.plan_name || ' plan',
                    'academy_name', o.name, 'amount', rp.amount, 'method', rp.payment_method, 'status', rp.payment_status,
                    'paid_at', COALESCE(rp.transaction_date, rp.created_at))
                FROM platform.registration_payments rp
                LEFT JOIN tenant.organizations o ON o.tenant_id = rp.tenant_id
                WHERE rp.admin_user_id = p_user_id
            ) y
        ), '[]'::jsonb),

        'enrollments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'enrollment_id', e.enrollment_id, 'learner_name', s.first_name || ' ' || s.last_name,
                'academy_name', o.name, 'course_name', c.title, 'batch_name', b.name,
                'tuition_amount', c.tuition_amount, 'billing_period', c.billing_period,
                'status', e.status, 'enrolled_at', e.enrolled_at
            ) ORDER BY e.enrolled_at DESC)
            FROM academics.enrollments e
            JOIN academics.students s ON s.student_id = e.student_id
            JOIN academics.batches b ON b.batch_id = e.batch_id
            JOIN academics.courses c ON c.course_id = b.course_id
            JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
            WHERE e.student_id IN (SELECT student_id FROM identity_app.fn_user_student_ids(p_user_id))
        ), '[]'::jsonb),

        'memberships', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'tenant_id', o.tenant_id, 'academy_name', o.name, 'role', m.role, 'title', m.title,
                'is_active', m.is_active, 'joined_at', m.created_at
            ) ORDER BY m.created_at DESC)
            FROM tenant.memberships m
            JOIN tenant.organizations o ON o.tenant_id = m.tenant_id
            WHERE m.user_id = p_user_id
        ), '[]'::jsonb),

        -- Latest 50 audit events performed by or about this user
        'activity', COALESCE((
            SELECT jsonb_agg(a ORDER BY a->>'created_at' DESC)
            FROM (
                SELECT jsonb_build_object('log_id', l.log_id, 'action', l.action, 'entity_type', l.entity_type,
                    'actor_name', au.full_name, 'is_self', l.actor_id = p_user_id, 'details', l.details,
                    'created_at', l.created_at) AS a
                FROM audit.compliance_logs l
                LEFT JOIN identity_app.users au ON au.user_id = l.actor_id
                WHERE l.actor_id = p_user_id OR (l.entity_type = 'user' AND l.entity_id = p_user_id::text)
                ORDER BY l.created_at DESC
                LIMIT 50
            ) z
        ), '[]'::jsonb),

        'suspension_history', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'history_id', h.history_id, 'action', h.action, 'reason', h.reason,
                'actor_name', au.full_name, 'created_at', h.created_at
            ) ORDER BY h.created_at DESC)
            FROM identity_app.user_status_history h
            LEFT JOIN identity_app.users au ON au.user_id = h.actor_id
            WHERE h.user_id = p_user_id
        ), '[]'::jsonb)
    );
END;
$$;

-- Used on every authenticated request to stop suspended or deactivated accounts
CREATE OR REPLACE FUNCTION identity_app.fn_user_access_check(
    p_user_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity_app, public
AS $$
    SELECT COALESCE(
        (SELECT jsonb_build_object('exists', true, 'is_active', u.is_active, 'is_suspended', u.is_suspended)
         FROM identity_app.users u WHERE u.user_id = p_user_id),
        jsonb_build_object('exists', false, 'is_active', false, 'is_suspended', false)
    );
$$;

-- Suspend or reactivate. Validates the acting operator, records history and audit, queues the notification.
CREATE OR REPLACE FUNCTION platform.fn_user_status_update(
    p_user_id UUID,
    p_is_suspended BOOLEAN,
    p_reason TEXT,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity_app, platform, audit, integration, public
AS $$
DECLARE
    v_actor identity_app.users;
    v_admin platform.admin_users;
    v_user identity_app.users;
    v_reason TEXT := NULLIF(btrim(p_reason), '');
    v_action TEXT := CASE WHEN p_is_suspended THEN 'suspended' ELSE 'reactivated' END;
    v_correlation TEXT := gen_random_uuid()::text;
    v_template platform.notification_templates;
    v_notified BOOLEAN := FALSE;
BEGIN
    -- 1. Acting operator must be an active platform administrator allowed to manage users
    SELECT * INTO v_actor FROM identity_app.users WHERE user_id = p_actor_id;
    IF NOT FOUND OR NOT v_actor.is_platform_admin OR NOT v_actor.is_active OR v_actor.is_suspended THEN
        RAISE EXCEPTION 'Only active platform administrators can change user account status.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_admin FROM platform.admin_users WHERE user_id = p_actor_id;
    IF FOUND AND (NOT v_admin.is_active OR NOT (
        v_admin.role = 'SuperAdmin'
        OR v_admin.permissions && ARRAY['all:manage', 'users:manage', 'support:tickets']::TEXT[]
    )) THEN
        RAISE EXCEPTION 'Your administrator role does not allow suspending or reactivating users.' USING ERRCODE = '42501';
    END IF;

    -- 2. Target checks
    SELECT * INTO v_user FROM identity_app.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', p_user_id USING ERRCODE = 'P0002';
    END IF;

    IF p_is_suspended THEN
        IF p_user_id = p_actor_id THEN
            RAISE EXCEPTION 'You cannot suspend your own account.' USING ERRCODE = '22023';
        END IF;
        IF v_user.is_platform_admin THEN
            RAISE EXCEPTION 'Platform administrator accounts cannot be suspended here. Manage them from Admin Roles.' USING ERRCODE = '22023';
        END IF;
        IF v_reason IS NULL OR length(v_reason) < 10 THEN
            RAISE EXCEPTION 'A suspension reason of at least 10 characters is required.' USING ERRCODE = '22023';
        END IF;
        IF length(v_reason) > 500 THEN
            RAISE EXCEPTION 'The suspension reason cannot exceed 500 characters.' USING ERRCODE = '22023';
        END IF;
        IF v_user.is_suspended THEN
            RAISE EXCEPTION 'This account is already suspended.' USING ERRCODE = '23505';
        END IF;
    ELSE
        IF NOT v_user.is_suspended THEN
            RAISE EXCEPTION 'This account is not suspended.' USING ERRCODE = '23505';
        END IF;
        IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
            RAISE EXCEPTION 'The reactivation note cannot exceed 500 characters.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 3. Status change only: the user row and all its relationships are kept
    UPDATE identity_app.users
    SET is_suspended = p_is_suspended,
        suspension_reason = CASE WHEN p_is_suspended THEN v_reason ELSE NULL END,
        suspended_at = CASE WHEN p_is_suspended THEN clock_timestamp() ELSE NULL END,
        suspended_by = CASE WHEN p_is_suspended THEN p_actor_id ELSE NULL END,
        updated_at = clock_timestamp()
    WHERE user_id = p_user_id;

    INSERT INTO identity_app.user_status_history (user_id, action, reason, actor_id)
    VALUES (p_user_id, v_action, v_reason, p_actor_id);

    -- 4. Notify the user (delivered by the outbox relay)
    SELECT * INTO v_template FROM platform.notification_templates
    WHERE template_id = CASE WHEN p_is_suspended THEN 'account_suspended' ELSE 'account_reactivated' END;

    IF FOUND AND v_template.is_active AND (v_user.email IS NOT NULL OR v_user.phone IS NOT NULL) THEN
        INSERT INTO integration.outbox_messages (tenant_id, correlation_id, event_type, payload)
        VALUES (NULL, v_correlation, 'notification.user.account_' || v_action, jsonb_build_object(
            'templateId', v_template.template_id,
            'channel', v_template.channel,
            'userId', p_user_id,
            'recipientEmail', v_user.email,
            'recipientPhone', v_user.phone,
            'subject', v_template.subject,
            'body', replace(replace(v_template.content, '{{name}}', v_user.full_name), '{{reason}}', COALESCE(v_reason, ''))
        ));
        v_notified := TRUE;
    END IF;

    -- 5. Audit trail
    INSERT INTO audit.compliance_logs (actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_actor_id, 'user.' || v_action, 'user', p_user_id::text, v_correlation,
            jsonb_build_object('userId', p_user_id, 'userName', v_user.full_name, 'reason', v_reason,
                               'isSuspended', p_is_suspended, 'notified', v_notified));

    RETURN jsonb_build_object('success', true, 'userId', p_user_id, 'isSuspended', p_is_suspended,
                              'action', v_action, 'notified', v_notified, 'correlationId', v_correlation);
END;
$$;
