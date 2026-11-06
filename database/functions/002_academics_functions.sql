-- ============================================================================
-- ClassSphere Stored Functions: 002_academics_functions.sql
-- Traceability: TDD Section 10.4, PLT-006, DECISION-002
-- Strict SECURITY DEFINER, schema-qualified, parameterized contract
-- ============================================================================

DROP FUNCTION IF EXISTS academics.fn_student_create(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DATE, VARCHAR, VARCHAR, VARCHAR, UUID, UUID);
DROP FUNCTION IF EXISTS academics.fn_student_search(UUID, TEXT, VARCHAR, INT, INT);
DROP FUNCTION IF EXISTS academics.fn_batch_list(UUID);
DROP FUNCTION IF EXISTS academics.fn_guardian_list(UUID);

CREATE OR REPLACE FUNCTION academics.fn_student_create(
    p_tenant_id UUID,
    p_first_name VARCHAR(100),
    p_last_name VARCHAR(100),
    p_email VARCHAR(255),
    p_phone VARCHAR(50),
    p_dob DATE,
    p_enrollment_number VARCHAR(50),
    p_matriculation_year VARCHAR(10),
    p_academic_standing VARCHAR(50),
    p_batch_id UUID,
    p_branch_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, tenant, audit, public
AS $$
DECLARE
    v_student_id UUID;
    v_enrollment_no VARCHAR(50);
    v_branch_id UUID;
BEGIN
    IF p_batch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM academics.batches WHERE batch_id = p_batch_id AND tenant_id = p_tenant_id
    ) THEN
        RAISE EXCEPTION 'Batch not found' USING ERRCODE = 'P0002';
    END IF;

    -- Home branch: requested branch, else the batch's branch, else the academy's primary branch
    v_branch_id := COALESCE(
        (SELECT branch_id FROM tenant.branches WHERE branch_id = p_branch_id AND tenant_id = p_tenant_id),
        (SELECT branch_id FROM academics.batches WHERE batch_id = p_batch_id),
        (SELECT branch_id FROM tenant.branches WHERE tenant_id = p_tenant_id ORDER BY is_primary DESC, created_at LIMIT 1));

    v_enrollment_no := COALESCE(p_enrollment_number, 'STU-' || UPPER(SUBSTRING(gen_random_uuid()::text, 1, 8)));

    INSERT INTO academics.students (
        tenant_id, branch_id, first_name, last_name, email, phone, date_of_birth, enrollment_number,
        matriculation_year, academic_standing
    ) VALUES (
        p_tenant_id, v_branch_id, p_first_name, p_last_name, p_email, p_phone, p_dob, v_enrollment_no,
        COALESCE(p_matriculation_year, EXTRACT(YEAR FROM CURRENT_DATE)::text),
        COALESCE(p_academic_standing, 'Good Standing')
    ) RETURNING student_id INTO v_student_id;

    IF p_batch_id IS NOT NULL THEN
        INSERT INTO academics.enrollments (tenant_id, student_id, batch_id)
        VALUES (p_tenant_id, v_student_id, p_batch_id);
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'student.created', 'student', v_student_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_first_name || ' ' || p_last_name, 'enrollmentNo', v_enrollment_no));

    RETURN jsonb_build_object(
        'success', true,
        'studentId', v_student_id,
        'enrollmentNumber', v_enrollment_no
    );
END;
$$;

