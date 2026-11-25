/**
 * Credit ledger and enrollment fee position.
 *
 * billing.credit_ledger is append-only and the database refuses any entry that would take a student's
 * balance below zero. Credit is never a payment: applying it reduces what an invoice charges and is shown as
 * a 'credit_adjustment' line, while billing.payments only ever holds money actually received.
 */
export type Queryable = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]> };

export const ACTIVE_ENROLLMENT = ['enrolled', 'confirmed', 'active', 'approved'];
export const isActiveEnrollment = (status: string) => ACTIVE_ENROLLMENT.includes(status.toLowerCase());

/** Payments that count as received money. */
export const RECEIVED_PAYMENT = ['posted', 'reconciled', 'verified'];

/** Business-rule error; the code is mapped to an HTTP status by lib/api/respond. */
export function billingError(kind: 'invalid' | 'conflict' | 'not_found' | 'forbidden', message: string) {
    const code = { invalid: '22023', conflict: '23505', not_found: 'P0002', forbidden: '42501' }[kind];
    return Object.assign(new Error(message), { code });
}

// Money is added and split in minor units so that totals always match exactly
export const toMinor = (value: unknown) => Math.round(Number(value ?? 0) * 100);
export const fromMinor = (minor: number) => minor / 100;

/** Validates a client-supplied amount (two decimals at most). */
export function parseAmount(value: unknown, label: string): number {
    const amount = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
    if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
        throw billingError('invalid', `${label} must be a non-negative amount with at most two decimals.`);
    }
    return fromMinor(toMinor(amount));
}

export interface LockedStudent { studentId: string; fullName: string; enrollmentNumber: string; status: string; branchId: string | null }

/** Serialises every billing change of one student and confirms the student belongs to the academy. */
export async function lockStudent(tx: Queryable, tenantId: string, studentId: string): Promise<LockedStudent> {
    const [row] = await tx.query<{ first_name: string; last_name: string; enrollment_number: string; status: string; branch_id: string | null }>(
        `SELECT first_name, last_name, enrollment_number, status, branch_id
         FROM academics.students WHERE student_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [studentId, tenantId]);
    if (!row) throw billingError('not_found', 'Student not found.');
    return {
        studentId, fullName: `${row.first_name} ${row.last_name}`.trim(), enrollmentNumber: row.enrollment_number,
        status: row.status, branchId: row.branch_id,
    };
}

export async function writeAudit(tx: Queryable, entry: {
    tenantId: string; actorId: string; action: string; entityType: string; entityId: string; details: unknown;
}) {
    await tx.query(
        `INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
         VALUES ($1, $2, $3, $4, $5, gen_random_uuid()::text, $6::jsonb)`,
        [entry.tenantId, entry.actorId, entry.action, entry.entityType, entry.entityId, JSON.stringify(entry.details)]);
}

export async function getCreditBalance(db: Queryable, tenantId: string, studentId: string): Promise<number> {
    const [row] = await db.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM billing.credit_ledger WHERE tenant_id = $1 AND student_id = $2`,
        [tenantId, studentId]);
    return Number(row.balance);
}

export interface CreditEntry {
    entryId: string; entryType: string; amount: number; balanceAfter: number; reason: string | null; createdAt: string;
    sourceCourse: string | null; targetCourse: string | null; invoiceNumber: string | null; actorName: string | null; transferId: string | null;
}

export async function getCreditHistory(db: Queryable, tenantId: string, studentId: string): Promise<CreditEntry[]> {
    const rows = await db.query<{
        entry_id: string; entry_type: string; amount: string; balance_after: string; reason: string | null; created_at: string;
        source_course: string | null; target_course: string | null; invoice_number: string | null; actor_name: string | null; transfer_id: string | null;
    }>(
        `SELECT l.entry_id, l.entry_type, l.amount::text, l.balance_after::text, l.reason, l.created_at, l.transfer_id,
                sc.title AS source_course, tc.title AS target_course, i.invoice_number, u.full_name AS actor_name
         FROM billing.credit_ledger l
         LEFT JOIN academics.enrollments se ON se.enrollment_id = l.source_enrollment_id
         LEFT JOIN academics.batches sb ON sb.batch_id = se.batch_id
         LEFT JOIN academics.courses sc ON sc.course_id = sb.course_id
         LEFT JOIN academics.enrollments te ON te.enrollment_id = l.target_enrollment_id
         LEFT JOIN academics.batches tb ON tb.batch_id = te.batch_id
         LEFT JOIN academics.courses tc ON tc.course_id = tb.course_id
         LEFT JOIN billing.invoices i ON i.invoice_id = l.invoice_id
         LEFT JOIN identity_app.users u ON u.user_id = l.actor_id
         WHERE l.tenant_id = $1 AND l.student_id = $2
         ORDER BY l.seq DESC`,
        [tenantId, studentId]);
    return rows.map(r => ({
        entryId: r.entry_id, entryType: r.entry_type, amount: Number(r.amount), balanceAfter: Number(r.balance_after), reason: r.reason,
        createdAt: r.created_at, sourceCourse: r.source_course, targetCourse: r.target_course, invoiceNumber: r.invoice_number,
        actorName: r.actor_name, transferId: r.transfer_id,
    }));
}

