-- ============================================================================
-- ClassSphere Roles & Grants: 001_roles_and_grants.sql
-- Traceability: TDD Section 10.2, 19; PLT-006, DECISION-002
-- Strict Least-Privilege Execution Boundary: Zero Direct Table CRUD
-- Role passwords are never committed; set them per environment with
--   ALTER ROLE classsphere_runtime PASSWORD '<from secret manager>';
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'classsphere_runtime') THEN
        CREATE ROLE classsphere_runtime WITH LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'classsphere_migration') THEN
        CREATE ROLE classsphere_migration WITH LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'classsphere_reporting') THEN
        CREATE ROLE classsphere_reporting WITH LOGIN;
    END IF;
END $$;

-- Revoke default public permissions
REVOKE ALL ON ALL TABLES IN SCHEMA platform, identity_app, tenant, academics, billing, engagement, reporting, audit, integration FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform, identity_app, tenant, academics, billing, engagement, reporting, audit, integration FROM PUBLIC;

-- Migration role receives full DDL privileges
GRANT ALL ON SCHEMA platform, identity_app, tenant, academics, billing, engagement, reporting, audit, integration TO classsphere_migration;
GRANT ALL ON ALL TABLES IN SCHEMA platform, identity_app, tenant, academics, billing, engagement, reporting, audit, integration TO classsphere_migration;

-- Runtime role: EXECUTE-ONLY on approved stored functions (ZERO direct table INSERT/UPDATE/DELETE/SELECT)
GRANT USAGE ON SCHEMA platform, identity_app, tenant, academics, billing, engagement, reporting, audit, integration TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA identity_app TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tenant TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA academics TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA billing TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA engagement TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO classsphere_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA integration TO classsphere_runtime;

-- Explicitly DENY table writes to runtime role as defense-in-depth
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform, identity_app, tenant, academics, billing, engagement, reporting, audit, integration FROM classsphere_runtime;
