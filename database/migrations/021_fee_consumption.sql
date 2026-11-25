-- ============================================================================
-- ClassSphere Migration: 021_fee_consumption.sql
-- Attendance-based consumed fee: class conducted / cancelled records, fee-consumption policy and verification reviews.
-- Attendance itself stays in academics.attendance_records. Idempotent.
-- ============================================================================

-- 1. Whether a class of a batch took place on a date (only recorded when someone confirms it)
CREATE TABLE IF NOT EXISTS academics.class_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES academics.batches(batch_id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('conducted', 'cancelled')),
    reason TEXT NOT NULL,
    confirmed_by_actor_id UUID NOT NULL,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (batch_id, session_date)
);

-- 2. How fees are consumed: academy default (course_id NULL) or per course. Without one, Finance reviews every case.
CREATE TABLE IF NOT EXISTS billing.fee_consumption_policies (
    policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    course_id UUID REFERENCES academics.courses(course_id) ON DELETE CASCADE,
    method VARCHAR(20) NOT NULL CHECK (method IN ('monthly', 'session', 'manual')),
    absent_counts BOOLEAN NOT NULL DEFAULT TRUE,
    excused_counts BOOLEAN NOT NULL DEFAULT TRUE,
    cancelled_counts BOOLEAN NOT NULL DEFAULT FALSE,
    partial_period VARCHAR(20) NOT NULL DEFAULT 'not_counted' CHECK (partial_period IN ('not_counted', 'full')),
    require_verification BOOLEAN NOT NULL DEFAULT TRUE, -- transfers with payments wait for a verified consumed fee
    updated_by_actor_id UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumption_policy_default ON billing.fee_consumption_policies (tenant_id) WHERE course_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumption_policy_course ON billing.fee_consumption_policies (tenant_id, course_id) WHERE course_id IS NOT NULL;

-- 3. Requests for verification and Finance's manual decisions on one enrollment
CREATE TABLE IF NOT EXISTS billing.consumption_reviews (
    review_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    enrollment_id UUID NOT NULL REFERENCES academics.enrollments(enrollment_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('request', 'manual')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'closed', 'verified')),
    transfer_id UUID REFERENCES billing.course_transfers(transfer_id), -- decision made for this transfer only
    until_date DATE NOT NULL,
    consumed_amount NUMERIC(10,2) CHECK (consumed_amount >= 0),
    reason TEXT,
    snapshot JSONB,
    created_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    closed_at TIMESTAMPTZ,
    CHECK (kind <> 'manual' OR (consumed_amount IS NOT NULL AND reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumption_review_open ON billing.consumption_reviews (enrollment_id) WHERE kind = 'request' AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_consumption_review_enrollment ON billing.consumption_reviews (tenant_id, enrollment_id, created_at);

-- 4. What a transfer credit decision was based on
ALTER TABLE billing.course_transfers
ADD COLUMN IF NOT EXISTS consumption_method VARCHAR(20),
ADD COLUMN IF NOT EXISTS consumption_snapshot JSONB;