export async function postCreditEntry(tx: Queryable, entry: {
    tenantId: string; studentId: string; entryType: 'transfer_credit' | 'advance_payment' | 'credit_applied'; amount: number;
    sourceEnrollmentId?: string | null; targetEnrollmentId?: string | null; transferId?: string | null;
    invoiceId?: string | null; paymentId?: string | null; reason: string; actorId: string; idempotencyKey: string;
}): Promise<{ entryId: string; balanceAfter: number }> {
    const [row] = await tx.query<{ entry_id: string; balance_after: string }>(
        `INSERT INTO billing.credit_ledger (tenant_id, student_id, entry_type, amount, source_enrollment_id, target_enrollment_id,
                                            transfer_id, invoice_id, payment_id, reason, actor_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING entry_id, balance_after::text`,
        [entry.tenantId, entry.studentId, entry.entryType, entry.amount, entry.sourceEnrollmentId ?? null, entry.targetEnrollmentId ?? null,
            entry.transferId ?? null, entry.invoiceId ?? null, entry.paymentId ?? null, entry.reason, entry.actorId, entry.idempotencyKey]);
    return { entryId: row.entry_id, balanceAfter: Number(row.balance_after) };
}

export interface EnrollmentInfo {
    enrollmentId: string; studentId: string; status: string; enrolledAt: string; batchId: string; batchName: string;
    courseId: string; courseTitle: string; courseCode: string; tuitionAmount: number; branchId: string | null; branchName: string | null;
}

export async function getEnrollment(db: Queryable, tenantId: string, enrollmentId: string): Promise<EnrollmentInfo> {
    const [r] = await db.query<{
        enrollment_id: string; student_id: string; status: string; enrolled_at: string; batch_id: string; batch_name: string;
        course_id: string; course_title: string; course_code: string; tuition_amount: string; branch_id: string | null; branch_name: string | null;
    }>(
        `SELECT e.enrollment_id, e.student_id, e.status, e.enrolled_at, b.batch_id, b.name AS batch_name, c.course_id, c.title AS course_title,
                c.code AS course_code, c.tuition_amount::text, b.branch_id, br.name AS branch_name
         FROM academics.enrollments e
         JOIN academics.batches b ON b.batch_id = e.batch_id
         JOIN academics.courses c ON c.course_id = b.course_id
         LEFT JOIN tenant.branches br ON br.branch_id = b.branch_id
         WHERE e.enrollment_id = $1 AND e.tenant_id = $2`,
        [enrollmentId, tenantId]);
    if (!r) throw billingError('not_found', 'Enrollment not found.');
    return {
        enrollmentId: r.enrollment_id, studentId: r.student_id, status: r.status, enrolledAt: r.enrolled_at, batchId: r.batch_id,
        batchName: r.batch_name, courseId: r.course_id, courseTitle: r.course_title, courseCode: r.course_code,
        tuitionAmount: Number(r.tuition_amount), branchId: r.branch_id, branchName: r.branch_name,
    };
}

export interface EnrollmentFinancials {
    courseFee: number;              // fee agreed for this enrollment, before credit
    verifiedPaid: number;           // money received, excluding money already moved to the credit ledger
    refunded: number;
    pendingVerification: number;    // declared by the guardian, not yet verified by Finance
    lateFeesPaid: number;           // part of verifiedPaid that went to late fees
    creditReceived: number;         // credit applied to this enrollment's invoices
    creditAlreadyGranted: number;   // credit earlier transferred out of this enrollment
    previouslyConsumed: number;     // consumed fee Finance confirmed at an earlier transfer of this enrollment
    outstanding: number;            // unpaid installments; stays with this enrollment
    unusedCeiling: number;          // most that could be unused, before deducting the consumed fee
    paymentsMatchInvoices: boolean; // false when invoices were marked paid without a payment record
    unlinkedPaid: number;           // payments of this student on invoices not linked to any course
}

