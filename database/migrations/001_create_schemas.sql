-- ============================================================================
-- ClassSphere PostgreSQL Baseline Migration: 001_create_schemas.sql
-- Traceability: TDD Section 10.1, PLT-006
-- ============================================================================

-- Logical Schema Partitioning per TDD Section 10.1
CREATE SCHEMA IF NOT EXISTS platform;       -- SaaS subscriptions, plans, global config
CREATE SCHEMA IF NOT EXISTS identity_app;   -- User credentials, MFA bindings, sessions
CREATE SCHEMA IF NOT EXISTS tenant;         -- Organizations, branches, memberships, settings
CREATE SCHEMA IF NOT EXISTS academics;      -- Courses, batches, sessions, students, attendance
CREATE SCHEMA IF NOT EXISTS billing;        -- Fee heads, payment plans, invoices, discounts
CREATE SCHEMA IF NOT EXISTS engagement;     -- Notices, circulars, achievements, notifications
CREATE SCHEMA IF NOT EXISTS reporting;      -- Read models, summaries, audit views
CREATE SCHEMA IF NOT EXISTS audit;          -- Append-only immutable compliance & security audit
CREATE SCHEMA IF NOT EXISTS integration;    -- Transactional outbox, inbox, webhooks

COMMENT ON SCHEMA platform IS 'SaaS platform management, tenant plans, and subscription entitlements';
COMMENT ON SCHEMA identity_app IS 'Identity provider abstraction, user credentials, MFA, and sessions';
COMMENT ON SCHEMA tenant IS 'Multi-tenant workspaces, branches, and role assignments';
COMMENT ON SCHEMA academics IS 'Academic operations, student rosters, batches, and attendance logs';
COMMENT ON SCHEMA billing IS 'Append-only bursar ledger, fee plans, invoices, and payments';
COMMENT ON SCHEMA engagement IS 'Circulars, broadcasts, achievements, and notifications';
COMMENT ON SCHEMA reporting IS 'Aggregated read models and operational reporting';
COMMENT ON SCHEMA audit IS 'Append-only immutable audit trail for security and financial actions';
COMMENT ON SCHEMA integration IS 'MassTransit/RabbitMQ transactional outbox and provider event logs';
