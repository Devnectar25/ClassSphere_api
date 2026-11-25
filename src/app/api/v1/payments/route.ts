import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { invoiceIdsInScope, requireStudentInScope, staffScope } from '@/lib/api/scope';
import {
    getStudentCourseFeeBreakdown,
    processCoursePayment
} from '@/lib/billing/fee-installments';

/**
 * Payments & Receipts API
 * Traceability: TDD Section 14, 19; PLT-012, DECISION-008
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;

    const studentId = req.nextUrl.searchParams.get('studentId');
    if (studentId) {
        try {
            await requireStudentInScope(context, studentId);
            const breakdown = await getStudentCourseFeeBreakdown(context.tenantId, studentId);
            const scope = await staffScope(context);
            if (!scope) return ok(context, breakdown);
            const courses = breakdown.courses.filter(c => c.batchId && scope.batchIds.includes(c.batchId));
            const sum = (key: 'totalFee' | 'paidAmount' | 'balanceAmount') => courses.reduce((t, c) => t + Math.round(c[key] * 100), 0) / 100;
            return ok(context, { ...breakdown, courses, totalFee: sum('totalFee'), totalPaid: sum('paidAmount'), totalBalance: sum('balanceAmount') });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    try {
        const list = await callFn<{ payments: Array<{ invoiceId: string; amount: number; status: string; isOnline: boolean; createdAt: string }>; summary: unknown }>(
            'billing.fn_payment_list', context.tenantId, context.branchId);
        const allowed = await invoiceIdsInScope(context);
        if (!allowed) return ok(context, list);
        const payments = list.payments.filter(p => allowed.has(p.invoiceId));
        const received = payments.filter(p => p.status === 'posted' || p.status === 'reconciled');
        const refunds = payments.filter(p => p.status === 'refunded');
        const total = (items: typeof payments) => items.reduce((t, p) => t + Math.round(Number(p.amount) * 100), 0) / 100;
        const month = new Date().toISOString().slice(0, 7);
        return ok(context, {
            payments,
            summary: {
                collectedThisMonth: total(received.filter(p => String(p.createdAt).slice(0, 7) === month)), onlineTotal: total(received.filter(p => p.isOnline)),
                offlineTotal: total(received.filter(p => !p.isOnline)), refundTotal: total(refunds), refundCount: refunds.length,
            },
        });
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const {
            studentId: reqStudentId,
            invoiceId,
            enrollmentId,
            courseTitle,
            amount,
            paymentMethod,
            paymentReference,
            paymentDate,
            gatewayOrderId,
            gatewayPaymentId
        } = body;

        const numAmount = Number(amount);
        if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
            return problem(context, req, 400, 'Validation Error', 'A positive payment amount is required.');
        }

        let effectiveStudentId = reqStudentId;
        if (!effectiveStudentId && invoiceId) {
            const invRows = await query<{ student_id: string }>(
                `SELECT student_id FROM billing.invoices WHERE invoice_id = $1 AND tenant_id = $2`,
                [invoiceId, context.tenantId]
            );
            if (invRows.length > 0) {
                effectiveStudentId = invRows[0].student_id;
            }
        }

        if (!effectiveStudentId) {
            return problem(context, req, 400, 'Validation Error', 'studentId or a valid invoiceId is required.');
        }

        const result = await processCoursePayment({
            tenantId: context.tenantId,
            studentId: effectiveStudentId,
            enrollmentId: enrollmentId || null,
            courseTitle,
            invoiceId,
            amount: numAmount,
            paymentMethod: paymentMethod || 'Cash',
            paymentReference: paymentReference || `OFFLINE-${effectiveStudentId.slice(0, 8)}-${Date.now()}`,
            paymentDate,
            gatewayOrderId,
            gatewayPaymentId,
            idempotencyKey: context.idempotencyKey,
            recordedByActorId: context.actorId
        });

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
