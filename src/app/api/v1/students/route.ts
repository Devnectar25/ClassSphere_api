import { NextRequest, NextResponse } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Students Directory & Enrollment API — branch-scoped
 * Traceability: TDD Section 10.4, PLT-003, PLT-006
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'students.read');
    if (context instanceof Response) return context;
    const searchParams = req.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    try {
        const result = await callFn<{ total: number }>('academics.fn_student_search',
            context.tenantId, context.branchId, searchParams.get('q') || null, searchParams.get('status') || null, limit, offset);
        const res = ok(context, result) as NextResponse;
        res.headers.set('X-Total-Count', String(result.total));
        return res;
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'students.write');
    if (context instanceof Response) return context;

    try {
        // Entitlement limit check (PLT-005, PLT-006)
        const check = await callFn<{ allowed: boolean; maximum: number; planTier: string }>(
            'tenant.fn_entitlement_check', context.tenantId, 'seats');
        if (!check.allowed) {
            return problem(context, req, 402, 'Subscription Entitlement Exceeded',
                `Seat limit of ${check.maximum} reached for ${check.planTier} tier. Upgrade subscription to enroll more students.`);
        }

        const { firstName, lastName, email, phone, dateOfBirth, matriculationYear, academicStanding, batchId, branchId } = await req.json();

        if (!firstName || !lastName || !email) {
            return problem(context, req, 400, 'Validation Error', 'firstName, lastName, and email are required fields.');
        }

        // Branch-scoped users always enroll into their own branch
        const result = await callFn('academics.fn_student_create',
            context.tenantId, firstName, lastName, email, phone || null, dateOfBirth || null, null,
            matriculationYear || null, academicStanding || null, batchId || null,
            context.branchId ?? branchId ?? null, context.actorId);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
