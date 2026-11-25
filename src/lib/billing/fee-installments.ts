import crypto from 'node:crypto';
import { query, withTransaction } from '@/lib/db/db';
import {
    ACTIVE_ENROLLMENT, billingError, fromMinor, getCreditBalance, lockStudent, postCreditEntry, toMinor, writeAudit, type Queryable,
} from '@/lib/billing/credit-ledger';
import { academyToday } from '@/lib/billing/course-period';
import { carryForwardShortfall, getRestorableAmount, restoreCarriedBalance } from '@/lib/billing/installment-carry';

export interface CourseInstallment {
    invoiceId: string;
    invoiceNumber: string;
    installmentNumber: number;
    designation: string;
    dueDate: string;
    amount: number;
    paidAmount: number;
    balanceAmount: number;
    /** Fee of this installment before credit, and the credit covering it */
    originalAmount: number;
    creditApplied: number;
    /** As first scheduled, before any balance was carried or the schedule was adjusted */
    scheduledAmount: number;
    scheduledDueDate: string;
    /** Moved here from an underpaid earlier installment (positive), or moved on to later ones (negative) */
    carriedForward: number;
    /** Parts of carriedForward: received from earlier installments, and moved on to later ones */
    carriedIn: number;
    carriedOut: number;
    /** Changed by Finance after it was scheduled */
    scheduleAdjustment: number;
    issuedAt: string;
    /** Unpaid part that was moved to later installments and can still be paid here */
    carriedOutstanding: number;
    /** Last online or declared payment that did not succeed */
    failedAttempt: { at: string; reason: string | null } | null;
    pendingVerification: number;
    status: 'pending' | 'partially_paid' | 'paid' | 'overdue' | 'verification_pending' | 'failed';
    lateFeeAmount: number;
    daysOverdue: number;
    receiptNumber?: string;
    paymentMethod?: string;
    payments: Array<{
        paymentId: string;
        amount: number;
        receiptNumber: string;
        paymentMethod: string;
        reference: string;
        status: string;
        createdAt: string;
        recordedBy: string | null;
    }>;
}

export interface StudentCourseBreakdown {
    enrollmentId: string | null;
    enrollmentStatus: string | null;
    courseId: string;
    courseTitle: string;
    courseCode: string;
    batchId?: string;
    batchName?: string;
    branchId?: string;
    branchName?: string;
    /** Original course fee, before credit */
    totalFee: number;
    creditApplied: number;
    paidAmount: number;
    balanceAmount: number;
    pendingVerification: number;
    advanceCredit: number;
    /** Outstanding with no installment left to carry it to; Finance reviews it */
    reviewOutstanding: number;
    feePlan: { paymentMode: string; frequency: string | null; installmentCount: number; creditAllocation: string; payableAmount: number } | null;
    /** Transferred in and waiting for Finance to create the fee plan */
    feePlanPending: boolean;
    status: 'paid' | 'partially_paid' | 'pending' | 'overdue' | 'verification_pending';
    isFullyPaid: boolean;
    finalInvoiceNumber?: string;
    finalInvoiceDate?: string;
    installments: CourseInstallment[];
    payments: Array<{
        paymentId: string;
        receiptNumber: string;
        amount: number;
        paymentMethod: string;
        reference: string;
        status: string;
        paidAt: string;
        invoiceNumber: string;
        designation: string;
        recordedBy: string | null;
    }>;
}

export interface LinkedGuardianInfo {
    guardianId: string;
    userId?: string | null;
    firstName: string;
    lastName: string;
    fullName: string;
    email: string;
    phone: string | null;
    relationship: string | null;
    isPrimary: boolean;
}

/**
 * Generates an official payment receipt number: RCP-YYYYMMDD-XXXXXX
 */
export function generateReceiptNumber(): string {
    const now = new Date();
    const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `RCP-${yyyymmdd}-${hex}`;
}

/**
 * Strictly verifies whether a guardian user has access to a specific student ward.
 */
export async function verifyGuardianWardAccess(
    tenantId: string,
    guardianUserId: string,
    studentId: string
): Promise<{ allowed: boolean; guardianId?: string; relationship?: string }> {
    const rows = await query<{ guardian_id: string; relationship: string | null }>(
        `SELECT g.guardian_id, g.relationship
         FROM academics.student_guardian_links l
         JOIN academics.guardians g ON g.guardian_id = l.guardian_id
         WHERE g.tenant_id = $1
           AND g.user_id = $2
           AND l.student_id = $3
         LIMIT 1`,
        [tenantId, guardianUserId, studentId]
    );

    if (rows.length === 0) {
        return { allowed: false };
    }
    return {
        allowed: true,
        guardianId: rows[0].guardian_id,
        relationship: rows[0].relationship || 'Guardian'
    };
}

/**
 * Retrieves student profile, linked guardian information, and course-wise fee breakdown
 * with separate installment schedules for each enrolled course.
 */