CREATE OR REPLACE FUNCTION academics.fn_student_search(
    p_tenant_id UUID,
    p_branch_id UUID DEFAULT NULL,
    p_query TEXT DEFAULT NULL,
    p_status VARCHAR(30) DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, billing, tenant, public
AS $$
DECLARE
    v_results JSONB;
    v_total INT;
    v_counts JSONB;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM academics.students s
    WHERE s.tenant_id = p_tenant_id
      AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
      AND (p_status IS NULL OR s.status = p_status)
      AND (p_query IS NULL OR (
          s.first_name || ' ' || s.last_name ILIKE '%' || p_query || '%' OR
          s.enrollment_number ILIKE '%' || p_query || '%' OR
          s.email ILIKE '%' || p_query || '%'
      ));

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_results
    FROM (
        SELECT s.student_id, s.first_name, s.last_name, s.email, s.phone, s.date_of_birth,
               s.enrollment_number, s.status, s.academic_standing, s.matriculation_year, s.created_at, s.branch_id,
               (SELECT name FROM tenant.branches br WHERE br.branch_id = s.branch_id) AS branch_name,
               (SELECT string_agg(b.name, ', ' ORDER BY b.name)
                FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE e.student_id = s.student_id AND e.status = 'enrolled') AS batches,
               (SELECT g.first_name || ' ' || g.last_name
                FROM academics.student_guardian_links l JOIN academics.guardians g ON g.guardian_id = l.guardian_id
                WHERE l.student_id = s.student_id
                ORDER BY l.is_primary DESC LIMIT 1) AS guardian_name,
               (SELECT CASE
                    WHEN COUNT(*) = 0 THEN 'none'
                    WHEN bool_or(i.balance_amount > 0 AND i.due_date < CURRENT_DATE) THEN 'overdue'
                    WHEN bool_or(i.balance_amount > 0) THEN 'pending'
                    ELSE 'paid' END
                FROM billing.invoices i
                WHERE i.student_id = s.student_id AND i.status <> 'void') AS fee_status
        FROM academics.students s
        WHERE s.tenant_id = p_tenant_id
          AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
          AND (p_status IS NULL OR s.status = p_status)
          AND (p_query IS NULL OR (
              s.first_name || ' ' || s.last_name ILIKE '%' || p_query || '%' OR
              s.enrollment_number ILIKE '%' || p_query || '%' OR
              s.email ILIKE '%' || p_query || '%'
          ))
        ORDER BY s.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) r;

    SELECT COALESCE(jsonb_object_agg(status, cnt), '{}'::jsonb) INTO v_counts
    FROM (SELECT status, COUNT(*) AS cnt FROM academics.students WHERE tenant_id = p_tenant_id AND (p_branch_id IS NULL OR branch_id = p_branch_id) GROUP BY status) c;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'status_counts', v_counts,
        'students', v_results
    );
END;
$$;

CREATE OR REPLACE FUNCTION academics.fn_course_list(
    p_tenant_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.title), '[]'::jsonb)
    FROM (
        SELECT c.course_id, c.title, c.code, c.description, c.category, c.level, c.duration_months,
               c.tuition_amount, c.billing_period, c.is_active,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_id', cs.subject_id, 'name', cs.name) ORDER BY cs.sort_order, cs.name)
                         FROM academics.course_subjects cs WHERE cs.course_id = c.course_id), '[]'::jsonb) AS subjects,
               (SELECT COUNT(*) FROM academics.batches b WHERE b.course_id = c.course_id) AS batch_count,
               (SELECT COUNT(DISTINCT e.student_id)
                FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE b.course_id = c.course_id AND e.status = 'enrolled') AS student_count
        FROM academics.courses c
        WHERE c.tenant_id = p_tenant_id
    ) r;
$$;

CREATE OR REPLACE FUNCTION academics.fn_batch_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, tenant, identity_app, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.name), '[]'::jsonb)
    FROM (
        SELECT b.batch_id, b.name, b.room, b.capacity, b.status, b.start_date, b.end_date,
               c.course_id, c.title AS course_title, br.name AS branch_name, b.instructor_user_id, u.full_name AS instructor_name,
               (SELECT COUNT(*) FROM academics.enrollments e WHERE e.batch_id = b.batch_id AND e.status = 'enrolled') AS enrolled_count,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'weekday', s.weekday,
                       'day', to_char(DATE '2024-01-01' + (s.weekday - 1), 'Dy'),
                       'start_key', to_char(s.start_time, 'HH24:MI'),
                       'end_key', to_char(s.end_time, 'HH24:MI'),
                       'start_time', to_char(s.start_time, 'HH12:MI AM'),
                       'end_time', to_char(s.end_time, 'HH12:MI AM'),
                       'session_type', s.session_type
                   ) ORDER BY s.weekday, s.start_time)
                   FROM academics.batch_schedules s WHERE s.batch_id = b.batch_id
               ), '[]'::jsonb) AS schedules
        FROM academics.batches b
        JOIN academics.courses c ON c.course_id = b.course_id
        JOIN tenant.branches br ON br.branch_id = b.branch_id
        LEFT JOIN identity_app.users u ON u.user_id = b.instructor_user_id
        WHERE b.tenant_id = p_tenant_id AND (p_branch_id IS NULL OR b.branch_id = p_branch_id)
    ) r;
$$;

