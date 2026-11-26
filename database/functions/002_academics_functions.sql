-- ============================================================================
-- ClassSphere Stored Functions: 002_academics_functions.sql
-- Traceability: TDD Section 10.4, PLT-006, DECISION-002
-- Strict SECURITY DEFINER, schema-qualified, parameterized contract
-- ============================================================================

DROP FUNCTION IF EXISTS academics.fn_student_create(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DATE, VARCHAR, VARCHAR, VARCHAR, UUID, UUID);
DROP FUNCTION IF EXISTS academics.fn_student_search(UUID, TEXT, VARCHAR, INT, INT);
DROP FUNCTION IF EXISTS academics.fn_student_search(UUID, UUID, TEXT, VARCHAR, INT, INT);
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
    v_seq_num INT;
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

    IF p_enrollment_number IS NOT NULL AND TRIM(p_enrollment_number) <> '' THEN
        v_enrollment_no := UPPER(TRIM(p_enrollment_number));
        IF EXISTS (SELECT 1 FROM academics.students WHERE tenant_id = p_tenant_id AND enrollment_number = v_enrollment_no) THEN
            RAISE EXCEPTION 'Student ID "%" already exists in this academy', v_enrollment_no USING ERRCODE = '23505';
        END IF;
    ELSE
        -- Auto-generate sequentially in format STUD-01, STUD-02, etc.
        SELECT COALESCE(MAX(
            CASE 
                WHEN enrollment_number ~* '^STUD-([0-9]+)$' THEN
                    SUBSTRING(enrollment_number FROM '^STUD-([0-9]+)$')::INT
                ELSE 0
            END
        ), 0) + 1 INTO v_seq_num
        FROM academics.students
        WHERE tenant_id = p_tenant_id;

        LOOP
            v_enrollment_no := 'STUD-' || LPAD(v_seq_num::text, 2, '0');
            EXIT WHEN NOT EXISTS (
                SELECT 1 FROM academics.students WHERE tenant_id = p_tenant_id AND enrollment_number = v_enrollment_no
            );
            v_seq_num := v_seq_num + 1;
        END LOOP;
    END IF;

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
    p_offset INT DEFAULT 0,
    p_course_id UUID DEFAULT NULL,
    p_batch_id UUID DEFAULT NULL
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
      AND (p_branch_id IS NULL OR s.branch_id = p_branch_id OR EXISTS (
          SELECT 1 FROM academics.enrollments e
          JOIN academics.batches b ON b.batch_id = e.batch_id
          WHERE e.student_id = s.student_id
            AND b.branch_id = p_branch_id
            AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
      ))
      AND (p_course_id IS NULL OR EXISTS (
          SELECT 1 FROM academics.enrollments e
          JOIN academics.batches b ON b.batch_id = e.batch_id
          WHERE e.student_id = s.student_id
            AND b.course_id = p_course_id
            AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
      ))
      AND (p_batch_id IS NULL OR EXISTS (
          SELECT 1 FROM academics.enrollments e
          WHERE e.student_id = s.student_id
            AND e.batch_id = p_batch_id
            AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
      ))
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
               s.profile->>'photo' AS photo,
               (SELECT name FROM tenant.branches br WHERE br.branch_id = s.branch_id) AS branch_name,
               (SELECT string_agg(DISTINCT b.name, ', ' ORDER BY b.name)
                FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE e.student_id = s.student_id AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')) AS batches,
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
          AND (p_branch_id IS NULL OR s.branch_id = p_branch_id OR EXISTS (
              SELECT 1 FROM academics.enrollments e
              JOIN academics.batches b ON b.batch_id = e.batch_id
              WHERE e.student_id = s.student_id
                AND b.branch_id = p_branch_id
                AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
          ))
          AND (p_course_id IS NULL OR EXISTS (
              SELECT 1 FROM academics.enrollments e
              JOIN academics.batches b ON b.batch_id = e.batch_id
              WHERE e.student_id = s.student_id
                AND b.course_id = p_course_id
                AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
          ))
          AND (p_batch_id IS NULL OR EXISTS (
              SELECT 1 FROM academics.enrollments e
              WHERE e.student_id = s.student_id
                AND e.batch_id = p_batch_id
                AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
          ))
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
    FROM (
        SELECT s.status, COUNT(*) AS cnt
        FROM academics.students s
        WHERE s.tenant_id = p_tenant_id
          AND (p_branch_id IS NULL OR s.branch_id = p_branch_id OR EXISTS (
              SELECT 1 FROM academics.enrollments e
              JOIN academics.batches b ON b.batch_id = e.batch_id
              WHERE e.student_id = s.student_id
                AND b.branch_id = p_branch_id
                AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
          ))
          AND (p_course_id IS NULL OR EXISTS (
              SELECT 1 FROM academics.enrollments e
              JOIN academics.batches b ON b.batch_id = e.batch_id
              WHERE e.student_id = s.student_id
                AND b.course_id = p_course_id
                AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
          ))
          AND (p_batch_id IS NULL OR EXISTS (
              SELECT 1 FROM academics.enrollments e
              WHERE e.student_id = s.student_id
                AND e.batch_id = p_batch_id
                AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
          ))
        GROUP BY s.status
    ) c;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'status_counts', v_counts,
        'students', v_results
    );
