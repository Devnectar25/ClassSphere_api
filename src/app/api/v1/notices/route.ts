import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Notices & Circular Broadcasts API
 * Traceability: TDD Section 10.4, 15
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('engagement.fn_notice_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'notices.write');
    if (context instanceof Response) return context;

    try {
        const { title, content, noticeType, status, priority, targetAudience, branchId, channels, expiresAt, isPinned } = await req.json();

        if (!title || !content) {
            return problem(context, req, 400, 'Validation Error', 'Title and content are required fields.');
        }

        const result = await callFn('engagement.fn_notice_publish',
            context.tenantId, title, content, noticeType, status, priority, targetAudience, null,
            context.branchId ?? branchId ?? null, Array.isArray(channels) ? channels : null, expiresAt || null, context.actorId, isPinned);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
