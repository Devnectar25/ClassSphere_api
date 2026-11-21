import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Platform Dashboard Telemetry API (Real-time DB aggregated counts)
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const timeframe = searchParams.get('timeframe') || 'month';

    try {
        const telemetry = await callFn('platform.fn_dashboard_telemetry', timeframe);
        return ok(context, telemetry);
    } catch (err) {
        return fail(err, context, req);
    }
}