END;
$$;

-- Drop redundant 6-argument overload so 8-argument function with defaults resolves unambiguously
DROP FUNCTION IF EXISTS academics.fn_student_search(UUID, UUID, TEXT, VARCHAR, INT, INT);

CREATE OR REPLACE FUNCTION academics.fn_course_list(
    p_tenant_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, tenant, public
AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.title), '[]'::jsonb)
    FROM (
        SELECT c.course_id, c.title, c.code, c.description, c.category, c.level, c.duration_months,
               c.tuition_amount, c.billing_period, c.is_active, c.branch_id, c.start_date, c.completion_policy,
               COALESCE(br.name, 'All Branches') AS branch_name,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_id', cs.subject_id, 'name', cs.name) ORDER BY cs.sort_order, cs.name)
                         FROM academics.course_subjects cs WHERE cs.course_id = c.course_id), '[]'::jsonb) AS subjects,
               (SELECT COUNT(*) FROM academics.batches b WHERE b.course_id = c.course_id) AS batch_count,
               (SELECT COUNT(DISTINCT e.student_id)
                FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE b.course_id = c.course_id AND e.status = 'enrolled') AS student_count
        FROM academics.courses c
        LEFT JOIN tenant.branches br ON br.branch_id = c.branch_id AND br.tenant_id = c.tenant_id
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
        SELECT b.batch_id, b.branch_id, b.name, b.room, b.capacity, b.status, b.start_date, b.end_date,
               c.course_id, c.title AS course_title, c.tuition_amount AS tuition_amount, br.name AS branch_name, b.instructor_user_id, u.full_name AS instructor_name,
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
    WITH scheduled_sessions AS (
        SELECT d::date AS session_date
        FROM generate_series(p_from, p_to, INTERVAL '1 day') d
        WHERE EXTRACT(ISODOW FROM d) IN (
            SELECT s.weekday FROM academics.batch_schedules s
            WHERE s.batch_id = p_batch_id AND s.tenant_id = p_tenant_id
        )
    ),
    logged_sessions AS (
        SELECT DISTINCT a.session_date
        FROM academics.attendance_records a
        WHERE a.batch_id = p_batch_id AND a.tenant_id = p_tenant_id
          AND a.session_date BETWEEN p_from AND p_to
    ),
    all_sessions AS (
        SELECT session_date FROM scheduled_sessions
        UNION
        SELECT session_date FROM logged_sessions
    )
    SELECT jsonb_build_object(
        'sessions', COALESCE((SELECT jsonb_agg(session_date ORDER BY session_date) FROM all_sessions), '[]'::jsonb),
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

-- Attendance daily roll call for a batch on a specific session date
CREATE OR REPLACE FUNCTION academics.fn_attendance_daily_get(
    p_tenant_id UUID,
    p_batch_id UUID,
    p_session_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
DECLARE
    v_students JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'student_id', st.student_id,
        'name', st.first_name || ' ' || st.last_name,
        'email', st.email,
        'status', ar.status,
        'remarks', ar.remarks,
        'overall_rate', COALESCE((
            SELECT ROUND((COUNT(*) FILTER (WHERE sub.status IN ('present', 'late'))::numeric / NULLIF(COUNT(*), 0)::numeric) * 100)
            FROM academics.attendance_records sub
            WHERE sub.tenant_id = p_tenant_id AND sub.student_id = st.student_id
        ), 100)
    ) ORDER BY st.first_name, st.last_name), '[]'::jsonb)
    INTO v_students
    FROM academics.enrollments e
    JOIN academics.students st ON st.student_id = e.student_id
    LEFT JOIN academics.attendance_records ar ON ar.tenant_id = p_tenant_id
        AND ar.batch_id = p_batch_id
        AND ar.student_id = st.student_id
        AND ar.session_date = p_session_date
    WHERE e.batch_id = p_batch_id AND e.tenant_id = p_tenant_id AND e.status = 'enrolled';

    RETURN jsonb_build_object(
        'batch_id', p_batch_id,
        'session_date', p_session_date::text,
        'students', v_students
    );
