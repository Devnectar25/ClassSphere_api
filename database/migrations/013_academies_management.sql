-- ============================================================================
-- ClassSphere Migration: 013_academies_management.sql
-- Academies Management: documents, location fields, suspension metadata,
-- sample verification documents, and initial pending/rejected fixtures.
-- Idempotent.
-- ============================================================================

-- 1. Ensure columns exist on tenant.organizations
ALTER TABLE tenant.organizations
ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 10.00,
ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS cover_image TEXT,
ADD COLUMN IF NOT EXISTS description TEXT,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS suspended_by UUID;

CREATE INDEX IF NOT EXISTS ix_organizations_verification ON tenant.organizations (verification_status);
CREATE INDEX IF NOT EXISTS ix_organizations_status ON tenant.organizations (status);

-- 2. Ensure location columns on tenant.branches
ALTER TABLE tenant.branches
ADD COLUMN IF NOT EXISTS city VARCHAR(100),
ADD COLUMN IF NOT EXISTS state VARCHAR(100),
ADD COLUMN IF NOT EXISTS pincode VARCHAR(20);

-- Populate location on primary branches from organization settings where missing
UPDATE tenant.branches b
SET city = COALESCE(b.city, o.settings->>'city', 'New York'),
    state = COALESCE(b.state, o.settings->>'state', 'NY'),
    pincode = COALESCE(b.pincode, o.settings->>'pincode', '10001')
FROM tenant.organizations o
WHERE b.tenant_id = o.tenant_id AND b.is_primary = true AND (b.city IS NULL OR b.city = '');

-- 3. Populate default verification documents for verified academies with empty documents
UPDATE tenant.organizations
SET documents = jsonb_build_array(
    jsonb_build_object(
        'id', 'doc-inc-01',
        'title', 'Certificate of Academy Incorporation',
        'type', 'incorporation_certificate',
        'url', '/api/v1/platform/academies/documents/download?type=incorporation',
        'status', 'verified',
        'verifiedAt', created_at,
        'size', '1.8 MB',
        'uploadedAt', created_at
    ),
    jsonb_build_object(
        'id', 'doc-tax-02',
        'title', 'GST & Tax Identification Proof',
        'type', 'tax_id',
        'url', '/api/v1/platform/academies/documents/download?type=tax_id',
        'status', 'verified',
        'verifiedAt', created_at,
        'size', '840 KB',
        'uploadedAt', created_at
    ),
    jsonb_build_object(
        'id', 'doc-own-03',
        'title', 'Government Photo ID of Academy Owner',
        'type', 'owner_identity',
        'url', '/api/v1/platform/academies/documents/download?type=owner_id',
        'status', 'verified',
        'verifiedAt', created_at,
        'size', '1.2 MB',
        'uploadedAt', created_at
    )
)
WHERE verification_status = 'verified' AND (documents IS NULL OR documents = '[]'::jsonb);

-- 4. Ensure realistic Pending and Rejected academies exist for admin review testing
DO $$
DECLARE
    v_pending_id UUID := '00000000-0000-0000-0000-000000000091';
    v_rejected_id UUID := '00000000-0000-0000-0000-000000000092';
    v_pending_user UUID := '00000000-0000-0000-0000-000000000093';
    v_rejected_user UUID := '00000000-0000-0000-0000-000000000094';
