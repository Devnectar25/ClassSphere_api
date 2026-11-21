import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Export of user records matching the current search and status filter (up to 10,000 rows).
 * GET ?q=&status=all|active|suspended
 * Every export is written to the audit trail.
 */
const STATUSES = ['all', 'active', 'suspended'];

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q')?.trim().slice(0, 100) || null;
    const status = searchParams.get('status') || 'all';
    if (!STATUSES.includes(status)) {
        return problem(context, req, 400, 'Validation Error', 'status must be one of: all, active, suspended.');
    }

    try {
        const result = await callFn<{ users: unknown[] }>('platform.fn_users_export', query, status, context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
