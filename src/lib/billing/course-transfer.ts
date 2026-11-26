/**
 * Course transfer: closes the old enrollment, opens the new one and hands the fee side to Finance.
 *
 * The academic transfer (students.write) and the Finance decision (billing.write) are separate steps, so Finance can
 * review credit later; a user holding both permissions may do everything in one request and one transaction.
 * Old dues always stay with the old enrollment and are never netted against credit.
 */
import {
    ACTIVE_ENROLLMENT, billingError, fromMinor, getCreditBalance, getEnrollment, getEnrollmentFinancials, isActiveEnrollment, lockStudent,
    postCreditEntry, toMinor, writeAudit, type EnrollmentInfo, type Queryable,
} from '@/lib/billing/credit-ledger';
import { getEnrollmentPeriod } from '@/lib/billing/course-period';
import {
    assessConsumption, assessmentSnapshot, closeVerificationRequest, recordManualReview, requestVerification, transferDay, unresolvedMessage, type ConsumptionAssessment,
} from '@/lib/billing/fee-consumption';
import { createEnrollmentFeePlan, type FeePlanInput, type FeePlanResult } from '@/lib/billing/fee-plans';

export interface TransferReview {
    decision: 'approve' | 'reject';
    /** Manual Finance review (needs the reason in notes); null uses the verified calculation */
    consumedAmount: number | null;
    approvedCredit: number | null;
    notes: string | null;
}

interface TransferRow {
    transfer_id: string; student_id: string; from_enrollment_id: string; to_enrollment_id: string; credit_status: string;
    fee_plan_status: string; created_at: string; approved_credit: string; eligible_credit: string | null;
}

