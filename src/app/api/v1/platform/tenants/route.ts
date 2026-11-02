import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Platform Tenant Search (SaaS operator)
 * Traceability: TDD Appendix A — GET /api/v1/platform/tenants
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        return ok(context, await callFn('tenant.fn_tenant_search', req.nextUrl.searchParams.get('q') || null));
    } catch (err) {
        return fail(err, context, req);
    }
}
