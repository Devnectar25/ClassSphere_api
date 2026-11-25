-- Migration 018: Add branch_id to academics.courses for branch-scoped courses
ALTER TABLE academics.courses
ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES tenant.branches(branch_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_branch ON academics.courses(tenant_id, branch_id);

-- Optional start date shown on the course catalogue
ALTER TABLE academics.courses
ADD COLUMN IF NOT EXISTS start_date DATE;

-- academics.fn_course_list, which returns these columns, lives in functions/002_academics_functions.sql.
-- Functions are applied after migrations, so a copy here would be overwritten on every db:migrate.
