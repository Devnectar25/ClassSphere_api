import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Public Subscription Plan Catalogue & Platform Operator Plan Management
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

export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const {
            planTier,
            description,
            priceMonthly,
            currency = 'INR',
            maxSeats,
            maxBranches,
            features,
            isPopular,
            razorpayPlanId,
        } = body;

        if (!planTier) {
            return problem(context, req, 400, 'Validation Error', 'planTier is required.');
        }

        const updated = await callFn(
            'platform.fn_plan_update',
            planTier,
            description ?? null,
            priceMonthly !== undefined ? Number(priceMonthly) : null,
            currency ?? 'INR',
            maxSeats !== undefined ? Number(maxSeats) : null,
            maxBranches !== undefined ? Number(maxBranches) : null,
            Array.isArray(features) ? features : null,
            isPopular !== undefined ? Boolean(isPopular) : null,
            razorpayPlanId ?? null
        );

        return ok(context, updated);
    } catch (err) {
        return fail(err, context, req);
    }
}
