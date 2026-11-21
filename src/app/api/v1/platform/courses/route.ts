import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Courses Moderation API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q') || null;
    const category = searchParams.get('category') || null;
    const tenantId = searchParams.get('tenantId') || null;
    const isHidden = searchParams.has('isHidden') ? searchParams.get('isHidden') === 'true' : null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn('platform.fn_courses_list', query, category, tenantId, isHidden, limit, offset);
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
        const { courseId, isHidden, isFeatured, reason } = body;

        if (!courseId) {
            return problem(context, req, 400, 'Validation Error', 'courseId is required.');
        }

        const result = await callFn(
            'platform.fn_course_visibility_update',
            courseId,
            isHidden !== undefined ? Boolean(isHidden) : null,
            isFeatured !== undefined ? Boolean(isFeatured) : null,
            reason ? String(reason).trim() : null,
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export { PATCH as POST };