async function lockTransfer(tx: Queryable, tenantId: string, transferId: string): Promise<TransferRow> {
    const [row] = await tx.query<TransferRow>(
        `SELECT transfer_id, student_id, from_enrollment_id, to_enrollment_id, credit_status, fee_plan_status, created_at,
                approved_credit::text, eligible_credit::text
         FROM billing.course_transfers WHERE transfer_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [transferId, tenantId]);
    if (!row) throw billingError('not_found', 'Course transfer not found.');
    return row;
}

export interface ExecuteTransferParams {
    tenantId: string; actorId: string; studentId: string; fromEnrollmentId: string; toBatchId: string;
    transferDate: Date; reason: string; remarks: string | null;
    /** Finance steps; the caller must hold billing.write to pass any of these. */
    review: TransferReview | null;
    feePlan: FeePlanInput | null;
    waiver: { reason: string } | null;
}

export interface TransferResult {
    transferId: string; newEnrollmentId: string; creditStatus: string; feePlanStatus: string; eligibleCredit: number | null;
    approvedCredit: number; creditBalance: number; oldOutstanding: number; feePlan: FeePlanResult | null; from: EnrollmentInfo; to: EnrollmentInfo;
    summary: TransferSummary;
}

/** What the transfer does to the money, as calculated inside the transaction. */
export interface TransferSummary {
    [key: string]: unknown;
    sameCourse: boolean; oldCourseFee: number; verifiedPaid: number; previousAdjustments: number; unusedCeiling: number;
    /** null while Finance has not verified it */
    consumedAmount: number | null; eligibleCredit: number | null; consumptionMethod: string | null; calculation: string | null;
    oldOutstanding: number; waivedAmount: number; remainingOutstanding: number;
    existingCredit: number; approvedCredit: number; creditApplied: number; remainingCredit: number;
    newCourseFee: number; discount: number; payable: number | null;
}

/** Performs the transfer. Must run inside a transaction: any failure leaves the old enrollment and payments untouched. */
export async function executeCourseTransfer(tx: Queryable, params: ExecuteTransferParams): Promise<TransferResult> {
    const { tenantId, actorId, studentId } = params;
    const student = await lockStudent(tx, tenantId, studentId);
    const from = await getEnrollment(tx, tenantId, params.fromEnrollmentId);
    if (from.studentId !== studentId) throw billingError('not_found', 'Current enrollment record not found.');
    if (!isActiveEnrollment(from.status)) {
        throw billingError('conflict', `Cannot transfer enrollment with status '${from.status}'. Only active enrollments can be transferred.`);
    }

    // Capacity is re-checked under a lock so that the last seat cannot be given away twice
    const [batch] = await tx.query<{ name: string; capacity: number; course_id: string }>(
        `SELECT name, capacity, course_id FROM academics.batches WHERE batch_id = $1 AND tenant_id = $2 FOR UPDATE`, [params.toBatchId, tenantId]);
    if (!batch) throw billingError('not_found', 'Destination batch not found.');
    const [seats] = await tx.query<{ taken: number }>(
        `SELECT COUNT(*)::int AS taken FROM academics.enrollments WHERE batch_id = $1 AND status = ANY($2)`, [params.toBatchId, ACTIVE_ENROLLMENT]);
    if (batch.capacity > 0 && seats.taken >= batch.capacity) {
        throw billingError('conflict', `Destination batch '${batch.name}' has reached maximum capacity (${seats.taken}/${batch.capacity} seats).`);
    }
    const [duplicate] = await tx.query<{ enrollment_id: string }>(
        `SELECT e.enrollment_id FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
         WHERE e.student_id = $1 AND b.course_id = $2 AND e.enrollment_id <> $3 AND e.status = ANY($4) LIMIT 1`,
        [studentId, batch.course_id, from.enrollmentId, ACTIVE_ENROLLMENT]);
    if (duplicate) throw billingError('conflict', 'Student already has an active enrollment in the destination course.');

    const sameCourse = batch.course_id === from.courseId;
    const position = await getEnrollmentFinancials(tx, tenantId, from);
    const existingCredit = await getCreditBalance(tx, tenantId, studentId);

    // Money is at stake: the consumed fee must be verified first, or decided by Finance in this request
    const reviewable = !sameCourse && (position.unusedCeiling > 0 || position.pendingVerification > 0 || position.unlinkedPaid > 0);
    if (reviewable && !params.review) {
        const assessment = await assessConsumption(tx, tenantId, from, transferDay(params.transferDate));
        if (assessment.policy.requireVerification && assessment.status !== 'verified') {
            throw billingError('conflict', `The transfer waits for verification of the consumed fee. ${unresolvedMessage(assessment)}`);
        }
    }

    const closed = await tx.query<{ enrollment_id: string }>(
        `UPDATE academics.enrollments SET status = 'transferred', transfer_reason = $1, remarks = $2, transferred_at = $3
         WHERE enrollment_id = $4 AND tenant_id = $5 AND status = ANY($6) RETURNING enrollment_id`,
        [params.reason, params.remarks, params.transferDate.toISOString(), from.enrollmentId, tenantId, ACTIVE_ENROLLMENT]);
    if (closed.length === 0) throw billingError('conflict', 'This enrollment has already been transferred.');

    // 'enrolled' is the status class lists, attendance, timetables and tests read
    const [created] = await tx.query<{ enrollment_id: string }>(
        `INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status, enrolled_at)
         VALUES ($1, $2, $3, 'enrolled', $4)
         ON CONFLICT (student_id, batch_id) DO UPDATE
         SET status = 'enrolled', enrolled_at = EXCLUDED.enrolled_at, transfer_reason = NULL, remarks = NULL, transferred_at = NULL
         RETURNING enrollment_id`,
        [tenantId, studentId, params.toBatchId, params.transferDate.toISOString()]);
    const to = await getEnrollment(tx, tenantId, created.enrollment_id);

    // Nothing was ever paid or credited (not reviewable): there is no credit to review
    const [transfer] = await tx.query<{ transfer_id: string; created_at: string }>(
        `INSERT INTO billing.course_transfers (tenant_id, student_id, from_enrollment_id, to_enrollment_id, transfer_date, reason, remarks,
             old_course_fee, old_paid_amount, old_outstanding_amount, unused_ceiling, credit_status, fee_plan_status, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING transfer_id, created_at`,
        [tenantId, studentId, from.enrollmentId, to.enrollmentId, params.transferDate.toISOString(), params.reason, params.remarks,
            position.courseFee, position.verifiedPaid, position.outstanding, position.unusedCeiling,
            reviewable ? 'pending_review' : 'not_applicable', sameCourse ? 'carried_over' : 'pending', actorId]);

    if (sameCourse) {
        // Batch change within one course: the fee does not change, so its schedule moves with the student
        await tx.query(
            `UPDATE billing.invoices SET enrollment_id = $1, updated_at = clock_timestamp()
             WHERE tenant_id = $2 AND enrollment_id = $3
               AND (enrollment_plan_id IN (SELECT enrollment_plan_id FROM billing.enrollment_fee_plans WHERE enrollment_id = $3 AND status = 'active')
                    OR NOT EXISTS (SELECT 1 FROM billing.course_transfers WHERE from_enrollment_id = $3 AND transfer_id <> $4))`,
            [to.enrollmentId, tenantId, from.enrollmentId, transfer.transfer_id]);
        await tx.query(`UPDATE billing.enrollment_fee_plans SET enrollment_id = $1 WHERE tenant_id = $2 AND enrollment_id = $3 AND status = 'active'`,
            [to.enrollmentId, tenantId, from.enrollmentId]);
    } else {
        await tx.query(`UPDATE billing.enrollment_fee_plans SET status = 'closed' WHERE tenant_id = $1 AND enrollment_id = $2 AND status = 'active'`,
            [tenantId, from.enrollmentId]);
    }

    let waivedAmount = 0;
    if (params.waiver && !sameCourse && position.outstanding > 0) {
        waivedAmount = await waiveOldDues(tx, { tenantId, actorId, enrollmentId: from.enrollmentId, reason: params.waiver.reason });
    }
    const remainingOutstanding = Math.max(0, position.outstanding - waivedAmount);

    let creditStatus = reviewable ? 'pending_review' : 'not_applicable';
    let eligibleCredit: number | null = reviewable ? null : 0;
    let approvedCredit = 0;
    let consumedAmount: number | null = null;
    const effectiveReview = params.review || (params.feePlan && reviewable ? {
        decision: 'approve' as const,
        consumedAmount: 0,
        approvedCredit: Math.min(position.unusedCeiling, params.feePlan.applyCredit > 0 ? params.feePlan.applyCredit : position.unusedCeiling),
        notes: 'Credit automatically applied with transfer installment plan',
    } : null);

    if (effectiveReview && reviewable) {
        const reviewed = await reviewTransferCredit(tx, { tenantId, actorId, transferId: transfer.transfer_id, review: effectiveReview });
        ({ creditStatus, eligibleCredit, approvedCredit, consumedAmount } = reviewed);
    } else {
        // A credit that stays pending keeps (or gets) its request for teachers, branch managers and Finance
        const closedEnrollment = await getEnrollment(tx, tenantId, from.enrollmentId);
        const open = reviewable && (await assessConsumption(tx, tenantId, closedEnrollment, null, transfer.transfer_id)).status !== 'verified';
        if (open) await requestVerification(tx, { tenantId, actorId, enrollment: closedEnrollment, until: null });
        else await closeVerificationRequest(tx, tenantId, from.enrollmentId);
    }
    let feePlan: FeePlanResult | null = null;
    if (params.feePlan && !sameCourse) {
        feePlan = await configureTransferFeePlan(tx, { tenantId, actorId, transferId: transfer.transfer_id, input: params.feePlan });
    }

    const creditBalance = await getCreditBalance(tx, tenantId, studentId);
    const feePlanStatus = sameCourse ? 'carried_over' : feePlan ? 'configured' : 'pending';
    await writeAudit(tx, {
        tenantId, actorId, action: 'student.course_transferred', entityType: 'student', entityId: studentId,
        details: {
            transferId: transfer.transfer_id, studentId, studentName: student.fullName, enrollmentNumber: student.enrollmentNumber,
            fromEnrollmentId: from.enrollmentId, fromBatchId: from.batchId, fromBatchName: from.batchName, fromBranchId: from.branchId,
            fromBranchName: from.branchName, fromCourseId: from.courseId, fromCourseTitle: from.courseTitle,
            toEnrollmentId: to.enrollmentId, toBatchId: to.batchId, toBatchName: to.batchName, toBranchId: to.branchId,
            toBranchName: to.branchName, toCourseId: to.courseId, toCourseTitle: to.courseTitle,
            transferDate: params.transferDate.toISOString(), transferReason: params.reason, remarks: params.remarks,
            feeDetails: {
                oldCourseTotalFee: position.courseFee, oldPaidAmount: position.verifiedPaid, oldOutstandingAmount: position.outstanding,
                consumedAmount, availableCredit: eligibleCredit, approvedCreditAdjustment: feePlan?.creditApplied ?? 0,
                newCourseBaseFee: feePlan?.netFee ?? to.tuitionAmount, finalPayableAmount: feePlan?.payableAmount ?? null,
                unusedRetainedCredit: creditBalance, waiveOldOutstanding: Boolean(params.waiver), waiverReason: params.waiver?.reason ?? null,
                waivedAmount,
            },
        },
    });
    return {
        transferId: transfer.transfer_id, newEnrollmentId: to.enrollmentId, creditStatus, feePlanStatus, eligibleCredit, approvedCredit,
        creditBalance, oldOutstanding: remainingOutstanding, feePlan, from, to,
        summary: {
            sameCourse, oldCourseFee: position.courseFee, verifiedPaid: position.verifiedPaid,
            previousAdjustments: fromMinor(toMinor(position.creditAlreadyGranted) + toMinor(position.previouslyConsumed) + toMinor(position.lateFeesPaid)),
            unusedCeiling: position.unusedCeiling, consumedAmount, eligibleCredit, consumptionMethod: null,
            calculation: null, oldOutstanding: position.outstanding, waivedAmount, remainingOutstanding,
            existingCredit, approvedCredit, creditApplied: feePlan?.creditApplied ?? 0, remainingCredit: creditBalance,
            newCourseFee: feePlan?.netFee ?? to.tuitionAmount, discount: feePlan?.discount ?? 0, payable: feePlan?.payableAmount ?? null,
        },
    };
}

async function waiveOldDues(tx: Queryable, params: { tenantId: string; actorId: string; enrollmentId: string; reason: string }): Promise<number> {
    const invoices = await tx.query<{ invoice_id: string; balance_amount: string; status: string }>(
        `SELECT invoice_id, balance_amount::text, status FROM billing.invoices
         WHERE tenant_id = $1 AND enrollment_id = $2 AND balance_amount > 0 AND status NOT IN ('void', 'cancelled', 'waived') FOR UPDATE`,
        [params.tenantId, params.enrollmentId]);
    for (const inv of invoices) {
        await tx.query(
            `UPDATE billing.invoices
             SET balance_amount = 0, status = CASE WHEN paid_amount > 0 THEN 'paid' ELSE 'waived' END, overdue_status = 'waived',
                 waived_reason = $1, waived_at = clock_timestamp(), waived_by_actor_id = $2, updated_at = clock_timestamp()
             WHERE invoice_id = $3`,
            [params.reason, params.actorId, inv.invoice_id]);
        await tx.query(
            `INSERT INTO billing.fee_audit (tenant_id, invoice_id, action, old_value, new_value, user_id, reason)
             VALUES ($1, $2, 'outstanding_waived', $3::jsonb, $4::jsonb, $5, $6)`,
            [params.tenantId, inv.invoice_id, JSON.stringify({ balance_amount: Number(inv.balance_amount), status: inv.status }),
            JSON.stringify({ balance_amount: 0 }), params.actorId, params.reason]);
    }
    return fromMinor(invoices.reduce((sum, inv) => sum + toMinor(Number(inv.balance_amount)), 0));
}

/** Finance decision on the unused fee of the old course. Each transfer can be decided once. */
export async function reviewTransferCredit(tx: Queryable, params: { tenantId: string; actorId: string; transferId: string; review: TransferReview }) {
    const { tenantId, actorId, transferId, review } = params;
    const found = await getTransferStudent(tx, tenantId, transferId);
    await lockStudent(tx, tenantId, found);
    const transfer = await lockTransfer(tx, tenantId, transferId);
    if (transfer.credit_status !== 'pending_review') {
        throw billingError('conflict', 'The credit of this transfer has already been decided.');
    }
    const from = await getEnrollment(tx, tenantId, transfer.from_enrollment_id);
    const position = await getEnrollmentFinancials(tx, tenantId, from);

    let assessment: ConsumptionAssessment;
    if (review.decision === 'reject') {
        if (!review.notes) throw billingError('invalid', 'Enter the reason for rejecting the transfer credit.');
        assessment = await assessConsumption(tx, tenantId, from, null, transferId);
    } else {
        if (review.consumedAmount !== null) {
            if (!review.notes) throw billingError('invalid', 'Enter the reason for the manually reviewed consumed fee.');
            await recordManualReview(tx, { tenantId, actorId, enrollment: from, until: null, transferId, consumedAmount: review.consumedAmount, reason: review.notes });
        }
        assessment = await assessConsumption(tx, tenantId, from, null, transferId);
        if (assessment.status !== 'verified' || assessment.consumedAmount === null) {
            throw billingError('conflict', `The credit cannot be approved yet. ${unresolvedMessage(assessment)}`);
        }
        if (position.pendingVerification > 0) {
            throw billingError('conflict', 'Verify or reject the pending manual payments of the old course before approving credit.');
        }
    }

    const consumed = review.consumedAmount ?? assessment.consumedAmount ?? 0;
    const eligible = fromMinor(Math.max(0, toMinor(position.unusedCeiling) - toMinor(consumed)));
    let approved = 0;
    if (review.decision === 'approve') {
        approved = review.approvedCredit !== null && review.approvedCredit !== undefined ? review.approvedCredit : eligible;
        if (toMinor(approved) > toMinor(eligible)) {
            throw billingError('invalid', `Approved credit exceeds the eligible unused credit of ${eligible.toFixed(2)}.`);
        }
        if (toMinor(approved) < toMinor(eligible) && !review.notes) {
            throw billingError('invalid', 'Enter the reason for approving less than the eligible credit.');
        }
    }
    const creditStatus = review.decision === 'reject' ? 'rejected' : approved > 0 ? 'approved' : 'no_credit';
    await tx.query(
        `UPDATE billing.course_transfers
         SET credit_status = $1, consumed_amount = $2, eligible_credit = $3, approved_credit = $4, review_notes = $5, reviewed_by_actor_id = $6,
             reviewed_at = clock_timestamp(), old_course_fee = $7, old_paid_amount = $8, old_outstanding_amount = $9, unused_ceiling = $10,
             consumption_method = $13, consumption_snapshot = $14::jsonb
         WHERE transfer_id = $11 AND tenant_id = $12`,
        [creditStatus, consumed, eligible, approved, review.notes, actorId, position.courseFee, position.verifiedPaid,
            position.outstanding, position.unusedCeiling, transferId, tenantId, assessment.method, JSON.stringify(assessmentSnapshot(assessment))]);
    await closeVerificationRequest(tx, tenantId, from.enrollmentId);
    if (approved > 0) {
        await postCreditEntry(tx, {
            tenantId, studentId: transfer.student_id, entryType: 'transfer_credit', amount: approved, sourceEnrollmentId: from.enrollmentId,
            transferId, reason: `Unused fee of ${from.courseTitle}`, actorId, idempotencyKey: `transfer-${transferId}`,
        });
    }
    await writeAudit(tx, {
        tenantId, actorId, action: review.decision === 'reject' ? 'billing.transfer_credit_rejected' : 'billing.transfer_credit_approved',
        entityType: 'course_transfer', entityId: transferId,
        details: {
            studentId: transfer.student_id, course: from.courseTitle, verifiedPaid: position.verifiedPaid, refunded: position.refunded,
            lateFeesPaid: position.lateFeesPaid, creditReceived: position.creditReceived, creditAlreadyGranted: position.creditAlreadyGranted,
            consumedAmount: consumed, eligibleCredit: eligible, approvedCredit: approved, notes: review.notes, consumption: assessmentSnapshot(assessment),
        },
    });
    return { creditStatus, eligibleCredit: eligible, approvedCredit: approved, consumedAmount: consumed };
}

async function getTransferStudent(db: Queryable, tenantId: string, transferId: string): Promise<string> {
    const [row] = await db.query<{ student_id: string }>(
        `SELECT student_id FROM billing.course_transfers WHERE transfer_id = $1 AND tenant_id = $2`, [transferId, tenantId]);
    if (!row) throw billingError('not_found', 'Course transfer not found.');
    return row.student_id;
}

/** Creates the fee plan of the destination course once the credit question is settled. */
export async function configureTransferFeePlan(tx: Queryable, params: { tenantId: string; actorId: string; transferId: string; input: FeePlanInput }) {
    const { tenantId, transferId } = params;
    const found = await getTransferStudent(tx, tenantId, transferId);
    await lockStudent(tx, tenantId, found);
    const transfer = await lockTransfer(tx, tenantId, transferId);
    if (transfer.credit_status === 'pending_review') {
        throw billingError('conflict', 'Approve or reject the transfer credit before creating the new fee plan.');
    }
    if (transfer.fee_plan_status !== 'pending') throw billingError('conflict', 'The new course already has its fee plan.');
    const from = await getEnrollment(tx, tenantId, transfer.from_enrollment_id);
    const plan = await createEnrollmentFeePlan(tx, {
        tenantId, actorId: params.actorId, enrollmentId: transfer.to_enrollment_id, input: params.input,
        transfer: { transferId, fromCourse: from.courseTitle },
    });
    await tx.query(`UPDATE billing.course_transfers SET fee_plan_status = 'configured' WHERE transfer_id = $1 AND tenant_id = $2`, [transferId, tenantId]);
    return plan;
}

export async function listTransfers(db: Queryable, tenantId: string, filter: { branchId: string | null; studentId: string | null; transferId: string | null }) {
    const rows = await db.query<Record<string, string | null>>(
        `SELECT t.transfer_id, t.student_id, s.first_name || ' ' || s.last_name AS student_name, s.enrollment_number,
                t.from_enrollment_id, t.to_enrollment_id, t.transfer_date, t.reason, t.remarks, t.credit_status, t.fee_plan_status,
                t.old_course_fee::text, t.old_paid_amount::text, t.old_outstanding_amount::text, t.unused_ceiling::text,
                t.consumed_amount::text, t.eligible_credit::text, t.approved_credit::text, t.review_notes, t.reviewed_at,
                u.full_name AS reviewed_by, t.created_at,
                fc.title AS from_course, fb.name AS from_batch, tc.title AS to_course, tb.name AS to_batch, tc.tuition_amount::text AS new_course_fee,
                fp.net_fee::text AS plan_net_fee, fp.credit_applied::text AS plan_credit, fp.payable_amount::text AS plan_payable,
                fp.payment_mode, fp.installment_count::text
         FROM billing.course_transfers t
         JOIN academics.students s ON s.student_id = t.student_id
         JOIN academics.enrollments fe ON fe.enrollment_id = t.from_enrollment_id
         JOIN academics.batches fb ON fb.batch_id = fe.batch_id
         JOIN academics.courses fc ON fc.course_id = fb.course_id
         JOIN academics.enrollments te ON te.enrollment_id = t.to_enrollment_id
         JOIN academics.batches tb ON tb.batch_id = te.batch_id
         JOIN academics.courses tc ON tc.course_id = tb.course_id
         LEFT JOIN billing.enrollment_fee_plans fp ON fp.transfer_id = t.transfer_id
         LEFT JOIN identity_app.users u ON u.user_id = t.reviewed_by_actor_id
         WHERE t.tenant_id = $1 AND ($2::uuid IS NULL OR s.branch_id = $2::uuid OR fb.branch_id = $2::uuid OR tb.branch_id = $2::uuid)
           AND ($3::uuid IS NULL OR t.student_id = $3::uuid) AND ($4::uuid IS NULL OR t.transfer_id = $4::uuid)
         ORDER BY (t.credit_status = 'pending_review') DESC, (t.fee_plan_status = 'pending') DESC, t.created_at DESC
         LIMIT 200`,
        [tenantId, filter.branchId, filter.studentId, filter.transferId]);
    const num = (v: string | null) => (v === null ? null : Number(v));
    return rows.map(r => ({
        transferId: r.transfer_id!, studentId: r.student_id!, studentName: r.student_name!, enrollmentNumber: r.enrollment_number!,
        fromEnrollmentId: r.from_enrollment_id!, toEnrollmentId: r.to_enrollment_id!, transferDate: r.transfer_date!, reason: r.reason!,
        remarks: r.remarks, creditStatus: r.credit_status!, feePlanStatus: r.fee_plan_status!, oldCourseFee: Number(r.old_course_fee),
        oldPaid: Number(r.old_paid_amount), oldOutstanding: Number(r.old_outstanding_amount), unusedCeiling: Number(r.unused_ceiling),
        consumedAmount: num(r.consumed_amount), eligibleCredit: num(r.eligible_credit), approvedCredit: Number(r.approved_credit),
        reviewNotes: r.review_notes, reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by, createdAt: r.created_at!,
        fromCourse: r.from_course!, fromBatch: r.from_batch!, toCourse: r.to_course!, toBatch: r.to_batch!, newCourseFee: Number(r.new_course_fee),
        plan: r.plan_net_fee === null ? null : {
            netFee: Number(r.plan_net_fee), creditApplied: Number(r.plan_credit), payable: Number(r.plan_payable),
            paymentMode: r.payment_mode!, installmentCount: Number(r.installment_count),
        },
    }));
}

export async function getTransferDetail(db: Queryable, tenantId: string, transferId: string, branchId: string | null) {
    const [transfer] = await listTransfers(db, tenantId, { branchId, studentId: null, transferId });
    if (!transfer) throw billingError('not_found', 'Course transfer not found.');
    const from = await getEnrollment(db, tenantId, transfer.fromEnrollmentId);
    const to = await getEnrollment(db, tenantId, transfer.toEnrollmentId);
    const financials = await getEnrollmentFinancials(db, tenantId, from);
    return {
        transfer, from, to, financials,
        assessment: await assessConsumption(db, tenantId, from, null, transferId),
        creditBalance: await getCreditBalance(db, tenantId, transfer.studentId),
        period: await getEnrollmentPeriod(db, tenantId, to.enrollmentId),
    };
}
