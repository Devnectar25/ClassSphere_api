import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db/db';
import { can, type Permission } from '@/lib/auth';
import { authorize, type RequestContext } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { requireAssignedBatch, staffScope } from '@/lib/api/scope';
import { billingError, getCreditBalance, getEnrollment, getEnrollmentFinancials, parseAmount, type EnrollmentInfo } from '@/lib/billing/credit-ledger';
import {
    assessConsumption, closeVerificationRequest, confirmClassSession, correctMissingAttendance, recordManualReview, requestVerification, saveConsumptionPolicy,
    type ConsumptionMethod,
} from '@/lib/billing/fee-consumption';

/**
 * Attendance and fee consumption of an enrollment: assessment, class confirmation, missing attendance, Finance's manual
 * review, the verification queue and the academy's policy. Finance never changes attendance; attendance staff never see
 * or set amounts.
 */
/** Academy administrators work across branches, whichever branch view is selected. */
const otherBranch = (context: RequestContext, branchId: string | null) =>
    Boolean(context.branchId && branchId !== context.branchId) && !context.isPlatformAdmin && context.actorRole !== 'TenantAdmin';
const allowed = (context: RequestContext, permission: Permission) => context.isPlatformAdmin || can(context.actorRole, permission);

interface Access { enrollment: EnrollmentInfo; ownBatch: boolean; canConfirm: boolean; canCorrect: boolean; canManual: boolean; canRequest: boolean; canSeeFees: boolean }

async function access(context: RequestContext, enrollmentId: unknown): Promise<Access> {
    if (!enrollmentId) throw billingError('invalid', 'enrollmentId is required.');
    const enrollment = await getEnrollment({ query }, context.tenantId, String(enrollmentId));
    if (enrollment.branchId && otherBranch(context, enrollment.branchId)) throw billingError('forbidden', 'This enrollment belongs to another branch.');
    await requireAssignedBatch(context, enrollment.batchId);
    const [batch] = await query<{ instructor_user_id: string | null }>(`SELECT instructor_user_id FROM academics.batches WHERE batch_id = $1`, [enrollment.batchId]);
    const ownBatch = batch?.instructor_user_id === context.actorId;
    const marks = allowed(context, 'attendance.write');
    const isTeacher = context.actorRole === 'Instructor';
    const rules = {
        // The responsible teacher, or branch / academy management; front-office staff may confirm that a class was held
        canConfirm: marks && (!isTeacher || ownBatch),
        canCorrect: marks && (isTeacher ? ownBatch : context.isPlatformAdmin || ['TenantAdmin', 'BranchManager'].includes(context.actorRole)),
        canManual: allowed(context, 'billing.write'),
        canRequest: allowed(context, 'students.write') || allowed(context, 'billing.write'),
        canSeeFees: allowed(context, 'billing.read'),
    };
    if (!rules.canConfirm && !rules.canSeeFees && !rules.canRequest) throw billingError('forbidden', 'You may only review the attendance of your own batches.');
    return { enrollment, ownBatch, ...rules };
}

