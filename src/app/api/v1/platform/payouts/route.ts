import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Payouts & Settlements API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const status = searchParams.get('status') || null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn('platform.fn_payouts_list', status, limit, offset);
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
        const { payoutId, action, holdReason } = body;

        if (!payoutId || !action) {
            return problem(context, req, 400, 'Validation Error', 'payoutId and action (release/hold) are required.');
        }

        if (action === 'hold' && (!holdReason || !holdReason.trim())) {
            return problem(context, req, 400, 'Validation Error', 'A hold reason is mandatory when placing a payout on hold.');
        }

        const result = await callFn(
            'platform.fn_payout_status_update',
            payoutId,
            action,
            holdReason ? holdReason.trim() : null,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
