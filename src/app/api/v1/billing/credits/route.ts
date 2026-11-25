import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db/db';
import { authorize, type RequestContext } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { requireStudentInScope } from '@/lib/api/scope';
import {
    applyCreditToEnrollment, billingError, getCreditBalance, getCreditHistory, getEnrollment, lockStudent, parseAmount, writeAudit,
} from '@/lib/billing/credit-ledger';

/** Student credit balance, ledger history and Finance-approved application of credit. */
async function requireStudent(context: RequestContext, studentId: string) {
    const [row] = await query<{ branch_id: string | null }>(
        `SELECT branch_id FROM academics.students WHERE student_id = $1 AND tenant_id = $2`, [studentId, context.tenantId]);
    if (!row) throw billingError('not_found', 'Student not found.');
    if (context.branchId && row.branch_id && row.branch_id !== context.branchId) throw billingError('forbidden', 'This student belongs to another branch.');
    await requireStudentInScope(context, studentId);
}

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        const studentId = req.nextUrl.searchParams.get('studentId');
        if (!studentId) return problem(context, req, 400, 'Validation Error', 'studentId is required.');
        await requireStudent(context, studentId);
        const audit = await query<{ action: string; created_at: string; details: unknown; actor_name: string | null }>(
            `SELECT a.action, a.created_at, a.details, u.full_name AS actor_name
             FROM audit.compliance_logs a LEFT JOIN identity_app.users u ON u.user_id = a.actor_id
             WHERE a.tenant_id = $1 AND (a.details->>'studentId' = $2 OR a.entity_id = $2)
               AND a.action IN ('billing.transfer_credit_approved', 'billing.transfer_credit_rejected', 'billing.credit_applied', 'billing.fee_plan_created',
                                'billing.payment_posted', 'billing.payment_declared', 'billing.payment_verified', 'billing.payment_rejected',
                                'billing.consumption_manual_review', 'billing.consumption_verification_requested', 'attendance.corrected', 'attendance.session_confirmed',
                                'billing.installment_carried_forward', 'billing.schedule_adjusted', 'student.course_transferred')
             ORDER BY a.created_at DESC LIMIT 100`,
            [context.tenantId, studentId]);
        return ok(context, {
            balance: await getCreditBalance({ query }, context.tenantId, studentId),
            entries: await getCreditHistory({ query }, context.tenantId, studentId),
            audit: audit.map(a => ({ action: a.action, createdAt: a.created_at, details: a.details, actorName: a.actor_name })),
        });
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    const { tenantId, actorId } = context;
    try {
        const body = await req.json();
        const studentId = body.studentId ? String(body.studentId) : '';
        if (!studentId) return problem(context, req, 400, 'Validation Error', 'studentId is required.');
        await requireStudent(context, studentId);

        switch (body.action) {
            case 'apply': {
                if (!context.idempotencyKey) return problem(context, req, 400, 'Idempotency Key Required', 'Applying credit requires an Idempotency-Key header.');
                const reason = String(body.reason ?? '').trim();
                if (!body.enrollmentId || !reason) return problem(context, req, 400, 'Validation Error', 'Choose the course and enter the reason for applying credit.');
                const amount = parseAmount(body.amount, 'Credit amount');
                return ok(context, await withTransaction(tx => applyCreditToEnrollment(tx, {
                    tenantId, studentId, enrollmentId: String(body.enrollmentId), amount, reason: reason.slice(0, 200), actorId,
                    idempotencyKey: context.idempotencyKey!.slice(0, 80),
                })));
            }
            // An older invoice that names no course is assigned to one by Finance; amounts are untouched
            case 'link_invoice': {
                const result = await withTransaction(async tx => {
                    await lockStudent(tx, tenantId, studentId);
                    const enrollment = await getEnrollment(tx, tenantId, String(body.enrollmentId ?? ''));
                    if (enrollment.studentId !== studentId) throw billingError('forbidden', 'Course enrollment does not belong to the selected student.');
                    const linked = await tx.query<{ invoice_number: string }>(
                        `UPDATE billing.invoices SET enrollment_id = $1, updated_at = clock_timestamp()
                         WHERE invoice_id = $2 AND tenant_id = $3 AND student_id = $4 AND enrollment_id IS NULL RETURNING invoice_number`,
                        [enrollment.enrollmentId, String(body.invoiceId ?? ''), tenantId, studentId]);
                    if (linked.length === 0) throw billingError('conflict', 'This invoice is already linked to a course.');
                    await writeAudit(tx, {
                        tenantId, actorId, action: 'billing.invoice_linked', entityType: 'invoice', entityId: String(body.invoiceId),
                        details: { studentId, invoiceNumber: linked[0].invoice_number, enrollmentId: enrollment.enrollmentId, course: enrollment.courseTitle },
                    });
                    return { invoiceNumber: linked[0].invoice_number, course: enrollment.courseTitle };
                });
                return ok(context, result);
            }
            default:
                return problem(context, req, 400, 'Validation Error', `Unrecognized action '${body.action}'.`);
        }
    } catch (err) {
        return fail(err, context, req);
    }
}
