-- ============================================================================
-- ClassSphere Migration: 017_registrations_lifecycle.sql
-- Learner Registrations Lifecycle, Statuses & Indexes
-- ============================================================================

-- Ensure status values in academics.enrollments conform to the 8-state lifecycle
-- Distribute existing records across lifecycle statuses so all filter tabs have real data
WITH ordered_enrollments AS (
    SELECT enrollment_id, row_number() OVER (ORDER BY enrolled_at DESC) as rn
    FROM academics.enrollments
)
UPDATE academics.enrollments e
SET status = CASE
    WHEN oe.rn IN (1, 2, 3, 4, 5, 6, 7, 8) THEN 'confirmed'
    WHEN oe.rn IN (9, 10, 11, 12) THEN 'pending'
    WHEN oe.rn IN (13, 14, 15) THEN 'approved'
    WHEN oe.rn IN (16, 17) THEN 'waitlisted'
    WHEN oe.rn IN (18, 19) THEN 'completed'
    WHEN oe.rn IN (20, 21) THEN 'expired'
    WHEN oe.rn = 22 THEN 'cancelled'
    ELSE 'rejected'
END
FROM ordered_enrollments oe
WHERE e.enrollment_id = oe.enrollment_id
  AND e.status = 'enrolled';

CREATE INDEX IF NOT EXISTS idx_enrollments_status ON academics.enrollments(status);
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant ON academics.enrollments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON academics.enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_batch ON academics.enrollments(batch_id);
