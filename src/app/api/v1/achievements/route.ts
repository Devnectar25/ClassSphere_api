import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Achievements & Student Honors API — branch-scoped
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('engagement.fn_achievement_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'students.write');
    if (context instanceof Response) return context;

    try {
        const { studentId, title, category, level, visibility, awardDate, issuer, grade, remarks } = await req.json();

        if (!studentId || !title || !category) {
            return problem(context, req, 400, 'Validation Error', 'studentId, title, and category are required.');
        }

        const result = await callFn(
            'engagement.fn_achievement_create',
            context.tenantId,
            studentId,
            title,
            category,
            level || 'Institute',
            visibility || 'public',
            awardDate || null,
            issuer || null,
            grade || null,
            remarks || null,
            context.actorId
        );

        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