export async function getStudentCourseFeeBreakdown(
    tenantId: string,
    studentId: string
): Promise<{
    student: {
        studentId: string;
        enrollmentNumber: string;
        firstName: string;
        lastName: string;
        fullName: string;
        email: string;
        phone: string | null;
        branchId: string | null;
        branchName: string | null;
        status: string;
    };
    academy: { name: string; logoUrl: string | null; address: string | null; phone: string | null; email: string | null };
    guardians: LinkedGuardianInfo[];
    courses: StudentCourseBreakdown[];
    creditBalance: number;
    totalFee: number;
    totalPaid: number;
    totalBalance: number;
}> {
    // 1. Fetch student info
    const studentRows = await query<{
        student_id: string;
        enrollment_number: string;
        first_name: string;
        last_name: string;
        email: string;
        phone: string | null;
        branch_id: string | null;
        branch_name: string | null;
        status: string;
    }>(
        `SELECT s.student_id, s.enrollment_number, s.first_name, s.last_name, s.email, s.phone,
                s.branch_id, br.name AS branch_name, s.status
         FROM academics.students s
         LEFT JOIN tenant.branches br ON br.branch_id = s.branch_id
         WHERE s.student_id = $1 AND s.tenant_id = $2`,
        [studentId, tenantId]
    );

    if (studentRows.length === 0) {
        throw new Error('Student not found');
    }
    const s = studentRows[0];

    // Issuer of invoices and receipts: the academy, with the student's branch address when it has one
    const [org] = await query<{ name: string; logo_url: string | null; address: string | null; phone: string | null; email: string | null }>(
        `SELECT o.name, o.branding->>'logoUrl' AS logo_url, COALESCE(NULLIF(b.address, ''), o.settings->>'address') AS address,
                COALESCE(NULLIF(b.phone, ''), o.settings->>'phone') AS phone, COALESCE(NULLIF(b.email, ''), o.settings->>'email') AS email
         FROM tenant.organizations o LEFT JOIN tenant.branches b ON b.branch_id = $2 AND b.tenant_id = o.tenant_id
         WHERE o.tenant_id = $1`,
        [tenantId, s.branch_id]);

    // 2. Fetch linked guardians
    const guardianRows = await query<{
        guardian_id: string;
        user_id: string | null;
        first_name: string;
        last_name: string;
        email: string;
        phone: string | null;
        relationship: string | null;
        is_primary: boolean;
    }>(
        `SELECT g.guardian_id, g.user_id, g.first_name, g.last_name, g.email, g.phone,
                g.relationship, l.is_primary
         FROM academics.student_guardian_links l
         JOIN academics.guardians g ON g.guardian_id = l.guardian_id
         WHERE l.student_id = $1 AND g.tenant_id = $2
         ORDER BY l.is_primary DESC, g.last_name ASC`,
        [studentId, tenantId]
    );

    const guardians: LinkedGuardianInfo[] = guardianRows.map(g => ({
        guardianId: g.guardian_id,
        userId: g.user_id,
        firstName: g.first_name,
        lastName: g.last_name,
        fullName: `${g.first_name} ${g.last_name}`.trim(),
        email: g.email,
        phone: g.phone,
        relationship: g.relationship,
        isPrimary: Boolean(g.is_primary)
    }));

    // 3. Enrollments: active courses, and closed ones that still carry fee records
    const enrollments = await query<{
        enrollment_id: string;
        batch_id: string;
        batch_name: string;
        course_id: string;
        course_title: string;
        course_code: string;
        tuition_amount: string;
        branch_id: string | null;
        branch_name: string | null;
        status: string;
        plan_mode: string | null;
        plan_frequency: string | null;
        plan_count: number | null;
        plan_allocation: string | null;
        plan_net_fee: string | null;
        plan_payable: string | null;
        plan_pending: boolean;
        advance_credit: string;
    }>(
        `SELECT e.enrollment_id, e.batch_id, b.name AS batch_name,
                c.course_id, c.title AS course_title, c.code AS course_code, c.tuition_amount::text,
                b.branch_id, br.name AS branch_name, e.status,
                fp.payment_mode AS plan_mode, fp.frequency AS plan_frequency, fp.installment_count AS plan_count,
                fp.credit_allocation AS plan_allocation, fp.net_fee::text AS plan_net_fee, fp.payable_amount::text AS plan_payable,
                EXISTS (SELECT 1 FROM billing.course_transfers ct
                        WHERE ct.to_enrollment_id = e.enrollment_id AND ct.fee_plan_status = 'pending') AS plan_pending,
                COALESCE((SELECT SUM(l.amount) FROM billing.credit_ledger l
                          WHERE l.source_enrollment_id = e.enrollment_id AND l.entry_type = 'advance_payment'), 0)::text AS advance_credit
         FROM academics.enrollments e
         JOIN academics.batches b ON b.batch_id = e.batch_id
         JOIN academics.courses c ON c.course_id = b.course_id
         LEFT JOIN tenant.branches br ON br.branch_id = b.branch_id
         LEFT JOIN LATERAL (
             SELECT * FROM billing.enrollment_fee_plans x WHERE x.enrollment_id = e.enrollment_id
             ORDER BY (x.status = 'active') DESC, x.created_at DESC LIMIT 1
         ) fp ON true
         WHERE e.student_id = $1 AND e.tenant_id = $2
           AND (e.status = ANY($3) OR EXISTS (SELECT 1 FROM billing.invoices i WHERE i.enrollment_id = e.enrollment_id AND i.status <> 'void'))
         ORDER BY (e.status = ANY($3)) DESC, e.enrolled_at`,
        [studentId, tenantId, ACTIVE_ENROLLMENT]
    );

    // 4. Fetch student invoices (dates as text: the driver would otherwise shift them by time zone)
    const invoiceRows = await query<InvoiceRow>(
        `SELECT invoice_id, invoice_number, designation, enrollment_id, installment_number,
                subtotal_amount::text, discount_amount::text, credit_applied::text, total_amount::text, paid_amount::text, balance_amount::text,
                due_date::text, status, overdue_status, late_fee_amount::text, days_overdue,
                original_amount::text, original_due_date::text, enrollment_plan_id, created_at,
                (SELECT COALESCE(SUM(it.amount), 0) FROM billing.invoice_items it
                 WHERE it.invoice_id = invoices.invoice_id AND it.item_type = 'schedule_adjustment')::text AS adjusted,
                (SELECT COALESCE(SUM(it.amount), 0) FROM billing.invoice_items it
                 WHERE it.invoice_id = invoices.invoice_id AND it.item_type IN ('carry_forward', 'carry_restored'))::text AS carried,
                (SELECT COALESCE(SUM(CASE WHEN (it.item_type = 'carry_forward' AND it.amount < 0) OR (it.item_type = 'carry_restored' AND it.amount > 0) THEN -it.amount END), 0)
                 FROM billing.invoice_items it WHERE it.invoice_id = invoices.invoice_id)::text AS carried_out,
                (SELECT o.failed_at FROM billing.payment_orders o WHERE o.invoice_id = invoices.invoice_id AND o.status = 'failed'
                   AND NOT EXISTS (SELECT 1 FROM billing.payment_orders n WHERE n.invoice_id = o.invoice_id AND n.status = 'paid' AND n.paid_at > o.failed_at)
                 ORDER BY o.failed_at DESC LIMIT 1) AS failed_at,
                (SELECT o.failure_reason FROM billing.payment_orders o WHERE o.invoice_id = invoices.invoice_id AND o.status = 'failed'
                 ORDER BY o.failed_at DESC LIMIT 1) AS failure_reason
         FROM billing.invoices
         WHERE student_id = $1 AND tenant_id = $2 AND status <> 'void'
         ORDER BY invoices.due_date ASC, installment_number ASC NULLS LAST, created_at ASC`,
        [studentId, tenantId]
    );

    // 5. Fetch student payments
    const paymentRows = await query<PaymentRow>(
        `SELECT p.payment_id, p.invoice_id, p.amount::text, p.payment_method, p.payment_reference,
                p.status, p.receipt_number, p.created_at, i.invoice_number, i.designation, u.full_name AS recorded_by
         FROM billing.payments p
         LEFT JOIN billing.invoices i ON i.invoice_id = p.invoice_id
         LEFT JOIN identity_app.users u ON u.user_id = p.recorded_by_actor_id
         WHERE p.student_id = $1 AND p.tenant_id = $2
         ORDER BY p.created_at DESC`,
        [studentId, tenantId]
    );
    const paymentsByInvoice = new Map<string, PaymentRow[]>();
    for (const p of paymentRows) {
        paymentsByInvoice.set(p.invoice_id, [...(paymentsByInvoice.get(p.invoice_id) ?? []), p]);
    }

    // 6. One bucket per enrollment, by the enrollment each invoice is linked to
    const todayStr = await academyToday({ query }, tenantId);
    const buildCourse = (
        invoices: InvoiceRow[],
        base: Pick<StudentCourseBreakdown, 'enrollmentId' | 'enrollmentStatus' | 'courseId' | 'courseTitle' | 'courseCode' | 'batchId' | 'batchName'
            | 'branchId' | 'branchName' | 'feePlan' | 'feePlanPending' | 'advanceCredit'>,
        agreedFee: number
    ): StudentCourseBreakdown => {
        const settled = invoices.every(inv => toMinor(inv.balance_amount) <= 0);
        const installments = invoices.map((inv, idx) => toInstallment(inv, idx, paymentsByInvoice.get(inv.invoice_id) ?? [], todayStr, settled));
        // Owed with nothing ahead to carry it to: a part-paid last installment, or only overdue ones
        const open = installments.filter(i => i.balanceAmount > 0);
        const ahead = open.some(i => i.dueDate >= todayStr && i.paidAmount === 0);
        const reviewOutstanding = !ahead && (open.length > 1 || open.some(i => i.paidAmount > 0 || installments.length > 1))
            ? fromMinor(open.reduce((t, i) => t + toMinor(i.balanceAmount), 0)) : 0;
        const sum = (pick: (i: CourseInstallment) => number) => fromMinor(installments.reduce((total, i) => total + toMinor(pick(i)), 0));
        const paidAmount = sum(i => i.paidAmount);
        const balanceAmount = sum(i => i.balanceAmount);
        const creditApplied = sum(i => i.creditApplied);

        let status: StudentCourseBreakdown['status'] = 'pending';
        if (installments.some(i => i.status === 'overdue')) status = 'overdue';
        else if (installments.length > 0 && balanceAmount <= 0) status = 'paid';
        else if (paidAmount > 0) status = 'partially_paid';

        const isFullyPaid = installments.length > 0 && balanceAmount <= 0;
        const coursePayments = paymentRows.filter(p => invoices.some(inv => inv.invoice_id === p.invoice_id));
        const settledPayments = coursePayments.filter(p => !['verification_pending', 'rejected'].includes(p.status));
        const finalInvoiceDate = isFullyPaid && settledPayments.length > 0 ? settledPayments[0].created_at : undefined;
        const studentCode = s.enrollment_number ? s.enrollment_number.toUpperCase() : s.student_id.substring(0, 6).toUpperCase();
        const courseCode = (base.courseCode || 'CRS').toUpperCase();
        const finalInvoiceNumber = `FINAL-INV-${courseCode}-${studentCode}`;

        return {
            ...base,
            totalFee: Math.max(agreedFee, sum(i => i.originalAmount)),
            creditApplied,
            paidAmount,
            balanceAmount,
            pendingVerification: sum(i => i.pendingVerification),
            reviewOutstanding,
            status,
            isFullyPaid,
            finalInvoiceNumber,
            finalInvoiceDate,
            installments,
            payments: coursePayments.map(p => ({
                paymentId: p.payment_id,
                receiptNumber: p.receipt_number,
                amount: Number(p.amount),
                paymentMethod: p.payment_method,
                reference: /^(PND|OFFLINE|PAY|ONLINE|CLR)-/.test(p.payment_reference) ? '' : p.payment_reference,
                status: p.status,
                paidAt: p.created_at,
                invoiceNumber: p.invoice_number || '',
                designation: p.designation || '',
                recordedBy: p.recorded_by
            }))
        };
    };

    const courses: StudentCourseBreakdown[] = enrollments.map(enr => {
        const isActive = ACTIVE_ENROLLMENT.includes(enr.status);
        return buildCourse(
            invoiceRows.filter(inv => inv.enrollment_id === enr.enrollment_id),
            {
                enrollmentId: enr.enrollment_id,
                enrollmentStatus: enr.status,
                courseId: enr.course_id,
                courseTitle: enr.course_title,
                courseCode: enr.course_code,
                batchId: enr.batch_id,
                batchName: enr.batch_name,
                branchId: enr.branch_id || undefined,
                branchName: enr.branch_name || undefined,
                advanceCredit: Number(enr.advance_credit),
                feePlan: enr.plan_mode ? {
                    paymentMode: enr.plan_mode, frequency: enr.plan_frequency, installmentCount: Number(enr.plan_count),
                    creditAllocation: enr.plan_allocation!, payableAmount: Number(enr.plan_payable)
                } : null,
                feePlanPending: isActive && enr.plan_pending
            },
            enr.plan_net_fee !== null ? Number(enr.plan_net_fee) : Number(enr.tuition_amount) || 0
        );
    });

    // Invoices that could not be matched to one course are shown on their own, never mixed into a course
    const known = new Set(enrollments.map(e => e.enrollment_id));
    const unlinked = invoiceRows.filter(inv => !inv.enrollment_id || !known.has(inv.enrollment_id));
    if (unlinked.length > 0) {
        courses.push(buildCourse(unlinked, {
            enrollmentId: null, enrollmentStatus: null, courseId: 'general-dues', courseTitle: 'General Academy Tuition', courseCode: 'GEN-001',
            advanceCredit: 0, feePlan: null, feePlanPending: false
        }, 0));
    }

    const overallTotalFee = courses.reduce((sum, c) => sum + c.totalFee, 0);
    const overallTotalPaid = courses.reduce((sum, c) => sum + c.paidAmount, 0);
    const overallTotalBalance = courses.reduce((sum, c) => sum + c.balanceAmount, 0);

    return {
        student: {
            studentId: s.student_id,
            enrollmentNumber: s.enrollment_number,
            firstName: s.first_name,
            lastName: s.last_name,
            fullName: `${s.first_name} ${s.last_name}`.trim(),
            email: s.email,
            phone: s.phone,
            branchId: s.branch_id,
            branchName: s.branch_name,
            status: s.status
        },
        academy: { name: org.name, logoUrl: org.logo_url, address: org.address, phone: org.phone, email: org.email },
        guardians,
        courses,
        creditBalance: await getCreditBalance({ query }, tenantId, studentId),
        totalFee: overallTotalFee,
        totalPaid: overallTotalPaid,
        totalBalance: overallTotalBalance
    };
}

