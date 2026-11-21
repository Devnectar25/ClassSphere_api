import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * GET /api/v1/billing/overdue/summary
 * Per-branch totals, aging buckets, and overall overdue aggregates
 * RBAC:
 * - Admin and Finance: full consolidated overview or per-branch breakdown
 * - Manager: scoped to their branch
 * - Staff: read-only
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
            'billing.fn_overdue_summary',
            context.tenantId,
            effectiveBranchId
        );

        return ok(context, data);
    } catch (err) {
        return fail(err, context, req);
    }
}
