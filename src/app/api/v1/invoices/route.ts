import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Invoices Ledger & Billing Cycle API
 * Traceability: TDD Section 10.4-10.5, 14; PLT-003, PLT-006, DECISION-008
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        const [ledger, aging] = await Promise.all([
            callFn<Record<string, unknown>>('billing.fn_invoice_list', context.tenantId, context.branchId),
            callFn('reporting.fn_fee_aging', context.tenantId, context.branchId),
        ]);
        return ok(context, { ...ledger, aging });
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'billing.write');
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
