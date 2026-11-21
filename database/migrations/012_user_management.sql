-- ============================================================================
-- ClassSphere Migration: 012_user_management.sql
-- Platform Users Management: verification flags, suspension metadata and history,
-- and notification templates for account status changes. Idempotent.
-- Suspension never deletes a user: rows and relationships stay intact.
-- ============================================================================

-- 1. Verification and suspension metadata on users
ALTER TABLE identity_app.users
ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS suspended_by UUID;

CREATE INDEX IF NOT EXISTS ix_users_suspended ON identity_app.users (is_suspended);
CREATE INDEX IF NOT EXISTS ix_users_created ON identity_app.users (created_at DESC);

-- 2. Suspension / reactivation history (one row per status change)
CREATE TABLE IF NOT EXISTS identity_app.user_status_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES identity_app.users(user_id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK (action IN ('suspended', 'reactivated')),
    reason TEXT,
    actor_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_user_status_history_user ON identity_app.user_status_history (user_id, created_at DESC);

-- Backfill history from status changes recorded in the audit trail before this table existed
INSERT INTO identity_app.user_status_history (user_id, action, reason, actor_id, created_at)
SELECT u.user_id,
       CASE WHEN l.action = 'user.suspended' THEN 'suspended' ELSE 'reactivated' END,
       l.details->>'reason',
       l.actor_id,
       l.created_at
FROM audit.compliance_logs l
JOIN identity_app.users u ON u.user_id::text = l.entity_id
WHERE l.entity_type = 'user'
  AND l.action IN ('user.suspended', 'user.reactivated')
  AND NOT EXISTS (SELECT 1 FROM identity_app.user_status_history h WHERE h.user_id = u.user_id);

-- Currently suspended users without a timestamp: use their latest suspension event, else now
UPDATE identity_app.users u
SET suspended_at = COALESCE(
        (SELECT MAX(h.created_at) FROM identity_app.user_status_history h WHERE h.user_id = u.user_id AND h.action = 'suspended'),
        clock_timestamp())
WHERE u.is_suspended AND u.suspended_at IS NULL;

-- 3. Notification templates for account status changes
INSERT INTO platform.notification_templates (template_id, channel, title, subject, content, is_active, is_system)
VALUES
    ('account_suspended', 'email', 'Account Suspended', 'Your ClassShare account has been suspended',
     'Dear {{name}}, your ClassShare account has been suspended. Reason: {{reason}}. Please contact support if you believe this is a mistake.', TRUE, TRUE),
    ('account_reactivated', 'email', 'Account Reactivated', 'Your ClassShare account has been reactivated',
     'Dear {{name}}, your ClassShare account has been reactivated. You can sign in and continue using your courses.', TRUE, TRUE)
ON CONFLICT (template_id) DO NOTHING;
