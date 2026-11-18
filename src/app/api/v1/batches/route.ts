import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope } from '@/lib/api/scope';

/**
 * Batches and Academic Scheduling API — branch-scoped
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('academics.fn_batch_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Updates a batch's details and replaces its weekly schedule. */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const { batchId, name, courseId, instructorUserId, room, capacity, status, startDate, endDate, schedules } = await req.json();
        if (!batchId || !name?.trim() || !courseId || !startDate) {
            return problem(context, req, 400, 'Validation Error', 'Batch name, course and start date are required.');
        }
        if (!Array.isArray(schedules)) {
            return problem(context, req, 400, 'Validation Error', 'schedules must be an array.');
        }
        if (!(await batchInScope(context, batchId))) {
            return problem(context, req, 403, 'Forbidden', 'This batch belongs to another branch.');
        }
        const result = await callFn('academics.fn_batch_update',
            context.tenantId, batchId, name, courseId, instructorUserId || null, room || null, Number(capacity),
            status, startDate, endDate || null, JSON.stringify(schedules), context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
