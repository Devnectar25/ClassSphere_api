import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db/db';
import { authorize, type RequestContext } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { requireAssignedBatch } from '@/lib/api/scope';
import { billingError, getEnrollment } from '@/lib/billing/credit-ledger';
import { adjustSchedule, getSchedule, parseScheduleAdjustment } from '@/lib/billing/schedule-adjust';

/** Installment schedule of a course enrollment: original and updated, history, and authorized adjustments. */
async function requireEnrollment(context: RequestContext, enrollmentId: string | null) {
    if (!enrollmentId) throw billingError('invalid', 'enrollmentId is required.');
    const enrollment = await getEnrollment({ query }, context.tenantId, enrollmentId);
    if (context.branchId && enrollment.branchId && enrollment.branchId !== context.branchId) throw billingError('forbidden', 'This enrollment belongs to another branch.');
    await requireAssignedBatch(context, enrollment.batchId);
    return enrollment;
}

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'billing.read');
    if (context instanceof Response) return context;
    try {
        const enrollment = await requireEnrollment(context, req.nextUrl.searchParams.get('enrollmentId'));
        return ok(context, await getSchedule({ query }, context.tenantId, enrollment.enrollmentId));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'billing.write');
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        if (body.action !== 'adjust') return problem(context, req, 400, 'Validation Error', `Unrecognized action '${body.action}'.`);
        const enrollment = await requireEnrollment(context, body.enrollmentId ? String(body.enrollmentId) : null);
        const input = parseScheduleAdjustment(body);
        await withTransaction(tx => adjustSchedule(tx, { tenantId: context.tenantId, enrollmentId: enrollment.enrollmentId, actorId: context.actorId, input }));
        return ok(context, await getSchedule({ query }, context.tenantId, enrollment.enrollmentId));
    } catch (err) {
        return fail(err, context, req);
    }
}
