import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Fee Heads & Fee Plans API
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('billing.fn_fee_structure_list', context.tenantId));
    } catch (err) {
        return fail(err, context, req);
    }
}
