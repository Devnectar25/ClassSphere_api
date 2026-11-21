import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope } from '@/lib/api/scope';

/**
 * Attendance Log, Daily Roll Call & Student Attendance API
 * Traceability: TDD Section 10.4, PLT-006
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    const params = req.nextUrl.searchParams;
    const batchId = params.get('batchId');
    const from = params.get('from');
    const to = params.get('to');
    const studentId = params.get('studentId');
    const date = params.get('date');

    // Case 1: Particular student's daily attendance history and statistics
    if (studentId) {
        try {
            const data = await callFn('academics.fn_student_attendance_get',
                context.tenantId, studentId, from || null, to || null);
            return ok(context, data);
        } catch (err) {
            return fail(err, context, req);
        }
    }

    // Case 2: Daily roll call for a batch on a specific session date
    if (batchId && date) {
        try {
            const data = await callFn('academics.fn_attendance_daily_get',
                context.tenantId, batchId, date);
            return ok(context, data);
        } catch (err) {
            return fail(err, context, req);
        }
    }

    // Case 3: Batch register grid over date range
    if (!batchId || !from || !to) {
        return problem(context, req, 400, 'Validation Error', 'batchId, from, and to (or studentId, or batchId and date) query parameters are required.');
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
        const body = await req.json();
        const { batchId, sessionDate, records, studentId, status, remarks } = body;

        let effectiveRecords = records;
        if (!effectiveRecords && studentId) {
            effectiveRecords = [{ studentId, status: status || 'present', remarks: remarks || null }];
        }

        if (!batchId || !sessionDate || !Array.isArray(effectiveRecords)) {
            return problem(context, req, 400, 'Validation Error', 'batchId, sessionDate, and records (or studentId) are required.');
        }
        if (!(await batchInScope(context, batchId))) {
            return problem(context, req, 403, 'Forbidden', 'This batch belongs to another branch.');
        }

        const result = await callFn('academics.fn_attendance_mark_batch',
            context.tenantId, batchId, sessionDate, JSON.stringify(effectiveRecords), context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function DELETE(req: NextRequest) {
    const context = authorize(req, 'attendance.write');
    if (context instanceof Response) return context;

    try {
        const params = req.nextUrl.searchParams;
        const studentId = params.get('studentId');
        const sessionDate = params.get('sessionDate');

        if (!studentId || !sessionDate) {
            return problem(context, req, 400, 'Validation Error', 'studentId and sessionDate are required.');
        }

        const result = await callFn('academics.fn_attendance_delete_record',
            context.tenantId, studentId, sessionDate, context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
