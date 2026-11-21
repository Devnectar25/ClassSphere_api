import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { ok, problem } from '@/lib/api/respond';

/**
 * Records payment cancellation when a user dismisses Razorpay checkout modal.
 * Keeps registration details preserved on the client for easy retry.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const context = { correlationId };

    try {
        const body = await req.json();
        const { orderId, reason } = body;

        if (!orderId) {
            return problem(context, req, 400, 'Validation Error', 'orderId is required.');
        }

        await callFn(
            'platform.fn_registration_payment_fail',
            orderId,
            reason || 'Payment cancelled by user',
            'cancelled'
        );

        return ok(context, {
            orderId,
            paymentStatus: 'cancelled',
            message: 'Payment was cancelled. You can retry payment at any time.',
        });
    } catch (err) {
        if (err instanceof SyntaxError) {
            return problem(context, req, 400, 'Malformed Request', 'Request body must be valid JSON.');
        }
        console.error(`[${correlationId}] Cancel route error:`, err);
        return problem(context, req, 500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}
