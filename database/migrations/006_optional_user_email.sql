-- ============================================================================
-- ClassSphere Migration: 006_optional_user_email.sql
-- Self-service sign-up may omit the email: such owners sign in with their mobile number.
-- Email stays UNIQUE (multiple NULLs are allowed). Idempotent.
-- ============================================================================

ALTER TABLE identity_app.users ALTER COLUMN email DROP NOT NULL;

-- Sign-in by mobile compares the last 10 digits of the stored phone
CREATE INDEX IF NOT EXISTS ix_users_phone_digits
    ON identity_app.users ((right(regexp_replace(phone, '\D', '', 'g'), 10)))
    WHERE phone IS NOT NULL;