interface InvoiceRow {
    invoice_id: string; invoice_number: string; designation: string; enrollment_id: string | null; installment_number: number | null;
    subtotal_amount: string; discount_amount: string; credit_applied: string; total_amount: string; paid_amount: string; balance_amount: string;
    due_date: string; status: string; overdue_status: string; late_fee_amount: string | null; days_overdue: number | null; carried: string;
    carried_out: string; original_amount: string; original_due_date: string; enrollment_plan_id: string | null; created_at: string; adjusted: string; failed_at: string | Date | null;
    failure_reason: string | null;
}

interface PaymentRow {
    payment_id: string; invoice_id: string; amount: string; payment_method: string; payment_reference: string; status: string;
    receipt_number: string; created_at: string; invoice_number: string | null; designation: string | null; recorded_by: string | null;
}

function toInstallment(inv: InvoiceRow, idx: number, payments: PaymentRow[], today: string, courseSettled: boolean): CourseInstallment {
    const paid = Number(inv.paid_amount);
    const balance = Number(inv.balance_amount);
    const credit = Number(inv.credit_applied);
    const settled = payments.filter(p => !['verification_pending', 'rejected'].includes(p.status));
    const pending = payments.filter(p => p.status === 'verification_pending').reduce((total, p) => total + Number(p.amount), 0);

    // A carried balance is part of the later installments: this one is complete once the course is
    const carriedOut = courseSettled ? 0 : Math.max(0, Number(inv.carried_out));
    const latest = payments[0];
    const lastPaid = settled[0] ? new Date(settled[0].created_at).getTime() : 0;
    const failed = balance <= 0 ? null
        : latest?.status === 'rejected' ? { at: new Date(latest.created_at).toISOString(), reason: 'Payment was not verified' }
        : inv.failed_at && new Date(inv.failed_at).getTime() > lastPaid ? { at: new Date(inv.failed_at).toISOString(), reason: inv.failure_reason } : null;

    let status: CourseInstallment['status'] = 'pending';
    if (balance <= 0) status = pending > 0 ? 'verification_pending' : carriedOut > 0 ? 'partially_paid' : 'paid';
    else if (pending > 0) status = 'verification_pending';
    else if (inv.overdue_status === 'overdue' || (inv.due_date < today && inv.overdue_status !== 'waived' && inv.overdue_status !== 'in_grace')) status = 'overdue';
    else if (failed) status = 'failed';
    else if (paid > 0) status = 'partially_paid';

    const numbered = (inv.designation || '').match(/Installment\s+(\d+)/i);
    return {
        invoiceId: inv.invoice_id,
        invoiceNumber: inv.invoice_number,
        installmentNumber: inv.installment_number ?? (numbered ? parseInt(numbered[1], 10) : idx + 1),
        designation: inv.designation || 'General Tuition',
        dueDate: inv.due_date,
        amount: Number(inv.total_amount),
        originalAmount: fromMinor(toMinor(inv.subtotal_amount) - toMinor(inv.discount_amount) + toMinor(credit)),
        creditApplied: credit,
        scheduledAmount: Number(inv.original_amount),
        scheduledDueDate: inv.original_due_date,
        carriedForward: Number(inv.carried),
        carriedIn: fromMinor(toMinor(inv.carried) + Math.max(0, toMinor(inv.carried_out))),
        carriedOut: Math.max(0, Number(inv.carried_out)),
        scheduleAdjustment: Number(inv.adjusted),
        issuedAt: inv.created_at,
        carriedOutstanding: carriedOut,
        failedAttempt: failed,
        pendingVerification: pending,
        paidAmount: paid,
        balanceAmount: balance,
        status,
        lateFeeAmount: Number(inv.late_fee_amount) || 0,
        daysOverdue: Number(inv.days_overdue) || 0,
        receiptNumber: settled[0]?.receipt_number,
        paymentMethod: settled[0]?.payment_method,
        payments: payments.map(p => ({
            paymentId: p.payment_id,
            amount: Number(p.amount),
            receiptNumber: p.receipt_number,
            paymentMethod: p.payment_method,
            reference: /^(PND|OFFLINE|PAY|ONLINE|CLR)-/.test(p.payment_reference) ? '' : p.payment_reference,
            status: p.status,
            createdAt: p.created_at,
            recordedBy: p.recorded_by
        }))
    };
}

