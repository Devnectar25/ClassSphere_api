import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Export of academy records matching search query and status filter (up to 10,000 rows).
 * Every export writes an entry to the audit compliance logs.
 */
const STATUSES = ['all', 'pending', 'verified', 'rejected', 'suspended'];

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q')?.trim().slice(0, 100) || null;
    const status = searchParams.get('status') || 'all';

    if (!STATUSES.includes(status)) {
        return problem(context, req, 400, 'Validation Error', `status must be one of: ${STATUSES.join(', ')}.`);
    }

    try {
        const result = await callFn<{ academies: unknown[] }>(
            'platform.fn_academies_export',
            query,
            status,
            context.actorId || null
        );
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
