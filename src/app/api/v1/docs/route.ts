import { NextResponse } from 'next/server';

/**
 * OpenAPI 3.0 Aggregated API Documentation
 * Traceability: TDD Section 9.2, PLT-003
 */
const get = (summary: string) => ({ get: { summary, responses: { '200': { description: 'OK' } } } });
const post = (summary: string, status = '200') => ({ post: { summary, responses: { [status]: { description: 'OK' } } } });

export async function GET() {
    const openApiSpec = {
        openapi: '3.0.3',
        info: {
            title: 'ClassSphere API Specification',
            version: '1.0.0',
            description: 'Multi-Tenant Class Management & Fee Collection API backed by PostgreSQL stored functions',
        },
        servers: [{ url: '/api/v1', description: 'API v1' }],
        paths: {
            '/health': get('Service health and database readiness probe'),
            '/plans': get('Public subscription plan catalogue'),
            '/auth/login': post('Authenticate user and detect MFA requirements'),
            '/auth/mfa': post('Verify TOTP challenge'),
            '/tenants': {
                ...get('Current workspace, subscription, branches and entitlements'),
                ...post('Provision tenant workspace (PlatformAdmin)', '201'),
                put: { summary: 'Update workspace settings and branding', responses: { '200': { description: 'OK' } } },
            },
            '/platform/tenants': get('Platform tenant search (PlatformAdmin)'),
            '/students': { ...get('Search and filter student directory'), ...post('Enroll new student', '201') },
            '/guardians': get('Guardian directory with linked students and payer status'),
            '/staff': get('Staff and role assignments'),
            '/courses': get('Course catalogue with batch and enrollment counts'),
            '/batches': get('Batches with schedules, instructors and capacity'),
            '/attendance': { ...get('Attendance register for a batch and date range'), ...post('Mark batch attendance') },
            '/fees': get('Fee heads and fee plans'),
            '/invoices': { ...get('Invoice ledger, summary and aging'), ...post('Generate invoice cycle (Idempotency-Key required)') },
            '/payments': { ...get('Payment ledger and collection summary'), ...post('Post payment and generate receipt') },
            '/notices': { ...get('Notices and announcements'), ...post('Publish, schedule or draft a notice', '201') },
            '/achievements': get('Student achievements'),
            '/reports': get('Reports: type=dashboard|collection|aging|audit|platform'),
            '/portal': { ...get('Guardian household portal'), ...post('Portal actions: practice log, absence, payment, seats, advisory') },
            '/files/upload-url': post('Create signed upload URL'),
            '/messaging/outbox': post('Claim outbox batch'),
        },
    };

    return NextResponse.json(openApiSpec);
}