export interface ProcessPaymentParams {
    tenantId: string;
    studentId: string;
    /** Course being paid; invoiceId alone is enough to identify it. */
    enrollmentId?: string | null;
    courseTitle?: string;
    invoiceId?: string | null;
    amount: number;
    paymentMethod: string;
    paymentReference?: string;
    paymentDate?: string;
    gatewayOrderId?: string | null;
    gatewayPaymentId?: string | null;
    idempotencyKey?: string | null;
    recordedByActorId: string;
    /** Money already captured by the gateway is never refused: whatever exceeds the dues becomes credit. */
    alreadyCaptured?: boolean;
}

export interface PaymentReceiptResult {
    paymentId: string;
    receiptNumber: string;
    invoiceId: string;
    invoiceNumber: string;
    installmentDesignation: string;
    amount: number;
    paymentMethod: string;
    status: string;
    createdAt: string;
}

export interface ProcessPaymentResult {
    success: boolean;
    studentId: string;
    courseTitle: string;
    totalAmountPaid: number;
    receipts: PaymentReceiptResult[];
    /** Part of the payment beyond the course dues, kept in the credit ledger */
    excessCredit: number;
    remainingCourseBalance: number;
    replayed?: boolean;
    message: string;
}

interface DueInvoice {
    invoice_id: string; invoice_number: string; designation: string; enrollment_id: string | null; balance_amount: string; paid_amount: string;
}

interface PaymentScope { enrollmentId: string | null; courseTitle: string; invoices: DueInvoice[]; fallbackInvoiceId: string }

/**
 * Finds the unpaid installments a payment may settle: those of exactly one course enrollment, the chosen
 * installment first and then by due date. A payment can never reach another course.
 */
async function resolvePaymentScope(tx: Queryable, params: {
    tenantId: string; studentId: string; enrollmentId?: string | null; invoiceId?: string | null; courseTitle?: string; alreadyCaptured?: boolean;
}): Promise<PaymentScope> {
    const { tenantId, studentId } = params;
    let invoiceId = params.invoiceId;
    let enrollmentId = params.enrollmentId ?? null;
    let invoiceRow: { enrollment_id: string | null; designation: string } | null = null;

    if (invoiceId) {
        const [row] = await tx.query<{ student_id: string; enrollment_id: string | null; designation: string; status: string }>(
            `SELECT student_id, enrollment_id, designation, status FROM billing.invoices WHERE invoice_id = $1 AND tenant_id = $2 FOR UPDATE`,
            [invoiceId, tenantId]);
        if (!row) throw billingError('not_found', 'Invoice not found.');
        if (row.student_id !== studentId) throw billingError('forbidden', 'Invoice does not belong to the selected student.');
        const closed = row.status === 'void' || row.status === 'cancelled';
        if (closed && !(params.alreadyCaptured && row.enrollment_id)) throw billingError('invalid', 'This invoice is no longer payable.');
        if (enrollmentId && row.enrollment_id !== enrollmentId) throw billingError('invalid', 'Invoice does not belong to the selected course.');
        enrollmentId = row.enrollment_id;
        invoiceRow = row;
        if (closed) invoiceId = null;
    } else if (!enrollmentId && params.courseTitle) {
        const matches = await tx.query<{ enrollment_id: string }>(
            `SELECT e.enrollment_id FROM academics.enrollments e
             JOIN academics.batches b ON b.batch_id = e.batch_id JOIN academics.courses c ON c.course_id = b.course_id
             WHERE e.student_id = $1 AND e.tenant_id = $2 AND lower(trim(c.title)) = lower(trim($3)) AND e.status = ANY($4)`,
            [studentId, tenantId, params.courseTitle, ACTIVE_ENROLLMENT]);
        if (matches.length !== 1) throw billingError('invalid', `Choose the course or installment being paid ("${params.courseTitle}" is not a single active course).`);
        enrollmentId = matches[0].enrollment_id;
    }
    if (!enrollmentId && !invoiceId) throw billingError('invalid', 'Choose the course or installment being paid.');

    let courseTitle = params.courseTitle ?? 'General Academy Tuition';
    if (enrollmentId) {
        const [row] = await tx.query<{ student_id: string; title: string }>(
            `SELECT e.student_id, c.title FROM academics.enrollments e
             JOIN academics.batches b ON b.batch_id = e.batch_id JOIN academics.courses c ON c.course_id = b.course_id
             WHERE e.enrollment_id = $1 AND e.tenant_id = $2`,
            [enrollmentId, tenantId]);
        if (!row) throw billingError('not_found', 'Course enrollment not found.');
        if (row.student_id !== studentId) throw billingError('forbidden', 'Course enrollment does not belong to the selected student.');
        courseTitle = row.title;
    }

    // An invoice linked to no course can only settle itself
    const invoices = await tx.query<DueInvoice>(
        `SELECT invoice_id, invoice_number, designation, enrollment_id, balance_amount::text, paid_amount::text
         FROM billing.invoices
         WHERE tenant_id = $1 AND student_id = $2 AND balance_amount > 0 AND status NOT IN ('void', 'cancelled')
           AND (($3::uuid IS NOT NULL AND enrollment_id = $3::uuid) OR ($3::uuid IS NULL AND invoice_id = $4::uuid))
         ORDER BY (invoice_id = $4::uuid) DESC NULLS LAST, invoices.due_date, installment_number NULLS LAST, invoice_number
         FOR UPDATE`,
        [tenantId, studentId, enrollmentId, invoiceId ?? null]);
    let fallbackInvoiceId = invoiceId ?? invoices[0]?.invoice_id;
    if (!fallbackInvoiceId) {
        const [last] = await tx.query<{ invoice_id: string }>(
            `SELECT invoice_id FROM billing.invoices WHERE tenant_id = $1 AND enrollment_id = $2 AND status NOT IN ('void', 'cancelled')
             ORDER BY invoices.due_date DESC LIMIT 1`, [tenantId, enrollmentId]);
        if (!last) throw billingError('invalid', 'This course has no fee plan to pay yet.');
        fallbackInvoiceId = last.invoice_id;
    }
    return { enrollmentId: enrollmentId ?? invoiceRow?.enrollment_id ?? null, courseTitle, invoices, fallbackInvoiceId };
}

