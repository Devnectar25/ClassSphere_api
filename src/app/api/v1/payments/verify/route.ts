import { NextRequest } from 'next/server';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { verifyManualPayment } from '@/lib/billing/fee-installments';

/**
 * Manual Payment Verification API
 * Allows authorized Finance staff to verify or reject payments declared by guardians, and to verify recorded ones.
 */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const paymentId = String(body.paymentId || '').trim();
        if (!paymentId) {
            return problem(context, req, 400, 'Validation Error', 'paymentId is required.');
        }
        return ok(context, await verifyManualPayment({
            tenantId: context.tenantId,
            paymentId,
            decision: body.decision === 'reject' ? 'reject' : 'verify',
            reason: body.reason ? String(body.reason).trim() || null : null,
            actorId: context.actorId
        }));
    } catch (err) {
        return fail(err, context, req);
    }
}
