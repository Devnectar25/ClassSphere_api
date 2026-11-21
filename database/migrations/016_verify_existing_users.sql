-- ============================================================================
-- ClassSphere Migration: 016_verify_existing_users.sql
-- Auto-verify email and phone for existing users with registered credentials.
-- ============================================================================

UPDATE identity_app.users
SET email_verified_at = COALESCE(email_verified_at, created_at, clock_timestamp())
WHERE email IS NOT NULL AND email_verified_at IS NULL;

UPDATE identity_app.users
SET phone_verified_at = COALESCE(phone_verified_at, created_at, clock_timestamp())
WHERE phone IS NOT NULL AND phone_verified_at IS NULL;
