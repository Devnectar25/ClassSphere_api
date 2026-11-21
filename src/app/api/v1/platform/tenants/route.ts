import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Academies / Tenants Listing (SaaS Multi-tenant registry)
 * Supports search query, subsection status filter (all, pending, verified, rejected, suspended),
 * and pagination with live subsection counts.
 */
const VALID_STATUSES = ['all', 'pending', 'verified', 'rejected', 'suspended'];

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const { searchParams } = req.nextUrl;
        const query = searchParams.get('q')?.trim().slice(0, 100) || null;
        const status = searchParams.get('status') || 'all';

        if (!VALID_STATUSES.includes(status)) {
            return problem(context, req, 400, 'Validation Error', `status must be one of: ${VALID_STATUSES.join(', ')}.`);
        }

        const pageSize = Math.min(Math.max(Number(searchParams.get('pageSize') || searchParams.get('limit') || 10), 1), 100);
        const page = Math.max(Number(searchParams.get('page') || 1), 1);
        const offset = searchParams.has('offset')
            ? Math.max(Number(searchParams.get('offset')), 0)
            : (page - 1) * pageSize;

        const result = await callFn('platform.fn_academies_list', query, status, pageSize, offset);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
