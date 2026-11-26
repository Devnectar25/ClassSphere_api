-- ============================================================================
-- ClassSphere Migration: 023_branch_head_name.sql
-- Add head_name to tenant.branches to allow entering branch head directly
-- without requiring an existing user account.
-- ============================================================================

ALTER TABLE tenant.branches
ADD COLUMN IF NOT EXISTS head_name VARCHAR(150);

-- Backfill head_name from identity_app.users where head_user_id exists
UPDATE tenant.branches b
SET head_name = u.full_name
FROM identity_app.users u
WHERE b.head_user_id = u.user_id AND b.head_name IS NULL;
