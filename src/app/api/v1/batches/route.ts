import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Batches and Academic Scheduling API — branch-scoped
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('academics.fn_batch_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}