BEGIN
    -- Pending Academy: Harmony School of Music
    IF NOT EXISTS (SELECT 1 FROM tenant.organizations WHERE tenant_id = v_pending_id) THEN
        INSERT INTO tenant.organizations (
            tenant_id, name, slug, academy_type, status, verification_status, commission_rate,
            currency, timezone, created_at, updated_at, description,
            settings, documents
        ) VALUES (
            v_pending_id, 'Harmony School of Fine Arts', 'harmony-fine-arts', 'Music', 'active', 'pending', 10.00,
            'INR', 'Asia/Kolkata', clock_timestamp() - INTERVAL '2 days', clock_timestamp() - INTERVAL '2 days',
            'Premier western classical piano and violin conservatory established in 2018.',
            '{"city": "Mumbai", "state": "Maharashtra", "pincode": "400050", "phone": "+91 98201 11222", "email": "admissions@harmonyarts.org"}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('id', 'doc-h1', 'title', 'Educational Society Registration Certificate', 'type', 'incorporation_certificate', 'url', '/api/v1/platform/academies/documents/download?type=incorporation', 'status', 'pending', 'size', '2.4 MB', 'uploadedAt', clock_timestamp() - INTERVAL '2 days'),
                jsonb_build_object('id', 'doc-h2', 'title', 'Pan Card & GST Compliance', 'type', 'tax_id', 'url', '/api/v1/platform/academies/documents/download?type=tax_id', 'status', 'pending', 'size', '950 KB', 'uploadedAt', clock_timestamp() - INTERVAL '2 days'),
                jsonb_build_object('id', 'doc-h3', 'title', 'Trinity College London Affiliation Letter', 'type', 'accreditation', 'url', '/api/v1/platform/academies/documents/download?type=affiliation', 'status', 'pending', 'size', '1.1 MB', 'uploadedAt', clock_timestamp() - INTERVAL '2 days')
            )
        );

        INSERT INTO identity_app.users (user_id, email, password_hash, full_name, phone, is_active, is_suspended, created_at)
        VALUES (v_pending_user, 'director@harmonyarts.org', '!', 'Vikramaditya Singhania', '+91 98201 11222', true, false, clock_timestamp() - INTERVAL '2 days')
        ON CONFLICT (user_id) DO NOTHING;

        INSERT INTO tenant.memberships (tenant_id, user_id, role, title, is_active, created_at)
        VALUES (v_pending_id, v_pending_user, 'TenantAdmin', 'Managing Director', true, clock_timestamp() - INTERVAL '2 days')
        ON CONFLICT DO NOTHING;

        INSERT INTO tenant.branches (branch_id, tenant_id, name, code, address, city, state, pincode, phone, email, head_user_id, is_primary, is_active)
        VALUES (gen_random_uuid(), v_pending_id, 'Bandra West Studios', 'BW01', 'Plot 42, Hill Road, Bandra West', 'Mumbai', 'Maharashtra', '400050', '+91 98201 11222', 'bandra@harmonyarts.org', v_pending_user, true, true);

        INSERT INTO platform.subscriptions (subscription_id, tenant_id, plan_tier, status, max_seats, max_branches, mrr, current_period_end)
        VALUES (gen_random_uuid(), v_pending_id, 'Professional', 'active', 250, 3, 2499.00, CURRENT_DATE + 30)
        ON CONFLICT DO NOTHING;
    END IF;

    -- Rejected Academy: Velocity Martial Arts Studio
    IF NOT EXISTS (SELECT 1 FROM tenant.organizations WHERE tenant_id = v_rejected_id) THEN
        INSERT INTO tenant.organizations (
            tenant_id, name, slug, academy_type, status, verification_status, rejection_reason, commission_rate,
            currency, timezone, created_at, updated_at, description,
            settings, documents
        ) VALUES (
            v_rejected_id, 'Velocity Martial Arts Academy', 'velocity-martial-arts', 'Karate', 'active', 'rejected',
            'Business registration certificate is expired and owner identity proof was unreadable. Please submit valid government documentation.',
            10.00, 'INR', 'Asia/Kolkata', clock_timestamp() - INTERVAL '5 days', clock_timestamp() - INTERVAL '1 day',
            'Dojo offering traditional Shotokan Karate and sports kickboxing for youth.',
            '{"city": "Bengaluru", "state": "Karnataka", "pincode": "560038", "phone": "+91 97400 33445", "email": "info@velocitykarate.in"}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('id', 'doc-v1', 'title', 'Expired Trade License', 'type', 'incorporation_certificate', 'url', '/api/v1/platform/academies/documents/download?type=incorporation', 'status', 'rejected', 'size', '1.1 MB', 'uploadedAt', clock_timestamp() - INTERVAL '5 days')
            )
        );

        INSERT INTO identity_app.users (user_id, email, password_hash, full_name, phone, is_active, is_suspended, created_at)
        VALUES (v_rejected_user, 'sensei.arjun@velocitykarate.in', '!', 'Arjun Deshmukh', '+91 97400 33445', true, false, clock_timestamp() - INTERVAL '5 days')
        ON CONFLICT (user_id) DO NOTHING;

        INSERT INTO tenant.memberships (tenant_id, user_id, role, title, is_active, created_at)
        VALUES (v_rejected_id, v_rejected_user, 'TenantAdmin', 'Chief Instructor & Founder', true, clock_timestamp() - INTERVAL '5 days')
        ON CONFLICT DO NOTHING;

        INSERT INTO tenant.branches (branch_id, tenant_id, name, code, address, city, state, pincode, phone, email, head_user_id, is_primary, is_active)
        VALUES (gen_random_uuid(), v_rejected_id, 'Indiranagar Dojo', 'IN01', '100 Feet Road, HAL 2nd Stage, Indiranagar', 'Bengaluru', 'Karnataka', '560038', '+91 97400 33445', 'info@velocitykarate.in', v_rejected_user, true, true);

        INSERT INTO platform.subscriptions (subscription_id, tenant_id, plan_tier, status, max_seats, max_branches, mrr, current_period_end)
        VALUES (gen_random_uuid(), v_rejected_id, 'Starter', 'active', 100, 1, 999.00, CURRENT_DATE + 30)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
