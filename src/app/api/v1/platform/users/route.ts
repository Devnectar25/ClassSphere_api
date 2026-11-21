import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Users Management API
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q') || null;
    const status = searchParams.get('status') || null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn('platform.fn_users_list', query, status, limit, offset);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PATCH(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { userId, isSuspended, reason } = body;

        if (!userId) {
            return problem(context, req, 400, 'Validation Error', 'userId is required.');
        }

        const result = await callFn(
            'platform.fn_user_status_update',
            userId,
            Boolean(isSuspended),
            reason || null,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export { PATCH as POST };
