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

    // Check for single registration detail request
    const detailId = searchParams.get('id') || searchParams.get('detailId');
    if (detailId) {
        try {
            const result = await callFn('platform.fn_registration_detail', detailId);
            return ok(context, { registration: result });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    const query = searchParams.get('q') || null;
    const status = searchParams.get('status') || null;
    const tenantId = searchParams.get('tenantId') || null;
    const courseId = searchParams.get('courseId') || null;
    const batchId = searchParams.get('batchId') || null;
    const startDate = searchParams.get('startDate') || null;
    const endDate = searchParams.get('endDate') || null;

    const isExport = searchParams.get('export') === 'true';
    const limit = isExport
        ? 1000
        : Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn(
            'platform.fn_registrations_list',
            query,
            status,
            tenantId,
            courseId,
            batchId,
            startDate,
            endDate,
            limit,
            offset
        );
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

        if (!reason || !reason.trim() || reason.trim().length < 5) {
            return problem(context, req, 400, 'Validation Error', 'A mandatory justification reason (min 5 characters) is required for status overrides.');
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
