import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * POST /api/v1/billing/invoices/waive-late-fee
 * Waive late fee for a specific invoice (reason is required)
 * RBAC: Admin and Finance only
 */
export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;

    const allowedRoles = ['PlatformAdmin', 'TenantAdmin', 'Finance'];
    if (!context.isPlatformAdmin && !allowedRoles.includes(context.actorRole)) {
        return problem(
            context,
            req,
            403,
            'Forbidden',
            'Only academy administrators and finance officers can waive late fees.'
        );
    }

    try {
        const body = await req.json();
        const invoiceId = body.invoiceId || body.invoice_id;
        const reason = body.reason?.trim();

        if (!invoiceId) {
            return problem(context, req, 400, 'Validation Error', 'invoiceId is required.');
        }

        if (!reason) {
            return problem(
                context,
                req,
                400,
                'Validation Error',
                'A valid reason is required to waive a late fee.'
            );
        }

        const result = await callFn(
            'billing.fn_invoice_late_fee_waive',
            context.tenantId,
            invoiceId,
            reason,
            context.actorId
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
