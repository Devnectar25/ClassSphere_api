import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { resolveRequestContext } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * POST /api/v1/billing/overdue/recalculate
 * Secret-protected endpoint for Vercel Cron (or manual trigger by Admin/Finance)
 * Recalculates days overdue, overdue status, applies late fees according to active rules,
 * and publishes parent engagement reminder notices.
 */
export async function POST(req: NextRequest) {
    const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();
    const correlated = { correlationId };
    const authHeader = req.headers.get('authorization') || '';
    const cronHeader = req.headers.get('x-cron-secret');
    const configuredSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET || 'classsphere_cron_secret';

    const isCronAuthorized =
        (cronHeader && cronHeader === configuredSecret) ||
        (authHeader.startsWith('Bearer ') && authHeader.slice(7) === configuredSecret);

    if (isCronAuthorized) {
        // Vercel Cron triggers recalculation across all active tenants
        try {
            const result = await callFn(
                'billing.fn_invoice_overdue_recalculate',
                null,
                null
            );
            return ok(correlated, result);
        } catch (err) {
            return fail(err, correlated, req);
        }
    }

    // Otherwise, require authenticated admin or finance user
    const context = resolveRequestContext(req);
    if (!context) {
        return problem(
            correlated,
            req,
            401,
            'Unauthorized',
            'Provide CRON_SECRET or an authenticated admin/finance token.'
        );
    }

    const allowedRoles = ['PlatformAdmin', 'TenantAdmin', 'Finance'];
    if (!context.isPlatformAdmin && !allowedRoles.includes(context.actorRole)) {
        return problem(
            context,
            req,
            403,
            'Forbidden',
            'Only academy administrators and finance officers can trigger fee recalculation.'
        );
    }

    try {
        const result = await callFn(
            'billing.fn_invoice_overdue_recalculate',
            context.tenantId,
            context.actorId
        );
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
