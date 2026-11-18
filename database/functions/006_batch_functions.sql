-- ============================================================================
-- ClassSphere Functions: 006_batch_functions.sql
-- Batch maintenance: edit batch details and replace its weekly schedule.
-- ============================================================================

-- Updates a batch's details and replaces its weekly schedule in one transaction.
-- p_schedules: array of { weekday: 1-7 (ISO, 1 = Monday), startTime: 'HH:MM', endTime: 'HH:MM', sessionType: string }
CREATE OR REPLACE FUNCTION academics.fn_batch_update(
    p_tenant_id UUID,
    p_batch_id UUID,
    p_name VARCHAR(150),
    p_course_id UUID,
    p_instructor_user_id UUID,
    p_room VARCHAR(100),
    p_capacity INT,
    p_status VARCHAR(30),
    p_start_date DATE,
    p_end_date DATE,
    p_schedules JSONB,
    p_actor_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = academics, tenant, audit, public
AS $$
DECLARE
    v_enrolled INT;
    v_item JSONB;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM academics.batches WHERE batch_id = p_batch_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Batch not found' USING ERRCODE = 'P0002';
    END IF;
    IF trim(COALESCE(p_name, '')) = '' THEN
        RAISE EXCEPTION 'Batch name is required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM academics.courses WHERE course_id = p_course_id AND tenant_id = p_tenant_id) THEN
        RAISE EXCEPTION 'Course not found' USING ERRCODE = '22023';
    END IF;
    IF p_instructor_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tenant.memberships
        WHERE tenant_id = p_tenant_id AND user_id = p_instructor_user_id AND role <> 'Guardian' AND is_active
    ) THEN
        RAISE EXCEPTION 'The instructor is not an active member of this academy' USING ERRCODE = '22023';
    END IF;
    IF p_status NOT IN ('upcoming', 'active', 'completed') THEN
        RAISE EXCEPTION 'Status must be upcoming, active or completed' USING ERRCODE = '22023';
    END IF;
    IF p_start_date IS NULL THEN
        RAISE EXCEPTION 'Start date is required' USING ERRCODE = '22023';
    END IF;
    IF p_end_date IS NOT NULL AND p_end_date < p_start_date THEN
        RAISE EXCEPTION 'End date cannot be before the start date' USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*) INTO v_enrolled FROM academics.enrollments WHERE batch_id = p_batch_id AND status = 'enrolled';
    IF p_capacity IS NULL OR p_capacity < 1 THEN
        RAISE EXCEPTION 'Capacity must be at least 1' USING ERRCODE = '22023';
    END IF;
    IF p_capacity < v_enrolled THEN
        RAISE EXCEPTION 'Capacity cannot be lower than the % students already enrolled', v_enrolled USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_schedules, '[]'::jsonb)) LOOP
        IF (v_item->>'weekday')::INT NOT BETWEEN 1 AND 7 THEN
            RAISE EXCEPTION 'Schedule day must be Monday to Sunday' USING ERRCODE = '22023';
        END IF;
        IF (v_item->>'endTime')::TIME <= (v_item->>'startTime')::TIME THEN
            RAISE EXCEPTION 'Each session must end after it starts' USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF (SELECT COUNT(*) <> COUNT(DISTINCT (e->>'weekday', (e->>'startTime')::TIME))
        FROM jsonb_array_elements(COALESCE(p_schedules, '[]'::jsonb)) e) THEN
        RAISE EXCEPTION 'Two sessions start on the same day at the same time' USING ERRCODE = '22023';
    END IF;

    UPDATE academics.batches SET
        name = trim(p_name),
        course_id = p_course_id,
        instructor_user_id = p_instructor_user_id,
        room = NULLIF(trim(COALESCE(p_room, '')), ''),
        capacity = p_capacity,
        status = p_status,
        start_date = p_start_date,
        end_date = p_end_date
    WHERE batch_id = p_batch_id AND tenant_id = p_tenant_id;

    DELETE FROM academics.batch_schedules WHERE batch_id = p_batch_id AND tenant_id = p_tenant_id;
    INSERT INTO academics.batch_schedules (tenant_id, batch_id, weekday, start_time, end_time, session_type)
    SELECT p_tenant_id, p_batch_id, (e->>'weekday')::SMALLINT, (e->>'startTime')::TIME, (e->>'endTime')::TIME,
           COALESCE(NULLIF(trim(e->>'sessionType'), ''), 'Class')
    FROM jsonb_array_elements(COALESCE(p_schedules, '[]'::jsonb)) e;

    INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
    VALUES (p_tenant_id, p_actor_id, 'batch.updated', 'batch', p_batch_id::text, gen_random_uuid()::text,
            jsonb_build_object('name', p_name, 'status', p_status, 'capacity', p_capacity, 'schedules', p_schedules));

    RETURN jsonb_build_object('success', true, 'batchId', p_batch_id);
END;
$$;
