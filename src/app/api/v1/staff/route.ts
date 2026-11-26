import { NextRequest } from 'next/server';
import { callFn, query, withTransaction } from '@/lib/db/db';
import { hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { readAssignments, type StaffAssignments } from '@/lib/api/scope';
import { billingError as ruleError, writeAudit } from '@/lib/billing/credit-ledger';
import { syncBranchManager } from '../branches/route';

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
        const [member] = await tx.query<{ role: string; branch_id: string | null; user_id: string; assignments: unknown }>(
            `SELECT role, branch_id, user_id, profile->'assignments' AS assignments FROM tenant.memberships WHERE membership_id = $1 AND tenant_id = $2 FOR UPDATE`, [membershipId, tenantId]);
        if (!member) throw ruleError('not_found', 'Staff member not found.');
        if (member.role !== 'Staff' && member.role !== 'Instructor') throw ruleError('invalid', 'Courses and batches are assigned to Staff or Instructor users.');
        await tx.query(
            `UPDATE tenant.memberships SET branch_id = $3::uuid, profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{assignments}', $4::jsonb) WHERE membership_id = $1 AND tenant_id = $2`,
            [membershipId, tenantId, branchId, JSON.stringify(a)]);

        // For instructors, assign selected batches to their user account
        if (member.role === 'Instructor' && member.user_id) {
            if (a.batchIds.length === 0) {
                await tx.query(
                    `UPDATE academics.batches SET instructor_user_id = NULL WHERE tenant_id = $1 AND instructor_user_id = $2`,
                    [tenantId, member.user_id]
                );
            } else {
                await tx.query(
                    `UPDATE academics.batches SET instructor_user_id = NULL WHERE tenant_id = $1 AND instructor_user_id = $2 AND NOT (batch_id = ANY($3::uuid[]))`,
                    [tenantId, member.user_id, a.batchIds]
                );
                await tx.query(
                    `UPDATE academics.batches SET instructor_user_id = $2 WHERE tenant_id = $1 AND batch_id = ANY($3::uuid[])`,
                    [tenantId, member.user_id, a.batchIds]
                );
            }
        }

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
        const effectiveBranch = context.restrictedBranchId ?? ((branchParam && branchParam !== 'all') ? branchParam : (branchParam === 'all' || context.actorRole === 'TenantAdmin' ? null : context.branchId));

        // Auto-heal any branches that have head_name or head_user_id but missing BranchManager membership
        const unlinkedBranches = await query<{ branch_id: string; head_user_id: string | null; head_name: string | null }>(
            `SELECT b.branch_id, b.head_user_id, b.head_name
             FROM tenant.branches b
             WHERE b.tenant_id = $1 AND b.is_active = true AND (b.head_name IS NOT NULL OR b.head_user_id IS NOT NULL)
               AND NOT EXISTS (
                   SELECT 1 FROM tenant.memberships m
                   WHERE m.tenant_id = b.tenant_id AND m.branch_id = b.branch_id AND m.role = 'BranchManager'
               )`,
            [context.tenantId]
        );
        for (const ub of unlinkedBranches) {
            await syncBranchManager(context.tenantId, ub.branch_id, ub.head_user_id, ub.head_name);
        }

        const staff = await callFn<Array<{ membershipId: string; role: string; batches: string | null }>>('tenant.fn_staff_list', context.tenantId, effectiveBranch);
        const rows = new Map((await query<{ membership_id: string; assignments: unknown }>(
            `SELECT membership_id, profile->'assignments' AS assignments FROM tenant.memberships WHERE tenant_id = $1 AND role IN ('Staff', 'Instructor')`, [context.tenantId]))
            .map(r => [r.membership_id, readAssignments(r.assignments)]));
        const all = [...rows.values()];
        const courseNames = new Map((await query<{ course_id: string; title: string; code: string | null }>(
            `SELECT course_id, title, code FROM academics.courses WHERE tenant_id = $1 AND course_id::text = ANY($2::text[])`, [context.tenantId, all.flatMap(a => a.courseIds)])).map(c => [c.course_id, c.code ? `${c.code}: ${c.title}` : c.title]));
        const batchNames = new Map((await query<{ batch_id: string; course_id: string; name: string }>(
            `SELECT b.batch_id, b.course_id, c.title || ': ' || b.name AS name FROM academics.batches b JOIN academics.courses c ON c.course_id = b.course_id
             WHERE b.tenant_id = $1 AND b.batch_id::text = ANY($2::text[])`, [context.tenantId, all.flatMap(a => a.batchIds)])).map(b => [b.batch_id, b]));
        const roleRank: Record<string, number> = {
            TenantAdmin: 1,      // Academy Admin always displayed first
            BranchManager: 2,
            Finance: 3,
            Instructor: 4,
            Staff: 5,
        };

        const result = staff.map(m => {
            if (m.role !== 'Staff' && m.role !== 'Instructor') return m;
            const a = rows.get(m.membershipId) ?? readAssignments(null);
            // Courses and batches that no longer exist are left out
            const batchIds = a.batchIds.filter(id => batchNames.has(id));
            const courseIds = a.courseIds.filter(id => courseNames.has(id));
            const narrowed = new Set(batchIds.map(id => batchNames.get(id)!.course_id));
            return {
                ...m, assignments: { courseIds, batchIds },
                assignedTo: [...courseIds.filter(id => !narrowed.has(id)).map(id => `${courseNames.get(id)}: all batches`), ...batchIds.map(id => batchNames.get(id)!.name)].sort(),
            };
        }).sort((a, b) => {
            const rankA = roleRank[a.role] ?? 99;
            const rankB = roleRank[b.role] ?? 99;
            if (rankA !== rankB) return rankA - rankB;
            return ((a as any).fullName || '').localeCompare((b as any).fullName || '');
        });

        return ok(context, result);
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
        const assignments = (role === 'Staff' || role === 'Instructor') ? readAssignments(body.assignments) : null;
        if (assignments && (assignments.courseIds.length > 0 || assignments.batchIds.length > 0)) {
            await checkAssignments(context.tenantId, branchId || null, assignments);
        }
        const result = await callFn<{ membershipId: string }>('tenant.fn_staff_create',
            context.tenantId, fullName, email, phone || null, hashPassword(password), role, branchId || null, title || null, context.actorId);
        if (assignments && (assignments.courseIds.length > 0 || assignments.batchIds.length > 0)) {
            await saveAssignments(context.tenantId, context.actorId, result.membershipId, branchId || null, assignments);
        }

        if (role === 'BranchManager' && branchId) {
            const [u] = await query<{ user_id: string }>(`SELECT user_id FROM tenant.memberships WHERE membership_id = $1`, [result.membershipId]);
            await query(`UPDATE tenant.branches SET head_user_id = $1, head_name = $2 WHERE branch_id = $3 AND tenant_id = $4`,
                [u?.user_id || null, fullName.trim(), branchId, context.tenantId]);
        }

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
            const [member] = await query<{ role: string; user_id: string }>(
                `SELECT role, user_id FROM tenant.memberships WHERE membership_id = $1 AND tenant_id = $2`, [membershipId, context.tenantId]);
            if (member && member.role === 'BranchManager' && branchId) {
                const [u] = await query<{ full_name: string }>(`SELECT full_name FROM identity_app.users WHERE user_id = $1`, [member.user_id]);
                await query(`UPDATE tenant.branches SET head_user_id = $1, head_name = $2 WHERE branch_id = $3 AND tenant_id = $4`,
                    [member.user_id, u?.full_name || null, branchId, context.tenantId]);
            }
            return ok(context, { saved: true });
        }
        if (!membershipId || typeof isActive !== 'boolean') {
            return problem(context, req, 400, 'Validation Error', 'membershipId and isActive are required.');
        }
        const res = await callFn('tenant.fn_membership_set_active', context.tenantId, membershipId, isActive, context.actorId);

        // Also keep identity_app.users.is_active synchronized
        const [member] = await query<{ user_id: string }>(
            `SELECT user_id FROM tenant.memberships WHERE membership_id = $1 AND tenant_id = $2`,
            [membershipId, context.tenantId]
        );
        if (member?.user_id) {
            await query(
                `UPDATE identity_app.users SET is_active = $1 WHERE user_id = $2`,
                [isActive, member.user_id]
            );
        }

        return ok(context, res);
    } catch (err) {
        return fail(err, context, req);
    }
}
