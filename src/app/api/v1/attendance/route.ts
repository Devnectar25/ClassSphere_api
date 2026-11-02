import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope } from '@/lib/api/scope';

/**
 * Attendance Log & Batch Roll Call API
 * Traceability: TDD Section 10.4, PLT-006
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    const params = req.nextUrl.searchParams;
    const batchId = params.get('batchId');
    const from = params.get('from');
    const to = params.get('to');

    if (!batchId || !from || !to) {
        return problem(context, req, 400, 'Validation Error', 'batchId, from, and to query parameters are required.');
    }

    try {
        return ok(context, await callFn('academics.fn_attendance_register', context.tenantId, batchId, from, to));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'attendance.write');
    if (context instanceof Response) return context;

    try {
        const { batchId, sessionDate, records } = await req.json();

        if (!batchId || !sessionDate || !Array.isArray(records)) {
            return problem(context, req, 400, 'Validation Error', 'batchId, sessionDate, and records array are required.');
        }
        if (!(await batchInScope(context, batchId))) {
            return problem(context, req, 403, 'Forbidden', 'This batch belongs to another branch.');
        }

        const result = await callFn('academics.fn_attendance_mark_batch',
            context.tenantId, batchId, sessionDate, JSON.stringify(records), context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
