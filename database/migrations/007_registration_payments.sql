-- ============================================================================
-- ClassSphere Migration: 007_registration_payments.sql
-- Production Razorpay Payment & Academy Registration Lifecycle Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.registration_payments (
    registration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(100) NOT NULL UNIQUE,
    payment_id VARCHAR(100) UNIQUE,
    plan_tier VARCHAR(50) NOT NULL REFERENCES platform.plans(plan_tier),
    plan_name VARCHAR(100) NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    payment_status VARCHAR(30) NOT NULL DEFAULT 'pending', -- 'pending', 'success', 'failed', 'cancelled'
    payment_method VARCHAR(50), -- 'upi', 'card', 'netbanking', 'wallet', 'emi'
    transaction_date TIMESTAMPTZ,
    subscription_start_date TIMESTAMPTZ,
    subscription_end_date TIMESTAMPTZ,
    registration_payload JSONB NOT NULL,
    tenant_id UUID,
    admin_user_id UUID,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_reg_payments_order ON platform.registration_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_reg_payments_payment ON platform.registration_payments(payment_id);
CREATE INDEX IF NOT EXISTS idx_reg_payments_status ON platform.registration_payments(payment_status);

ALTER TABLE platform.subscriptions
ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS gateway_payment_id VARCHAR(100);