const dateParam = (value: unknown) => {
    const text = String(value ?? '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? text : null;
};

async function view(context: RequestContext, a: Access, until: string | null) {
    const assessment = await assessConsumption({ query }, context.tenantId, a.enrollment, until);
    const permissions = { canConfirm: a.canConfirm, canCorrect: a.canCorrect, canManual: a.canManual, canRequest: a.canRequest };
    const f = await getEnrollmentFinancials({ query }, context.tenantId, a.enrollment);
    const reviewable = f.unusedCeiling > 0 || f.pendingVerification > 0 || f.unlinkedPaid > 0;
    const transferBlocked = reviewable && assessment.policy.requireVerification && assessment.status !== 'verified';
    if (!a.canSeeFees) {
        return { assessment: { ...assessment, courseFee: null, consumedAmount: null, calculation: null, manualReview: null }, permissions, transferBlocked, credit: null };
    }
    const previousAdjustments = f.creditAlreadyGranted + f.previouslyConsumed + f.lateFeesPaid;
    return {
        assessment, permissions, transferBlocked,
        credit: {
            courseFee: f.courseFee, outstanding: f.outstanding, refunded: f.refunded, unlinkedPaid: f.unlinkedPaid,
            creditBalance: await getCreditBalance({ query }, context.tenantId, a.enrollment.studentId),
            verifiedPayments: f.verifiedPaid, creditReceived: f.creditReceived, previousAdjustments, pendingVerification: f.pendingVerification, unusedCeiling: f.unusedCeiling, reviewable,
            eligibleCredit: assessment.consumedAmount === null ? null : Math.max(0, Math.round((f.unusedCeiling - assessment.consumedAmount) * 100) / 100),
        },
    };
}

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    try {
        const params = req.nextUrl.searchParams;
        if (params.get('view') === 'policy') {
            if (!allowed(context, 'billing.read')) return problem(context, req, 403, 'Forbidden', 'Finance access is required.');
            try {
                const rows = await query<{
                    course_id: string | null; course_title: string | null; method: string; absent_counts: boolean; excused_counts: boolean; cancelled_counts: boolean;
                    partial_period: string; require_verification: boolean; updated_at: string; actor: string | null;
                }>(
                    `SELECT p.course_id, c.title AS course_title, p.method, p.absent_counts, p.excused_counts, p.cancelled_counts, p.partial_period, p.require_verification,
                            p.updated_at, u.full_name AS actor
                     FROM billing.fee_consumption_policies p LEFT JOIN academics.courses c ON c.course_id = p.course_id
                     LEFT JOIN identity_app.users u ON u.user_id = p.updated_by_actor_id
                     WHERE p.tenant_id = $1 ORDER BY p.course_id NULLS FIRST, c.title`, [context.tenantId]);
                return ok(context, rows.map(r => ({
                    courseId: r.course_id, courseTitle: r.course_title, method: r.method, absentCounts: r.absent_counts, excusedCounts: r.excused_counts,
                    cancelledCounts: r.cancelled_counts, partialPeriod: r.partial_period, requireVerification: r.require_verification, updatedAt: r.updated_at, updatedBy: r.actor,
                })));
            } catch (err) {
                console.warn('[billing/consumption view=policy fallback]', (err as Error).message);
                return ok(context, []);
            }
        }
        if (params.get('view') === 'queue') {
            const ownOnly = context.actorRole === 'Instructor' && !context.isPlatformAdmin;
            const rows = await query<{ enrollment_id: string; student_name: string; enrollment_number: string; until_date: string; created_at: string; requested_by: string | null }>(
                `SELECT r.enrollment_id, s.first_name || ' ' || s.last_name AS student_name, s.enrollment_number, r.until_date::text, r.created_at, u.full_name AS requested_by
                 FROM billing.consumption_reviews r
                 JOIN academics.students s ON s.student_id = r.student_id
                 JOIN academics.enrollments e ON e.enrollment_id = r.enrollment_id
                 JOIN academics.batches b ON b.batch_id = e.batch_id
                 LEFT JOIN identity_app.users u ON u.user_id = r.created_by_actor_id
                 WHERE r.tenant_id = $1 AND r.kind = 'request' AND r.status = 'open'
                   AND ($2::uuid IS NULL OR b.branch_id = $2::uuid) AND (NOT $3::boolean OR b.instructor_user_id = $4::uuid)
                 ORDER BY r.created_at LIMIT 50`, [context.tenantId, context.branchId, ownOnly, context.actorId]);
            const items = [];
            const scope = await staffScope(context);
            for (const r of rows) {
                const enrollment = await getEnrollment({ query }, context.tenantId, r.enrollment_id);
                if (scope && !scope.batchIds.includes(enrollment.batchId)) continue;
                // Assessed as of today: the transfer has not happened yet
                const a = await assessConsumption({ query }, context.tenantId, enrollment, null);
                items.push({
                    enrollmentId: r.enrollment_id, studentName: r.student_name, enrollmentNumber: r.enrollment_number, courseTitle: a.courseTitle, batchName: a.batchName,
                    status: a.status, unresolved: a.unresolved.length, issues: a.issues, requestedAt: r.created_at, requestedBy: r.requested_by,
                });
            }
            return ok(context, items);
        }
        return ok(context, await view(context, await access(context, params.get('enrollmentId')), dateParam(params.get('until'))));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    const { tenantId, actorId } = context;
    try {
        const body = await req.json();
        if (body.action === 'save_policy') {
            if (!allowed(context, 'billing.write') || otherBranch(context, null)) return problem(context, req, 403, 'Forbidden', 'The fee-consumption policy is set for the whole academy. Switch to the all-branches view of an academy Finance user.');
            if (!['monthly', 'session', 'manual'].includes(body.method)) return problem(context, req, 400, 'Validation Error', 'Choose a fee-consumption method.');
            await withTransaction(tx => saveConsumptionPolicy(tx, {
                tenantId, actorId, courseId: body.courseId ? String(body.courseId) : null,
                policy: {
                    method: body.method as ConsumptionMethod, absentCounts: body.absentCounts !== false, excusedCounts: body.excusedCounts !== false,
                    cancelledCounts: body.cancelledCounts === true, partialPeriod: body.partialPeriod === 'full' ? 'full' : 'not_counted',
                    requireVerification: body.requireVerification !== false,
                },
            }));
            return ok(context, { saved: true });
        }

        const a = await access(context, body.enrollmentId);
        const { enrollment } = a;
        const until = dateParam(body.until);
        const deny = (message: string) => { throw billingError('forbidden', message); };
        switch (body.action) {
            case 'confirm_session':
                if (!a.canConfirm) deny('Only the responsible teacher, branch manager or academy staff may confirm a class.');
                await withTransaction(tx => confirmClassSession(tx, { tenantId, actorId, enrollment, date: body.date, status: body.status, reason: body.reason }));
                break;
            case 'correct_attendance':
                if (!a.canCorrect) deny('Only the responsible teacher or a branch manager may correct attendance.');
                await withTransaction(tx => correctMissingAttendance(tx, { tenantId, actorId, enrollment, date: body.date, status: body.status, reason: body.reason }));
                break;
            case 'manual_review':
                if (!a.canManual) deny('Only Finance may enter the consumed fee.');
                await withTransaction(async tx => {
                    await recordManualReview(tx, { tenantId, actorId, enrollment, until, consumedAmount: parseAmount(body.consumedAmount, 'Consumed fee'), reason: body.reason });
                    await closeVerificationRequest(tx, tenantId, enrollment.enrollmentId);
                });
                break;
            case 'request_verification':
                if (!a.canRequest) deny('You may not request a verification.');
                await withTransaction(tx => requestVerification(tx, { tenantId, actorId, enrollment, until }));
                break;
            default:
                return problem(context, req, 400, 'Validation Error', `Unrecognized action '${body.action}'.`);
        }
        return ok(context, await view(context, a, until));
    } catch (err) {
        return fail(err, context, req);
    }
}
