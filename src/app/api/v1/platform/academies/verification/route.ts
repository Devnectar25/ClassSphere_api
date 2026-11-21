import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Academy Lifecycle Mutation API:
 * Handles approve, reject, suspend, reactivate, and special commission rate configuration.
 * Automatically synchronizes course discovery visibility, audit compliance logs,
 * and owner verification.
 */
export async function PATCH(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { tenantId, verificationStatus, commissionRate } = body;
        let action = body.action as string | undefined;
        let reason = (body.reason as string | undefined)?.trim() || null;

        if (!tenantId) {
            return problem(context, req, 400, 'Validation Error', 'tenantId is required.');
        }

        // Map verificationStatus or action
        if (!action && verificationStatus) {
            if (verificationStatus === 'verified' || verificationStatus === 'approved') action = 'approve';
            else if (verificationStatus === 'rejected') action = 'reject';
            else if (verificationStatus === 'suspended') action = 'suspend';
            else if (verificationStatus === 'reactivate' || verificationStatus === 'active') action = 'reactivate';
        }

        if (commissionRate !== undefined && commissionRate !== null && !action) {
            action = 'commission';
        }

        if (!action) {
            return problem(context, req, 400, 'Validation Error', 'A valid action (approve, reject, suspend, reactivate, commission) is required.');
        }

        if ((action === 'reject' || action === 'suspend') && (!reason || reason.length < 10)) {
            return problem(context, req, 400, 'Validation Error', `A mandatory ${action} reason of at least 10 characters is required.`);
        }

        if (action === 'commission') {
            const rate = Number(commissionRate);
            if (isNaN(rate) || rate < 0 || rate > 50) {
                return problem(context, req, 400, 'Validation Error', 'Commission rate must be between 0 and 50 percent.');
            }
        }

        const result = await callFn(
            'platform.fn_academy_action',
            tenantId,
            action,
            reason,
            commissionRate !== undefined && commissionRate !== null ? Number(commissionRate) : null,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export { PATCH as POST };
