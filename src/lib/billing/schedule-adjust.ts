/**
 * Installment schedule of one enrollment: original against updated, and authorized changes to the unpaid future part.
 * Paid installments, payments and receipts are never changed; the total still to be collected stays exactly the same.
 */
import {
    ACTIVE_ENROLLMENT, billingError, fromMinor, getEnrollment, lockStudent, parseAmount, toMinor, writeAudit, type EnrollmentInfo, type Queryable,
} from '@/lib/billing/credit-ledger';
import { assertWithinPeriod, getEnrollmentPeriod, MAX_INSTALLMENTS, type CoursePeriod, type DurationOverride, type Frequency } from '@/lib/billing/course-period';
import { nextInvoiceNumbers, parseDate, periodLabel } from '@/lib/billing/fee-plans';

interface Row {
    invoice_id: string; invoice_number: string; designation: string; installment_number: number | null; position: number | null; enrollment_plan_id: string | null;
    subtotal_amount: string; discount_amount: string; credit_applied: string; total_amount: string; paid_amount: string; balance_amount: string;
    late_fee_amount: string; due_date: string; status: string; original_amount: string; original_due_date: string; pending: string;
}

interface Loaded { plan: { id: string; status: string; frequency: string | null } | null; rows: Row[]; adjustable: Row[]; isReview: boolean }

/** Tuition still to collect on an installment (late fees are not rescheduled). */
const openTuition = (r: Row) => toMinor(r.balance_amount) - Math.max(0, toMinor(r.late_fee_amount) - toMinor(r.paid_amount));

async function load(db: Queryable, tenantId: string, enrollment: EnrollmentInfo, today: string, lock: boolean): Promise<Loaded> {
    const [plan] = await db.query<{ enrollment_plan_id: string; status: string; frequency: string | null }>(
        `SELECT enrollment_plan_id, status, frequency FROM billing.enrollment_fee_plans WHERE tenant_id = $1 AND enrollment_id = $2
         ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`, [tenantId, enrollment.enrollmentId]);
    const all = await db.query<Row>(
        `SELECT i.invoice_id, i.invoice_number, i.designation, i.installment_number, i.enrollment_plan_id,
                COALESCE(i.installment_number, substring(i.designation from '^Installment ([0-9]+) of')::int) AS position,
                i.subtotal_amount::text, i.discount_amount::text, i.credit_applied::text, i.total_amount::text, i.paid_amount::text, i.balance_amount::text,
                COALESCE(i.late_fee_amount, 0)::text AS late_fee_amount, i.due_date::text, i.status, i.original_amount::text, i.original_due_date::text,
                (SELECT COALESCE(SUM(p.amount), 0) FROM billing.payments p WHERE p.invoice_id = i.invoice_id AND p.status = 'verification_pending')::text AS pending
         FROM billing.invoices i
         WHERE i.tenant_id = $1 AND i.enrollment_id = $2 AND i.status NOT IN ('void', 'cancelled')
         ORDER BY position NULLS LAST, i.due_date, i.invoice_number ${lock ? 'FOR UPDATE OF i' : ''}`,
        [tenantId, enrollment.enrollmentId]);
    const series = all.filter(r => (plan ? r.enrollment_plan_id === plan.enrollment_plan_id : /^Installment \d+ of \d+/.test(r.designation)));
    const rows = series.length > 0 ? series : all.length === 1 ? all : [];

    const unpaid = rows.filter(r => openTuition(r) > 0 && toMinor(r.pending) === 0);
    const future = unpaid.filter(r => r.due_date >= today && toMinor(r.late_fee_amount) === 0);
    // Nothing lies ahead but money is still owed: that outstanding amount is what Finance reviews and reschedules
    const isReview = future.length === 0 && unpaid.length > 0;
    return { plan: plan ? { id: plan.enrollment_plan_id, status: plan.status, frequency: plan.frequency } : null, rows, adjustable: isReview ? unpaid : future, isReview };
}

