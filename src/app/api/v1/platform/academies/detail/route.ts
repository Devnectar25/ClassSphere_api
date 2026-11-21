import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Academy Comprehensive 10-Tab Dossier API
 * Returns: Overview, Owner Info, Academy Info, Verification Docs, Courses,
 * Batches, Registrations, Payments, Payout History, Activity History.
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const tenantId = req.nextUrl.searchParams.get('tenantId')?.trim();
        if (!tenantId) {
            return problem(context, req, 400, 'Validation Error', 'tenantId parameter is required.');
        }

        const dossier = await callFn('platform.fn_academy_detail', tenantId);
        return ok(context, dossier);
    } catch (err) {
        return fail(err, context, req);
    }
}
