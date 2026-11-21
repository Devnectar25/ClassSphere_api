import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Academy Verification & Commission Configuration API
 */
export async function PATCH(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { tenantId, verificationStatus, reason, commissionRate } = body;

        if (!tenantId || !verificationStatus) {
            return problem(context, req, 400, 'Validation Error', 'tenantId and verificationStatus are required.');
        }

        if (verificationStatus === 'rejected' && (!reason || !reason.trim())) {
            return problem(context, req, 400, 'Validation Error', 'A rejection reason is mandatory when rejecting an academy.');
        }

        if (verificationStatus === 'suspended' && (!reason || !reason.trim())) {
            return problem(context, req, 400, 'Validation Error', 'A suspension reason is mandatory when suspending an academy.');
        }

        const result = await callFn(
            'platform.fn_academy_verification_update',
            tenantId,
            verificationStatus,
            reason ? reason.trim() : null,
            commissionRate !== undefined && commissionRate !== null ? Number(commissionRate) : null,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export { PATCH as POST };
