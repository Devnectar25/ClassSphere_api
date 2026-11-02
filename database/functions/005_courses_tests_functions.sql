-- ============================================================================
-- ClassSphere Stored Functions: 005_courses_tests_functions.sql
-- Course catalogue with subjects, test scheduling, marks entry, grading and report cards.
-- ============================================================================

-- Grading scale on percentage: A+ ≥ 90, A ≥ 80, B+ ≥ 70, B ≥ 60, C ≥ 50, D ≥ 40, F below 40
CREATE OR REPLACE FUNCTION academics.fn_grade(p_percentage NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_percentage IS NULL THEN NULL
        WHEN p_percentage >= 90 THEN 'A+'
        WHEN p_percentage >= 80 THEN 'A'
        WHEN p_percentage >= 70 THEN 'B+'
        WHEN p_percentage >= 60 THEN 'B'
        WHEN p_percentage >= 50 THEN 'C'
        WHEN p_percentage >= 40 THEN 'D'
        ELSE 'F'
    END;
$$;

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
SET search_path = academics, audit, public
AS $$
DECLARE
    v_course_id UUID;
BEGIN
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

    RETURN jsonb_build_object('success', true, 'courseId', v_course_id);
END;
$$;

CREATE OR REPLACE FUNCTION academics.fn_course_subject_add(
    p_tenant_id UUID,
    p_course_id UUID,
    p_name VARCHAR(150),
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_subject_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM academics.courses WHERE course_id = p_course_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Course not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO academics.course_subjects (tenant_id, course_id, name, sort_order)
    VALUES (p_tenant_id, p_course_id, trim(p_name),
            (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM academics.course_subjects WHERE course_id = p_course_id))
    RETURNING subject_id INTO v_subject_id;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'course.subject_added', 'course', p_course_id::text, gen_random_uuid()::text,
            jsonb_build_object('subject', p_name));

    RETURN jsonb_build_object('success', true, 'subjectId', v_subject_id);
END;
$$;

CREATE OR REPLACE FUNCTION academics.fn_test_schedule(
    p_tenant_id UUID,
    p_batch_id UUID,
    p_title VARCHAR(200),
    p_test_type VARCHAR(30),
    p_test_date DATE,
    p_subjects JSONB, -- [{ "subjectId": uuid, "maxMarks": number }]
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_course_id UUID;
    v_test_id UUID;
    v_item JSONB;
BEGIN
    SELECT course_id INTO v_course_id FROM academics.batches WHERE batch_id = p_batch_id AND tenant_id = p_tenant_id;
    IF v_course_id IS NULL THEN
        RAISE EXCEPTION 'Batch not found' USING ERRCODE = 'P0002';
    END IF;
    IF jsonb_array_length(COALESCE(p_subjects, '[]'::jsonb)) = 0 THEN
        RAISE EXCEPTION 'Select at least one subject for the test' USING ERRCODE = '22023';
    END IF;

    INSERT INTO academics.tests (tenant_id, batch_id, title, test_type, test_date, created_by_actor_id)
    VALUES (p_tenant_id, p_batch_id, p_title, COALESCE(p_test_type, 'Unit Test'), p_test_date, p_actor_id)
    RETURNING test_id INTO v_test_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_subjects) LOOP
        IF NOT EXISTS (
            SELECT 1 FROM academics.course_subjects
            WHERE subject_id = (v_item->>'subjectId')::UUID AND course_id = v_course_id
        ) THEN
            RAISE EXCEPTION 'Subject is not part of this batch''s course' USING ERRCODE = '22023';
        END IF;
        INSERT INTO academics.test_subjects (test_id, subject_id, max_marks)
        VALUES (v_test_id, (v_item->>'subjectId')::UUID, (v_item->>'maxMarks')::NUMERIC);
    END LOOP;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'test.scheduled', 'test', v_test_id::text, gen_random_uuid()::text,
            jsonb_build_object('title', p_title, 'date', p_test_date));

    RETURN jsonb_build_object('success', true, 'testId', v_test_id);
END;
$$;

