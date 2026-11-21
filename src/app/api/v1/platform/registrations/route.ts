import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Registrations & Lifecycle Management API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q') || null;
    const status = searchParams.get('status') || null;
    const tenantId = searchParams.get('tenantId') || null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn('platform.fn_registrations_list', query, status, tenantId, limit, offset);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PATCH(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { registrationId, newStatus, reason } = body;

        if (!registrationId || !newStatus) {
            return problem(context, req, 400, 'Validation Error', 'registrationId and newStatus are required.');
        }

        if (!reason || !reason.trim()) {
            return problem(context, req, 400, 'Validation Error', 'A mandatory reason is required for status overrides.');
        }

        const result = await callFn(
            'platform.fn_registration_status_override',
            registrationId,
            newStatus,
            reason.trim(),
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export { PATCH as POST };
