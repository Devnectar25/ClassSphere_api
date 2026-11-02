-- ============================================================================
-- ClassSphere PostgreSQL Baseline Migration: 002_create_tables.sql
-- Traceability: TDD Section 10.1-10.2, 11, 14, 15, 19; PLT-006, PLT-011
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PLATFORM SCHEMA (SaaS Plans, Subscriptions & Global Config)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.plans (
    plan_tier VARCHAR(50) PRIMARY KEY, -- 'Starter', 'Professional', 'Enterprise'
    description TEXT NOT NULL,
    price_monthly NUMERIC(10,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    max_seats INT NOT NULL,
    max_branches INT NOT NULL,
    features TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_popular BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS platform.subscriptions (
    subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    plan_tier VARCHAR(50) NOT NULL REFERENCES platform.plans(plan_tier),
    status VARCHAR(30) NOT NULL DEFAULT 'active', -- 'trialing', 'active', 'suspended', 'canceled'
    max_seats INT NOT NULL DEFAULT 100,
    max_branches INT NOT NULL DEFAULT 1,
    storage_limit_gb NUMERIC(8,2) NOT NULL DEFAULT 10.0,
    mrr NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly',
    trial_ends_at TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    current_period_end TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '30 days'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- 2. IDENTITY_APP SCHEMA (Users, Sessions, MFA Bindings)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_app.users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret_encrypted VARCHAR(255),
    mfa_recovery_codes_hash TEXT[],
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS identity_app.user_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES identity_app.users(user_id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- 3. TENANT SCHEMA (Workspaces, Branches, Memberships, RBAC)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant.organizations (
    tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    domain VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'active', -- 'active', 'suspended', 'trial'
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
    branding JSONB NOT NULL DEFAULT '{"primaryColor": "#1E3A8A", "logoUrl": null}'::jsonb,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb, -- category, contact, academicSession, notification triggers
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS tenant.branches (
    branch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    code VARCHAR(50) NOT NULL,
    address TEXT,
    phone VARCHAR(50),
    email VARCHAR(255),
    head_user_id UUID REFERENCES identity_app.users(user_id),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS tenant.memberships (
    membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES identity_app.users(user_id) ON DELETE CASCADE,
    branch_id UUID REFERENCES tenant.branches(branch_id),
    role VARCHAR(50) NOT NULL, -- 'TenantAdmin', 'Staff', 'Instructor', 'Finance', 'Guardian'
    title VARCHAR(150),
    profile JSONB NOT NULL DEFAULT '{}'::jsonb, -- office, distinction, avatarUrl
    permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, user_id, role)
);

-- ----------------------------------------------------------------------------
-- 4. ACADEMICS SCHEMA (Courses, Batches, Students, Guardians, Attendance)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academics.courses (
    course_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    category VARCHAR(100) NOT NULL, -- 'Music', 'Arts', 'TestPrep', 'Academics', 'Sports'
    level VARCHAR(100),
    duration_months INT,
    tuition_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    billing_period VARCHAR(30) NOT NULL DEFAULT 'monthly', -- 'monthly', 'term', 'annual'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS academics.batches (
    batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES academics.courses(course_id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL REFERENCES tenant.branches(branch_id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    instructor_user_id UUID REFERENCES identity_app.users(user_id),
    room VARCHAR(100),
    capacity INT NOT NULL DEFAULT 30,
    status VARCHAR(30) NOT NULL DEFAULT 'active', -- 'upcoming', 'active', 'completed'
    start_date DATE NOT NULL,
    end_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS academics.batch_schedules (
    schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES academics.batches(batch_id) ON DELETE CASCADE,
    weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1 = Monday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    session_type VARCHAR(50) NOT NULL DEFAULT 'Class', -- 'Intensive', 'Seminar', 'Ensemble', 'Rehearsal'
    UNIQUE(batch_id, weekday, start_time)
);

CREATE TABLE IF NOT EXISTS academics.students (
    student_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    preferred_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(50),
    date_of_birth DATE,
    enrollment_number VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active', -- 'inquiry', 'active', 'on-hold', 'completed', 'withdrawn'
    academic_standing VARCHAR(50) DEFAULT 'Good Standing',
    matriculation_year VARCHAR(10),
    profile JSONB NOT NULL DEFAULT '{}'::jsonb, -- division, track, standingRoster, juryStatus, juryDate, practiceSuite
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, enrollment_number)
);

CREATE TABLE IF NOT EXISTS academics.guardians (
    guardian_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    user_id UUID REFERENCES identity_app.users(user_id),
    household_code VARCHAR(50) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    relationship VARCHAR(50) NOT NULL DEFAULT 'Parent',
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS academics.student_guardian_links (
    link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    guardian_id UUID NOT NULL REFERENCES academics.guardians(guardian_id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(student_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS academics.enrollments (
    enrollment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES academics.batches(batch_id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'enrolled', -- 'enrolled', 'waitlisted', 'dropped', 'completed'
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(student_id, batch_id)
);

CREATE TABLE IF NOT EXISTS academics.attendance_records (
    attendance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES academics.batches(batch_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'excused', 'late')),
    remarks TEXT,
    recorded_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, batch_id, student_id, session_date)
);

CREATE TABLE IF NOT EXISTS academics.absence_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    absence_date DATE NOT NULL,
    reason TEXT NOT NULL,
    makeup_requested BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'submitted', -- 'submitted', 'approved', 'rejected'
    requested_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- 5. BILLING SCHEMA (Strictly Append-Only Ledger, Invoices, Payments, Receipts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.fee_heads (
    fee_head_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    frequency VARCHAR(30) NOT NULL DEFAULT 'one-time', -- 'one-time', 'monthly', 'term', 'annual'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS billing.fee_plans (
    plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    course_id UUID REFERENCES academics.courses(course_id),
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    due_day_of_month INT NOT NULL DEFAULT 5,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS billing.fee_plan_items (
    plan_id UUID NOT NULL REFERENCES billing.fee_plans(plan_id) ON DELETE CASCADE,
    fee_head_id UUID NOT NULL REFERENCES billing.fee_heads(fee_head_id) ON DELETE RESTRICT,
    amount NUMERIC(10,2) NOT NULL,
    PRIMARY KEY (plan_id, fee_head_id)
);

CREATE TABLE IF NOT EXISTS billing.invoices (
    invoice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    invoice_number VARCHAR(50) NOT NULL,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE RESTRICT,
    billing_period VARCHAR(50) NOT NULL,
    subtotal_amount NUMERIC(10,2) NOT NULL,
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(10,2) NOT NULL,
    paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    balance_amount NUMERIC(10,2) NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending', -- 'draft', 'pending', 'paid', 'partially_paid', 'void'
    designation TEXT NOT NULL,
    idempotency_key VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS billing.payments (
    payment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES billing.invoices(invoice_id) ON DELETE RESTRICT,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE RESTRICT,
    payment_reference VARCHAR(100) NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    payment_method VARCHAR(50) NOT NULL, -- 'Razorpay', 'Card', 'UPI', 'BankWire', 'Cash', 'Cheque'
    status VARCHAR(30) NOT NULL DEFAULT 'posted', -- 'posted', 'reconciled', 'refunded', 'reversed'
    receipt_number VARCHAR(50) NOT NULL,
    gateway_order_id VARCHAR(100),
    gateway_payment_id VARCHAR(100),
    idempotency_key VARCHAR(100),
    recorded_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tenant_id, receipt_number)
);

-- ----------------------------------------------------------------------------
-- 6. ENGAGEMENT SCHEMA (Notices, Achievements, Events, Practice, Advisory)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engagement.notices (
    notice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    notice_type VARCHAR(30) NOT NULL DEFAULT 'notice', -- 'announcement', 'notice', 'alert', 'event'
    status VARCHAR(20) NOT NULL DEFAULT 'published', -- 'draft', 'scheduled', 'published'
    priority VARCHAR(20) NOT NULL DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
    target_audience VARCHAR(50) NOT NULL DEFAULT 'all', -- 'all', 'guardians', 'students', 'staff', 'batch'
    target_batch_id UUID REFERENCES academics.batches(batch_id),
    branch_id UUID REFERENCES tenant.branches(branch_id),
    channels TEXT[] NOT NULL DEFAULT ARRAY['in-app']::TEXT[],
    author_actor_id UUID NOT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS engagement.achievements (
    achievement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100) NOT NULL, -- 'Distinction', 'Honors', 'Competition', 'Certification'
    level VARCHAR(50) NOT NULL DEFAULT 'Institute', -- 'Institute', 'City', 'District', 'State', 'National'
    visibility VARCHAR(20) NOT NULL DEFAULT 'guardian', -- 'public', 'batch', 'guardian', 'private'
    award_date DATE NOT NULL,
    issuer VARCHAR(150) NOT NULL,
    grade VARCHAR(50),
    remarks TEXT,
    photo_file_key VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS engagement.events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    event_type VARCHAR(30) NOT NULL DEFAULT 'event', -- 'event', 'test', 'session', 'fee'
    starts_at TIMESTAMPTZ NOT NULL,
    venue VARCHAR(255),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS engagement.event_participants (
    event_id UUID NOT NULL REFERENCES engagement.events(event_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    role_label VARCHAR(150),
    program VARCHAR(255),
    seating VARCHAR(255),
    guaranteed_seats INT NOT NULL DEFAULT 0,
    seats_claimed_at TIMESTAMPTZ,
    PRIMARY KEY (event_id, student_id)
);

CREATE TABLE IF NOT EXISTS engagement.practice_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    log_date DATE NOT NULL,
    hours NUMERIC(4,1) NOT NULL CHECK (hours > 0 AND hours <= 24),
    piece VARCHAR(255),
    notes TEXT,
    recorded_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS engagement.advisory_bookings (
    booking_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant.organizations(tenant_id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES academics.students(student_id) ON DELETE CASCADE,
    mentor_user_id UUID REFERENCES identity_app.users(user_id),
    slot_at TIMESTAMPTZ NOT NULL,
    topic TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'requested', -- 'requested', 'confirmed', 'cancelled'
    requested_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- 7. AUDIT SCHEMA (Append-Only Immutable Security & Compliance Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.compliance_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    actor_id UUID,
    action VARCHAR(100) NOT NULL, -- 'auth.login', 'billing.payment_posted', 'student.created', etc.
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100),
    ip_address VARCHAR(45),
    correlation_id VARCHAR(100) NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- 8. INTEGRATION SCHEMA (MassTransit / RabbitMQ Transactional Outbox & Inbox)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration.outbox_messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    correlation_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(150) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    processed_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS integration.inbox_processed_events (
    event_id VARCHAR(100) PRIMARY KEY,
    consumer_name VARCHAR(150) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- COMPOSITE INDEXES FOR PERFORMANCE & STRICT TENANT ISOLATION (TDD 10.1, 11)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_memberships_tenant_user ON tenant.memberships (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_courses_tenant ON academics.courses (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_batches_tenant ON academics.batches (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_batch_schedules_batch ON academics.batch_schedules (tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_students_tenant_status ON academics.students (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_guardian_links_guardian ON academics.student_guardian_links (tenant_id, guardian_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON academics.enrollments (tenant_id, student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_batch ON academics.enrollments (tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_attendance_batch_date ON academics.attendance_records (tenant_id, batch_id, session_date);
CREATE INDEX IF NOT EXISTS idx_invoices_student ON billing.invoices (tenant_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON billing.invoices (tenant_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON billing.payments (tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_notices_tenant ON engagement.notices (tenant_id, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_practice_logs_student ON engagement.practice_logs (tenant_id, student_id, log_date);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON engagement.events (tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action ON audit.compliance_logs (tenant_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed ON integration.outbox_messages (processed_at) WHERE processed_at IS NULL;