export async function getSchedule(db: Queryable, tenantId: string, enrollmentId: string) {
    const enrollment = await getEnrollment(db, tenantId, enrollmentId);
    const period = await getEnrollmentPeriod(db, tenantId, enrollmentId);
    const { plan, rows, adjustable, isReview } = await load(db, tenantId, enrollment, period.today, false);
    const history = await db.query<{
        audit_id: string; action: string; old_value: unknown; new_value: unknown; reason: string | null; created_at: string; invoice_number: string;
        designation: string; actor: string | null;
    }>(
        `SELECT a.audit_id, a.action, a.old_value, a.new_value, a.reason, a.created_at, i.invoice_number, i.designation, u.full_name AS actor
         FROM billing.fee_audit a
         JOIN billing.invoices i ON i.invoice_id = a.invoice_id
         LEFT JOIN identity_app.users u ON u.user_id = a.user_id
         WHERE a.tenant_id = $1 AND i.enrollment_id = $2
           AND a.action IN ('installment_carry_forward', 'installment_carry_restored', 'schedule_adjusted', 'schedule_added', 'schedule_removed', 'credit_applied',
                            'outstanding_waived')
         ORDER BY a.created_at DESC, i.installment_number LIMIT 200`, [tenantId, enrollmentId]);
    const ids = new Set(adjustable.map(r => r.invoice_id));
    const sum = (list: Row[], pick: (r: Row) => number) => fromMinor(list.reduce((t, r) => t + pick(r), 0));
    return {
        enrollment, period, frequency: plan?.frequency ?? null, isReview,
        outstanding: sum(rows, r => toMinor(r.balance_amount)),
        adjustableTotal: sum(adjustable, openTuition),
        installments: rows.map(r => ({
            invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, installmentNumber: r.position, designation: r.designation,
            originalAmount: Number(r.original_amount), originalDueDate: r.original_due_date, amount: Number(r.total_amount), dueDate: r.due_date,
            paidAmount: Number(r.paid_amount), balanceAmount: Number(r.balance_amount), openAmount: fromMinor(Math.max(0, openTuition(r))),
            creditApplied: Number(r.credit_applied), adjustable: ids.has(r.invoice_id),
        })),
        history: history.map(h => ({
            id: h.audit_id, action: h.action, oldValue: h.old_value, newValue: h.new_value, reason: h.reason, createdAt: h.created_at,
            invoiceNumber: h.invoice_number, designation: h.designation, actorName: h.actor,
        })),
    };
}

export interface ScheduleAdjustment extends DurationOverride {
    installments: Array<{ invoiceId: string | null; dueDate: string; amount: number }>;
    frequency: Frequency | null;
    reason: string;
}

export function parseScheduleAdjustment(body: Record<string, unknown>): ScheduleAdjustment {
    const rows = Array.isArray(body.installments) ? body.installments as Array<Record<string, unknown>> : [];
    if (rows.length === 0 || rows.length > MAX_INSTALLMENTS) throw billingError('invalid', `Enter between 1 and ${MAX_INSTALLMENTS} installments.`);
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 3) throw billingError('invalid', 'Enter the reason for this adjustment.');
    const frequency = body.frequency ? body.frequency as Frequency : null;
    if (frequency && !['monthly', 'every_2_months', 'quarterly', 'half_yearly', 'custom'].includes(frequency)) throw billingError('invalid', 'Unknown installment frequency.');
    return {
        installments: rows.map((r, i) => ({
            invoiceId: r.invoiceId ? String(r.invoiceId) : null,
            dueDate: parseDate(r.dueDate, `Due date of installment ${i + 1}`),
            amount: parseAmount(r.amount, `Amount of installment ${i + 1}`),
        })),
        frequency, reason: reason.slice(0, 500), allowBeyondDuration: body.allowBeyondDuration === true,
        beyondDurationReason: body.beyondDurationReason ? String(body.beyondDurationReason).trim().slice(0, 500) || null : null,
    };
}

