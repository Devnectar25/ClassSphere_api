import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { requireAssignedBatch } from '@/lib/api/scope';

/**
 * Notices & Circular Broadcasts API
 * Traceability: TDD Section 10.4, 15
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('engagement.fn_notice_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'notices.write');
    if (context instanceof Response) return context;

    try {
        const { title, content, noticeType, status, priority, targetAudience, targetBatchId, branchId, channels, scheduledAt, expiresAt, isPinned } = await req.json();
        if (targetBatchId) await requireAssignedBatch(context, targetBatchId);

        if (!title || !content) {
            return problem(context, req, 400, 'Validation Error', 'Title and content are required fields.');
        }

        const result = await callFn<{ success: boolean; noticeId?: string; status?: string }>('engagement.fn_notice_publish',
            context.tenantId, title, content, noticeType, status, priority, targetAudience, targetBatchId || null,
            context.branchId ?? branchId ?? null, Array.isArray(channels) ? channels : null, expiresAt || null, context.actorId, isPinned);

        if (status === 'scheduled' && scheduledAt && result?.noticeId) {
            try {
                await query(
                    'UPDATE engagement.notices SET published_at = $1 WHERE notice_id = $2 AND tenant_id = $3',
                    [scheduledAt, result.noticeId, context.tenantId]
                );
            } catch {}
        }

        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
