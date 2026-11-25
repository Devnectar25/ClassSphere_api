/**
 * Fee plan of one enrollment: one-time or installments, after any approved credit.
 *
 * Credit can be used in two ways:
 *   spread      the installments are calculated on the fee that remains after credit
 *   sequential  the installments are calculated on the full fee and credit settles the earliest ones first
 */
import {
    billingError, fromMinor, getCreditBalance, getEnrollment, isActiveEnrollment, lockStudent, parseAmount, postCreditEntry,
    toMinor, writeAudit, type EnrollmentInfo, type Queryable,
} from '@/lib/billing/credit-ledger';
import { addMonths, assertInstallmentsWithinCourse, assertWithinPeriod, FREQUENCY_MONTHS, getEnrollmentPeriod, MAX_INSTALLMENTS, type DurationOverride, type Frequency } from '@/lib/billing/course-period';

export type PaymentMode = 'one_time' | 'installment';
export type CreditAllocation = 'spread' | 'sequential';

export interface FeePlanInput extends DurationOverride {
    paymentMode: PaymentMode;
    frequency: Frequency | null;
    installmentCount: number;
    firstDueDate: string | null;
    /** Custom amounts and/or dates; amounts must add up to the scheduled total. */
    installments: Array<{ dueDate: string | null; amount: number | null }> | null;
    templatePlanId: string | null;
    applyCredit: number;
    creditAllocation: CreditAllocation;
}

export interface ScheduledInstallment {
    installmentNumber: number;
    dueDate: string;
    gross: number;    // fee of this installment
    credit: number;   // credit covering it
    payable: number;  // what the guardian pays
}

export function parseDate(value: unknown, label: string): string {
    const text = String(value ?? '').slice(0, 10);
    const date = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
        throw billingError('invalid', `${label} must be a valid date.`);
    }
    return text;
}

/** Reads and validates a fee plan request body. */
export function parseFeePlanInput(body: Record<string, unknown>): FeePlanInput {
    const paymentMode = body.paymentMode as PaymentMode;
    if (paymentMode !== 'one_time' && paymentMode !== 'installment') {
        throw billingError('invalid', 'Choose One-Time Payment or Installment Payment.');
    }
    const creditAllocation = (body.creditAllocation ?? 'spread') as CreditAllocation;
    if (creditAllocation !== 'spread' && creditAllocation !== 'sequential') throw billingError('invalid', 'Unknown credit allocation.');

    const rows = Array.isArray(body.installments) ? body.installments as Array<Record<string, unknown>> : null;
    const installments = rows && rows.length > 0 ? rows.map((r, i) => ({
        dueDate: r.dueDate ? parseDate(r.dueDate, `Due date of installment ${i + 1}`) : null,
        amount: r.amount === undefined || r.amount === null || r.amount === '' ? null : parseAmount(r.amount, `Amount of installment ${i + 1}`),
    })) : null;

    const frequency = paymentMode === 'installment' ? (body.frequency ?? 'monthly') as Frequency : null;
    if (frequency && frequency !== 'custom' && !(frequency in FREQUENCY_MONTHS)) throw billingError('invalid', 'Unknown installment frequency.');
    const installmentCount = paymentMode === 'one_time' ? 1 : Number(body.installmentCount ?? installments?.length ?? 0);
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > MAX_INSTALLMENTS) {
        throw billingError('invalid', `Number of installments must be between 1 and ${MAX_INSTALLMENTS}.`);
    }
    if (installments && installments.length !== installmentCount) {
        throw billingError('invalid', `Enter the details of all ${installmentCount} installments.`);
    }
    return {
        paymentMode, frequency, installmentCount, installments, creditAllocation,
        firstDueDate: body.firstDueDate ? parseDate(body.firstDueDate, 'First due date') : null,
        templatePlanId: body.templatePlanId ? String(body.templatePlanId) : null,
        allowBeyondDuration: body.allowBeyondDuration === true,
        beyondDurationReason: body.beyondDurationReason ? String(body.beyondDurationReason).trim().slice(0, 500) || null : null,
        applyCredit: body.applyCredit === undefined || body.applyCredit === null || body.applyCredit === '' ? 0 : parseAmount(body.applyCredit, 'Credit to apply'),
    };
}