/** Replaces the adjustable installments. Must run inside a transaction. */
export async function adjustSchedule(tx: Queryable, params: { tenantId: string; enrollmentId: string; actorId: string; input: ScheduleAdjustment }) {
    const { tenantId, actorId, input } = params;
    const enrollment = await getEnrollment(tx, tenantId, params.enrollmentId);
    const student = await lockStudent(tx, tenantId, enrollment.studentId);
    const period: CoursePeriod = await getEnrollmentPeriod(tx, tenantId, enrollment.enrollmentId);
    const loaded = await load(tx, tenantId, enrollment, period.today, true);
    if (loaded.adjustable.length === 0) throw billingError('conflict', 'There are no unpaid future installments to adjust.');

    const byId = new Map(loaded.adjustable.map(r => [r.invoice_id, r]));
    const used = new Set<string>();
    for (const item of input.installments) {
        if (item.invoiceId) {
            if (!byId.has(item.invoiceId)) throw billingError('conflict', 'An installment in this schedule was paid or changed meanwhile. Reload and try again.');
            if (used.has(item.invoiceId)) throw billingError('invalid', 'An installment is listed twice.');
            used.add(item.invoiceId);
        }
        const paid = item.invoiceId ? toMinor(byId.get(item.invoiceId)!.paid_amount) : 0;
        if (item.amount === 0 && paid === 0) throw billingError('invalid', 'Every installment amount must be greater than zero.');
    }
    const total = input.installments.reduce((t, i) => t + toMinor(i.amount), 0);
    const expected = loaded.adjustable.reduce((t, r) => t + openTuition(r), 0);
    if (total !== expected) {
        throw billingError('invalid', `The installments add up to ${fromMinor(total).toFixed(2)} but ${fromMinor(expected).toFixed(2)} is still to be collected.`);
    }
    const dated = input.installments.filter(i => i.amount > 0);
    for (const [i, item] of dated.entries()) {
        if (item.dueDate < period.today) throw billingError('invalid', 'Due dates cannot be in the past.');
        if (i > 0 && item.dueDate <= dated[i - 1].dueDate) throw billingError('invalid', 'Due dates must be in order, each later than the one before.');
    }
    assertWithinPeriod(period, dated.at(-1)!.dueDate, input);
    const removed = loaded.adjustable.filter(r => !used.has(r.invoice_id));
    if (removed.some(r => toMinor(r.paid_amount) > 0)) throw billingError('invalid', 'A partially paid installment cannot be removed; set its remaining amount to zero instead.');

    const planId = loaded.plan?.id ?? await adoptPlan(tx, { tenantId, actorId, enrollment, rows: loaded.rows, frequency: input.frequency });

    // Existing numbers are reused in order, new installments are numbered after the last one
    const numbers = loaded.adjustable.filter(r => used.has(r.invoice_id)).map(r => r.position ?? 0);
    let last = Math.max(0, ...loaded.rows.map(r => r.position ?? 0));
    const freeNumbers = input.installments.map((_, i) => numbers[i] ?? ++last);
    const created = input.installments.filter(i => !i.invoiceId).length;
    const invoiceNumbers = created > 0 ? await nextInvoiceNumbers(tx, tenantId, created) : [];

    const results: Array<{ invoiceId: string; installmentNumber: number; dueDate: string; amount: number }> = [];
    for (const [i, item] of input.installments.entries()) {
        const number = freeNumbers[i];
        const row = item.invoiceId ? byId.get(item.invoiceId)! : null;
        if (row) {
            const delta = toMinor(item.amount) - openTuition(row);
            const changedDate = item.amount > 0 && item.dueDate !== row.due_date;
            await tx.query(
                `UPDATE billing.invoices
                 SET subtotal_amount = subtotal_amount + $1::numeric, total_amount = total_amount + $1::numeric, balance_amount = balance_amount + $1::numeric,
                     due_date = $2::date, billing_period = $3, installment_number = $4, enrollment_plan_id = $5,
                     status = CASE WHEN balance_amount + $1::numeric = 0 THEN 'paid' WHEN paid_amount > 0 THEN 'partially_paid' ELSE 'pending' END,
                     overdue_status = CASE WHEN balance_amount + $1::numeric = 0 THEN 'paid' WHEN $6::boolean THEN 'upcoming' ELSE overdue_status END,
                     days_overdue = CASE WHEN $6::boolean THEN 0 ELSE days_overdue END, updated_at = clock_timestamp()
                 WHERE invoice_id = $7 AND tenant_id = $8`,
                [fromMinor(delta), changedDate ? item.dueDate : row.due_date, changedDate ? periodLabel(item.dueDate) : periodLabel(row.due_date), number, planId,
                    changedDate, row.invoice_id, tenantId]);
            if (delta !== 0) await addItem(tx, tenantId, row.invoice_id, fromMinor(delta), input.reason);
            if (delta !== 0 || changedDate) {
                await addHistory(tx, { tenantId, actorId, invoiceId: row.invoice_id, action: 'schedule_adjusted', reason: input.reason,
                    old: { amount: Number(row.total_amount), dueDate: row.due_date },
                    now: { amount: fromMinor(toMinor(row.total_amount) + delta), dueDate: changedDate ? item.dueDate : row.due_date } });
            }
            results.push({ invoiceId: row.invoice_id, installmentNumber: number, dueDate: item.dueDate, amount: item.amount });
        } else {
            const [invoice] = await tx.query<{ invoice_id: string }>(
                `INSERT INTO billing.invoices (tenant_id, invoice_number, student_id, enrollment_id, enrollment_plan_id, installment_number, billing_period,
                     subtotal_amount, total_amount, paid_amount, balance_amount, due_date, status, overdue_status, designation, original_amount)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 0, $8, $9::date, 'pending', 'upcoming', $10, 0) RETURNING invoice_id`,
                [tenantId, invoiceNumbers.shift(), enrollment.studentId, enrollment.enrollmentId, planId, number, periodLabel(item.dueDate), item.amount,
                    item.dueDate, `Installment ${number}: ${enrollment.courseTitle.trim()} Tuition`]);
            await addItem(tx, tenantId, invoice.invoice_id, item.amount, input.reason);
            await addHistory(tx, { tenantId, actorId, invoiceId: invoice.invoice_id, action: 'schedule_added', reason: input.reason, old: {}, now: { amount: item.amount, dueDate: item.dueDate } });
            results.push({ invoiceId: invoice.invoice_id, installmentNumber: number, dueDate: item.dueDate, amount: item.amount });
        }
    }

    // Removed installments become void; credit recorded on them moves to the first remaining one so none is lost
    for (const row of removed) {
        const discount = toMinor(row.discount_amount);
        if (discount > 0) {
            await tx.query(
                `UPDATE billing.invoices SET subtotal_amount = subtotal_amount + $1::numeric, discount_amount = discount_amount + $1::numeric,
                        credit_applied = credit_applied + $2::numeric WHERE invoice_id = $3 AND tenant_id = $4`,
                [fromMinor(discount), Number(row.credit_applied), results[0].invoiceId, tenantId]);
        }
        await tx.query(
            `UPDATE billing.invoices SET status = 'void', overdue_status = 'cancelled', subtotal_amount = 0, discount_amount = 0, credit_applied = 0,
                    total_amount = 0, balance_amount = 0, enrollment_plan_id = $1, updated_at = clock_timestamp()
             WHERE invoice_id = $2 AND tenant_id = $3`, [planId, row.invoice_id, tenantId]);
        await addItem(tx, tenantId, row.invoice_id, -Number(row.total_amount), input.reason);
        await addHistory(tx, { tenantId, actorId, invoiceId: row.invoice_id, action: 'schedule_removed', reason: input.reason,
            old: { amount: Number(row.total_amount), dueDate: row.due_date }, now: { amount: 0 } });
    }
    await tx.query(
        `UPDATE billing.enrollment_fee_plans
         SET installment_count = (SELECT COUNT(*) FROM billing.invoices WHERE enrollment_plan_id = $1 AND status <> 'void'),
             payment_mode = CASE WHEN (SELECT COUNT(*) FROM billing.invoices WHERE enrollment_plan_id = $1 AND status <> 'void') > 1 THEN 'installment' ELSE payment_mode END,
             frequency = COALESCE($2, frequency)
         WHERE enrollment_plan_id = $1`, [planId, input.frequency]);
    await writeAudit(tx, {
        tenantId, actorId, action: 'billing.schedule_adjusted', entityType: 'enrollment', entityId: enrollment.enrollmentId,
        details: {
            studentId: enrollment.studentId, student: student.fullName, course: enrollment.courseTitle, reason: input.reason, frequency: input.frequency,
            amount: fromMinor(total), installments: results, removed: removed.map(r => r.invoice_number), review: loaded.isReview,
            beyondDurationReason: input.allowBeyondDuration ? input.beyondDurationReason : null,
        },
    });
    return { adjusted: results, removed: removed.length };
}

