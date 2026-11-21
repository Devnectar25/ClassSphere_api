-- ============================================================================
-- ClassSphere Migration: 015_user_and_academy_friendly_ids.sql
-- Friendly Human-Readable Identifiers: USR-101... for Users, AC-101... for Academies
-- ============================================================================

-- 1. Sequences starting at 101
CREATE SEQUENCE IF NOT EXISTS identity_app.seq_user_code START WITH 101 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS tenant.seq_academy_code START WITH 101 INCREMENT BY 1;

-- 2. Add columns with default expressions
ALTER TABLE identity_app.users 
    ADD COLUMN IF NOT EXISTS user_code VARCHAR(30) UNIQUE;

ALTER TABLE tenant.organizations 
    ADD COLUMN IF NOT EXISTS academy_code VARCHAR(30) UNIQUE;

-- 3. Backfill existing identity_app.users ordered by created_at
DO $$
DECLARE
    r RECORD;
    v_num INT := 101;
BEGIN
    FOR r IN (SELECT user_id FROM identity_app.users WHERE user_code IS NULL ORDER BY created_at ASC) LOOP
        UPDATE identity_app.users SET user_code = 'USR-' || v_num WHERE user_id = r.user_id;
        v_num := v_num + 1;
    END LOOP;

    -- Ensure sequence is always strictly greater than maximum user_code in database
    PERFORM setval('identity_app.seq_user_code', GREATEST(100, (
        SELECT COALESCE(MAX(NULLIF(regexp_replace(user_code, '^USR-', ''), '')::BIGINT), 100)
        FROM identity_app.users
    )));
END;
$$;

-- 4. Backfill existing tenant.organizations ordered by created_at
DO $$
DECLARE
    r RECORD;
    v_num INT := 101;
BEGIN
    FOR r IN (SELECT tenant_id FROM tenant.organizations WHERE academy_code IS NULL ORDER BY created_at ASC) LOOP
        UPDATE tenant.organizations SET academy_code = 'AC-' || v_num WHERE tenant_id = r.tenant_id;
        v_num := v_num + 1;
    END LOOP;

    -- Ensure sequence is always strictly greater than maximum academy_code in database
    PERFORM setval('tenant.seq_academy_code', GREATEST(100, (
        SELECT COALESCE(MAX(NULLIF(regexp_replace(academy_code, '^AC-', ''), '')::BIGINT), 100)
        FROM tenant.organizations
    )));
END;
$$;

-- 5. Set column defaults using the sequences
ALTER TABLE identity_app.users 
    ALTER COLUMN user_code SET DEFAULT ('USR-' || nextval('identity_app.seq_user_code'));

ALTER TABLE tenant.organizations 
    ALTER COLUMN academy_code SET DEFAULT ('AC-' || nextval('tenant.seq_academy_code'));

-- 6. Trigger fallback to guarantee user_code and academy_code are always populated
CREATE OR REPLACE FUNCTION identity_app.fn_trg_set_user_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_code IS NULL OR btrim(NEW.user_code) = '' THEN
        NEW.user_code := 'USR-' || nextval('identity_app.seq_user_code');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_user_code ON identity_app.users;
CREATE TRIGGER trg_set_user_code
BEFORE INSERT ON identity_app.users
FOR EACH ROW
EXECUTE FUNCTION identity_app.fn_trg_set_user_code();

CREATE OR REPLACE FUNCTION tenant.fn_trg_set_academy_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.academy_code IS NULL OR btrim(NEW.academy_code) = '' THEN
        NEW.academy_code := 'AC-' || nextval('tenant.seq_academy_code');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_academy_code ON tenant.organizations;
CREATE TRIGGER trg_set_academy_code
BEFORE INSERT ON tenant.organizations
FOR EACH ROW
EXECUTE FUNCTION tenant.fn_trg_set_academy_code();

-- 7. Add indexes for fast lookup
CREATE INDEX IF NOT EXISTS ix_users_user_code ON identity_app.users(user_code);
CREATE INDEX IF NOT EXISTS ix_organizations_academy_code ON tenant.organizations(academy_code);
