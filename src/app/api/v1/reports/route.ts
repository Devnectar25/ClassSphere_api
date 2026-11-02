import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Reports, Dashboards & Compliance Audit API — branch-scoped
 * Traceability: TDD Section 10.4, 20; PLT-009
 */
export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams;
    const reportType = searchParams.get('type') || 'aging';
    const permission = reportType === 'platform' ? 'platform' : reportType === 'audit' ? 'audit.read' : 'reports.read';
    // Platform operators may search the audit trail across academies without opening one
    const platformAudit = reportType === 'audit' && authorize(req, 'platform');
    const context = platformAudit && !(platformAudit instanceof Response) ? platformAudit : authorize(req, permission);
    if (context instanceof Response) return context;

    try {
        switch (reportType) {
            case 'audit':
                return ok(context, await callFn('reporting.fn_audit_search',
                    context.tenantId || null,
                    searchParams.get('action') || null,
                    Math.min(parseInt(searchParams.get('limit') || '50', 10), 200),
                    parseInt(searchParams.get('offset') || '0', 10)));
            case 'platform':
                return ok(context, await callFn('reporting.fn_platform_metrics'));
            case 'dashboard':
                return ok(context, await callFn('reporting.fn_dashboard_summary', context.tenantId, context.branchId));
            case 'collection':
                return ok(context, await callFn('reporting.fn_collection_report', context.tenantId, context.branchId));
            case 'aging':
                return ok(context, await callFn('reporting.fn_fee_aging', context.tenantId, context.branchId));
            default:
                return problem(context, req, 400, 'Validation Error', `Unknown report type '${reportType}'.`);
        }
    } catch (err) {
        return fail(err, context, req);
    }
}
