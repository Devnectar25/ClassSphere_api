import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { branchIdsInScope } from '@/lib/api/scope';
import { hashPassword } from '@/lib/auth';

/**
 * Ensures that a Branch Manager is properly linked or created as a user with
 * role = 'BranchManager' in tenant.memberships and reflected on the branch.
 */
export async function syncBranchManager(
    tenantId: string,
    branchId: string,
    headUserId: string | null | undefined,
    headName: string | null | undefined
): Promise<{ userId: string | null; fullName: string | null }> {
    const cleanName = (headName && typeof headName === 'string' && headName.trim()) ? headName.trim() : null;
    let resolvedUserId = (headUserId && typeof headUserId === 'string' && headUserId.trim()) ? headUserId.trim() : null;
    let resolvedName = cleanName;

    if (!resolvedUserId && !cleanName) {
        await query(
            `UPDATE tenant.branches SET head_user_id = NULL, head_name = NULL WHERE branch_id = $1 AND tenant_id = $2`,
            [branchId, tenantId]
        );
        return { userId: null, fullName: null };
    }

    if (resolvedUserId) {
        const [u] = await query<{ user_id: string; full_name: string }>(
            `SELECT user_id, full_name FROM identity_app.users WHERE user_id = $1`,
            [resolvedUserId]
        );
        if (u) {
            resolvedName = cleanName || u.full_name;
        } else {
            resolvedUserId = null;
        }
    }

    if (!resolvedUserId && cleanName) {
        // 1. Try finding within tenant memberships
        const [tenantUser] = await query<{ user_id: string; full_name: string }>(
            `SELECT u.user_id, u.full_name FROM identity_app.users u
             JOIN tenant.memberships m ON m.user_id = u.user_id
             WHERE m.tenant_id = $1 AND LOWER(TRIM(u.full_name)) = LOWER(TRIM($2))
             LIMIT 1`,
            [tenantId, cleanName]
        );

        if (tenantUser) {
            resolvedUserId = tenantUser.user_id;
            resolvedName = tenantUser.full_name;
        } else {
            // 2. Try finding anywhere in identity_app.users
            const [globalUser] = await query<{ user_id: string; full_name: string }>(
                `SELECT user_id, full_name FROM identity_app.users
                 WHERE LOWER(TRIM(full_name)) = LOWER(TRIM($1))
                 ORDER BY last_login_at DESC NULLS LAST, created_at DESC
                 LIMIT 1`,
                [cleanName]
            );

            if (globalUser) {
                resolvedUserId = globalUser.user_id;
                resolvedName = globalUser.full_name;
            } else {
                // 3. Create a new user in identity_app.users
                const [tenantOrg] = await query<{ slug: string }>(
                    `SELECT slug FROM tenant.organizations WHERE tenant_id = $1`,
                    [tenantId]
                );
                const baseSlug = tenantOrg?.slug || 'academy';
                const nameSlug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '') || 'manager';
                let candidateEmail = `${nameSlug}@${baseSlug}.com`;

                const [emailExists] = await query<{ user_id: string }>(
                    `SELECT user_id FROM identity_app.users WHERE LOWER(email) = LOWER($1)`,
                    [candidateEmail]
                );
                if (emailExists) {
                    candidateEmail = `${nameSlug}.${Math.floor(1000 + Math.random() * 9000)}@${baseSlug}.com`;
                }

                const defaultPasswordHash = hashPassword('Welcome@123');
                const [newUser] = await query<{ user_id: string }>(
                    `INSERT INTO identity_app.users (full_name, email, password_hash, is_active, email_verified_at)
                     VALUES ($1, $2, $3, true, clock_timestamp())
                     RETURNING user_id`,
                    [cleanName, candidateEmail, defaultPasswordHash]
                );
                resolvedUserId = newUser?.user_id || null;
                resolvedName = cleanName;
            }
        }
    }

    if (resolvedUserId) {
        // Ensure role = 'BranchManager' and branch_id = branchId in tenant.memberships
        const [existing] = await query<{ membership_id: string; role: string }>(
            `SELECT membership_id, role FROM tenant.memberships WHERE tenant_id = $1 AND user_id = $2 AND role = 'BranchManager'`,
            [tenantId, resolvedUserId]
        );

        if (existing) {
            await query(
                `UPDATE tenant.memberships SET branch_id = $1, is_active = true WHERE membership_id = $2`,
                [branchId, existing.membership_id]
            );
        } else {
            const [other] = await query<{ membership_id: string; role: string }>(
                `SELECT membership_id, role FROM tenant.memberships
                 WHERE tenant_id = $1 AND user_id = $2 AND role NOT IN ('TenantAdmin', 'BranchManager')
                 LIMIT 1`,
                [tenantId, resolvedUserId]
            );

            if (other) {
                await query(
                    `UPDATE tenant.memberships SET role = 'BranchManager', branch_id = $1, is_active = true WHERE membership_id = $2`,
                    [branchId, other.membership_id]
                );
            } else {
                await query(
                    `INSERT INTO tenant.memberships (tenant_id, user_id, branch_id, role, title, is_active)
                     VALUES ($1, $2, $3, 'BranchManager', 'Branch Manager', true)
                     ON CONFLICT (tenant_id, user_id, role)
                     DO UPDATE SET branch_id = EXCLUDED.branch_id, is_active = true`,
                    [tenantId, resolvedUserId, branchId]
                );
            }
        }

        // Unlink any other user who was previously BranchManager for this branch
        await query(
            `UPDATE tenant.memberships SET branch_id = NULL
             WHERE tenant_id = $1 AND branch_id = $2 AND role = 'BranchManager' AND user_id <> $3`,
            [tenantId, branchId, resolvedUserId]
        );
    }

    await query(
        `UPDATE tenant.branches SET head_user_id = $1, head_name = $2 WHERE branch_id = $3 AND tenant_id = $4`,
        [resolvedUserId, resolvedName, branchId, tenantId]
    );

    return { userId: resolvedUserId, fullName: resolvedName };
}

