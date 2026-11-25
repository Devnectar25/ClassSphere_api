import { query } from '@/lib/db/db';
import type { RequestContext } from '@/lib/api/context';

/**
 * What a signed-in user may reach.
 *
 * Branch: users whose account belongs to a branch only reach that branch.
 * Staff additionally reach only the courses and batches assigned to them under Users & Roles. Staff of a branch without
 * any assignment reach none; Staff without a branch and without assignments work across the academy.
 */
export interface StaffScope { branchId: string | null; batchIds: string[]; courseIds: string[] }
export interface StaffAssignments { courseIds: string[]; batchIds: string[] }

/** Enrollment statuses that no longer connect a student with a batch. */
const LEFT = ['cancelled', 'rejected', 'expired', 'transferred', 'dropped'];

const forbidden = (message: string) => Object.assign(new Error(message), { code: '42501' });
const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

export function readAssignments(value: unknown): StaffAssignments {
    const v = (value ?? {}) as Record<string, unknown>;
    return { courseIds: strings(v.courseIds), batchIds: strings(v.batchIds) };
}

/** Current branch and assignments of a Staff account; read on every request so that changes apply at once. */
export async function staffMembership(tenantId: string, userId: string): Promise<{ branchId: string | null; assignments: StaffAssignments } | null> {
    const [row] = await query<{ branch_id: string | null; assignments: unknown }>(
        `SELECT branch_id, profile->'assignments' AS assignments FROM tenant.memberships
         WHERE tenant_id = $1 AND user_id = $2 AND role = 'Staff' AND is_active ORDER BY created_at DESC LIMIT 1`, [tenantId, userId]);
    return row ? { branchId: row.branch_id, assignments: readAssignments(row.assignments) } : null;
}

const scopes = new WeakMap<RequestContext, Promise<StaffScope | null>>();

/** Courses and batches a Staff user may reach; null when the user is not limited to assignments. */
export function staffScope(context: RequestContext): Promise<StaffScope | null> {
    if (context.actorRole !== 'Staff' || context.isPlatformAdmin) return Promise.resolve(null);
    let scope = scopes.get(context);
    if (!scope) scopes.set(context, scope = loadScope(context));
    return scope;
}

async function loadScope(context: RequestContext): Promise<StaffScope | null> {
    const member = await staffMembership(context.tenantId, context.actorId);
    if (!member) return { branchId: null, batchIds: [], courseIds: [] };
    const { branchId, assignments } = member;
    if (!branchId && assignments.courseIds.length === 0 && assignments.batchIds.length === 0) return null;

    const batches = await query<{ batch_id: string; course_id: string }>(
        `SELECT batch_id, course_id FROM academics.batches WHERE tenant_id = $1 AND ($2::uuid IS NULL OR branch_id = $2::uuid)`, [context.tenantId, branchId]);
    const chosen = batches.filter(b => assignments.batchIds.includes(b.batch_id));
    // A course without a chosen batch means all of its batches
    const narrowed = new Set(chosen.map(b => b.course_id));
    const allowed = [...chosen, ...batches.filter(b => assignments.courseIds.includes(b.course_id) && !narrowed.has(b.course_id))];
    const courses = await query<{ course_id: string }>(
        `SELECT course_id FROM academics.courses
         WHERE tenant_id = $1 AND course_id::text = ANY($2::text[]) AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id = $3::uuid)`,
        [context.tenantId, assignments.courseIds, branchId]);
    return {
        branchId, batchIds: allowed.map(b => b.batch_id),
        courseIds: [...new Set([...allowed.map(b => b.course_id), ...courses.map(c => c.course_id)])],
    };
}

/** Batches the user may work with: of their branch and, for Staff, assigned to them. */
export async function batchInScope(context: RequestContext, batchId: string): Promise<boolean> {
    const scope = await staffScope(context);
    if (scope && !scope.batchIds.includes(String(batchId))) return false;
    if (!context.branchId) return true;
    const [row] = await query(`SELECT 1 FROM academics.batches WHERE tenant_id = $1 AND batch_id = $2 AND branch_id = $3`, [context.tenantId, batchId, context.branchId]);
    return Boolean(row);
}

/** For Staff only: the batch must be one of theirs. Other roles keep their own rules. */
export async function requireAssignedBatch(context: RequestContext, batchId: string | null | undefined, message = 'This batch is not assigned to you.') {
    const scope = await staffScope(context);
    if (scope && !scope.batchIds.includes(String(batchId ?? ''))) throw forbidden(message);
}

/** Ids of the students a Staff user may see; null when there is no such limit. */
export async function studentIdsInScope(context: RequestContext): Promise<Set<string> | null> {
    const scope = await staffScope(context);
    if (!scope) return null;
    const rows = await query<{ student_id: string }>(
        `SELECT DISTINCT student_id FROM academics.enrollments WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[]) AND status <> ALL($3::text[])`,
        [context.tenantId, scope.batchIds, LEFT]);
    return new Set(rows.map(r => r.student_id));
}

/** Refuses students outside the user's branch or, for Staff, outside their batches. An unknown student is left to the caller. */
export async function requireStudentInScope(context: RequestContext, studentId: string) {
    const scope = await staffScope(context);
    if (!scope && !context.restrictedBranchId) return;
    const [row] = await query<{ ok: boolean }>(
        `SELECT (CASE WHEN $3::uuid[] IS NOT NULL
                      THEN EXISTS (SELECT 1 FROM academics.enrollments e WHERE e.student_id = s.student_id AND e.batch_id = ANY($3::uuid[]) AND e.status <> ALL($4::text[]))
                      ELSE s.branch_id IS NULL OR s.branch_id = $5::uuid
                           OR EXISTS (SELECT 1 FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id WHERE e.student_id = s.student_id AND b.branch_id = $5::uuid)
                 END) AS ok
         FROM academics.students s WHERE s.tenant_id = $1 AND s.student_id = $2`,
        [context.tenantId, studentId, scope?.batchIds ?? null, LEFT, context.restrictedBranchId]);
    if (row && !row.ok) throw forbidden(scope ? 'This student is not in a batch assigned to you.' : 'This student belongs to another branch.');
}

/** Ids of the invoices a Staff user may see; null when there is no such limit. */
export async function invoiceIdsInScope(context: RequestContext): Promise<Set<string> | null> {
    const scope = await staffScope(context);
    const students = await studentIdsInScope(context);
    if (!scope || !students) return null;
    const rows = await query<{ invoice_id: string }>(
        `SELECT i.invoice_id FROM billing.invoices i LEFT JOIN academics.enrollments e ON e.enrollment_id = i.enrollment_id
         WHERE i.tenant_id = $1 AND i.student_id = ANY($2::uuid[]) AND (i.enrollment_id IS NULL OR e.batch_id = ANY($3::uuid[]))`,
        [context.tenantId, [...students], scope.batchIds]);
    return new Set(rows.map(r => r.invoice_id));
}

/** Branches the user may choose from; null = every branch of the academy. */
export async function branchIdsInScope(context: RequestContext): Promise<Set<string> | null> {
    if (context.restrictedBranchId) return new Set([context.restrictedBranchId]);
    const scope = await staffScope(context);
    if (!scope) return null;
    const rows = await query<{ branch_id: string }>(
        `SELECT DISTINCT branch_id FROM academics.batches WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[]) AND branch_id IS NOT NULL`, [context.tenantId, scope.batchIds]);
    return new Set(rows.map(r => r.branch_id));
}
