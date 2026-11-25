import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { requireAssignedBatch, staffScope } from '@/lib/api/scope';
import { billingError, getCreditBalance, getEnrollment, parseAmount } from '@/lib/billing/credit-ledger';
import { buildSchedule, createEnrollmentFeePlan, getCourseFee, parseFeePlanInput } from '@/lib/billing/fee-plans';
import { getEnrollmentPeriod } from '@/lib/billing/course-period';
import { configureTransferFeePlan, getTransferDetail, listTransfers, reviewTransferCredit, type TransferReview } from '@/lib/billing/course-transfer';

/**
 * Finance side of course transfers: credit review and the new course fee plan.
 * Users restricted to a branch only reach transfers that involve their branch.
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        const params = req.nextUrl.searchParams;
        const transferId = params.get('transferId');
        if (transferId) {
            const detail = await getTransferDetail({ query }, context.tenantId, transferId, context.branchId);
            await requireAssignedBatch(context, detail.to.batchId, 'This transfer is not in a batch assigned to you.');
            return ok(context, detail);
        }
        const list = await listTransfers({ query }, context.tenantId, {
            branchId: context.branchId, studentId: params.get('studentId'), transferId: null,
        });
        const scope = await staffScope(context);
        if (!scope) return ok(context, list);
        const own = new Set((await query<{ enrollment_id: string }>(
            `SELECT enrollment_id FROM academics.enrollments WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])`, [context.tenantId, scope.batchIds])).map(r => r.enrollment_id));
        return ok(context, list.filter(t => own.has(t.toEnrollmentId)));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    const { tenantId, actorId, branchId } = context;
    try {
        const body = await req.json();
        const transferId = body.transferId ? String(body.transferId) : null;
        // Confirms the transfer exists and is within the user's branch
        if (transferId) await getTransferDetail({ query }, tenantId, transferId, branchId);

        switch (body.action) {
            case 'review': {
                if (!transferId) return problem(context, req, 400, 'Validation Error', 'transferId is required.');
                const review = parseTransferReview(body);
                const result = await withTransaction(tx => reviewTransferCredit(tx, { tenantId, actorId, transferId, review }));
                return ok(context, result);
            }
            case 'create_fee_plan': {
                const input = parseFeePlanInput(body);
                if (transferId) {
                    return ok(context, await withTransaction(tx => configureTransferFeePlan(tx, { tenantId, actorId, transferId, input })), 201);
                }
                if (!body.enrollmentId) return problem(context, req, 400, 'Validation Error', 'transferId or enrollmentId is required.');
                const enrollment = await getEnrollment({ query }, tenantId, String(body.enrollmentId));
                if (branchId && enrollment.branchId !== branchId) throw billingError('forbidden', 'This enrollment belongs to another branch.');
                const [pending] = await query<{ transfer_id: string }>(
                    `SELECT transfer_id FROM billing.course_transfers WHERE tenant_id = $1 AND to_enrollment_id = $2 AND fee_plan_status = 'pending'`,
                    [tenantId, enrollment.enrollmentId]);
                if (pending) throw billingError('conflict', 'Create this fee plan from the course transfer.');
                return ok(context, await withTransaction(tx => createEnrollmentFeePlan(tx, {
                    tenantId, actorId, enrollmentId: enrollment.enrollmentId, input, transfer: null,
                })), 201);
            }
            case 'preview_schedule': {
                const input = parseFeePlanInput(body);
                const detail = transferId ? await getTransferDetail({ query }, tenantId, transferId, branchId) : null;
                if (!detail && !body.enrollmentId) return problem(context, req, 400, 'Validation Error', 'transferId or enrollmentId is required.');
                const enrollment = detail?.to ?? await getEnrollment({ query }, tenantId, String(body.enrollmentId));
                const fee = await getCourseFee({ query }, tenantId, enrollment, input.templatePlanId);
                const period = await getEnrollmentPeriod({ query }, tenantId, enrollment.enrollmentId);
                input.firstDueDate ??= period.firstDueDate;
                return ok(context, {
                    ...fee, period, creditBalance: await getCreditBalance({ query }, tenantId, enrollment.studentId),
                    installments: buildSchedule(fee.netFee, input.applyCredit, input),
                });
            }
            default:
                return problem(context, req, 400, 'Validation Error', `Unrecognized action '${body.action}'.`);
        }
    } catch (err) {
        return fail(err, context, req);
    }
}

function parseTransferReview(body: Record<string, unknown>): TransferReview {
    if (body.decision !== 'approve' && body.decision !== 'reject') throw billingError('invalid', 'Choose to approve or reject the transfer credit.');
    const optional = (value: unknown, label: string) => (value === undefined || value === null || value === '' ? null : parseAmount(value, label));
    return {
        decision: body.decision,
        consumedAmount: optional(body.consumedAmount, 'Consumed fee'),
        approvedCredit: optional(body.approvedCredit, 'Approved credit'),
        notes: body.notes ? String(body.notes).trim().slice(0, 1000) || null : null,
    };
}