-- Report card for a test: every enrolled student's marks per subject, total, percentage, grade and rank
CREATE OR REPLACE FUNCTION academics.fn_test_report(
    p_tenant_id UUID,
    p_test_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
    WITH t AS (
        SELECT ts.*, b.name AS batch_name, b.batch_id AS b_id, c.title AS course_title
        FROM academics.tests ts
        JOIN academics.batches b ON b.batch_id = ts.batch_id
        JOIN academics.courses c ON c.course_id = b.course_id
        WHERE ts.test_id = p_test_id AND ts.tenant_id = p_tenant_id
    ), subj AS (
        SELECT s.subject_id, s.name, s.sort_order, x.max_marks
        FROM academics.test_subjects x JOIN academics.course_subjects s ON s.subject_id = x.subject_id
        WHERE x.test_id = p_test_id
    ), pupils AS (
        SELECT st.student_id, st.first_name || ' ' || st.last_name AS name, st.enrollment_number
        FROM t JOIN academics.enrollments e ON e.batch_id = t.b_id AND e.status = 'enrolled'
        JOIN academics.students st ON st.student_id = e.student_id
    ), scores AS (
        SELECT p.student_id,
               SUM(r.marks_obtained) AS total,
               COUNT(r.subject_id) FILTER (WHERE r.marks_obtained IS NOT NULL OR r.is_absent) AS entered
        FROM pupils p LEFT JOIN academics.test_results r ON r.test_id = p_test_id AND r.student_id = p.student_id
        GROUP BY p.student_id
    ), ranked AS (
        SELECT sc.*, ROUND(sc.total * 100 / NULLIF((SELECT SUM(max_marks) FROM subj), 0), 1) AS percentage,
               CASE WHEN sc.total IS NOT NULL THEN DENSE_RANK() OVER (ORDER BY sc.total DESC NULLS LAST) END AS rank
        FROM scores sc
    )
    SELECT jsonb_build_object(
        'test', (SELECT jsonb_build_object('test_id', test_id, 'title', title, 'test_type', test_type, 'test_date', test_date,
                                            'status', status, 'published_at', published_at, 'batch_id', b_id,
                                            'batch_name', batch_name, 'course_title', course_title) FROM t),
        'subjects', COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_id', subject_id, 'name', name, 'max_marks', max_marks)
                                               ORDER BY sort_order, name) FROM subj), '[]'::jsonb),
        'max_total', (SELECT SUM(max_marks) FROM subj),
        'students', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'student_id', p.student_id, 'name', p.name, 'enrollment_number', p.enrollment_number,
                'marks', COALESCE((
                    SELECT jsonb_object_agg(r.subject_id::text, jsonb_build_object(
                        'marks', r.marks_obtained, 'absent', r.is_absent, 'remarks', r.remarks,
                        'grade', academics.fn_grade(r.marks_obtained * 100 / NULLIF(sj.max_marks, 0))))
                    FROM academics.test_results r JOIN subj sj ON sj.subject_id = r.subject_id
                    WHERE r.test_id = p_test_id AND r.student_id = p.student_id
                ), '{}'::jsonb),
                'total', rk.total, 'percentage', rk.percentage,
                'grade', academics.fn_grade(rk.percentage), 'rank', rk.rank,
                'complete', rk.entered = (SELECT COUNT(*) FROM subj)
            ) ORDER BY rk.rank NULLS LAST, p.name)
            FROM pupils p JOIN ranked rk ON rk.student_id = p.student_id
        ), '[]'::jsonb),
        'summary', (SELECT jsonb_build_object(
            'class_size', COUNT(*),
            'graded', COUNT(*) FILTER (WHERE total IS NOT NULL),
            'average_percentage', ROUND(AVG(percentage), 1),
            'highest_percentage', MAX(percentage),
            'passed', COUNT(*) FILTER (WHERE percentage >= 40)
        ) FROM ranked)
    )
    WHERE EXISTS (SELECT 1 FROM t);
$$;

CREATE OR REPLACE FUNCTION academics.fn_test_list(
    p_tenant_id UUID,
    p_branch_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = academics, public
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'test_id', t.test_id, 'title', t.title, 'test_type', t.test_type, 'test_date', t.test_date, 'status', t.status,
        'batch_id', b.batch_id, 'batch_name', b.name, 'course_title', c.title,
        'subjects', (SELECT jsonb_agg(jsonb_build_object('name', s.name, 'max_marks', x.max_marks) ORDER BY s.sort_order, s.name)
                     FROM academics.test_subjects x JOIN academics.course_subjects s ON s.subject_id = x.subject_id
                     WHERE x.test_id = t.test_id),
        'class_size', (SELECT COUNT(*) FROM academics.enrollments e WHERE e.batch_id = b.batch_id AND e.status = 'enrolled'),
        'graded', (SELECT COUNT(DISTINCT r.student_id) FROM academics.test_results r WHERE r.test_id = t.test_id)
    ) ORDER BY t.test_date DESC, t.created_at DESC), '[]'::jsonb)
    FROM academics.tests t
    JOIN academics.batches b ON b.batch_id = t.batch_id
    JOIN academics.courses c ON c.course_id = b.course_id
    WHERE t.tenant_id = p_tenant_id AND (p_branch_id IS NULL OR b.branch_id = p_branch_id);
