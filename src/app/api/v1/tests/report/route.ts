import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope } from '@/lib/api/scope';

/**
 * Test report card: marks per student and subject with totals, percentage, grade and rank
 */
type Report = { test: { batchId: string } } | null;

export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        const report = await callFn<Report>('academics.fn_test_report', context.tenantId, req.nextUrl.searchParams.get('testId'));
        if (!report || !(await batchInScope(context, report.test.batchId))) {
            return problem(context, req, 404, 'Not Found', 'Test not found.');
        }
        return ok(context, report);
    } catch (err) {
        return fail(err, context, req);
    }
}

/** Saves marks: [{ studentId, subjectId, marks, absent, remarks }] */
export async function PUT(req: NextRequest) {
    const context = authorize(req, 'tests.write');
    if (context instanceof Response) return context;
    try {
        const { testId, results } = await req.json();
        if (!testId || !Array.isArray(results)) {
            return problem(context, req, 400, 'Validation Error', 'testId and results are required.');
        }
        const report = await callFn<Report>('academics.fn_test_report', context.tenantId, testId);
        if (!report || !(await batchInScope(context, report.test.batchId))) {
            return problem(context, req, 404, 'Not Found', 'Test not found.');
        }
        return ok(context, await callFn('academics.fn_test_results_save', context.tenantId, testId, JSON.stringify(results), context.actorId));
    } catch (err) {
        return fail(err, context, req);
    }
}