/**
 * Branch listing (GET)
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        const rows = await query<{
            branch_id: string;
            name: string;
            code: string;
            address: string | null;
            phone: string | null;
            is_primary: boolean;
            is_active: boolean;
            head_user_id: string | null;
            head_name: string | null;
        }>(
            `SELECT b.branch_id, b.name, b.code, b.address, b.phone, b.is_primary, b.is_active,
                    COALESCE(bm.user_id, b.head_user_id) AS head_user_id,
                    COALESCE(bm.full_name, u.full_name, b.head_name) AS head_name
             FROM tenant.branches b
             LEFT JOIN identity_app.users u ON u.user_id = b.head_user_id
             LEFT JOIN LATERAL (
                 SELECT m.user_id, mu.full_name
                 FROM tenant.memberships m
                 JOIN identity_app.users mu ON mu.user_id = m.user_id
                 WHERE m.tenant_id = b.tenant_id AND m.branch_id = b.branch_id AND m.role = 'BranchManager' AND m.is_active = true
                 ORDER BY m.created_at DESC
                 LIMIT 1
             ) bm ON true
             WHERE b.tenant_id = $1 AND b.is_active = true
             ORDER BY b.is_primary DESC, b.name ASC`,
            [context.tenantId]
        );
        const allowed = await branchIdsInScope(context);
        return ok(context, rows.filter(r => !allowed || allowed.has(r.branch_id)).map(r => ({
            branchId: r.branch_id,
            name: r.name,
            code: r.code,
            address: r.address,
            phone: r.phone,
            isPrimary: r.is_primary,
            isActive: r.is_active,
            headUserId: r.head_user_id,
            headName: r.head_name
        })));
    } catch (err) {
        return fail(err, context, req);
    }
}

/**
 * Branch creation (within the subscription's branch quota)
 * Traceability: TDD Section 10.4; PLT-005
 */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'branches.write');
    if (context instanceof Response) return context;
    try {
        const { name, code, address, phone, headUserId, headName, isPrimary, isActive } = await req.json();
        if (!name?.trim() || !code?.trim()) return problem(context, req, 400, 'Validation Error', 'Branch name and code are required.');

        const check = await callFn<{ allowed: boolean; maximum: number; planTier: string }>('tenant.fn_entitlement_check', context.tenantId, 'branches');
        if (!check.allowed) {
            return problem(context, req, 402, 'Subscription Entitlement Exceeded',
                `Branch limit of ${check.maximum} reached for the ${check.planTier} plan.`);
        }

        const result = await callFn<{ success: boolean; branchId: string }>('tenant.fn_branch_create',
            context.tenantId, name.trim(), String(code).trim().toUpperCase(), address?.trim() || null, phone?.trim() || null, context.actorId);

        if (result?.branchId) {
            const synced = await syncBranchManager(context.tenantId, result.branchId, headUserId, headName);

            await callFn('tenant.fn_branch_update',
                context.tenantId,
                result.branchId,
                name.trim(),
                String(code).trim().toUpperCase(),
                address?.trim() || null,
                phone?.trim() || null,
                synced.userId,
                isPrimary !== undefined ? Boolean(isPrimary) : null,
                isActive !== undefined ? Boolean(isActive) : true,
                context.actorId
            );
        }

        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

/**
 * Branch update
 */
export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'branches.write');
    if (context instanceof Response) return context;
    try {
        const { branchId, name, code, address, phone, headUserId, headName, isPrimary, isActive } = await req.json();
        if (!branchId || !name?.trim() || !code?.trim()) {
            return problem(context, req, 400, 'Validation Error', 'Branch ID, name and code are required.');
        }

        const synced = await syncBranchManager(context.tenantId, branchId, headUserId, headName);

        const result = await callFn('tenant.fn_branch_update',
            context.tenantId,
            branchId,
            name.trim(),
            String(code).trim().toUpperCase(),
            address || null,
            phone || null,
            synced.userId,
            isPrimary !== undefined ? Boolean(isPrimary) : null,
            isActive !== undefined ? Boolean(isActive) : true,
            context.actorId
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

/**
 * Branch deletion
 */
export async function DELETE(req: NextRequest) {
    const context = await authorize(req, 'branches.write');
    if (context instanceof Response) return context;
    try {
        const searchParams = req.nextUrl.searchParams;
        let branchId = searchParams.get('branchId');
        if (!branchId) {
            const body = await req.json().catch(() => ({}));
            branchId = body?.branchId;
        }

        if (!branchId) {
            return problem(context, req, 400, 'Validation Error', 'Branch ID is required.');
        }

        const result = await callFn('tenant.fn_branch_delete',
            context.tenantId,
            branchId,
            context.actorId
        );
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
