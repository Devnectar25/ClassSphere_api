import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Payments & Receipts API
 * Traceability: TDD Section 14, 19; PLT-012, DECISION-008
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('billing.fn_payment_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'billing.write');
    if (context instanceof Response) return context;

    try {
        const { invoiceId, amount, paymentMethod, gatewayOrderId, gatewayPaymentId } = await req.json();

        if (!invoiceId || !amount) {
            return problem(context, req, 400, 'Validation Error', 'invoiceId and amount are required fields.');
        }

        const result = await callFn('billing.fn_payment_post',
            context.tenantId, invoiceId, Number(amount), paymentMethod || 'Cash',
            gatewayOrderId || null, gatewayPaymentId || null, context.idempotencyKey || null, context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
