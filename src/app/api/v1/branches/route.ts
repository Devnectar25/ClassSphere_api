import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Branch creation (within the subscription's branch quota)
 * Traceability: TDD Section 10.4; PLT-005
 */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'branches.write');
    if (context instanceof Response) return context;
    try {
        const { name, code, address, phone } = await req.json();
        if (!name || !code) return problem(context, req, 400, 'Validation Error', 'Branch name and code are required.');

        const check = await callFn<{ allowed: boolean; maximum: number; planTier: string }>('tenant.fn_entitlement_check', context.tenantId, 'branches');
        if (!check.allowed) {
            return problem(context, req, 402, 'Subscription Entitlement Exceeded',
                `Branch limit of ${check.maximum} reached for the ${check.planTier} plan.`);
        }
        const result = await callFn('tenant.fn_branch_create',
            context.tenantId, name, String(code).toUpperCase(), address || null, phone || null, context.actorId);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
