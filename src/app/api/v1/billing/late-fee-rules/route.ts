import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * GET /api/v1/billing/late-fee-rules
 * Returns tenant default late fee rule, branch overrides, and effective rule
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;

    try {
        const { searchParams } = req.nextUrl;
        const requestedBranch = searchParams.get('branchId') || searchParams.get('branch_id');

        const effectiveBranchId = context.actorRole === 'BranchManager'
            ? context.branchId
            : (context.branchId || requestedBranch || null);

        const data = await callFn(
            'billing.fn_late_fee_rule_get',
            context.tenantId,
            effectiveBranchId
        );

        return ok(context, data);
    } catch (err) {
        return fail(err, context, req);
    }
}

/**
 * PUT /api/v1/billing/late-fee-rules
 * Upserts a late fee rule (tenant default or branch override)
 * RBAC: Admin and Finance only
 */
export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;

    // RBAC: Admin and Finance can manage rules
    const allowedRoles = ['PlatformAdmin', 'TenantAdmin', 'Finance'];
    if (!context.isPlatformAdmin && !allowedRoles.includes(context.actorRole)) {
        return problem(
            context,
            req,
            403,
            'Forbidden',
            'Only academy administrators and finance officers can configure late fee rules.'
        );
    }

    try {
        const body = await req.json();
        const { branchId, calcMethod, value, graceDays, capAmount, isActive } = body;

        const normalizedMethod = String(calcMethod || '').toLowerCase().trim();
        if (!['flat', 'percent', 'per_day'].includes(normalizedMethod)) {
            return problem(
                context,
                req,
                400,
                'Validation Error',
                'calcMethod must be flat, percent, or per_day.'
            );
        }

        const numValue = Number(value);
        if (!Number.isFinite(numValue) || numValue < 0) {
            return problem(
                context,
                req,
                400,
                'Validation Error',
                'Rule value must be a non-negative number.'
            );
        }

        const numGrace = Number(graceDays ?? 0);
        if (!Number.isFinite(numGrace) || numGrace < 0) {
            return problem(
                context,
                req,
                400,
                'Validation Error',
                'Grace days must be a non-negative integer.'
            );
        }

        const numCap = capAmount !== null && capAmount !== undefined && capAmount !== ''
            ? Number(capAmount)
            : null;
        if (numCap !== null && (!Number.isFinite(numCap) || numCap < 0)) {
            return problem(
                context,
                req,
                400,
                'Validation Error',
                'Cap amount must be a non-negative number or null.'
            );
        }

        const result = await callFn(
            'billing.fn_late_fee_rule_upsert',
            context.tenantId,
            branchId || null,
            normalizedMethod,
            numValue,
            numGrace,
            numCap,
            isActive ?? true,
            context.actorId
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