END;
$$;

-- Particular student attendance records and statistics
CREATE OR REPLACE FUNCTION academics.fn_student_attendance_get(
    p_tenant_id UUID,
    p_student_id UUID,
    p_from DATE DEFAULT NULL,
    p_to DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
DECLARE
    v_student RECORD;
    v_total INT;
    v_present INT;
    v_absent INT;
    v_late INT;
    v_excused INT;
    v_records JSONB;
BEGIN
    SELECT s.student_id, s.first_name, s.last_name, s.email, s.phone
    INTO v_student
    FROM academics.students s
    WHERE s.student_id = p_student_id AND s.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'present'),
        COUNT(*) FILTER (WHERE status = 'absent'),
        COUNT(*) FILTER (WHERE status = 'late'),
        COUNT(*) FILTER (WHERE status = 'excused')
    INTO v_total, v_present, v_absent, v_late, v_excused
    FROM academics.attendance_records
    WHERE tenant_id = p_tenant_id AND student_id = p_student_id
      AND (p_from IS NULL OR session_date >= p_from)
      AND (p_to IS NULL OR session_date <= p_to);

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'attendance_id', ar.attendance_id,
            'session_date', ar.session_date::text,
            'batch_id', ar.batch_id,
            'batch_name', b.name,
            'status', ar.status,
            'remarks', ar.remarks,
            'created_at', ar.created_at
        ) ORDER BY ar.session_date DESC, ar.created_at DESC
    ), '[]'::jsonb)
    INTO v_records
    FROM academics.attendance_records ar
    JOIN academics.batches b ON b.batch_id = ar.batch_id
    WHERE ar.tenant_id = p_tenant_id AND ar.student_id = p_student_id
      AND (p_from IS NULL OR ar.session_date >= p_from)
      AND (p_to IS NULL OR ar.session_date <= p_to);

    RETURN jsonb_build_object(
        'student', jsonb_build_object(
            'student_id', v_student.student_id,
            'name', v_student.first_name || ' ' || v_student.last_name,
            'email', v_student.email,
            'phone', v_student.phone,
            'enrolled_batches', COALESCE((
                SELECT jsonb_agg(jsonb_build_object('batch_id', b.batch_id, 'name', b.name))
                FROM academics.enrollments e
                JOIN academics.batches b ON b.batch_id = e.batch_id
                WHERE e.student_id = p_student_id AND e.status = 'enrolled'
            ), '[]'::jsonb)
        ),
        'summary', jsonb_build_object(
            'total', v_total,
            'present', v_present,
            'absent', v_absent,
            'late', v_late,
            'excused', v_excused,
            'rate', CASE WHEN v_total > 0 THEN ROUND(((v_present + v_late)::numeric / v_total::numeric) * 100) ELSE 100 END
        ),
        'records', v_records
    );
