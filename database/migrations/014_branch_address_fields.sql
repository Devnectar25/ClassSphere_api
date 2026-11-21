-- ============================================================================
-- ClassSphere Migration: 014_branch_address_fields.sql
-- Add country and location to tenant.branches for full physical address storage.
-- ============================================================================

ALTER TABLE tenant.branches
ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'India',
ADD COLUMN IF NOT EXISTS location VARCHAR(150);
