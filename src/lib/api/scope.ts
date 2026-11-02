import { callFn } from '@/lib/db/db';
import type { RequestContext } from '@/lib/api/context';

/** Branch-scoped users may only work with batches of their own branch. */
export async function batchInScope(context: RequestContext, batchId: string) {
    if (!context.branchId) return true;
    const batches = await callFn<Array<{ batchId: string }>>('academics.fn_batch_list', context.tenantId, context.branchId);
    return batches.some(b => b.batchId === batchId);
}
