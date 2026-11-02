import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Transactional Outbox & Notification Dispatch API
 * Traceability: TDD Section 15; PLT-011, DECISION-006
 */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json().catch(() => ({}));
        const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 10;
        const messages = await callFn<unknown[]>('integration.fn_outbox_claim', batchSize);

        return ok(context, { claimedCount: messages.length, requestedBatchSize: batchSize, messages });
    } catch (err) {
        return fail(err, context, req);
    }
}
