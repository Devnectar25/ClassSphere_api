import { NextRequest } from 'next/server';
import { callFn, query, withTransaction } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope, staffScope } from '@/lib/api/scope';
import { billingError as ruleError, writeAudit } from '@/lib/billing/credit-ledger';

/** A course of one branch has its batches in that branch; an academy-wide course may have them anywhere. */
async function checkBranch(tenantId: string, courseId: string, branchId: string) {
    const [course] = await query<{ title: string; branch_id: string | null; branch_name: string | null }>(
        `SELECT c.title, c.branch_id, b.name AS branch_name FROM academics.courses c LEFT JOIN tenant.branches b ON b.branch_id = c.branch_id
         WHERE c.tenant_id = $1 AND c.course_id = $2`, [tenantId, courseId]);
    if (course?.branch_id && course.branch_id !== branchId) throw ruleError('invalid', `${course.title.trim()} is a course of ${course.branch_name}. Its batches must be in that branch.`);
    const [branch] = await query(`SELECT 1 FROM tenant.branches WHERE tenant_id = $1 AND branch_id = $2`, [tenantId, branchId]);
    if (!branch) throw ruleError('invalid', 'Branch not found.');
}

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
        // Only an account of one branch is limited to it; a selected branch view is just the default
        if (context.restrictedBranchId && branchId && context.restrictedBranchId !== branchId) {
            return problem(context, req, 403, 'Forbidden', 'Cannot create a batch for another branch.');
        }
        const [course] = await query<{ branch_id: string | null }>(`SELECT branch_id FROM academics.courses WHERE tenant_id = $1 AND course_id = $2`, [context.tenantId, courseId]);
        const effectiveBranchId = context.restrictedBranchId || branchId || course?.branch_id || context.branchId || null;
        if (effectiveBranchId) await checkBranch(context.tenantId, courseId, effectiveBranchId);
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

        const [current] = await query<{ branch_id: string | null; course_id: string }>(
            `SELECT branch_id, course_id FROM academics.batches WHERE tenant_id = $1 AND batch_id = $2`, [context.tenantId, batchId]);
        if (!current) return problem(context, req, 404, 'Not Found', 'Batch not found.');
        const newBranchId = branchId ? String(branchId) : current.branch_id;
        const branchChanged = newBranchId !== current.branch_id;
        if (branchChanged && context.restrictedBranchId && newBranchId !== context.restrictedBranchId) {
            return problem(context, req, 403, 'Forbidden', 'You cannot move a batch to another branch.');
        }
        // An older batch may keep its branch until it or its course is changed
        if (newBranchId && (branchChanged || courseId !== current.course_id)) await checkBranch(context.tenantId, courseId, newBranchId);

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
        if (branchChanged) {
            await withTransaction(async tx => {
                await tx.query(`UPDATE academics.batches SET branch_id = $3 WHERE tenant_id = $1 AND batch_id = $2`, [context.tenantId, batchId, newBranchId]);
                await writeAudit(tx, {
                    tenantId: context.tenantId, actorId: context.actorId, action: 'batch.branch_changed', entityType: 'batch', entityId: batchId,
                    details: { name: name.trim(), from: current.branch_id, to: newBranchId },
                });
            });
        }
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
