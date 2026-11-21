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
 * Create a Fee Head or Fee Plan
 */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();

        // 1. Fee Head creation
        if (body.type === 'fee_head' || (body.code && !body.items)) {
            const { code, name, frequency, isActive } = body;
            if (!code?.trim() || !name?.trim()) {
                return problem(context, req, 400, 'Validation Error', 'Fee head code and name are required.');
            }
            const result = await callFn('billing.fn_fee_head_create',
                context.tenantId,
                code.trim().toUpperCase(),
                name.trim(),
                frequency || 'monthly',
                isActive ?? true,
                context.actorId
            );
            return ok(context, result, 201);
        }

        // 2. Fee Plan creation
        const { name, courseId, discountPercent, dueDayOfMonth, isActive, items } = body;
        if (!name?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Plan name is required.');
        }

        const result = await callFn('billing.fn_fee_plan_create',
            context.tenantId,
            name.trim(),
            courseId || null,
            Number(discountPercent || 0),
            Number(dueDayOfMonth || 5),
            isActive ?? true,
            Array.isArray(items) ? JSON.stringify(items) : '[]',
            context.actorId
        );
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/**
 * Update an existing Fee Plan or Fee Head
 */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();

        // 1. Fee Head update
        if (body.type === 'fee_head' || body.feeHeadId) {
            const { feeHeadId, code, name, frequency, isActive } = body;
            if (!feeHeadId || !name?.trim() || !code?.trim()) {
                return problem(context, req, 400, 'Validation Error', 'Fee head ID, code, and name are required.');
            }
            const result = await callFn('billing.fn_fee_head_update',
                context.tenantId,
                feeHeadId,
                code.trim().toUpperCase(),
                name.trim(),
                frequency || 'monthly',
                isActive ?? true,
                context.actorId
            );
            return ok(context, result);
        }

        // 2. Fee Plan update
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
