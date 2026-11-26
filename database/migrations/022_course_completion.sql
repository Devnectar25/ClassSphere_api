-- Migration 022: Course Completion Management System
-- Schema and structures for course completion settings, tracking, review, and finalization

-- 1. Course completion policy configuration
ALTER TABLE academics.courses
ADD COLUMN IF NOT EXISTS completion_policy JSONB NOT NULL DEFAULT '{
    "enabled": false,
    "minAttendancePct": 75,
    "requiredSessions": 0,
    "requiredAssessments": 1,
    "minPassingMarks": 40,
    "requireApproval": true,
    "checkAttendance": true,
    "checkAssessments": true,
    "checkMarks": true,
    "checkSessions": false,
    "checkDuration": false
}'::jsonb;

-- 2. Course completions record table
CREATE TABLE IF NOT EXISTS academics.course_completions (
    completion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    enrollment_id UUID NOT NULL REFERENCES academics.enrollments(enrollment_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES academics.courses(course_id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES academics.batches(batch_id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'returned', 'pending_approval')),
    completion_date DATE NOT NULL DEFAULT CURRENT_DATE,
    final_result VARCHAR(100) NOT NULL DEFAULT 'Passed',
    attendance_rate NUMERIC(5,2) DEFAULT 0.00,
    sessions_attended INT DEFAULT 0,
    sessions_total INT DEFAULT 0,
    assessments_completed INT DEFAULT 0,
    assessments_total INT DEFAULT 0,
    average_score NUMERIC(5,2) DEFAULT 0.00,
    approved_by_actor_id UUID REFERENCES identity_app.users(user_id) ON DELETE SET NULL,
    remarks TEXT,
    return_remarks TEXT,
    metrics_snapshot JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (enrollment_id)
);

CREATE INDEX IF NOT EXISTS idx_course_completions_tenant ON academics.course_completions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_course_completions_student ON academics.course_completions (tenant_id, student_id);
CREATE INDEX IF NOT EXISTS idx_course_completions_course ON academics.course_completions (tenant_id, course_id);
CREATE INDEX IF NOT EXISTS idx_course_completions_batch ON academics.course_completions (tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_course_completions_status ON academics.course_completions (tenant_id, status);
