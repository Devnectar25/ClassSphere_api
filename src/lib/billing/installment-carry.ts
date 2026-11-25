/**
 * Underpaid installment: the unpaid part is added equally to the remaining installments of the same schedule.
 * Example: 3 × 2000, the first is paid 1000 → the first has nothing left to collect and the others become 2500 each.
 *
 * Only what is scheduled moves; the course fee, credit and payments stay the same. Late fees stay on their own
 * installment, and the last installment keeps its balance because there is nothing left to move it to.
 * Paying such an installment again takes the paid part back out of the later ones, so several partial payments work.
 */
import { fromMinor, toMinor, writeAudit, type Queryable } from '@/lib/billing/credit-ledger';

interface ScheduleRow {
    invoice_id: string; invoice_number: string; designation: string; student_id: string;
    total_amount: string; paid_amount: string; balance_amount: string; late_fee_amount: string | null; position: number | null;
    pending: string; carried_out: string; carried_in: string;
}

export interface CarryForwardResult { amount: number; installments: Array<{ invoiceId: string; invoiceNumber: string; added: number; balance: number }> }

/** Installments of one schedule: the same fee plan, or (registration schedules) the same "Installment n of N" series. */
async function loadSeries(tx: Queryable, tenantId: string, invoiceId: string): Promise<ScheduleRow[]> {
    return await tx.query<ScheduleRow>(
        `SELECT i.invoice_id, i.invoice_number, i.designation, i.student_id, i.total_amount::text, i.paid_amount::text, i.balance_amount::text,
                i.late_fee_amount::text,
                COALESCE(i.installment_number, substring(i.designation from '^Installment ([0-9]+) of')::int) AS position,
                (SELECT COALESCE(SUM(p.amount), 0) FROM billing.payments p
                 WHERE p.invoice_id = i.invoice_id AND p.status = 'verification_pending')::text AS pending,
                (SELECT COALESCE(SUM(CASE WHEN (item_type = 'carry_forward' AND amount < 0) OR (item_type = 'carry_restored' AND amount > 0) THEN -amount END), 0)
                 FROM billing.invoice_items it WHERE it.invoice_id = i.invoice_id)::text AS carried_out,
                (SELECT COALESCE(SUM(CASE WHEN (item_type = 'carry_forward' AND amount > 0) OR (item_type = 'carry_restored' AND amount < 0) THEN amount END), 0)
                 FROM billing.invoice_items it WHERE it.invoice_id = i.invoice_id)::text AS carried_in
         FROM billing.invoices i
         JOIN billing.invoices t ON t.invoice_id = $2 AND t.tenant_id = i.tenant_id AND t.student_id = i.student_id
         WHERE i.tenant_id = $1 AND i.status NOT IN ('void', 'cancelled', 'waived') AND i.waived_at IS NULL
           AND i.enrollment_id IS NOT DISTINCT FROM t.enrollment_id
           AND CASE WHEN t.enrollment_plan_id IS NOT NULL THEN i.enrollment_plan_id = t.enrollment_plan_id
                    ELSE i.enrollment_plan_id IS NULL AND t.designation ~ '^Installment [0-9]+ of [0-9]+'
                         AND regexp_replace(i.designation, '^Installment [0-9]+ of', '') = regexp_replace(t.designation, '^Installment [0-9]+ of', '')
                         AND i.designation ~ '^Installment [0-9]+ of [0-9]+' END
         ORDER BY position, i.due_date FOR UPDATE OF i`,
        [tenantId, invoiceId]);
}

/** Must run inside the transaction that recorded the payment. Returns null when nothing had to move. */
export async function carryForwardShortfall(tx: Queryable, params: { tenantId: string; invoiceId: string; actorId: string }): Promise<CarryForwardResult | null> {
    const rows = await loadSeries(tx, params.tenantId, params.invoiceId);
    const target = rows.find(r => r.invoice_id === params.invoiceId);
    if (!target || target.position === null || toMinor(target.paid_amount) <= 0 || toMinor(target.balance_amount) <= 0) return null;
    // Money already declared for this installment is decided first
    if (toMinor(target.pending) > 0) return null;

    const unpaidLateFee = Math.max(0, toMinor(target.late_fee_amount) - toMinor(target.paid_amount));
    const shortfall = toMinor(target.balance_amount) - unpaidLateFee;
    const later = rows.filter(r => r.position !== null && r.position > target.position! && toMinor(r.balance_amount) > 0);
    if (shortfall <= 0 || later.length === 0) return null;

    const amount = fromMinor(shortfall);
    await changeScheduled(tx, params, target, -amount, 'carry_forward', `Unpaid balance moved to the next ${later.length} installment(s)`);
    const base = Math.floor(shortfall / later.length);
    const installments: CarryForwardResult['installments'] = [];
    for (const [i, inv] of later.entries()) {
        const share = i === later.length - 1 ? shortfall - base * (later.length - 1) : base;
        if (share === 0) continue;
        const added = fromMinor(share);
        await changeScheduled(tx, params, inv, added, 'carry_forward', `Balance carried from installment ${target.position}`);
        installments.push({ invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number, added, balance: fromMinor(toMinor(inv.balance_amount) + share) });
    }
    await writeAudit(tx, {
        tenantId: params.tenantId, actorId: params.actorId, action: 'billing.installment_carried_forward', entityType: 'invoice', entityId: target.invoice_id,
        details: { studentId: target.student_id, invoiceNumber: target.invoice_number, amount, installments },
    });
    return { amount, installments };
}