$$;

CREATE OR REPLACE FUNCTION academics.fn_test_results_save(
    p_tenant_id UUID,
    p_test_id UUID,
    p_results JSONB, -- [{ "studentId", "subjectId", "marks": number|null, "absent": bool, "remarks": text }]
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, public
AS $$
DECLARE
    v_test RECORD;
    v_item JSONB;
    v_max NUMERIC;
    v_marks NUMERIC;
    v_absent BOOLEAN;
    v_count INT := 0;
BEGIN
    SELECT * INTO v_test FROM academics.tests WHERE test_id = p_test_id AND tenant_id = p_tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Test not found' USING ERRCODE = 'P0002';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_results) LOOP
        SELECT max_marks INTO v_max FROM academics.test_subjects
        WHERE test_id = p_test_id AND subject_id = (v_item->>'subjectId')::UUID;
        IF v_max IS NULL THEN
            RAISE EXCEPTION 'Subject is not part of this test' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM academics.enrollments WHERE batch_id = v_test.batch_id AND student_id = (v_item->>'studentId')::UUID) THEN
            RAISE EXCEPTION 'Student is not enrolled in this batch' USING ERRCODE = '22023';
        END IF;

        v_absent := COALESCE((v_item->>'absent')::BOOLEAN, false);
        v_marks := CASE WHEN v_absent THEN NULL ELSE NULLIF(v_item->>'marks', '')::NUMERIC END;
        IF v_marks IS NOT NULL AND (v_marks < 0 OR v_marks > v_max) THEN
            RAISE EXCEPTION 'Marks must be between 0 and %', v_max USING ERRCODE = '22023';
        END IF;

        INSERT INTO academics.test_results (test_id, student_id, subject_id, tenant_id, marks_obtained, is_absent, remarks, recorded_by_actor_id)
        VALUES (p_test_id, (v_item->>'studentId')::UUID, (v_item->>'subjectId')::UUID, p_tenant_id, v_marks, v_absent,
                NULLIF(v_item->>'remarks', ''), p_actor_id)
        ON CONFLICT (test_id, student_id, subject_id) DO UPDATE SET
            marks_obtained = EXCLUDED.marks_obtained, is_absent = EXCLUDED.is_absent, remarks = EXCLUDED.remarks,
            recorded_by_actor_id = EXCLUDED.recorded_by_actor_id, updated_at = clock_timestamp();
        v_count := v_count + 1;
    END LOOP;

    UPDATE academics.tests SET status = 'completed' WHERE test_id = p_test_id AND status = 'scheduled';

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'test.marks_recorded', 'test', p_test_id::text, gen_random_uuid()::text,
            jsonb_build_object('entries', v_count));

    RETURN jsonb_build_object('success', true, 'saved', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION academics.fn_test_publish(
    p_tenant_id UUID,
    p_test_id UUID,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, audit, integration, public
AS $$
DECLARE
    v_title VARCHAR(200);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM academics.test_results WHERE test_id = p_test_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Enter marks before publishing results' USING ERRCODE = '22023';
    END IF;

    UPDATE academics.tests SET status = 'published', published_at = clock_timestamp()
    WHERE test_id = p_test_id AND tenant_id = p_tenant_id
    RETURNING title INTO v_title;

    INSERT INTO integration.outbox_messages (tenant_id, correlation_id, event_type, payload)
    VALUES (p_tenant_id, gen_random_uuid()::text, 'academics.test_results_published',
            jsonb_build_object('testId', p_test_id, 'title', v_title));

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'test.published', 'test', p_test_id::text, gen_random_uuid()::text,
            jsonb_build_object('title', v_title));

    RETURN jsonb_build_object('success', true);
END;
$$;
