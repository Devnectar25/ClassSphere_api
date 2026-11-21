import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Refunds Management API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const status = searchParams.get('status') || null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn('platform.fn_refunds_list', status, limit, offset);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { refundId, action, reason, gatewayRefundId } = body;

        if (!refundId || !action) {
            return problem(context, req, 400, 'Validation Error', 'refundId and action (approve/reject) are required.');
        }

        if (action === 'reject' && (!reason || !reason.trim())) {
            return problem(context, req, 400, 'Validation Error', 'A rejection reason is mandatory when rejecting a refund.');
        }

        const result = await callFn(
            'platform.fn_refund_process',
            refundId,
            action,
            reason ? reason.trim() : null,
            gatewayRefundId || null,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