async function settleInvoice(tx: Queryable, tenantId: string, invoiceId: string, amount: number) {
    await tx.query(
        `UPDATE billing.invoices
         SET paid_amount = paid_amount + $1::numeric, balance_amount = balance_amount - $1::numeric,
             status = CASE WHEN balance_amount - $1::numeric = 0 THEN 'paid' ELSE 'partially_paid' END,
             overdue_status = CASE WHEN balance_amount - $1::numeric = 0 THEN 'paid' ELSE overdue_status END,
             updated_at = clock_timestamp()
         WHERE invoice_id = $2 AND tenant_id = $3`,
        [amount, invoiceId, tenantId]);
}

async function scopeBalance(tx: Queryable, tenantId: string, scope: PaymentScope): Promise<number> {
    const [row] = await tx.query<{ balance: string }>(
        `SELECT COALESCE(SUM(balance_amount), 0)::text AS balance FROM billing.invoices
         WHERE tenant_id = $1 AND status NOT IN ('void', 'cancelled')
           AND (($2::uuid IS NOT NULL AND enrollment_id = $2::uuid) OR ($2::uuid IS NULL AND invoice_id = $3::uuid))`,
        [tenantId, scope.enrollmentId, scope.fallbackInvoiceId]);
    return Number(row.balance);
}

async function keepExcessAsCredit(tx: Queryable, params: {
    tenantId: string; studentId: string; enrollmentId: string | null; invoiceId: string; paymentId: string; amount: number; courseTitle: string; actorId: string;
}) {
    await postCreditEntry(tx, {
        tenantId: params.tenantId, studentId: params.studentId, entryType: 'advance_payment', amount: params.amount,
        sourceEnrollmentId: params.enrollmentId, invoiceId: params.invoiceId, paymentId: params.paymentId,
        reason: `Payment beyond the dues of ${params.courseTitle}`, actorId: params.actorId, idempotencyKey: `advance-${params.paymentId}`,
    });
}

async function receiptsWhere(tx: Queryable, tenantId: string, condition: string, value: string): Promise<PaymentReceiptResult[]> {
    const rows = await tx.query<{
        payment_id: string; receipt_number: string; invoice_id: string; invoice_number: string; designation: string; amount: string;
        payment_method: string; status: string; created_at: string;
    }>(
        `SELECT p.payment_id, p.receipt_number, p.invoice_id, i.invoice_number, i.designation, p.amount::text, p.payment_method, p.status, p.created_at
         FROM billing.payments p JOIN billing.invoices i ON i.invoice_id = p.invoice_id
         WHERE p.tenant_id = $1 AND ${condition} ORDER BY p.created_at, p.idempotency_key`,
        [tenantId, value]);
    return rows.map(r => ({
        paymentId: r.payment_id, receiptNumber: r.receipt_number, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number,
        installmentDesignation: r.designation, amount: Number(r.amount), paymentMethod: r.payment_method, status: r.status, createdAt: r.created_at,
    }));
}

// Keys are stored as "<hash>-<n>", one row per installment covered by the payment
const paymentKey = (studentId: string, key: string) => crypto.createHash('sha256').update(`${studentId}:${key}`).digest('hex').slice(0, 40);

/**
 * Posts a payment inside a transaction:
 * - Strictly isolated to one course enrollment: payments for Course A never affect Course B.
 * - Partial payments leave the balance on the installment.
 * - Excess rolls over to the next unpaid installments of the same course; anything beyond the course dues is kept
 *   in the credit ledger, so no money is lost and none is counted twice.
 */
