import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize, invalidateUserAccess } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Users Management API
 * GET   ?q=&status=all|active|suspended&limit=&offset=  → paged users with tab counts
 * PATCH { userId, isSuspended, reason }                  → suspend (reason required) or reactivate
 * Suspension only changes account status; user records and relationships are never deleted.
 */
const STATUSES = ['all', 'active', 'suspended'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q')?.trim().slice(0, 100) || null;
    const status = searchParams.get('status') || 'all';
    if (!STATUSES.includes(status)) {
        return problem(context, req, 400, 'Validation Error', 'status must be one of: all, active, suspended.');
    }
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '10', 10) || 10, 1), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10) || 0, 0);
    const roleParam = searchParams.get('role');
    const role = roleParam === 'all' ? null : (roleParam || 'TenantAdmin');

    try {
        const result = await callFn('platform.fn_users_list', query, status, limit, offset, role);
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
        const { userId, isSuspended } = body ?? {};
        const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';

        if (typeof userId !== 'string' || !UUID.test(userId)) {
            return problem(context, req, 400, 'Validation Error', 'A valid userId is required.');
        }

        if (body?.verifyEmail !== undefined || body?.verifyPhone !== undefined) {
            const result = await callFn(
                'platform.fn_user_verify',
                userId,
                Boolean(body?.verifyEmail),
                Boolean(body?.verifyPhone),
                context.actorId
            );
            return ok(context, result);
        }

        if (typeof isSuspended !== 'boolean') {
            return problem(context, req, 400, 'Validation Error', 'isSuspended must be true (suspend) or false (reactivate).');
        }
        if (isSuspended && reason.length < 10) {
            return problem(context, req, 400, 'Validation Error', 'A suspension reason of at least 10 characters is required.');
        }
        if (reason.length > 500) {
            return problem(context, req, 400, 'Validation Error', 'The reason cannot exceed 500 characters.');
        }

        // Permission, self-suspension and state checks run inside the stored function
        const result = await callFn('platform.fn_user_status_update', userId, isSuspended, reason || null, context.actorId);
        invalidateUserAccess(userId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export { PATCH as POST };
