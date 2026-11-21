import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Admin Roles & Permissions API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const admins = await callFn('platform.fn_admin_users_list');
        return ok(context, admins);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { adminId, userId, email, fullName, role, permissions } = body;

        if (!role) {
            return problem(context, req, 400, 'Validation Error', 'Role is required.');
        }

        const result = await callFn(
            'platform.fn_admin_user_upsert',
            adminId || null,
            userId || null,
            email || null,
            fullName || null,
            role,
            Array.isArray(permissions) ? permissions : ['*'],
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