export async function postCoursePayment(tx: Queryable, params: ProcessPaymentParams): Promise<ProcessPaymentResult> {
    const { tenantId, studentId, amount, paymentMethod } = params;
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
        throw billingError('invalid', 'Payment amount must be a positive amount with at most two decimals.');
    }
    const paidOn = params.paymentDate ? new Date(params.paymentDate) : new Date();
    if (Number.isNaN(paidOn.getTime())) throw billingError('invalid', 'Payment date is not valid.');
    if (paidOn.getTime() > Date.now() + 86400000) throw billingError('invalid', 'Payment date cannot be in the future.');

    await lockStudent(tx, tenantId, studentId);

    // Duplicate prevention: same request or same gateway payment
    const key = params.idempotencyKey ? paymentKey(studentId, params.idempotencyKey) : null;
    const replayed = key ? await receiptsWhere(tx, tenantId, `p.idempotency_key LIKE $2`, `${key}-%`)
        : params.gatewayPaymentId ? await receiptsWhere(tx, tenantId, 'p.gateway_payment_id = $2', params.gatewayPaymentId) : [];
    if (replayed.length > 0) {
        return {
            success: true, studentId, courseTitle: params.courseTitle ?? '', totalAmountPaid: fromMinor(replayed.reduce((t, r) => t + toMinor(r.amount), 0)),
            receipts: replayed, excessCredit: 0, remainingCourseBalance: 0, replayed: true, message: 'This payment was already recorded.',
        };
    }

    let scope = await resolvePaymentScope(tx, params);
    // Paying an installment whose balance was carried forward: take that part back from the later installments first
    if (params.invoiceId && scope.invoices[0] && scope.invoices[0].invoice_id !== params.invoiceId) {
        const restored = await restoreCarriedBalance(tx, { tenantId, invoiceId: params.invoiceId, amount, actorId: params.recordedByActorId });
        if (restored > 0) scope = await resolvePaymentScope(tx, params);
    }
    if (scope.invoices.length === 0 && !params.alreadyCaptured) {
        throw billingError('invalid', `No pending installments found for ${scope.courseTitle}.`);
    }

    const reference = params.paymentReference || params.gatewayPaymentId || `PAY-${studentId.slice(0, 8)}-${Date.now()}`;
    const receipts: PaymentReceiptResult[] = [];
    const record = async (inv: { invoice_id: string; invoice_number: string; designation: string }, value: number) => {
        const receiptNumber = generateReceiptNumber();
        const [row] = await tx.query<{ payment_id: string }>(
            `INSERT INTO billing.payments (tenant_id, invoice_id, student_id, payment_reference, amount, payment_method, status, receipt_number,
                 gateway_order_id, gateway_payment_id, idempotency_key, recorded_by_actor_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'posted', $7, $8, $9, $10, $11, $12) RETURNING payment_id`,
            [tenantId, inv.invoice_id, studentId, reference.slice(0, 100), value, paymentMethod, receiptNumber, params.gatewayOrderId || null,
                params.gatewayPaymentId || null, key ? `${key}-${receipts.length}` : null, params.recordedByActorId, paidOn.toISOString()]);
        await writeAudit(tx, {
            tenantId, actorId: params.recordedByActorId, action: 'billing.payment_posted', entityType: 'payment', entityId: row.payment_id,
            details: {
                receipt: receiptNumber, amount: value, method: paymentMethod, invoiceNumber: inv.invoice_number, studentId,
                enrollmentId: scope.enrollmentId, courseTitle: scope.courseTitle,
            },
        });
        receipts.push({
            paymentId: row.payment_id, receiptNumber, invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number,
            installmentDesignation: inv.designation, amount: value, paymentMethod, status: 'posted', createdAt: paidOn.toISOString(),
        });
        return row.payment_id;
    };

    let remaining = toMinor(amount);
    const underpaid = scope.invoices.length > 0 && remaining < toMinor(scope.invoices[0].balance_amount);
    for (const inv of scope.invoices) {
        if (remaining <= 0) break;
        const share = Math.min(remaining, toMinor(inv.balance_amount));
        await settleInvoice(tx, tenantId, inv.invoice_id, fromMinor(share));
        await record(inv, fromMinor(share));
        remaining -= share;
    }

    const excessCredit = fromMinor(remaining);
    if (remaining > 0) {
        const [inv] = await tx.query<{ invoice_id: string; invoice_number: string; designation: string }>(
            `SELECT invoice_id, invoice_number, designation FROM billing.invoices WHERE invoice_id = $1`,
            [receipts.at(-1)?.invoiceId ?? scope.fallbackInvoiceId]);
        const paymentId = await record({ ...inv, designation: `Advance credit — ${scope.courseTitle}` }, excessCredit);
        await keepExcessAsCredit(tx, {
            tenantId, studentId, enrollmentId: scope.enrollmentId, invoiceId: inv.invoice_id, paymentId, amount: excessCredit,
            courseTitle: scope.courseTitle, actorId: params.recordedByActorId,
        });
    }

    // The installment being paid was not paid in full: its balance joins the remaining installments
    const carried = underpaid
        ? await carryForwardShortfall(tx, { tenantId, invoiceId: scope.invoices[0].invoice_id, actorId: params.recordedByActorId }) : null;

    let message = `Payment of ₹${amount.toLocaleString('en-IN')} recorded. Receipt ${receipts.map(r => r.receiptNumber).join(', ')}.`;
    if (receipts.length > 1 + (excessCredit > 0 ? 1 : 0)) message += ' The excess was applied to the next installments of this course.';
    if (carried) message += ` The unpaid ₹${carried.amount.toLocaleString('en-IN')} was added to the next ${carried.installments.length} installment(s).`;
    if (excessCredit > 0) message += ` ₹${excessCredit.toLocaleString('en-IN')} beyond the course dues was kept as credit balance.`;
    return {
        success: true, studentId, courseTitle: scope.courseTitle, totalAmountPaid: amount, receipts, excessCredit,
        remainingCourseBalance: await scopeBalance(tx, tenantId, scope), message,
    };
}

/** Records a payment received by Finance, or captured online, in its own transaction. */
export async function processCoursePayment(params: ProcessPaymentParams): Promise<ProcessPaymentResult> {
    return await withTransaction(tx => postCoursePayment(tx, params));
}

/**
 * Bank / counter payment declared by a guardian. Nothing is settled until Finance verifies it; the declaration is
 * split over the installments it covers so that each can be verified on its own.
 */