CREATE OR REPLACE FUNCTION academics.fn_guardian_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, billing, identity_app, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.last_name, r.first_name), '[]'::jsonb)
    FROM (
        SELECT g.guardian_id, g.household_code, g.first_name, g.last_name, g.relationship, g.phone, g.email,
               g.user_id IS NOT NULL AS has_portal_access,
               (SELECT u.email FROM identity_app.users u WHERE u.user_id = g.user_id) AS portal_email,
               (SELECT u.last_login_at FROM identity_app.users u WHERE u.user_id = g.user_id) AS portal_last_login,
               COALESCE(bool_or(l.is_primary), false) AS is_primary,
               COALESCE(jsonb_agg(jsonb_build_object('student_id', s.student_id, 'name', s.first_name || ' ' || s.last_name)
                                  ORDER BY s.first_name) FILTER (WHERE s.student_id IS NOT NULL), '[]'::jsonb) AS students,
               CASE
                   WHEN EXISTS (SELECT 1 FROM billing.invoices i JOIN academics.student_guardian_links l2 ON l2.student_id = i.student_id
                                WHERE l2.guardian_id = g.guardian_id AND i.status <> 'void'
                                  AND i.balance_amount > 0 AND i.due_date < CURRENT_DATE) THEN 'Overdue'
                   WHEN EXISTS (SELECT 1 FROM billing.payments p JOIN academics.student_guardian_links l2 ON l2.student_id = p.student_id
                                WHERE l2.guardian_id = g.guardian_id) THEN 'Active payer'
                   ELSE 'Pending setup'
               END AS payer_status
        FROM academics.guardians g
        LEFT JOIN academics.student_guardian_links l ON l.guardian_id = g.guardian_id
        LEFT JOIN academics.students s ON s.student_id = l.student_id
        WHERE g.tenant_id = p_tenant_id
          AND (p_branch_id IS NULL OR EXISTS (
              SELECT 1 FROM academics.student_guardian_links l3 JOIN academics.students s3 ON s3.student_id = l3.student_id
              WHERE l3.guardian_id = g.guardian_id AND s3.branch_id = p_branch_id))
        GROUP BY g.guardian_id
    ) r;
$$;

CREATE OR REPLACE FUNCTION academics.fn_attendance_mark_batch(
    p_tenant_id UUID,
    p_batch_id UUID,
    p_session_date DATE,
    p_records JSONB, -- array of { studentId: UUID, status: string, remarks: string }
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_item JSONB;
    v_count INT := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM academics.batches WHERE batch_id = p_batch_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Batch not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_session_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'Attendance cannot be recorded for a future session (%)', p_session_date USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_records) LOOP
        IF NOT EXISTS (
            SELECT 1 FROM academics.enrollments
            WHERE tenant_id = p_tenant_id AND batch_id = p_batch_id AND student_id = (v_item->>'studentId')::UUID
        ) THEN
            RAISE EXCEPTION 'Student % is not enrolled in this batch', v_item->>'studentId' USING ERRCODE = '22023';
        END IF;

        INSERT INTO academics.attendance_records (
            tenant_id, batch_id, student_id, session_date, status, remarks, recorded_by_actor_id
        ) VALUES (
            p_tenant_id,
            p_batch_id,
            (v_item->>'studentId')::UUID,
            p_session_date,
            COALESCE(v_item->>'status', 'present'),
            v_item->>'remarks',
            p_actor_id
        )
        ON CONFLICT (tenant_id, batch_id, student_id, session_date)
        DO UPDATE SET
            status = EXCLUDED.status,
            remarks = EXCLUDED.remarks,
            recorded_by_actor_id = EXCLUDED.recorded_by_actor_id;

        v_count := v_count + 1;
    END LOOP;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'attendance.marked_batch', 'batch', p_batch_id::text, gen_random_uuid()::text,
            jsonb_build_object('batchId', p_batch_id, 'date', p_session_date, 'count', v_count));

    RETURN jsonb_build_object('success', true, 'markedCount', v_count, 'sessionDate', p_session_date);
END;
$$;

-- Attendance register grid: scheduled session dates in range × enrolled students
CREATE OR REPLACE FUNCTION academics.fn_attendance_register(
    p_tenant_id UUID,
    p_batch_id UUID,
    p_from DATE,
    p_to DATE
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
    WITH sessions AS (
        SELECT d::date AS session_date
        FROM generate_series(p_from, p_to, INTERVAL '1 day') d
        WHERE EXTRACT(ISODOW FROM d) IN (
            SELECT s.weekday FROM academics.batch_schedules s
            WHERE s.batch_id = p_batch_id AND s.tenant_id = p_tenant_id
        )
    )
    SELECT jsonb_build_object(
        'sessions', COALESCE((SELECT jsonb_agg(session_date ORDER BY session_date) FROM sessions), '[]'::jsonb),
        'students', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'student_id', st.student_id,
                'name', st.first_name || ' ' || st.last_name,
                'records', COALESCE((
                    SELECT jsonb_object_agg(a.session_date::text, a.status)
                    FROM academics.attendance_records a
                    WHERE a.batch_id = p_batch_id AND a.student_id = st.student_id
                      AND a.session_date BETWEEN p_from AND p_to
                ), '{}'::jsonb)
            ) ORDER BY st.first_name, st.last_name)
            FROM academics.enrollments e
            JOIN academics.students st ON st.student_id = e.student_id
            WHERE e.batch_id = p_batch_id AND e.tenant_id = p_tenant_id AND e.status = 'enrolled'
        ), '[]'::jsonb)
    );
