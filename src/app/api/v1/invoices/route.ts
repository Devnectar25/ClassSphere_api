import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { invoiceIdsInScope } from '@/lib/api/scope';

/**
 * Invoices Ledger & Billing Cycle API
 * Traceability: TDD Section 10.4-10.5, 14; PLT-003, PLT-006, DECISION-008
 */
interface StaffInvoice {
    invoiceId: string; status: string; totalAmount: number; paidAmount: number; balanceAmount: number; lateFeeAmount: number | null; createdAt: string; dueDate: string;
}

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        const [ledger, aging] = await Promise.all([
            callFn<Record<string, unknown>>('billing.fn_invoice_list', context.tenantId, context.branchId),
            callFn('reporting.fn_fee_aging', context.tenantId, context.branchId),
        ]);
        const allowed = await invoiceIdsInScope(context);
        if (!allowed) return ok(context, { ...ledger, aging });

        // Staff: the same figures over the invoices of their own batches
        const invoices = (ledger.invoices as StaffInvoice[]).filter(i => allowed.has(i.invoiceId));
        const open = invoices.filter(i => i.status !== 'void');
        const total = (list: StaffInvoice[], key: 'totalAmount' | 'paidAmount' | 'balanceAmount' | 'lateFeeAmount') =>
            Math.round(list.reduce((sum, i) => sum + Math.round(Number(i[key] ?? 0) * 100), 0)) / 100;
        const month = new Date().toISOString().slice(0, 7);
        const thisMonth = open.filter(i => String(i.createdAt).slice(0, 7) === month);
        const due = invoices.filter(i => i.status === 'pending' || i.status === 'overdue');
        const overdue = invoices.filter(i => i.status === 'overdue');
        const summary = {
            billedThisMonth: total(thisMonth, 'totalAmount'), billedThisMonthCount: thisMonth.length, billedTotal: total(open, 'totalAmount'), collectedTotal: total(open, 'paidAmount'),
            outstandingAmount: total(due, 'balanceAmount'), outstandingCount: due.length, overdueAmount: total(overdue, 'balanceAmount'), overdueCount: overdue.length,
            lateFeesTotal: total(open, 'lateFeeAmount'),
        };
        const today = Date.parse(new Date().toISOString().slice(0, 10));
        const unpaid = open.filter(i => Number(i.balanceAmount) > 0);
        const age = (i: StaffInvoice) => Math.round((today - Date.parse(String(i.dueDate).slice(0, 10))) / 86400000);
        const bucket = { current: unpaid.filter(i => age(i) <= 0), days1To30: unpaid.filter(i => age(i) >= 1 && age(i) <= 30), days31To60: unpaid.filter(i => age(i) >= 31 && age(i) <= 60), days61Plus: unpaid.filter(i => age(i) > 60) };
        const each = <T>(pick: (list: StaffInvoice[]) => T) => Object.fromEntries(Object.entries(bucket).map(([k, list]) => [k, pick(list)]));
        return ok(context, {
            ...ledger, invoices, summary,
            aging: {
                ...each(list => total(list, 'balanceAmount')), totalOutstanding: total(unpaid, 'balanceAmount'), counts: each(list => list.length),
                overdueInvoices: (aging as { overdueInvoices?: Array<{ invoiceId: string }> }).overdueInvoices?.filter(i => allowed.has(i.invoiceId)) ?? [],
            },
        });
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    if (!context.idempotencyKey) {
        return problem(context, req, 400, 'Idempotency Key Required',
            'Invoice cycle generation requires an Idempotency-Key header.');
    }

    try {
        const { cycleDate } = await req.json();
        const result = await callFn('billing.fn_invoice_generate_cycle',
            context.tenantId, cycleDate || new Date().toISOString().split('T')[0], context.actorId, context.idempotencyKey);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
