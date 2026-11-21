import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Platform Payments & Transactions API
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q') || null;
    const status = searchParams.get('status') || null;
    const tenantId = searchParams.get('tenantId') || null;
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    try {
        const result = await callFn('platform.fn_payments_list', query, status, tenantId, limit, offset);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
