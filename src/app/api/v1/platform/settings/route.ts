import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Global Settings API
 */
export async function GET(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const settings = await callFn('platform.fn_settings_get');
        return ok(context, settings);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { key, value } = body;

        if (!key || value === undefined) {
            return problem(context, req, 400, 'Validation Error', 'Setting key and value are required.');
        }

        const result = await callFn(
            'platform.fn_settings_update',
            key,
            JSON.stringify(value),
            context.actorId || null
        );

        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
