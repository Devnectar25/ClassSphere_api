import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

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

/**
 * Update an existing Fee Plan
 */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { planId, name, discountPercent, isActive, items } = body;
        if (!planId || !name?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Plan ID and name are required.');
        }

        const result = await callFn('billing.fn_fee_plan_update',
            context.tenantId,
            planId,
            name.trim(),
            Number(discountPercent || 0),
            isActive ?? true,
            Array.isArray(items) ? JSON.stringify(items) : null,
            context.actorId
        );
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
