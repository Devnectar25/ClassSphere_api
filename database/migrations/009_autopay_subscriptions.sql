-- ============================================================================
-- ClassSphere Migration: 009_autopay_subscriptions.sql
-- Autopay Subscriptions & Recurring Mandates Schema Extension
-- ============================================================================

ALTER TABLE platform.registration_payments
ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_reg_payments_sub ON platform.registration_payments(subscription_id);

ALTER TABLE platform.subscriptions
ADD COLUMN IF NOT EXISTS gateway_subscription_id VARCHAR(100);

ALTER TABLE platform.plans
ADD COLUMN IF NOT EXISTS razorpay_plan_id VARCHAR(100);

-- Link pre-created monthly recurring plans in Razorpay
UPDATE platform.plans SET razorpay_plan_id = 'plan_U2Mo5I7kb6fo9p' WHERE plan_tier = 'Starter';
UPDATE platform.plans SET razorpay_plan_id = 'plan_U2Mpx1pHYgVwzT' WHERE plan_tier = 'Professional';
UPDATE platform.plans SET razorpay_plan_id = 'plan_U2Mpx1k3rSBPM7' WHERE plan_tier = 'Enterprise';
