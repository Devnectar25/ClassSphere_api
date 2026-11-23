import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail } from '@/lib/api/respond';

/**
 * Platform Reports & Analytics API
 * Returns live aggregated report metrics, filtered time series, and drill-down record datasets.
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    const { searchParams } = req.nextUrl;
    const timeframe = searchParams.get('timeframe') || 'month';
    const fromDate = searchParams.get('from') ? new Date(searchParams.get('from')!).toISOString() : null;
    const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!).toISOString() : null;
    const academy = searchParams.get('academy') || null;
    const course = searchParams.get('course') || null;
    const regStatus = searchParams.get('regStatus') || null;
    const payStatus = searchParams.get('payStatus') || null;

    try {
        const report = await callFn(
            'platform.fn_platform_reports',
            timeframe,
            fromDate,
            toDate,
            academy,
            course,
            regStatus,
            payStatus,
            context.actorId || null
        );
        return ok(context, report);
    } catch (err) {
        return fail(err, context, req);
    }
}
