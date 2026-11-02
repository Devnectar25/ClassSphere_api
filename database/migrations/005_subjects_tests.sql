-- ============================================================================
-- ClassSphere Migration: 005_subjects_tests.sql
-- Course subjects, scheduled tests, per-subject marks and grading. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS academics.course_subjects (
    subject_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES academics.courses(course_id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    code VARCHAR(30),
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (course_id, name)
);

CREATE TABLE IF NOT EXISTS academics.tests (
    test_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES academics.batches(batch_id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    test_type VARCHAR(30) NOT NULL DEFAULT 'Unit Test', -- 'Unit Test', 'Mid Term', 'Final', 'Practical', 'Assessment'
    test_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'published')),
    published_at TIMESTAMPTZ,
    created_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS academics.test_subjects (
    test_id UUID NOT NULL REFERENCES academics.tests(test_id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES academics.course_subjects(subject_id) ON DELETE CASCADE, -- subjects are removed only with their course
    max_marks NUMERIC(6,2) NOT NULL CHECK (max_marks > 0),
    PRIMARY KEY (test_id, subject_id)
);

CREATE TABLE IF NOT EXISTS academics.test_results (
    test_id UUID NOT NULL REFERENCES academics.tests(test_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES academics.course_subjects(subject_id) ON DELETE CASCADE, -- subjects are removed only with their course
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    marks_obtained NUMERIC(6,2) CHECK (marks_obtained >= 0),
    is_absent BOOLEAN NOT NULL DEFAULT FALSE,
    remarks TEXT,
    recorded_by_actor_id UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (test_id, student_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_course_subjects_course ON academics.course_subjects (tenant_id, course_id);
CREATE INDEX IF NOT EXISTS idx_tests_batch ON academics.tests (tenant_id, batch_id, test_date);
CREATE INDEX IF NOT EXISTS idx_test_results_student ON academics.test_results (tenant_id, student_id);
