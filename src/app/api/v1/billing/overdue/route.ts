import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize, resolveRequestContext } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { invoiceIdsInScope } from '@/lib/api/scope';

interface OverdueListResponse {
    items: Array<Record<string, unknown>>;
    summary: Record<string, unknown>;
}

interface HouseholdResponse {
    wards?: Array<{
        id: string;
        name: string;
        invoices?: Array<{
            id: string;
            invoice_number: string;
            designation: string;
            billing_period: string;
            amount: number;
            balance: number;
            late_fee_amount?: number;
            overdue_status?: string;
            days_overdue?: number;
            due_date?: string;
            status: string;
        }>;
    }>;
}

/**
 * GET /api/v1/billing/overdue
 * Filters: branchId, courseId, batchId, minDaysOverdue
 * RBAC:
 * - Admin and Finance: full access across tenant or scoped by branch filter
 * - Manager: restricted to their assigned branch
 * - Staff: read-only access
 * - Parent (Guardian): restricted to their linked children's dues
 */
export async function GET(req: NextRequest) {
    const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();
    const rawContext = resolveRequestContext(req);
    if (!rawContext) {
        return problem({ correlationId }, req, 401, 'Unauthorized', 'Sign in to access overdue fees.');
    }

    // Parent / Guardian view: return their linked children's overdue invoices
    if (rawContext.actorRole === 'Guardian') {
        try {
            const household = await callFn<HouseholdResponse>(
                'reporting.fn_guardian_household',
                rawContext.tenantId,
                null,
                rawContext.actorId
            );

            const items: Array<Record<string, unknown>> = [];
            let totalOverdue = 0;
            let totalLateFees = 0;

            for (const ward of household?.wards || []) {
                for (const inv of ward.invoices || []) {
                    const isOverdue = inv.status === 'overdue' || inv.overdue_status === 'overdue' || (Number(inv.balance || 0) > 0 && inv.due_date && new Date(inv.due_date) < new Date());
                    if (isOverdue || (inv.late_fee_amount && inv.late_fee_amount > 0)) {
                        items.push({
                            invoice_id: inv.id,
                            invoice_number: inv.invoice_number,
                            student_id: ward.id,
                            student_name: ward.name,
                            designation: inv.designation,
                            billing_period: inv.billing_period,
                            original_amount: inv.amount,
                            late_fee_amount: inv.late_fee_amount || 0,
                            balance_amount: inv.balance,
                            due_date: inv.due_date,
                            days_overdue: inv.days_overdue || 0,
                            overdue_status: inv.overdue_status || 'overdue',
                            status: inv.status,
                        });
                        totalOverdue += Number(inv.balance || 0);
                        totalLateFees += Number(inv.late_fee_amount || 0);
                    }
                }
            }

            return ok(rawContext, {
                items,
                summary: {
                    total_overdue_count: items.length,
                    total_overdue_amount: totalOverdue,
                    total_late_fees: totalLateFees,
                },
            });
        } catch (err) {
            return fail(err, rawContext, req);
        }
    }

    // Staff / Manager / Finance / Admin
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;

    try {
        const { searchParams } = req.nextUrl;
        const requestedBranch = searchParams.get('branchId') || searchParams.get('branch_id');
        const courseId = searchParams.get('courseId') || searchParams.get('course_id');
        const batchId = searchParams.get('batchId') || searchParams.get('batch_id');
        const minDaysRaw = searchParams.get('minDaysOverdue') || searchParams.get('daysOverdue') || searchParams.get('days_overdue');
        const minDaysOverdue = minDaysRaw ? parseInt(minDaysRaw, 10) : null;

        // RBAC: Manager cannot view branches other than their own
        const effectiveBranchId = context.actorRole === 'BranchManager'
            ? context.branchId
            : (context.branchId || requestedBranch || null);

        const data = await callFn<OverdueListResponse>(
            'billing.fn_overdue_list',
            context.tenantId,
            effectiveBranchId,
            courseId || null,
            batchId || null,
            Number.isFinite(minDaysOverdue) ? minDaysOverdue : null
        );

        const allowed = await invoiceIdsInScope(context);
        if (!allowed) return ok(context, data);
        const items = (data.items as Array<{ invoiceId: string; overdueStatus: string; balanceAmount: number; lateFeeAmount: number | null }>).filter(i => allowed.has(i.invoiceId));
        const over = items.filter(i => i.overdueStatus === 'overdue' || Number(i.balanceAmount) > 0);
        return ok(context, {
            items,
            summary: {
                totalOverdueCount: over.length, totalOverdueAmount: over.reduce((t, i) => t + Number(i.balanceAmount), 0), totalLateFees: items.reduce((t, i) => t + Number(i.lateFeeAmount ?? 0), 0),
                totalWaivedCount: items.filter(i => i.overdueStatus === 'waived').length, totalInGraceCount: items.filter(i => i.overdueStatus === 'in_grace').length,
            },
        });
    } catch (err) {
        return fail(err, context, req);
    }
}