$$;

CREATE OR REPLACE FUNCTION academics.fn_absence_request_create(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_student_id UUID,
    p_absence_date DATE,
    p_reason TEXT,
    p_makeup_requested BOOLEAN,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_request_id UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM academics.student_guardian_links
        WHERE tenant_id = p_tenant_id AND guardian_id = p_guardian_id AND student_id = p_student_id
    ) THEN
        RAISE EXCEPTION 'Student is not linked to this guardian' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO academics.absence_requests (tenant_id, student_id, absence_date, reason, makeup_requested, requested_by_actor_id)
    VALUES (p_tenant_id, p_student_id, p_absence_date, p_reason, COALESCE(p_makeup_requested, false), p_actor_id)
    RETURNING request_id INTO v_request_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'attendance.absence_requested', 'student', p_student_id::text, gen_random_uuid()::text,
            jsonb_build_object('date', p_absence_date, 'reason', p_reason, 'makeupRequested', p_makeup_requested));

    RETURN jsonb_build_object('success', true, 'requestId', v_request_id);
END;
$$;

-- Creates (or links) the guardian's portal sign-in and Guardian membership
CREATE OR REPLACE FUNCTION academics.fn_guardian_portal_enable(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_password_hash VARCHAR(255),
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, identity_app, tenant, audit, public
AS $$
DECLARE
    v_guardian RECORD;
    v_user_id UUID;
BEGIN
    SELECT * INTO v_guardian FROM academics.guardians WHERE guardian_id = p_guardian_id AND tenant_id = p_tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guardian not found' USING ERRCODE = 'P0002';
    END IF;

    v_user_id := v_guardian.user_id;
    IF v_user_id IS NULL THEN
        SELECT user_id INTO v_user_id FROM identity_app.users WHERE lower(email) = lower(v_guardian.email);
    END IF;
    IF v_user_id IS NULL THEN
        INSERT INTO identity_app.users (email, password_hash, full_name, phone)
        VALUES (lower(v_guardian.email), p_password_hash, v_guardian.first_name || ' ' || v_guardian.last_name, v_guardian.phone)
        RETURNING user_id INTO v_user_id;
    ELSE
        UPDATE identity_app.users SET password_hash = p_password_hash, is_active = TRUE WHERE user_id = v_user_id;
    END IF;

    UPDATE academics.guardians SET user_id = v_user_id WHERE guardian_id = p_guardian_id;
    INSERT INTO tenant.memberships (tenant_id, user_id, role)
    VALUES (p_tenant_id, v_user_id, 'Guardian')
    ON CONFLICT (tenant_id, user_id, role) DO UPDATE SET is_active = TRUE;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'guardian.portal_enabled', 'guardian', p_guardian_id::text, gen_random_uuid()::text,
            jsonb_build_object('email', v_guardian.email));

    RETURN jsonb_build_object('success', true, 'userId', v_user_id, 'email', v_guardian.email);
END;
$$;

-- Adds a guardian (parent) linked to one or more students of the academy
CREATE OR REPLACE FUNCTION academics.fn_guardian_create(
    p_tenant_id UUID,
    p_first_name VARCHAR(100),
    p_last_name VARCHAR(100),
    p_relationship VARCHAR(50),
    p_phone VARCHAR(50),
    p_email VARCHAR(255),
    p_student_ids UUID[],
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_guardian_id UUID;
    v_linked INT;
BEGIN
    IF COALESCE(array_length(p_student_ids, 1), 0) = 0 THEN
        RAISE EXCEPTION 'Link the guardian to at least one student' USING ERRCODE = '22023';
    END IF;
    SELECT COUNT(*) INTO v_linked FROM academics.students WHERE tenant_id = p_tenant_id AND student_id = ANY(p_student_ids);
    IF v_linked <> array_length(p_student_ids, 1) THEN
        RAISE EXCEPTION 'One or more students were not found in this academy' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO academics.guardians (tenant_id, household_code, first_name, last_name, relationship, phone, email)
    VALUES (p_tenant_id, 'HH-' || upper(substr(md5(gen_random_uuid()::text), 1, 6)), p_first_name, p_last_name,
            COALESCE(p_relationship, 'Parent'), p_phone, lower(trim(p_email)))
    RETURNING guardian_id INTO v_guardian_id;

    INSERT INTO academics.student_guardian_links (tenant_id, student_id, guardian_id, is_primary)
    SELECT p_tenant_id, sid, v_guardian_id, TRUE FROM unnest(p_student_ids) AS sid;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'guardian.created', 'guardian', v_guardian_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_first_name || ' ' || p_last_name, 'students', v_linked));

    RETURN jsonb_build_object('success', true, 'guardianId', v_guardian_id);
END;
$$;
