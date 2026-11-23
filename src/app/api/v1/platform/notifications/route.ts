import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Notification Templates, Delivery History, Failed Notifications & Announcements API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const type = searchParams.get('type') || 'templates';

    try {
        if (type === 'deliveries') {
            const status = searchParams.get('status') || null;
            const channel = searchParams.get('channel') || null;
            const q = searchParams.get('q') || null;
            const fromDate = searchParams.get('from') ? new Date(searchParams.get('from')!).toISOString() : null;
            const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!).toISOString() : null;
            const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
            const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

            const result = await callFn(
                'platform.fn_notification_deliveries_list',
                status,
                channel,
                q,
                fromDate,
                toDate,
                limit,
                offset
            );
            return ok(context, result);
        }

        if (type === 'failed') {
            const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
            const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

            const result = await callFn('platform.fn_failed_notifications_list', limit, offset);
            return ok(context, result);
        }

        if (type === 'announcements') {
            const status = searchParams.get('status') || null;
            const target = searchParams.get('target') || null;
            const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
            const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

            const result = await callFn('platform.fn_announcements_list', status, target, limit, offset);
            return ok(context, result);
        }

        // Default: Templates list
        const templates = await callFn('platform.fn_notification_templates_list');
        return ok(context, templates);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { templateId, subject, content, channel, isActive } = body;

        if (!templateId) {
            return problem(context, req, 400, 'Validation Error', 'templateId is required.');
        }

        const result = await callFn(
            'platform.fn_notification_template_update',
            templateId,
            subject || null,
            content || null,
            channel || null,
            isActive !== undefined ? Boolean(isActive) : true,
            context.actorId || null
        );

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
        const { action } = body;

        // 1. Retry failed notification
        if (action === 'retry') {
            const { messageId } = body;
            if (!messageId) {
                return problem(context, req, 400, 'Validation Error', 'messageId is required to retry delivery.');
            }

            const result = await callFn('platform.fn_notification_retry', messageId, context.actorId || null);
            return ok(context, result);
        }

        // 2. Upsert Announcement
        if (action === 'upsert_announcement' || action === 'create_announcement' || action === 'edit_announcement') {
            const { announcementId, title, message, targetAudience, startDate, expiryDate, status } = body;

            if (!title || !message) {
                return problem(context, req, 400, 'Validation Error', 'title and message are required.');
            }

            const result = await callFn(
                'platform.fn_announcement_upsert',
                announcementId || null,
                title.trim(),
                message.trim(),
                targetAudience || 'all_learners',
                startDate ? new Date(startDate).toISOString() : null,
                expiryDate ? new Date(expiryDate).toISOString() : null,
                status || 'published',
                context.actorId || null
            );
            return ok(context, result);
        }

        // 3. Announcement Action (publish, schedule, deactivate, delete)
        if (action === 'announcement_action') {
            const { announcementId, subAction } = body;
            if (!announcementId || !subAction) {
                return problem(context, req, 400, 'Validation Error', 'announcementId and subAction are required.');
            }

            const result = await callFn(
                'platform.fn_announcement_action',
                announcementId,
                subAction,
                context.actorId || null
            );
            return ok(context, result);
        }

        // 4. Test notification dispatch (for verification of triggers)
        if (action === 'dispatch') {
            const { eventType, recipientName, recipientEmail, recipientPhone, params, channel } = body;
            if (!eventType) {
                return problem(context, req, 400, 'Validation Error', 'eventType is required.');
            }

            const result = await callFn(
                'platform.fn_notification_dispatch',
                eventType,
                recipientName || 'Test Recipient',
                recipientEmail || 'test@classshare.com',
                recipientPhone || null,
                params || {},
                channel || null,
                context.actorId || null,
                null
            );
            return ok(context, result);
        }

        return problem(context, req, 400, 'Invalid Action', `Unsupported action: ${action}`);
    } catch (err) {
        return fail(err, context, req);
    }
}
