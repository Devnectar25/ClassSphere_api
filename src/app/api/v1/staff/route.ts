import { NextRequest } from 'next/server';
import { callFn, query, withTransaction } from '@/lib/db/db';
import { hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { readAssignments, type StaffAssignments } from '@/lib/api/scope';
import { billingError as ruleError, writeAudit } from '@/lib/billing/credit-ledger';

/** Courses and batches of a Staff user; they must exist in the academy and, with a branch, belong to it. */
async function checkAssignments(tenantId: string, branchId: string | null, a: StaffAssignments) {
    const batches = a.batchIds.length === 0 ? [] : await query<{ branch_id: string | null }>(
        `SELECT branch_id FROM academics.batches WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`, [tenantId, a.batchIds]);
    const courses = a.courseIds.length === 0 ? [] : await query<{ branch_id: string | null; has_batch: boolean }>(
        `SELECT c.branch_id, EXISTS (SELECT 1 FROM academics.batches b WHERE b.course_id = c.course_id AND b.branch_id = $3::uuid) AS has_batch
         FROM academics.courses c WHERE c.tenant_id = $1 AND c.course_id = ANY($2::uuid[])`, [tenantId, a.courseIds, branchId]);
    if (batches.length !== new Set(a.batchIds).size || courses.length !== new Set(a.courseIds).size) throw ruleError('invalid', 'A selected course or batch does not exist.');
    if (branchId && batches.some(b => b.branch_id !== branchId)) throw ruleError('invalid', 'A selected batch belongs to another branch.');
    if (branchId && courses.some(c => c.branch_id && c.branch_id !== branchId && !c.has_batch)) throw ruleError('invalid', 'A selected course belongs to another branch.');
}

async function saveAssignments(tenantId: string, actorId: string, membershipId: string, branchId: string | null, a: StaffAssignments) {
    await withTransaction(async tx => {
        const [member] = await tx.query<{ role: string; branch_id: string | null; assignments: unknown }>(
            `SELECT role, branch_id, profile->'assignments' AS assignments FROM tenant.memberships WHERE membership_id = $1 AND tenant_id = $2 FOR UPDATE`, [membershipId, tenantId]);
        if (!member) throw ruleError('not_found', 'Staff member not found.');
        if (member.role !== 'Staff') throw ruleError('invalid', 'Courses and batches are assigned to Staff users. Teachers get their batches from the batch form.');
        await tx.query(
            `UPDATE tenant.memberships SET branch_id = $3::uuid, profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{assignments}', $4::jsonb) WHERE membership_id = $1 AND tenant_id = $2`,
            [membershipId, tenantId, branchId, JSON.stringify(a)]);
        await writeAudit(tx, {
            tenantId, actorId, action: 'staff.access_changed', entityType: 'membership', entityId: membershipId,
            details: { branchId, ...a, previous: { branchId: member.branch_id, ...readAssignments(member.assignments) } },
        });
    });
}

/**
 * Staff, Roles & Academy Users API — branch-scoped
 * Traceability: TDD Section 10.4, 13
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'staff.read');
    if (context instanceof Response) return context;
    try {
        const branchParam = req.nextUrl.searchParams.get('branchId');
        const effectiveBranch = context.restrictedBranchId ?? ((branchParam && branchParam !== 'all') ? branchParam : context.branchId);
        const staff = await callFn<Array<{ membershipId: string; role: string; batches: string | null }>>('tenant.fn_staff_list', context.tenantId, effectiveBranch);
        const rows = new Map((await query<{ membership_id: string; assignments: unknown }>(
            `SELECT membership_id, profile->'assignments' AS assignments FROM tenant.memberships WHERE tenant_id = $1 AND role = 'Staff'`, [context.tenantId]))
            .map(r => [r.membership_id, readAssignments(r.assignments)]));
        return ok(context, staff.map(m => (m.role === 'Staff' ? { ...m, assignments: rows.get(m.membershipId) ?? readAssignments(null) } : m)));
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Creates a role-based academy user with a sign-in. */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'staff.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { fullName, email, phone, password, role, branchId, title } = body;
        if (!fullName || !email || !role) {
            return problem(context, req, 400, 'Validation Error', 'fullName, email and role are required.');
        }
        if (!password || String(password).length < 8) {
            return problem(context, req, 400, 'Validation Error', 'A temporary password of at least 8 characters is required.');
        }
        const assignments = role === 'Staff' ? readAssignments(body.assignments) : null;
        if (assignments) await checkAssignments(context.tenantId, branchId || null, assignments);
        const result = await callFn<{ membershipId: string }>('tenant.fn_staff_create',
            context.tenantId, fullName, email, phone || null, hashPassword(password), role, branchId || null, title || null, context.actorId);
        if (assignments) await saveAssignments(context.tenantId, context.actorId, result.membershipId, branchId || null, assignments);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Activates or deactivates a staff member's access, or sets the branch, courses and batches of a Staff user. */
export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'staff.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { membershipId, isActive } = body;
        if (body.action === 'assign') {
            if (!membershipId) return problem(context, req, 400, 'Validation Error', 'membershipId is required.');
            const assignments = readAssignments(body.assignments);
            const branchId = body.branchId ? String(body.branchId) : null;
            if (branchId) {
                const [branch] = await query(`SELECT 1 FROM tenant.branches WHERE branch_id = $1 AND tenant_id = $2`, [branchId, context.tenantId]);
                if (!branch) return problem(context, req, 400, 'Validation Error', 'Branch not found.');
            }
            await checkAssignments(context.tenantId, branchId, assignments);
            await saveAssignments(context.tenantId, context.actorId, membershipId, branchId, assignments);
            return ok(context, { saved: true });
        }
        if (!membershipId || typeof isActive !== 'boolean') {
            return problem(context, req, 400, 'Validation Error', 'membershipId and isActive are required.');
        }
        return ok(context, await callFn('tenant.fn_membership_set_active', context.tenantId, membershipId, isActive, context.actorId));
    } catch (err) {
        return fail(err, context, req);
    }
}