/** Installment schedule for a fee and an amount of credit. Every total matches to the paisa. */
export function buildSchedule(netFee: number, credit: number, input: FeePlanInput): ScheduledInstallment[] {
    const net = toMinor(netFee);
    const creditMinor = toMinor(credit);
    if (creditMinor > net) throw billingError('invalid', 'Credit cannot exceed the new course fee.');
    const payable = net - creditMinor;

    // Nothing left to pay: a single settled entry keeps the fee and the credit on record
    const fullyCovered = payable === 0 && input.creditAllocation === 'spread';
    const count = fullyCovered ? 1 : input.installmentCount;
    const scheduled = input.creditAllocation === 'sequential' || fullyCovered ? net : payable;
    const rows = fullyCovered ? null : input.installments;

    // Amounts
    let amounts: number[];
    if (rows?.some(r => r.amount !== null)) {
        if (rows.some(r => r.amount === null)) throw billingError('invalid', 'Enter an amount for every installment.');
        amounts = rows.map(r => toMinor(r.amount));
        if (amounts.some(a => a <= 0)) throw billingError('invalid', 'Every installment amount must be greater than zero.');
        const total = amounts.reduce((a, b) => a + b, 0);
        if (total !== scheduled) {
            throw billingError('invalid', `Installment amounts add up to ${fromMinor(total).toFixed(2)} but must total ${fromMinor(scheduled).toFixed(2)}.`);
        }
    } else {
        const base = Math.floor(scheduled / count);
        if (base <= 0) throw billingError('invalid', 'The amount is too small for this number of installments.');
        amounts = Array.from({ length: count }, (_, i) => (i === count - 1 ? scheduled - base * (count - 1) : base));
    }

    // Due dates
    let dates: string[];
    if (rows?.some(r => r.dueDate !== null)) {
        if (rows.some(r => r.dueDate === null)) throw billingError('invalid', 'Enter a due date for every installment.');
        dates = rows.map(r => r.dueDate!);
    } else {
        if (input.paymentMode === 'installment' && input.frequency === 'custom') throw billingError('invalid', 'Enter a due date for every installment.');
        if (!input.firstDueDate) throw billingError('invalid', 'Choose the first due date.');
        const step = input.frequency && input.frequency !== 'custom' ? FREQUENCY_MONTHS[input.frequency] : 0;
        dates = amounts.map((_, i) => addMonths(input.firstDueDate!, i * step));
    }
    if (dates.some((d, i) => i > 0 && d <= dates[i - 1])) {
        throw billingError('invalid', 'Due dates must be in order, each later than the one before.');
    }

    let creditLeft = creditMinor;
    return amounts.map((amount, i) => {
        let share: number;
        if (input.creditAllocation === 'sequential') share = Math.min(creditLeft, amount);
        else if (fullyCovered || i === amounts.length - 1) share = creditLeft;
        else share = Math.floor((creditMinor * amount) / payable);
        creditLeft -= share;
        const gross = input.creditAllocation === 'sequential' || fullyCovered ? amount : amount + share;
        return {
            installmentNumber: i + 1, dueDate: dates[i], gross: fromMinor(gross), credit: fromMinor(share), payable: fromMinor(gross - share),
        };
    });
}

/** Course fee from the catalogue, less the discount of the chosen fee plan template. */
export async function getCourseFee(db: Queryable, tenantId: string, course: { courseId: string; tuitionAmount: number }, templatePlanId: string | null) {
    let discount = 0;
    if (templatePlanId) {
        const [plan] = await db.query<{ discount_percent: string; course_id: string | null; is_active: boolean }>(
            `SELECT discount_percent::text, course_id, is_active FROM billing.fee_plans WHERE plan_id = $1 AND tenant_id = $2`,
            [templatePlanId, tenantId]);
        if (!plan) throw billingError('not_found', 'Fee plan not found.');
        if (!plan.is_active) throw billingError('invalid', 'This fee plan is not active.');
        if (plan.course_id && plan.course_id !== course.courseId) throw billingError('invalid', 'This fee plan belongs to a different course.');
        // Same rounding as course enrollment: discounted fee to the whole rupee
        const percent = Number(plan.discount_percent) || 0;
        if (percent > 0) discount = fromMinor(toMinor(course.tuitionAmount) - Math.round(course.tuitionAmount * (1 - percent / 100)) * 100);
    }
    const courseFee = course.tuitionAmount;
    return { courseFee, discount, netFee: fromMinor(toMinor(courseFee) - toMinor(discount)) };
}

