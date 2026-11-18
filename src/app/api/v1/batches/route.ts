import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

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

/** Creates a new batch with optional timetable schedule. */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { courseId, branchId, name, instructorUserId, room, capacity, status, startDate, endDate, schedules } = body;
        if (!courseId || !name?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Course and Batch name are required.');
        }

        const effectiveBranchId = branchId || context.branchId;
        if (!effectiveBranchId) {
            return problem(context, req, 400, 'Validation Error', 'Branch is required.');
        }

        const result = await callFn('academics.fn_batch_create',
            context.tenantId,
            courseId,
            effectiveBranchId,
            name.trim(),
            instructorUserId || null,
            room || null,
            capacity ? Number(capacity) : 30,
            status || 'active',
            startDate || null,
            endDate || null,
            Array.isArray(schedules) && schedules.length > 0 ? JSON.stringify(schedules) : null,
            context.actorId
        );
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Updates an existing batch with optional timetable schedule. */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { batchId, courseId, branchId, name, instructorUserId, room, capacity, status, startDate, endDate, schedules } = body;
        if (!batchId || !name?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Batch ID and Batch name are required.');
        }

        const effectiveBranchId = branchId || context.branchId;

        const result = await callFn('academics.fn_batch_update',
            context.tenantId,
            batchId,
            courseId || null,
            effectiveBranchId || null,
            name.trim(),
            instructorUserId || null,
            room || null,
            capacity ? Number(capacity) : 30,
            status || 'active',
            startDate || null,
            endDate || null,
            Array.isArray(schedules) ? JSON.stringify(schedules) : null,
            context.actorId
        );
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
