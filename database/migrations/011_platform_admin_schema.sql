-- ============================================================================
-- ClassSphere / ClassShare Migration: 011_platform_admin_schema.sql
-- Complete Schema extensions for Platform Admin Panel:
-- Categories, Settings, Refunds, Payouts, Notification Templates, Admin Roles, Verification
-- ============================================================================

-- 1. Extend tenant.organizations for Academy Verification & Commission
ALTER TABLE tenant.organizations
ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) NOT NULL DEFAULT 'verified',
ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS cover_image TEXT,
ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. Extend academics.courses for Course Moderation & Visibility
ALTER TABLE academics.courses
ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS image_url TEXT;

-- 3. Extend identity_app.users for User Suspension & Activity Tracking
ALTER TABLE identity_app.users
ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

-- 4. Platform Dynamic Course Categories
CREATE TABLE IF NOT EXISTS platform.categories (
    category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    icon VARCHAR(100) DEFAULT 'BookOpen',
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Seed default categories if empty
INSERT INTO platform.categories (name, description, icon, display_order, is_active)
VALUES 
    ('Academics', 'K-12 coaching, science, math, competitive test preparation.', 'GraduationCap', 1, TRUE),
    ('Music', 'Vocal training, classical instruments, guitar, piano & ensembles.', 'Music', 2, TRUE),
    ('Dance & Performing Arts', 'Contemporary, classical ballet, hip hop, drama and stage craft.', 'Sparkles', 3, TRUE),
    ('Sports & Martial Arts', 'Swimming, cricket, football, karate, yoga and fitness clubs.', 'Activity', 4, TRUE),
    ('Arts & Creative Design', 'Painting, pottery, graphic design, animation and digital arts.', 'Palette', 5, TRUE),
    ('Language & Coding', 'Foreign languages, public speaking, computer programming & robotics.', 'Code', 6, TRUE)
ON CONFLICT (name) DO NOTHING;

-- 5. Platform Global Settings
CREATE TABLE IF NOT EXISTS platform.settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_by UUID
);

-- Seed default platform settings
INSERT INTO platform.settings (setting_key, category, value, description)
VALUES 
    ('commission', 'financial', '{"defaultPercentage": 10.0, "taxOnCommission": 18.0}'::jsonb, 'Platform commission rate and applicable GST percentage.'),
    ('registration', 'lifecycle', '{"defaultPaymentWindowHours": 48, "deadlineRules": "Auto-expire after window"}'::jsonb, 'Payment window for accepted registrations.'),
    ('cancellation', 'lifecycle', '{"defaultPolicy": "Full refund up to 48 hours before batch start", "allowAcademyOverrides": true}'::jsonb, 'Cancellation and learner refund rules.'),
    ('settlement', 'financial', '{"releaseSchedule": "Weekly on Mondays", "payoutHoldingDays": 7}'::jsonb, 'Academy settlement cycles and holding criteria.'),
    ('general', 'general', '{"platformName": "ClassShare", "supportEmail": "support@classshare.io", "contactNumber": "+91 80000 12345", "address": "Bangalore, KA, India"}'::jsonb, 'Public branding and support contact coordinates.'),
    ('features', 'controls', '{"enableOnlinePayments": true, "enableParentPortal": true, "enableWhitelabel": false, "enableSms": true}'::jsonb, 'Global feature toggles and capability flags.')
ON CONFLICT (setting_key) DO NOTHING;

-- 6. Refunds Management
CREATE TABLE IF NOT EXISTS platform.refunds (
    refund_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    payment_id VARCHAR(100),
    registration_id UUID,
    learner_name VARCHAR(150) NOT NULL,
    academy_name VARCHAR(200) NOT NULL,
    course_name VARCHAR(200),
    amount NUMERIC(10,2) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'requested', -- 'requested', 'under_review', 'approved', 'rejected', 'processing', 'refunded', 'failed'
    rejection_reason TEXT,
    gateway_refund_id VARCHAR(100),
    requested_by UUID,
    reviewed_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    processed_at TIMESTAMPTZ
);

-- 7. Payouts & Settlements
CREATE TABLE IF NOT EXISTS platform.payouts (
    payout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    academy_name VARCHAR(200) NOT NULL,
    total_collected NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    platform_commission NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    tax_on_commission NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    gateway_charges NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    net_academy_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    expected_release_date DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending', -- 'pending', 'upcoming', 'completed', 'held', 'failed'
    hold_reason TEXT,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 8. Notification Templates & Platform Announcements
CREATE TABLE IF NOT EXISTS platform.notification_templates (
    template_id VARCHAR(100) PRIMARY KEY,
    channel VARCHAR(30) NOT NULL, -- 'email', 'sms', 'in_app', 'whatsapp'
    title VARCHAR(200) NOT NULL,
    subject VARCHAR(255),
    content TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO platform.notification_templates (template_id, channel, title, subject, content, is_active, is_system)
VALUES 
    ('welcome_learner', 'email', 'Learner Welcome Email', 'Welcome to ClassShare!', 'Dear {{name}}, your account has been successfully created. Explore top academies and courses today.', TRUE, TRUE),
    ('academy_approved', 'email', 'Academy Verification Approved', 'Congratulations! Your Academy has been Verified', 'Dear {{ownerName}}, your academy {{academyName}} has been reviewed and approved. You can now publish courses.', TRUE, TRUE),
    ('academy_rejected', 'email', 'Academy Verification Needs Attention', 'Update on your Academy Verification Application', 'Dear {{ownerName}}, we could not verify {{academyName}} due to: {{reason}}. Please update your documents.', TRUE, TRUE),
    ('payment_receipt', 'email', 'Payment Receipt', 'Your Payment of {{amount}} is Confirmed', 'Payment of {{amount}} for {{courseName}} was successful. Receipt ID: {{paymentId}}.', TRUE, TRUE),
    ('payout_released', 'email', 'Academy Settlement Released', 'ClassShare Payout Credit Notification', 'A settlement of {{netAmount}} has been credited for {{academyName}}. Reference: {{payoutId}}.', TRUE, FALSE),
    ('system_maintenance', 'in_app', 'Platform Maintenance Notice', 'Scheduled Maintenance', 'ClassShare will be undergoing scheduled platform maintenance on Sunday at 02:00 AM IST.', TRUE, FALSE)
ON CONFLICT (template_id) DO NOTHING;

-- 9. Admin Roles & Permissions
CREATE TABLE IF NOT EXISTS platform.admin_users (
    admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES identity_app.users(user_id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'SupportAdmin', -- 'SuperAdmin', 'FinanceAdmin', 'SupportAdmin'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(user_id)
);