export async function nextInvoiceNumbers(tx: Queryable, tenantId: string, count: number): Promise<string[]> {
    const now = new Date();
    const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`;
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice-number-${tenantId}`]);
    const [row] = await tx.query<{ last: number }>(
        `SELECT COALESCE(MAX(substring(invoice_number from '-([0-9]+)$')::int), 0)::int AS last
         FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2 AND invoice_number ~ '^INV-[0-9]{6}-[0-9]{1,9}$'`,
        [tenantId, `${prefix}%`]);
    return Array.from({ length: count }, (_, i) => `${prefix}${String(row.last + 1 + i).padStart(4, '0')}`);
}

export const periodLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export interface FeePlanResult {
    enrollmentPlanId: string; courseFee: number; discount: number; netFee: number; creditApplied: number; payableAmount: number;
    creditBalance: number; installments: Array<ScheduledInstallment & { invoiceId: string; invoiceNumber: string }>;
}

/** Creates the fee plan and installments of an enrollment. Must run inside a transaction. */
export async function createEnrollmentFeePlan(tx: Queryable, params: {
    tenantId: string; enrollmentId: string; actorId: string; input: FeePlanInput;
    transfer: { transferId: string; fromCourse: string } | null;
}): Promise<FeePlanResult> {
    const { tenantId, actorId, transfer } = params;
    const enrollment: EnrollmentInfo = await getEnrollment(tx, tenantId, params.enrollmentId);
    const student = await lockStudent(tx, tenantId, enrollment.studentId);
    if (!isActiveEnrollment(enrollment.status)) throw billingError('invalid', 'A fee plan can be created only for an active course enrollment.');

    const [existing] = await tx.query<{ kind: string }>(
        `SELECT 'plan' AS kind FROM billing.enrollment_fee_plans WHERE tenant_id = $1 AND enrollment_id = $2 AND status = 'active'
         UNION ALL
         SELECT 'invoice' FROM billing.invoices
         WHERE tenant_id = $1 AND enrollment_id = $2 AND status NOT IN ('void', 'cancelled')
           AND ($3::uuid IS NULL OR created_at > (SELECT created_at FROM billing.course_transfers WHERE transfer_id = $3::uuid))
         LIMIT 1`,
        [tenantId, enrollment.enrollmentId, transfer?.transferId ?? null]);
    if (existing) throw billingError('conflict', 'This course enrollment already has a fee plan or invoices.');

    // Without a first due date the schedule starts with the course
    const period = await getEnrollmentPeriod(tx, tenantId, enrollment.enrollmentId);
    const input: FeePlanInput = { ...params.input, firstDueDate: params.input.firstDueDate ?? period.firstDueDate };
    const { courseFee, discount, netFee } = await getCourseFee(tx, tenantId, enrollment, input.templatePlanId);
    if (netFee <= 0) throw billingError('invalid', `${enrollment.courseTitle} has no fee set in the course catalogue.`);
    const balance = await getCreditBalance(tx, tenantId, enrollment.studentId);
    if (toMinor(input.applyCredit) > toMinor(balance)) {
        throw billingError('invalid', `Credit amount exceeds the available credit balance of ${balance.toFixed(2)}.`);
    }
    if (toMinor(input.applyCredit) > toMinor(netFee)) {
        throw billingError('invalid', `Credit amount exceeds the new course fee of ${netFee.toFixed(2)}.`);
    }
    const schedule = buildSchedule(netFee, input.applyCredit, input);
    // Installments stay within the course; a one-time due date after it needs an authorization
    if (input.paymentMode === 'installment') assertInstallmentsWithinCourse(period, schedule.map(i => i.dueDate), input.frequency);
    else assertWithinPeriod(period, schedule.at(-1)!.dueDate, input);
    const payableAmount = fromMinor(toMinor(netFee) - toMinor(input.applyCredit));

    const [plan] = await tx.query<{ enrollment_plan_id: string }>(
        `INSERT INTO billing.enrollment_fee_plans (tenant_id, student_id, enrollment_id, template_plan_id, transfer_id, payment_mode, frequency,
             installment_count, credit_allocation, course_fee, discount_amount, net_fee, credit_applied, payable_amount, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING enrollment_plan_id`,
        [tenantId, enrollment.studentId, enrollment.enrollmentId, input.templatePlanId, transfer?.transferId ?? null, input.paymentMode, input.frequency,
            schedule.length, input.creditAllocation, courseFee, discount, netFee, input.applyCredit, payableAmount, actorId]);
    const planId = plan.enrollment_plan_id;

    const numbers = await nextInvoiceNumbers(tx, tenantId, schedule.length);
    const creditLabel = transfer ? `Transfer credit from ${transfer.fromCourse}` : 'Credit balance applied';
    const installments: FeePlanResult['installments'] = [];
    for (const [i, inst] of schedule.entries()) {
        const settled = inst.payable === 0;
        const designation = schedule.length > 1
            ? `Installment ${inst.installmentNumber} of ${schedule.length}: ${enrollment.courseTitle.trim()} Tuition`
            : `${enrollment.courseTitle.trim()} Tuition (${enrollment.batchName}) — ${periodLabel(inst.dueDate)}`;
        const [invoice] = await tx.query<{ invoice_id: string }>(
            `INSERT INTO billing.invoices (tenant_id, invoice_number, student_id, enrollment_id, enrollment_plan_id, installment_number, billing_period,
                 subtotal_amount, discount_amount, credit_applied, total_amount, paid_amount, balance_amount, due_date, status, overdue_status,
                 designation, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, 0, $10, $11::date, $12, $13, $14, $15) RETURNING invoice_id`,
            [tenantId, numbers[i], enrollment.studentId, enrollment.enrollmentId, planId, inst.installmentNumber, periodLabel(inst.dueDate),
                inst.gross, inst.credit, inst.payable, inst.dueDate, settled ? 'paid' : 'pending', settled ? 'paid' : 'upcoming',
                designation, `efp-${planId}-${inst.installmentNumber}`]);
        await tx.query(
            `INSERT INTO billing.invoice_items (tenant_id, invoice_id, item_type, description, amount) VALUES ($1, $2, 'tuition', $3, $4)`,
            [tenantId, invoice.invoice_id, `${enrollment.courseTitle} (${enrollment.batchName}) Tuition`, inst.gross]);
        if (inst.credit > 0) {
            await tx.query(
                `INSERT INTO billing.invoice_items (tenant_id, invoice_id, item_type, description, amount) VALUES ($1, $2, 'credit_adjustment', $3, $4)`,
                [tenantId, invoice.invoice_id, creditLabel, -inst.credit]);
            await postCreditEntry(tx, {
                tenantId, studentId: enrollment.studentId, entryType: 'credit_applied', amount: -inst.credit,
                targetEnrollmentId: enrollment.enrollmentId, transferId: transfer?.transferId ?? null, invoiceId: invoice.invoice_id,
                reason: creditLabel, actorId, idempotencyKey: `plan-${planId}-${inst.installmentNumber}`,
            });
        }
        installments.push({ ...inst, invoiceId: invoice.invoice_id, invoiceNumber: numbers[i] });
    }

    const creditBalance = await getCreditBalance(tx, tenantId, enrollment.studentId);
    await writeAudit(tx, {
        tenantId, actorId, action: 'billing.fee_plan_created', entityType: 'enrollment', entityId: enrollment.enrollmentId,
        details: {
            planId, studentId: enrollment.studentId, student: student.fullName, course: enrollment.courseTitle, transferId: transfer?.transferId ?? null,
            paymentMode: input.paymentMode, frequency: input.frequency, courseFee, discount, netFee, creditApplied: input.applyCredit, payableAmount,
            creditAllocation: input.creditAllocation, courseEnd: period.endDate,
            beyondDurationReason: input.paymentMode === 'one_time' && input.allowBeyondDuration ? input.beyondDurationReason : null, installments: installments.map(i => ({ invoice: i.invoiceNumber, due: i.dueDate, payable: i.payable, credit: i.credit })),
        },
    });
    return { enrollmentPlanId: planId, courseFee, discount, netFee, creditApplied: input.applyCredit, payableAmount, creditBalance, installments };
}
