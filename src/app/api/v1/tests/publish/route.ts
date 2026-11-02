import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope } from '@/lib/api/scope';

/** Publishes a test's results to the parent portal. */
export async function POST(req: NextRequest) {
    const context = authorize(req, 'tests.write');
    if (context instanceof Response) return context;
    try {
        const { testId } = await req.json();
        const report = await callFn<{ test: { batchId: string } } | null>('academics.fn_test_report', context.tenantId, testId ?? null);
        if (!report || !(await batchInScope(context, report.test.batchId))) {
            return problem(context, req, 404, 'Not Found', 'Test not found.');
        }
        return ok(context, await callFn('academics.fn_test_publish', context.tenantId, testId, context.actorId));
    } catch (err) {
        return fail(err, context, req);
    }
}