/** Fee position of one enrollment, from actual payments, refunds and earlier adjustments. */
export async function getEnrollmentFinancials(db: Queryable, tenantId: string, enrollment: EnrollmentInfo): Promise<EnrollmentFinancials> {
    const [inv] = await db.query<{ gross: string; paid: string; credit: string; outstanding: string; late_paid: string }>(
        `SELECT COALESCE(SUM(subtotal_amount - (discount_amount - credit_applied)), 0)::text AS gross,
                COALESCE(SUM(paid_amount), 0)::text AS paid,
                COALESCE(SUM(credit_applied), 0)::text AS credit,
                COALESCE(SUM(balance_amount), 0)::text AS outstanding,
                COALESCE(SUM(LEAST(late_fee_amount, paid_amount)), 0)::text AS late_paid
         FROM billing.invoices
         WHERE tenant_id = $1 AND enrollment_id = $2 AND status NOT IN ('void', 'cancelled')`,
        [tenantId, enrollment.enrollmentId]);
    const [pay] = await db.query<{ received: string; refunded: string; pending: string }>(
        `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status = ANY($3)), 0)::text AS received,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'refunded'), 0)::text AS refunded,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'verification_pending'), 0)::text AS pending
         FROM billing.payments p JOIN billing.invoices i ON i.invoice_id = p.invoice_id
         WHERE p.tenant_id = $1 AND i.enrollment_id = $2`,
        [tenantId, enrollment.enrollmentId, RECEIVED_PAYMENT]);
    const [ledger] = await db.query<{ granted: string; advance: string }>(
        `SELECT COALESCE((SELECT SUM(amount) FROM billing.credit_ledger
                          WHERE tenant_id = $1 AND source_enrollment_id = $2 AND entry_type IN ('transfer_credit', 'legacy_credit')), 0)::text AS granted,
                COALESCE((SELECT SUM(l.amount) FROM billing.credit_ledger l
                          JOIN billing.payments p ON p.payment_id = l.payment_id
                          JOIN billing.invoices i ON i.invoice_id = p.invoice_id
                          WHERE l.tenant_id = $1 AND i.enrollment_id = $2 AND l.entry_type = 'advance_payment'), 0)::text AS advance`,
        [tenantId, enrollment.enrollmentId]);
    const [earlier] = await db.query<{ consumed: string }>(
        `SELECT COALESCE(SUM(consumed_amount), 0)::text AS consumed FROM billing.course_transfers
         WHERE tenant_id = $1 AND from_enrollment_id = $2 AND credit_status IN ('approved', 'no_credit', 'rejected')`,
        [tenantId, enrollment.enrollmentId]);
    const [plan] = await db.query<{ net_fee: string }>(
        `SELECT net_fee::text FROM billing.enrollment_fee_plans
         WHERE tenant_id = $1 AND enrollment_id = $2 ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`,
        [tenantId, enrollment.enrollmentId]);
    const [unlinked] = await db.query<{ paid: string }>(
        `SELECT COALESCE(SUM(p.amount), 0)::text AS paid
         FROM billing.payments p JOIN billing.invoices i ON i.invoice_id = p.invoice_id
         WHERE p.tenant_id = $1 AND p.student_id = $2 AND i.enrollment_id IS NULL AND i.status <> 'void' AND p.status = ANY($3)`,
        [tenantId, enrollment.studentId, RECEIVED_PAYMENT]);

    const received = toMinor(pay.received) - toMinor(ledger.advance);
    const ceiling = received - toMinor(inv.late_paid) + toMinor(inv.credit) - toMinor(ledger.granted) - toMinor(earlier.consumed);
    return {
        courseFee: plan ? Number(plan.net_fee) : Math.max(enrollment.tuitionAmount, Number(inv.gross)),
        verifiedPaid: fromMinor(received),
        refunded: Number(pay.refunded),
        pendingVerification: Number(pay.pending),
        lateFeesPaid: Number(inv.late_paid),
        creditReceived: Number(inv.credit),
        creditAlreadyGranted: Number(ledger.granted),
        previouslyConsumed: Number(earlier.consumed),
        outstanding: Number(inv.outstanding),
        unusedCeiling: fromMinor(Math.max(0, ceiling)),
        paymentsMatchInvoices: received === toMinor(inv.paid),
        unlinkedPaid: Number(unlinked.paid),
    };
}

/**
 * Applies available credit to the unpaid installments of one enrollment, earliest due first.
 * Late fees are not covered by credit. Returns the amount applied per invoice.
 */