END;
$$;

-- Delete a single student attendance record
CREATE OR REPLACE FUNCTION academics.fn_attendance_delete_record(
    p_tenant_id UUID,
    p_student_id UUID,
    p_session_date DATE,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
BEGIN
    DELETE FROM academics.attendance_records
    WHERE tenant_id = p_tenant_id
      AND student_id = p_student_id
      AND session_date = p_session_date;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'attendance.record_deleted', 'student', p_student_id::text, gen_random_uuid()::text,
            jsonb_build_object('studentId', p_student_id, 'date', p_session_date));

    RETURN jsonb_build_object('success', true, 'deletedDate', p_session_date);
END;
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
        INSERT INTO identity_app.users (email, password_hash, full_name, phone, email_verified_at, phone_verified_at)
        VALUES (
            lower(v_guardian.email),
            p_password_hash,
            v_guardian.first_name || ' ' || v_guardian.last_name,
            v_guardian.phone,
            CASE WHEN v_guardian.email IS NOT NULL THEN clock_timestamp() ELSE NULL END,
            CASE WHEN v_guardian.phone IS NOT NULL THEN clock_timestamp() ELSE NULL END
        )
        RETURNING user_id INTO v_user_id;
    ELSE
        -- If user already exists, do not overwrite their existing password
        UPDATE identity_app.users SET password_hash = COALESCE(password_hash, p_password_hash), is_active = TRUE WHERE user_id = v_user_id;
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

CREATE OR REPLACE FUNCTION academics.fn_guardian_update(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_first_name VARCHAR(100),
    p_last_name VARCHAR(100),
    p_relationship VARCHAR(50),
    p_phone VARCHAR(50),
    p_email VARCHAR(255),
    p_is_primary BOOLEAN,
    p_student_ids UUID[],
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, identity_app, audit, public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT user_id INTO v_user_id
    FROM academics.guardians
    WHERE guardian_id = p_guardian_id AND tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guardian not found' USING ERRCODE = 'P0002';
    END IF;

    IF trim(COALESCE(p_first_name, '')) = '' OR trim(COALESCE(p_last_name, '')) = '' THEN
        RAISE EXCEPTION 'First and last name are required' USING ERRCODE = '22023';
    END IF;

    IF trim(COALESCE(p_phone, '')) = '' THEN
        RAISE EXCEPTION 'Phone number is required' USING ERRCODE = '22023';
    END IF;

    IF trim(COALESCE(p_email, '')) = '' THEN
        RAISE EXCEPTION 'Email address is required' USING ERRCODE = '22023';
    END IF;

    -- Update guardian record
    UPDATE academics.guardians
    SET first_name = trim(p_first_name),
        last_name = trim(p_last_name),
        relationship = COALESCE(trim(p_relationship), relationship),
        phone = trim(p_phone),
        email = lower(trim(p_email))
    WHERE guardian_id = p_guardian_id AND tenant_id = p_tenant_id;

    -- Update linked portal user if exists
    IF v_user_id IS NOT NULL THEN
        UPDATE identity_app.users
        SET full_name = trim(p_first_name) || ' ' || trim(p_last_name),
            email = lower(trim(p_email)),
            phone = trim(p_phone)
        WHERE user_id = v_user_id;
    END IF;

    -- Update student links if student_ids provided
    IF p_student_ids IS NOT NULL AND array_length(p_student_ids, 1) > 0 THEN
        DELETE FROM academics.student_guardian_links
        WHERE tenant_id = p_tenant_id AND guardian_id = p_guardian_id;

        INSERT INTO academics.student_guardian_links (tenant_id, student_id, guardian_id, is_primary)
        SELECT p_tenant_id, sid, p_guardian_id, COALESCE(p_is_primary, TRUE)
        FROM unnest(p_student_ids) AS sid;
    ELSIF p_is_primary IS NOT NULL THEN
        UPDATE academics.student_guardian_links
        SET is_primary = p_is_primary
        WHERE tenant_id = p_tenant_id AND guardian_id = p_guardian_id;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'guardian.updated', 'guardian', p_guardian_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_first_name || ' ' || p_last_name, 'guardianId', p_guardian_id));

    RETURN jsonb_build_object('success', true, 'guardianId', p_guardian_id);
