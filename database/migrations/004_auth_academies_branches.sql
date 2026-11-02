-- ============================================================================
-- ClassSphere Migration: 004_auth_academies_branches.sql
-- Sign-in & role-based access, academy types, branch-wise student management.
-- Idempotent: safe on new and existing databases.
-- ============================================================================

-- Academy type ('Tuition', 'Music', 'Sports', 'Dance', 'Arts', 'Test Prep', 'Language', 'Other')
ALTER TABLE tenant.organizations ADD COLUMN IF NOT EXISTS academy_type VARCHAR(50) NOT NULL DEFAULT 'Tuition';

-- SaaS operators sign in without belonging to an academy
ALTER TABLE identity_app.users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Every student belongs to a home branch
ALTER TABLE academics.students ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES tenant.branches(branch_id);
CREATE INDEX IF NOT EXISTS idx_students_tenant_branch ON academics.students (tenant_id, branch_id);

UPDATE academics.students s
SET branch_id = COALESCE(
    (SELECT b.branch_id FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
     WHERE e.student_id = s.student_id ORDER BY e.enrolled_at LIMIT 1),
    (SELECT br.branch_id FROM tenant.branches br WHERE br.tenant_id = s.tenant_id ORDER BY br.is_primary DESC, br.created_at LIMIT 1))
WHERE s.branch_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON identity_app.users (lower(email));
