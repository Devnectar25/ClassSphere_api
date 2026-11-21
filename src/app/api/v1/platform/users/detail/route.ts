import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform user details: personal info, verification, registration history, payments,
 * enrolled courses and batches, academy memberships, account activity and suspension history.
 * GET ?userId=<uuid>
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const userId = req.nextUrl.searchParams.get('userId') ?? '';
    if (!UUID.test(userId)) {
        return problem(context, req, 400, 'Validation Error', 'A valid userId is required.');
    }

    try {
        return ok(context, await callFn('platform.fn_user_detail', userId));
    } catch (err) {
        return fail(err, context, req);
    }
}