export async function applyCreditToEnrollment(tx: Queryable, params: {
    tenantId: string; studentId: string; enrollmentId: string; amount: number; reason: string; actorId: string; idempotencyKey: string;
}) {
    const student = await lockStudent(tx, params.tenantId, params.studentId);
    const [replayed] = await tx.query<{ amount: string }>(
        `SELECT (-SUM(amount))::text AS amount FROM billing.credit_ledger
         WHERE tenant_id = $1 AND student_id = $2 AND idempotency_key LIKE $3 HAVING COUNT(*) > 0`,
        [params.tenantId, params.studentId, `apply-${params.idempotencyKey}-%`]);
    if (replayed) {
        return { applied: Number(replayed.amount), replayed: true, balance: await getCreditBalance(tx, params.tenantId, params.studentId), invoices: [] };
    }

    const enrollment = await getEnrollment(tx, params.tenantId, params.enrollmentId);
    if (enrollment.studentId !== params.studentId) throw billingError('invalid', 'Enrollment does not belong to the selected student.');
    if (!isActiveEnrollment(enrollment.status)) {
        throw billingError('invalid', 'Credit can be applied only to an active course. Old dues stay with the old enrollment.');
    }
    if (params.amount <= 0) throw billingError('invalid', 'Credit amount must be greater than zero.');

    const balance = await getCreditBalance(tx, params.tenantId, params.studentId);
    if (toMinor(params.amount) > toMinor(balance)) {
        throw billingError('invalid', `Credit amount exceeds the available credit balance of ${balance.toFixed(2)}.`);
    }
    const invoices = await tx.query<{ invoice_id: string; invoice_number: string; total_amount: string; paid_amount: string; balance_amount: string }>(
        `SELECT invoice_id, invoice_number, total_amount::text, paid_amount::text, balance_amount::text
         FROM billing.invoices
         WHERE tenant_id = $1 AND enrollment_id = $2 AND balance_amount > 0 AND status NOT IN ('void', 'cancelled')
         ORDER BY due_date, installment_number NULLS LAST, invoice_number FOR UPDATE`,
        [params.tenantId, params.enrollmentId]);
    const coverable = (i: { total_amount: string; paid_amount: string; balance_amount: string }) =>
        Math.max(0, Math.min(toMinor(i.balance_amount), toMinor(i.total_amount) - toMinor(i.paid_amount)));
    const maximum = invoices.reduce((sum, i) => sum + coverable(i), 0);
    if (toMinor(params.amount) > maximum) {
        throw billingError('invalid', `Credit amount exceeds the remaining course fee of ${fromMinor(maximum).toFixed(2)}.`);
    }

    let remaining = toMinor(params.amount);
    const applied: Array<{ invoiceId: string; invoiceNumber: string; amount: number }> = [];
    for (const inv of invoices) {
        const share = Math.min(remaining, coverable(inv));
        if (share <= 0) continue;
        const amount = fromMinor(share);
        await tx.query(
            `UPDATE billing.invoices
             SET credit_applied = credit_applied + $1::numeric, discount_amount = discount_amount + $1::numeric,
                 total_amount = total_amount - $1::numeric, balance_amount = balance_amount - $1::numeric,
                 status = CASE WHEN balance_amount - $1::numeric = 0 THEN 'paid' ELSE status END,
                 overdue_status = CASE WHEN balance_amount - $1::numeric = 0 THEN 'paid' ELSE overdue_status END,
                 updated_at = clock_timestamp()
             WHERE invoice_id = $2 AND tenant_id = $3`,
            [amount, inv.invoice_id, params.tenantId]);
        await tx.query(
            `INSERT INTO billing.invoice_items (tenant_id, invoice_id, item_type, description, amount)
             VALUES ($1, $2, 'credit_adjustment', $3, $4)`,
            [params.tenantId, inv.invoice_id, `Credit applied: ${params.reason}`.slice(0, 250), -amount]);
        await tx.query(
            `INSERT INTO billing.fee_audit (tenant_id, invoice_id, action, old_value, new_value, user_id, reason)
             VALUES ($1, $2, 'credit_applied', $3::jsonb, $4::jsonb, $5, $6)`,
            [params.tenantId, inv.invoice_id,
                JSON.stringify({ total_amount: Number(inv.total_amount), balance_amount: Number(inv.balance_amount) }),
                JSON.stringify({ credit: amount, balance_amount: fromMinor(toMinor(inv.balance_amount) - share) }), params.actorId, params.reason]);
        await postCreditEntry(tx, {
            tenantId: params.tenantId, studentId: params.studentId, entryType: 'credit_applied', amount: -amount,
            targetEnrollmentId: params.enrollmentId, invoiceId: inv.invoice_id, reason: params.reason, actorId: params.actorId,
            idempotencyKey: `apply-${params.idempotencyKey}-${applied.length}`,
        });
        applied.push({ invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number, amount });
        remaining -= share;
    }
    const balanceAfter = await getCreditBalance(tx, params.tenantId, params.studentId);
    await writeAudit(tx, {
        tenantId: params.tenantId, actorId: params.actorId, action: 'billing.credit_applied', entityType: 'student', entityId: params.studentId,
        details: { student: student.fullName, enrollmentId: params.enrollmentId, course: enrollment.courseTitle, amount: params.amount, invoices: applied, balanceAfter, reason: params.reason },
    });
    return { applied: params.amount, replayed: false, balance: balanceAfter, invoices: applied };
}