/** Registration schedules had no fee plan record; the first adjustment gives them one, with unchanged amounts. */
async function adoptPlan(tx: Queryable, params: { tenantId: string; actorId: string; enrollment: EnrollmentInfo; rows: Row[]; frequency: Frequency | null }): Promise<string> {
    const { rows, enrollment } = params;
    const payable = rows.reduce((t, r) => t + toMinor(r.total_amount), 0);
    const credit = rows.reduce((t, r) => t + toMinor(r.credit_applied), 0);
    const fee = fromMinor(payable + credit);
    const [plan] = await tx.query<{ enrollment_plan_id: string }>(
        `INSERT INTO billing.enrollment_fee_plans (tenant_id, student_id, enrollment_id, payment_mode, frequency, installment_count, course_fee, net_fee,
             credit_applied, payable_amount, status, created_by_actor_id)
         VALUES ($1, $2, $3, 'installment', $4, $5, $6, $6, $7, $8, $9, $10) RETURNING enrollment_plan_id`,
        [params.tenantId, enrollment.studentId, enrollment.enrollmentId, params.frequency ?? 'custom', rows.length, fee, fromMinor(credit), fromMinor(payable),
            ACTIVE_ENROLLMENT.includes(enrollment.status) ? 'active' : 'closed', params.actorId]);
    for (const [i, r] of rows.entries()) {
        r.position ??= i + 1;
        await tx.query(`UPDATE billing.invoices SET enrollment_plan_id = $1, installment_number = $2 WHERE invoice_id = $3`, [plan.enrollment_plan_id, r.position, r.invoice_id]);
    }
    return plan.enrollment_plan_id;
}

async function addItem(tx: Queryable, tenantId: string, invoiceId: string, amount: number, reason: string) {
    await tx.query(
        `INSERT INTO billing.invoice_items (tenant_id, invoice_id, item_type, description, amount) VALUES ($1, $2, 'schedule_adjustment', $3, $4)`,
        [tenantId, invoiceId, `Schedule adjusted: ${reason}`.slice(0, 250), amount]);
}

async function addHistory(tx: Queryable, h: { tenantId: string; actorId: string; invoiceId: string; action: string; reason: string; old: unknown; now: unknown }) {
    await tx.query(
        `INSERT INTO billing.fee_audit (tenant_id, invoice_id, action, old_value, new_value, user_id, reason) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [h.tenantId, h.invoiceId, h.action, JSON.stringify(h.old), JSON.stringify(h.now), h.actorId, h.reason]);
}
