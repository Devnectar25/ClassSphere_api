import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope, staffScope } from '@/lib/api/scope';

/**
 * Batches and Academic Scheduling API — branch-scoped
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        const branchParam = req.nextUrl.searchParams.get('branchId');
        const effectiveBranch = context.restrictedBranchId ?? (branchParam === 'all' ? null : (branchParam || context.branchId));
        const batches = await callFn<Array<{ batchId: string }>>('academics.fn_batch_list', context.tenantId, effectiveBranch);
        const scope = await staffScope(context);
        return ok(context, scope ? batches.filter(b => scope.batchIds.includes(b.batchId)) : batches);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Creates a new batch with its weekly schedule. */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const { name, courseId, branchId, instructorUserId, room, capacity, status, startDate, endDate, schedules } = await req.json();
        if (!name?.trim() || !courseId) {
            return problem(context, req, 400, 'Validation Error', 'Batch name and course are required.');
        }
        if (schedules !== undefined && !Array.isArray(schedules)) {
            return problem(context, req, 400, 'Validation Error', 'schedules must be an array.');
        }
        if (context.branchId && branchId && context.branchId !== branchId) {
            return problem(context, req, 403, 'Forbidden', 'Cannot create a batch for another branch.');
        }
        const effectiveBranchId = context.branchId || branchId || null;
        const result = await callFn('academics.fn_batch_create',
            context.tenantId,
            name.trim(),
            courseId,
            effectiveBranchId,
            instructorUserId || null,
            room || null,
            Number(capacity || 25),
            status || 'active',
            startDate || new Date().toISOString().split('T')[0],
            endDate || null,
            JSON.stringify(Array.isArray(schedules) ? schedules : []),
            context.actorId
        );
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Updates a batch's details and (when an array is sent) replaces its weekly schedule. */
export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'courses.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { batchId, courseId, branchId, name, instructorUserId, room, capacity, status, startDate, endDate, schedules } = body;
        if (!batchId || !name?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Batch ID and Batch name are required.');
        }
        if (schedules !== undefined && schedules !== null && !Array.isArray(schedules)) {
            return problem(context, req, 400, 'Validation Error', 'schedules must be an array.');
        }
        // Branch-scoped users may only edit batches of their own branch (from main)
        if (!(await batchInScope(context, batchId))) {
            return problem(context, req, 403, 'Forbidden', 'This batch belongs to another branch.');
        }

        const effectiveBranchId = branchId || context.branchId;

        const result = await callFn('academics.fn_batch_update',
            context.tenantId,
            batchId,
            name.trim(),
            courseId,
            instructorUserId || null,
            room || null,
            capacity ? Number(capacity) : 30,
            status || 'active',
            startDate || null,
            endDate || null,
            JSON.stringify(Array.isArray(schedules) ? schedules : []),
            context.actorId
        );
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
