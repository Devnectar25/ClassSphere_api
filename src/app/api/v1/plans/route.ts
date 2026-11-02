import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { ok, fail } from '@/lib/api/respond';

/**
 * Public Subscription Plan Catalogue
 * Traceability: TDD Section 18 (pricing pages), PLT-005
 */
export async function GET(req: NextRequest) {
    const context = { correlationId: crypto.randomUUID() };
    try {
        return ok(context, await callFn('platform.fn_plan_list'));
    } catch (err) {
        return fail(err, context, req);
    }
}