END;
$$;

-- Links an existing guardian to a student
CREATE OR REPLACE FUNCTION academics.fn_guardian_link_student(
    p_tenant_id UUID,
    p_guardian_id UUID,
    p_student_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM academics.guardians WHERE guardian_id = p_guardian_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Guardian not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM academics.students WHERE student_id = p_student_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO academics.student_guardian_links (tenant_id, student_id, guardian_id, is_primary)
    VALUES (p_tenant_id, p_student_id, p_guardian_id, TRUE)
    ON CONFLICT (student_id, guardian_id) DO NOTHING;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'guardian.student_linked', 'guardian', p_guardian_id::text, gen_random_uuid()::text,
            jsonb_build_object('student_id', p_student_id, 'guardian_id', p_guardian_id));

    RETURN jsonb_build_object('success', true);
END;
$$;


CREATE OR REPLACE FUNCTION academics.fn_student_update(
    p_tenant_id UUID,
    p_student_id UUID,
    p_first_name VARCHAR(100),
    p_last_name VARCHAR(100),
    p_email VARCHAR(255),
    p_phone VARCHAR(50),
    p_status VARCHAR(30),
    p_batch_id UUID,
    p_branch_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, tenant, audit, public
AS $$
BEGIN
    UPDATE academics.students
    SET first_name = COALESCE(p_first_name, first_name),
        last_name = COALESCE(p_last_name, last_name),
        email = COALESCE(p_email, email),
        phone = COALESCE(p_phone, phone),
        status = COALESCE(p_status, status),
        branch_id = COALESCE(p_branch_id, branch_id),
        updated_at = clock_timestamp()
    WHERE student_id = p_student_id AND tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_batch_id IS NOT NULL THEN
        -- Closed enrollments (transferred, completed, …) are history and are never moved or reopened here
        IF EXISTS (SELECT 1 FROM academics.enrollments
                   WHERE student_id = p_student_id AND batch_id = p_batch_id AND tenant_id = p_tenant_id) THEN
            UPDATE academics.enrollments SET status = 'enrolled'
            WHERE student_id = p_student_id AND batch_id = p_batch_id AND tenant_id = p_tenant_id
              AND status IN ('confirmed', 'active', 'approved', 'pending', 'waitlisted');
        ELSIF (SELECT COUNT(*) FROM academics.enrollments WHERE student_id = p_student_id AND tenant_id = p_tenant_id
               AND status IN ('enrolled', 'confirmed', 'active', 'approved')) = 1 THEN
            UPDATE academics.enrollments
            SET batch_id = p_batch_id, status = 'enrolled'
            WHERE student_id = p_student_id AND tenant_id = p_tenant_id
              AND status IN ('enrolled', 'confirmed', 'active', 'approved');
        ELSE
            INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status)
            VALUES (p_tenant_id, p_student_id, p_batch_id, 'enrolled');
        END IF;
    END IF;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'student.updated', 'student', p_student_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_first_name || ' ' || p_last_name, 'status', p_status));

    RETURN jsonb_build_object('success', true, 'studentId', p_student_id);
END;
$$;

