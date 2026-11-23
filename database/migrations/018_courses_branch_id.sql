-- Migration 018: Add branch_id to academics.courses for branch-scoped courses
ALTER TABLE academics.courses
ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES tenant.branches(branch_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_branch ON academics.courses(tenant_id, branch_id);

-- Update academics.fn_course_list to return branch_id and branch_name
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
               c.tuition_amount, c.billing_period, c.is_active, c.branch_id,
               COALESCE(b.name, 'All Branches') AS branch_name,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_id', cs.subject_id, 'name', cs.name) ORDER BY cs.sort_order, cs.name)
                         FROM academics.course_subjects cs WHERE cs.course_id = c.course_id), '[]'::jsonb) AS subjects,
               (SELECT COUNT(*) FROM academics.batches bt WHERE bt.course_id = c.course_id) AS batch_count,
               (SELECT COUNT(DISTINCT e.student_id)
                FROM academics.enrollments e JOIN academics.batches bt ON bt.batch_id = e.batch_id
                WHERE bt.course_id = c.course_id AND e.status = 'enrolled') AS student_count
        FROM academics.courses c
        LEFT JOIN tenant.branches b ON b.branch_id = c.branch_id
        WHERE c.tenant_id = p_tenant_id
    ) r;
$$;
