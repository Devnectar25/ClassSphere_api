import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope } from '@/lib/api/scope';

/**
 * Tests: schedule tests for a batch across course subjects — branch-scoped
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        return ok(context, await callFn('academics.fn_test_list', context.tenantId, context.branchId));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorize(req, 'tests.write');
    if (context instanceof Response) return context;
    try {
        const { batchId, title, testType, testDate, subjects } = await req.json();
        if (!batchId || !title || !testDate || !Array.isArray(subjects)) {
            return problem(context, req, 400, 'Validation Error', 'batchId, title, testDate and subjects are required.');
        }
        if (!(await batchInScope(context, batchId))) {
            return problem(context, req, 403, 'Forbidden', 'This batch belongs to another branch.');
        }
        const result = await callFn('academics.fn_test_schedule',
            context.tenantId, batchId, title, testType || null, testDate, JSON.stringify(subjects), context.actorId);
        return ok(context, result, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}