function restorable(rows: ScheduleRow[], invoiceId: string) {
    const target = rows.find(r => r.invoice_id === invoiceId);
    if (!target || target.position === null) return null;
    const sources = rows
        .filter(r => r.position !== null && r.position > target.position! && toMinor(r.pending) === 0)
        .map(row => ({ row, available: Math.max(0, Math.min(toMinor(row.carried_in), toMinor(row.balance_amount), toMinor(row.total_amount) - toMinor(row.paid_amount))) }))
        .filter(s => s.available > 0);
    const limit = Math.min(toMinor(target.carried_out), sources.reduce((sum, s) => sum + s.available, 0));
    return { target, sources, limit: Math.max(0, limit) };
}

/** Part of an installment that was carried forward and can still be paid on the installment itself. */
export async function getRestorableAmount(tx: Queryable, tenantId: string, invoiceId: string): Promise<number> {
    const found = restorable(await loadSeries(tx, tenantId, invoiceId), invoiceId);
    return found ? fromMinor(Math.max(0, found.limit - toMinor(found.target.pending))) : 0;
}

/** Takes up to \`amount\` of a carried balance back out of the later installments, equally. Returns what was restored. */
export async function restoreCarriedBalance(tx: Queryable, params: { tenantId: string; invoiceId: string; amount: number; actorId: string }): Promise<number> {
    const found = restorable(await loadSeries(tx, params.tenantId, params.invoiceId), params.invoiceId);
    if (!found) return 0;
    const total = Math.min(toMinor(params.amount), found.limit);
    if (total <= 0) return 0;

    const taken = new Map<string, number>();
    let remaining = total;
    for (const [i, s] of found.sources.entries()) {
        const share = Math.min(s.available, Math.floor(remaining / (found.sources.length - i)));
        taken.set(s.row.invoice_id, share);
        remaining -= share;
    }
    for (const s of found.sources) {
        const extra = Math.min(remaining, s.available - taken.get(s.row.invoice_id)!);
        taken.set(s.row.invoice_id, taken.get(s.row.invoice_id)! + extra);
        remaining -= extra;
    }
    const position = found.target.position;
    for (const s of found.sources) {
        const share = fromMinor(taken.get(s.row.invoice_id)!);
        if (share > 0) await changeScheduled(tx, params, s.row, -share, 'carry_restored', `Carried balance paid on installment ${position}`);
    }
    await changeScheduled(tx, params, found.target, fromMinor(total), 'carry_restored', 'Carried balance paid on this installment');
    return fromMinor(total);
}

async function changeScheduled(
    tx: Queryable, params: { tenantId: string; actorId: string }, inv: ScheduleRow, change: number, itemType: 'carry_forward' | 'carry_restored', description: string,
) {
    await tx.query(
        `UPDATE billing.invoices
         SET subtotal_amount = subtotal_amount + $1::numeric, total_amount = total_amount + $1::numeric, balance_amount = balance_amount + $1::numeric,
             status = CASE WHEN balance_amount + $1::numeric = 0 THEN 'paid' WHEN paid_amount > 0 THEN 'partially_paid' ELSE 'pending' END,
             overdue_status = CASE WHEN balance_amount + $1::numeric = 0 THEN 'paid' WHEN overdue_status = 'paid' THEN 'upcoming' ELSE overdue_status END,
             updated_at = clock_timestamp()
         WHERE invoice_id = $2 AND tenant_id = $3`,
        [change, inv.invoice_id, params.tenantId]);
    await tx.query(
        `INSERT INTO billing.invoice_items (tenant_id, invoice_id, item_type, description, amount) VALUES ($1, $2, $3, $4, $5)`,
        [params.tenantId, inv.invoice_id, itemType, description, change]);
    await tx.query(
        `INSERT INTO billing.fee_audit (tenant_id, invoice_id, action, old_value, new_value, user_id, reason)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [params.tenantId, inv.invoice_id, `installment_${itemType}`,
            JSON.stringify({ amount: Number(inv.total_amount), balance: Number(inv.balance_amount) }),
            JSON.stringify({ amount: fromMinor(toMinor(inv.total_amount) + toMinor(change)), balance: fromMinor(toMinor(inv.balance_amount) + toMinor(change)) }),
            params.actorId, description]);
}
