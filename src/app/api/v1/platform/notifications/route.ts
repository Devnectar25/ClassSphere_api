import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Notification Templates API
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const templates = await callFn('platform.fn_notification_templates_list');
        return ok(context, templates);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { templateId, subject, content, isActive } = body;

        if (!templateId) {
            return problem(context, req, 400, 'Validation Error', 'templateId is required.');
        }

        const result = await callFn(
            'platform.fn_notification_template_update',
            templateId,
            subject || null,
            content || null,
            isActive !== undefined ? Boolean(isActive) : true,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
