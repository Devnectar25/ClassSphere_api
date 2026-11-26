import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { branchIdsInScope } from '@/lib/api/scope';

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
                    b.head_user_id, COALESCE(u.full_name, b.head_name) AS head_name
             FROM tenant.branches b
             LEFT JOIN identity_app.users u ON u.user_id = b.head_user_id
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

        let resolvedHeadUserId: string | null = headUserId || null;
        let resolvedHeadName: string | null = (headName && typeof headName === 'string' && headName.trim()) ? headName.trim() : null;

        if (resolvedHeadUserId && !resolvedHeadName) {
            const userRows = await query<{ full_name: string }>(`SELECT full_name FROM identity_app.users WHERE user_id = $1`, [resolvedHeadUserId]);
            if (userRows.length > 0) resolvedHeadName = userRows[0].full_name;
        } else if (resolvedHeadName && !resolvedHeadUserId) {
            const matchRows = await query<{ user_id: string }>(
                `SELECT u.user_id FROM identity_app.users u JOIN tenant.memberships m ON m.user_id = u.user_id
                 WHERE m.tenant_id = $1 AND LOWER(TRIM(u.full_name)) = LOWER(TRIM($2)) LIMIT 1`,
                [context.tenantId, resolvedHeadName]
            );
            if (matchRows.length > 0) resolvedHeadUserId = matchRows[0].user_id;
        }

        const result = await callFn<{ success: boolean; branchId: string }>('tenant.fn_branch_create',
            context.tenantId, name.trim(), String(code).trim().toUpperCase(), address?.trim() || null, phone?.trim() || null, context.actorId);

        if (result?.branchId) {
            await callFn('tenant.fn_branch_update',
                context.tenantId,
                result.branchId,
                name.trim(),
                String(code).trim().toUpperCase(),
                address?.trim() || null,
                phone?.trim() || null,
                resolvedHeadUserId,
                isPrimary !== undefined ? Boolean(isPrimary) : null,
                isActive !== undefined ? Boolean(isActive) : true,
                context.actorId
            );

            await query(
                `UPDATE tenant.branches SET head_name = $1 WHERE branch_id = $2 AND tenant_id = $3`,
                [resolvedHeadName, result.branchId, context.tenantId]
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

        let resolvedHeadUserId: string | null = headUserId || null;
        let resolvedHeadName: string | null = (headName && typeof headName === 'string' && headName.trim()) ? headName.trim() : null;

        if (resolvedHeadUserId && !resolvedHeadName) {
            const userRows = await query<{ full_name: string }>(`SELECT full_name FROM identity_app.users WHERE user_id = $1`, [resolvedHeadUserId]);
            if (userRows.length > 0) resolvedHeadName = userRows[0].full_name;
        } else if (resolvedHeadName && !resolvedHeadUserId) {
            const matchRows = await query<{ user_id: string }>(
                `SELECT u.user_id FROM identity_app.users u JOIN tenant.memberships m ON m.user_id = u.user_id
                 WHERE m.tenant_id = $1 AND LOWER(TRIM(u.full_name)) = LOWER(TRIM($2)) LIMIT 1`,
                [context.tenantId, resolvedHeadName]
            );
            if (matchRows.length > 0) resolvedHeadUserId = matchRows[0].user_id;
        }

        const result = await callFn('tenant.fn_branch_update',
            context.tenantId,
            branchId,
            name.trim(),
            String(code).trim().toUpperCase(),
            address || null,
            phone || null,
            resolvedHeadUserId,
            isPrimary !== undefined ? Boolean(isPrimary) : null,
            isActive !== undefined ? Boolean(isActive) : true,
            context.actorId
        );

        await query(
            `UPDATE tenant.branches SET head_name = $1 WHERE branch_id = $2 AND tenant_id = $3`,
            [resolvedHeadName, branchId, context.tenantId]
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