export async function declareManualPayment(params: {
    tenantId: string; studentId: string; enrollmentId?: string | null; invoiceId?: string | null; amount: number; paymentMethod: string;
    paymentReference?: string; idempotencyKey?: string | null; actorId: string;
}) {
    return await withTransaction(async tx => {
        const { tenantId, studentId, amount } = params;
        if (!Number.isFinite(amount) || amount <= 0) throw billingError('invalid', 'Payment amount must be greater than zero.');
        await lockStudent(tx, tenantId, studentId);
        const key = params.idempotencyKey ? paymentKey(studentId, params.idempotencyKey) : null;
        if (key) {
            const existing = await receiptsWhere(tx, tenantId, 'p.idempotency_key LIKE $2', `${key}-%`);
            if (existing.length > 0) return { success: true, pendingVerification: true, receipts: existing, message: 'This payment was already submitted for verification.' };
        }
        const scope = await resolvePaymentScope(tx, params);
        const pending = await tx.query<{ invoice_id: string; amount: string }>(
            `SELECT invoice_id, SUM(amount)::text AS amount FROM billing.payments
             WHERE tenant_id = $1 AND student_id = $2 AND status = 'verification_pending' GROUP BY invoice_id`, [tenantId, studentId]);
        let remaining = toMinor(amount);
        const receipts: PaymentReceiptResult[] = [];
        let targets = scope.invoices.map(inv => ({ ...inv, open: toMinor(inv.balance_amount) }));
        if (params.invoiceId && scope.invoices[0]?.invoice_id !== params.invoiceId) {
            // Rest of an installment that was carried forward; it is taken back from the later ones when verified
            const restorable = toMinor(await getRestorableAmount(tx, tenantId, params.invoiceId));
            if (restorable > 0) {
                if (remaining > restorable) throw billingError('invalid', `Up to ${fromMinor(restorable).toFixed(2)} can be paid on this installment.`);
                const [row] = await tx.query<DueInvoice>(
                    `SELECT invoice_id, invoice_number, designation, enrollment_id, balance_amount::text, paid_amount::text FROM billing.invoices WHERE invoice_id = $1`,
                    [params.invoiceId]);
                // what is already declared on it was deducted above, so it is added back for the check below
                targets = [{ ...row, open: restorable + toMinor(pending.find(p => p.invoice_id === row.invoice_id)?.amount) }];
            }
        }
        for (const inv of targets) {
            if (remaining <= 0) break;
            const open = inv.open - toMinor(pending.find(p => p.invoice_id === inv.invoice_id)?.amount);
            const share = Math.min(remaining, open);
            if (share <= 0) continue;
            const number = `PND-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
            const [row] = await tx.query<{ payment_id: string; created_at: string }>(
                `INSERT INTO billing.payments (tenant_id, invoice_id, student_id, payment_reference, amount, payment_method, status, receipt_number,
                     idempotency_key, recorded_by_actor_id)
                 VALUES ($1, $2, $3, $4, $5, $6, 'verification_pending', $7, $8, $9) RETURNING payment_id, created_at`,
                [tenantId, inv.invoice_id, studentId, (params.paymentReference || number).slice(0, 100), fromMinor(share), params.paymentMethod, number,
                    key ? `${key}-${receipts.length}` : null, params.actorId]);
            receipts.push({
                paymentId: row.payment_id, receiptNumber: number, invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number,
                installmentDesignation: inv.designation, amount: fromMinor(share), paymentMethod: params.paymentMethod,
                status: 'verification_pending', createdAt: row.created_at,
            });
            remaining -= share;
        }
        if (remaining > 0) throw billingError('invalid', 'Amount exceeds the unpaid balance of this course (including payments awaiting verification).');
        await writeAudit(tx, {
            tenantId, actorId: params.actorId, action: 'billing.payment_declared', entityType: 'student', entityId: studentId,
            details: { amount, method: params.paymentMethod, reference: params.paymentReference ?? null, course: scope.courseTitle, invoices: receipts.map(r => r.invoiceNumber) },
        });
        return { success: true, pendingVerification: true, receipts, message: 'Payment submitted. It will be applied once the academy verifies it.' };
    });
}

/** Finance decision on a payment: settles or rejects a declared one, or marks a recorded one as verified. */
export async function verifyManualPayment(params: {
    tenantId: string; paymentId: string; decision: 'verify' | 'reject'; reason: string | null; actorId: string;
}) {
    return await withTransaction(async tx => {
        const { tenantId, paymentId, actorId } = params;
        const [found] = await tx.query<{ student_id: string }>(
            `SELECT student_id FROM billing.payments WHERE payment_id = $1 AND tenant_id = $2`, [paymentId, tenantId]);
        if (!found) throw billingError('not_found', 'Payment record not found.');
        await lockStudent(tx, tenantId, found.student_id);
        const [pay] = await tx.query<{ amount: string; receipt_number: string; status: string; invoice_id: string; balance_amount: string; enrollment_id: string | null; designation: string; idempotency_key: string | null }>(
            `SELECT p.idempotency_key, p.amount::text, p.receipt_number, p.status, p.invoice_id, i.balance_amount::text, i.enrollment_id, i.designation
             FROM billing.payments p JOIN billing.invoices i ON i.invoice_id = p.invoice_id
             WHERE p.payment_id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, i`, [paymentId, tenantId]);

        // 'reconciled' is the verified state every finance report counts
        if (params.decision === 'verify' && (pay.status === 'reconciled' || pay.status === 'verified')) {
            return { success: true, paymentId, receiptNumber: pay.receipt_number, status: pay.status, message: `Payment ${pay.receipt_number} was already verified.` };
        }
        if (pay.status !== 'verification_pending' && !(params.decision === 'verify' && pay.status === 'posted')) {
            throw billingError('conflict', `A payment with status '${pay.status}' cannot be ${params.decision === 'verify' ? 'verified' : 'rejected'}.`);
        }

        let receiptNumber = pay.receipt_number;
        let excessCredit = 0;
        if (params.decision === 'reject') {
            if (!params.reason) throw billingError('invalid', 'Enter the reason for rejecting this payment.');
            await tx.query(`UPDATE billing.payments SET status = 'rejected' WHERE payment_id = $1`, [paymentId]);
        } else if (pay.status === 'posted') {
            await tx.query(`UPDATE billing.payments SET status = 'reconciled' WHERE payment_id = $1`, [paymentId]);
        } else {
            const amount = toMinor(pay.amount);
            let share = Math.min(amount, toMinor(pay.balance_amount));
            receiptNumber = generateReceiptNumber();
            if (share < amount) {
                share += toMinor(await restoreCarriedBalance(tx, { tenantId, invoiceId: pay.invoice_id, amount: fromMinor(amount - share), actorId }));
            }
            if (share > 0) await settleInvoice(tx, tenantId, pay.invoice_id, fromMinor(share));
            await tx.query(`UPDATE billing.payments SET status = 'reconciled', receipt_number = $1 WHERE payment_id = $2`, [receiptNumber, paymentId]);
            // The installment was settled another way meanwhile: the money is real, so it stays as credit
            excessCredit = fromMinor(amount - share);
            if (excessCredit > 0) {
                await keepExcessAsCredit(tx, {
                    tenantId, studentId: found.student_id, enrollmentId: pay.enrollment_id, invoiceId: pay.invoice_id, paymentId, amount: excessCredit,
                    courseTitle: pay.designation, actorId,
                });
            }
        }
        // Once every declaration of this installment is decided, a shortfall moves on. Part "0" of a declaration is the
        // installment being paid; later parts are money paid ahead and leave their installment as scheduled.
        const paidAhead = /-[1-9]\d*$/.test(pay.idempotency_key ?? '');
        if (pay.status === 'verification_pending' && !paidAhead) {
            await carryForwardShortfall(tx, { tenantId, invoiceId: pay.invoice_id, actorId });
        }
        await writeAudit(tx, {
            tenantId, actorId, action: params.decision === 'reject' ? 'billing.payment_rejected' : 'billing.payment_verified', entityType: 'payment', entityId: paymentId,
            details: { receipt: receiptNumber, amount: Number(pay.amount), studentId: found.student_id, previousStatus: pay.status, excessCredit, reason: params.reason },
        });
        const status = params.decision === 'reject' ? 'rejected' : 'reconciled';
        return { success: true, paymentId, receiptNumber, status, excessCredit, message: `Payment ${receiptNumber} has been ${status === 'rejected' ? 'rejected' : 'verified'}.` };
    });
}

/**
 * Creates a Razorpay order for an online fee payment. The order is stored with its student, course and amount, and
 * only those stored values are used when it is captured.
 */
export async function createFeePaymentOrder(params: {
    tenantId: string;
    studentId: string;
    enrollmentId?: string | null;
    invoiceId?: string | null;
    amount: number;
    currency?: string;
    actorId: string;
}): Promise<{
    orderId: string;
    amount: number;
    currency: string;
    keyId: string;
    isSimulation?: boolean;
}> {
    const { tenantId, studentId, amount } = params;
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
        throw billingError('invalid', 'Payment amount must be a positive amount with at most two decimals.');
    }
    const scope = await withTransaction(async tx => {
        await lockStudent(tx, tenantId, studentId);
        const found = await resolvePaymentScope(tx, params);
        const due = found.invoices.reduce((total, i) => total + toMinor(i.balance_amount), 0);
        if (due === 0) throw billingError('invalid', `${found.courseTitle} has no outstanding balance.`);
        if (toMinor(amount) > due) throw billingError('invalid', `Amount exceeds the outstanding balance of ${fromMinor(due).toFixed(2)} for ${found.courseTitle}.`);
        return found;
    });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const currency = params.currency || 'INR';
    const amountInPaise = toMinor(amount);
    const configured = Boolean(keyId && keySecret && !keyId.startsWith('rzp_mock'));
    let orderId: string;

    if (configured) {
        const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        const res = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                amount: amountInPaise,
                currency,
                receipt: `FEE-${Date.now()}`,
                payment_capture: 1, // a successful QR, UPI or card payment is captured by itself
                notes: { purpose: 'course_fee', studentId, enrollmentId: scope.enrollmentId ?? '', invoiceId: params.invoiceId ?? '' },
            }),
        }).catch(() => null);
        if (!res?.ok) {
            console.error('[Razorpay order failed]', res ? `${res.status} ${await res.text()}` : 'no response');
            throw billingError('invalid', 'The payment gateway could not start this payment. Please try again.');
        }
        orderId = ((await res.json()) as { id: string }).id;
    } else {
        // Local development without gateway keys; never available in production
        if (process.env.NODE_ENV === 'production') throw billingError('invalid', 'Online payments are not configured for this academy.');
        orderId = `order_sim_${crypto.randomBytes(10).toString('hex')}`;
    }

    await query(
        `INSERT INTO billing.payment_orders (order_id, tenant_id, student_id, enrollment_id, invoice_id, amount, currency, gateway, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orderId, tenantId, studentId, scope.enrollmentId, params.invoiceId ?? null, amount, currency, configured ? 'razorpay' : 'simulation', params.actorId]);
    return { orderId, amount: amountInPaise, currency, keyId: keyId || 'rzp_test_sim', ...(configured ? {} : { isSimulation: true }) };
}

/** Verifies the Razorpay checkout signature. */
export function verifyFeePaymentSignature(params: { orderId: string; paymentId: string; signature: string }): boolean {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) return false;
    const expected = Buffer.from(crypto.createHmac('sha256', keySecret).update(`${params.orderId}|${params.paymentId}`).digest('hex'));
    const actual = Buffer.from(params.signature);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Posts the payment of a captured order exactly once, whether the browser or the webhook reports it first.
 * Returns null when the order is not a fee order.
 */
export async function captureFeePaymentOrder(params: {
    orderId: string; paymentId: string; paymentMethod: string;
    /** Set by the portal: the order must belong to this student, and the signature must be valid. */
    portal?: { tenantId: string; studentId: string; signature: string };
    /** Set by the webhook: amount captured by the gateway, in paise. */
    capturedPaise?: number;
}): Promise<ProcessPaymentResult | null> {
    return await withTransaction(async tx => {
        const [order] = await tx.query<{
            tenant_id: string; student_id: string; enrollment_id: string | null; invoice_id: string | null; amount: string; gateway: string;
            status: string; gateway_payment_id: string | null; result: ProcessPaymentResult | null; created_by_actor_id: string;
        }>(
            `SELECT tenant_id, student_id, enrollment_id, invoice_id, amount::text, gateway, status, gateway_payment_id, result, created_by_actor_id
             FROM billing.payment_orders WHERE order_id = $1 FOR UPDATE`, [params.orderId]);
        if (!order) return null;
        if (params.portal) {
            if (order.tenant_id !== params.portal.tenantId || order.student_id !== params.portal.studentId) {
                throw billingError('forbidden', 'This payment order belongs to a different student.');
            }
            if (order.gateway === 'razorpay'
                && !verifyFeePaymentSignature({ orderId: params.orderId, paymentId: params.paymentId, signature: params.portal.signature })) {
                throw billingError('invalid', 'Razorpay signature could not be verified.');
            }
            if (order.gateway === 'simulation' && process.env.NODE_ENV === 'production') throw billingError('forbidden', 'Simulated payments are disabled.');
        } else if (params.capturedPaise !== toMinor(order.amount)) {
            throw billingError('invalid', 'Captured amount does not match the payment order.');
        }
        if (order.status === 'paid') {
            if (order.gateway_payment_id !== params.paymentId) throw billingError('conflict', 'This payment order is already paid.');
            return { ...order.result!, replayed: true };
        }
        const result = await postCoursePayment(tx, {
            tenantId: order.tenant_id, studentId: order.student_id, enrollmentId: order.invoice_id ? null : order.enrollment_id, invoiceId: order.invoice_id,
            amount: Number(order.amount), paymentMethod: params.paymentMethod, paymentReference: params.paymentId, gatewayOrderId: params.orderId,
            gatewayPaymentId: params.paymentId, idempotencyKey: `order-${params.orderId}`, recordedByActorId: order.created_by_actor_id, alreadyCaptured: true,
        });
        await tx.query(
            `UPDATE billing.payment_orders SET status = 'paid', gateway_payment_id = $1, result = $2::jsonb, paid_at = clock_timestamp() WHERE order_id = $3`,
            [params.paymentId, JSON.stringify(result), params.orderId]);
        return result;
    });
}

/**
 * Asks Razorpay whether an order has been paid (QR scanned on another device, browser closed, callback lost) and posts
 * the captured payment. Never trusts the browser: only a payment captured for this order and amount settles it.
 */
export async function checkFeePaymentOrder(params: { orderId: string; tenantId: string; studentId: string }): Promise<{ status: 'paid' | 'pending'; result: ProcessPaymentResult | null }> {
    const [order] = await query<{ status: string; gateway: string; amount: string; currency: string; result: ProcessPaymentResult | null }>(
        `SELECT status, gateway, amount::text, currency, result FROM billing.payment_orders WHERE order_id = $1 AND tenant_id = $2 AND student_id = $3`,
        [params.orderId, params.tenantId, params.studentId]);
    if (!order) throw billingError('not_found', 'Payment order not found.');
    if (order.status === 'paid') return { status: 'paid', result: order.result };
    const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = process.env;
    if (order.gateway !== 'razorpay' || !keyId || !keySecret) return { status: 'pending', result: null };

    const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(params.orderId)}/payments`, {
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64') },
        signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res?.ok) return { status: 'pending', result: null };
    const { items } = (await res.json()) as { items?: Array<{ id: string; status: string; amount: number; currency: string; order_id: string }> };
    const paid = items?.find(p => p.status === 'captured' && p.order_id === params.orderId && p.amount === toMinor(order.amount) && p.currency === order.currency);
    if (!paid) return { status: 'pending', result: null };
    return { status: 'paid', result: await captureFeePaymentOrder({ orderId: params.orderId, paymentId: paid.id, paymentMethod: 'Razorpay', capturedPaise: paid.amount }) };
}

/** Settles recent online attempts of a student that were paid without the browser reporting it. Returns how many. */
export async function reconcileFeePaymentOrders(params: { tenantId: string; studentId: string }): Promise<number> {
    const orders = await query<{ order_id: string }>(
        `SELECT order_id FROM billing.payment_orders
         WHERE tenant_id = $1 AND student_id = $2 AND gateway = 'razorpay' AND status <> 'paid' AND created_at > clock_timestamp() - interval '24 hours'
         ORDER BY created_at DESC LIMIT 5`, [params.tenantId, params.studentId]);
    const checked = await Promise.all(orders.map(o => checkFeePaymentOrder({ ...params, orderId: o.order_id }).catch(() => null)));
    return checked.filter(c => c?.status === 'paid').length;
}

/** Marks an online attempt as failed. The order can still be paid later; nothing is posted. */
export async function failFeePaymentOrder(params: { orderId: string; reason: string; portal?: { tenantId: string; studentId: string } }): Promise<boolean> {
    const rows = await query<{ order_id: string }>(
        `UPDATE billing.payment_orders SET status = 'failed', failure_reason = $2, failed_at = clock_timestamp()
         WHERE order_id = $1 AND status IN ('created', 'failed')
           AND ($3::uuid IS NULL OR (tenant_id = $3::uuid AND student_id = $4::uuid)) RETURNING order_id`,
        [params.orderId, params.reason.slice(0, 300), params.portal?.tenantId ?? null, params.portal?.studentId ?? null]);
    if (rows.length > 0) return true;
    return (await query(`SELECT 1 FROM billing.payment_orders WHERE order_id = $1`, [params.orderId])).length > 0;
}
