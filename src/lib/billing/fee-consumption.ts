/**
 * Attendance-based consumed fee of an enrollment.
 *
 * A consumed fee is calculated only from what is recorded: the batch timetable, attendance, and confirmations that a
 * class took place or was cancelled. Anything unrecorded stays unresolved; it is never read as Present, Absent or held.
 */
import { billingError, fromMinor, getEnrollmentFinancials, isActiveEnrollment, lockStudent, toMinor, writeAudit, type EnrollmentInfo, type Queryable } from '@/lib/billing/credit-ledger';
import { addMonths, dateIn, getEnrollmentPeriod } from '@/lib/billing/course-period';

export type ConsumptionMethod = 'monthly' | 'session' | 'manual';
export type VerificationStatus = 'verified' | 'pending_verification' | 'attendance_missing' | 'finance_review_required';

export interface ConsumptionPolicy {
    configured: boolean; courseSpecific: boolean; method: ConsumptionMethod; absentCounts: boolean; excusedCounts: boolean; cancelledCounts: boolean;
    partialPeriod: 'not_counted' | 'full'; requireVerification: boolean;
}

/**
 * present/absent/excused: recorded attendance of a held class. missing: held, but this student was not marked.
 * unconfirmed: scheduled, nothing recorded. conflict: cancelled, but attendance exists.
 * unscheduled: attendance on a date that is not a class of the timetable; not counted until someone confirms an extra class.
 */
export type SessionState = 'present' | 'absent' | 'excused' | 'cancelled' | 'missing' | 'unconfirmed' | 'conflict' | 'unscheduled';

/** scheduled: a class of the timetable, or an extra class confirmed by authorized staff (extra). attendance: what is recorded for the student. */
export interface SessionEntry { date: string; scheduled: boolean; extra: boolean; state: SessionState; attendance: string | null; note: string | null }

export interface ConsumptionAssessment {
    enrollmentId: string; batchId: string; batchName: string; courseTitle: string; enrollmentDate: string; courseStart: string; courseEnd: string | null; until: string;
    policy: ConsumptionPolicy; hasTimetable: boolean;
    /** scheduled = conducted + cancelled + unconfirmed + conflict; conducted = present + absent (excused included) + missing. unscheduled is in none of them. */
    counts: { scheduled: number; conducted: number; marked: number; present: number; absent: number; excused: number; cancelled: number; missing: number; unconfirmed: number; conflict: number; unscheduled: number };
    totalCourseSessions: number; sessions: SessionEntry[]; unresolved: SessionEntry[];
    courseFee: number; method: ConsumptionMethod; calculation: string | null; consumedAmount: number | null;
    status: VerificationStatus; issues: string[]; warnings: string[];
    manualReview: { amount: number; reason: string; reviewedBy: string | null; reviewedAt: string; untilDate: string } | null;
    verificationRequestedAt: string | null;
}

const DAY = 86400000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const isoWeekday = (iso: string) => toDate(iso).getUTCDay() || 7;
const addDays = (iso: string, days: number) => toIso(new Date(toDate(iso).getTime() + days * DAY));

export async function getConsumptionPolicy(db: Queryable, tenantId: string, courseId: string): Promise<ConsumptionPolicy> {
    try {
        const [row] = await db.query<{
            course_id: string | null; method: ConsumptionMethod; absent_counts: boolean; excused_counts: boolean; cancelled_counts: boolean;
            partial_period: 'not_counted' | 'full'; require_verification: boolean;
        }>(
            `SELECT course_id, method, absent_counts, excused_counts, cancelled_counts, partial_period, require_verification
             FROM billing.fee_consumption_policies WHERE tenant_id = $1 AND (course_id = $2 OR course_id IS NULL)
             ORDER BY course_id NULLS LAST LIMIT 1`, [tenantId, courseId]);
        if (!row) {
            return {
                configured: false, courseSpecific: false, method: 'manual', absentCounts: true, excusedCounts: true, cancelledCounts: false,
                partialPeriod: 'not_counted', requireVerification: true,
            };
        }
        return {
            configured: true, courseSpecific: row.course_id !== null, method: row.method, absentCounts: row.absent_counts, excusedCounts: row.excused_counts,
            cancelledCounts: row.cancelled_counts, partialPeriod: row.partial_period, requireVerification: row.require_verification,
        };
    } catch (err) {
        console.warn('[getConsumptionPolicy fallback]', (err as Error).message);
        return {
            configured: false, courseSpecific: false, method: 'manual', absentCounts: true, excusedCounts: true, cancelledCounts: false,
            partialPeriod: 'not_counted', requireVerification: true,
        };
    }
}

/** The date the user chose: transfer dates are stored as midnight UTC of that day. */
export const transferDay = (value: string | Date) => new Date(value).toISOString().slice(0, 10);

/**
 * Assesses an enrollment up to a date. An enrollment that was already transferred is assessed up to its transfer
 * (transferId, or its latest one), whatever the date. Reads only; nothing is changed or assumed.
 */
export async function assessConsumption(
    db: Queryable, tenantId: string, enrollment: EnrollmentInfo, untilDate: string | null, transferId: string | null = null,
): Promise<ConsumptionAssessment> {
    const [transfer] = transferId || !isActiveEnrollment(enrollment.status) ? await db.query<{ transfer_id: string; transfer_date: string | Date; reentered: boolean }>(
        `SELECT t.transfer_id, t.transfer_date,
                EXISTS (SELECT 1 FROM billing.course_transfers b WHERE b.to_enrollment_id = t.from_enrollment_id AND b.created_at > t.created_at) AS reentered
         FROM billing.course_transfers t
         WHERE t.tenant_id = $1 AND t.from_enrollment_id = $2 AND ($3::uuid IS NULL OR t.transfer_id = $3::uuid)
         ORDER BY t.created_at DESC LIMIT 1`, [tenantId, enrollment.enrollmentId, transferId]) : [];
    const requestedUntil = transfer ? transferDay(transfer.transfer_date) : untilDate;
    const policy = await getConsumptionPolicy(db, tenantId, enrollment.courseId);
    const period = await getEnrollmentPeriod(db, tenantId, enrollment.enrollmentId);
    const [batch] = await db.query<{ end_date: string | null; timezone: string | null; enrolled_at: string | Date; returned: boolean }>(
        `SELECT b.end_date::text, o.timezone, e.enrolled_at,
                EXISTS (SELECT 1 FROM billing.course_transfers o JOIN billing.course_transfers i ON i.to_enrollment_id = o.from_enrollment_id AND i.created_at > o.created_at
                        WHERE o.from_enrollment_id = e.enrollment_id) AS returned
         FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id JOIN tenant.organizations o ON o.tenant_id = e.tenant_id
         WHERE e.enrollment_id = $1 AND e.tenant_id = $2`, [enrollment.enrollmentId, tenantId]);
    const enrollmentDate = dateIn(batch.timezone, new Date(batch.enrolled_at));
    const start = enrollmentDate > period.startDate ? enrollmentDate : period.startDate;
    const latest = requestedUntil && requestedUntil < period.today ? requestedUntil : period.today;
    const until = latest < enrollmentDate ? enrollmentDate : latest;

    const timetable = await db.query<{ weekday: number }>(
        `SELECT DISTINCT weekday::int AS weekday FROM academics.batch_schedules WHERE tenant_id = $1 AND batch_id = $2`, [tenantId, enrollment.batchId]);
    const weekdays = new Set(timetable.map(t => Number(t.weekday)));
    const attendance = await db.query<{ session_date: string; own: string | null }>(
        `SELECT session_date::text, MAX(status) FILTER (WHERE student_id = $3) AS own FROM academics.attendance_records
         WHERE tenant_id = $1 AND batch_id = $2 AND session_date <= $4::date GROUP BY session_date`,
        [tenantId, enrollment.batchId, enrollment.studentId, until]);
    const logs = await db.query<{ session_date: string; status: string; reason: string }>(
        `SELECT session_date::text, status, reason FROM academics.class_sessions WHERE tenant_id = $1 AND batch_id = $2 AND session_date <= $3::date`,
        [tenantId, enrollment.batchId, until]);
    const marked = new Map(attendance.map(a => [a.session_date, a.own]));
    const logged = new Map(logs.map(l => [l.session_date, l]));

    // Classes of the timetable while the student is enrolled; a batch end date is a class day, a duration end is not
    const lastDay = !period.endDate ? null : batch.end_date && batch.end_date === period.endDate ? period.endDate : addDays(period.endDate, -1);
    const timetabled = (d: string) => d >= start && (!lastDay || d <= lastDay) && weekdays.has(isoWeekday(d));
    const dates = new Map<string, boolean>();
    for (let d = start; d <= until; d = addDays(d, 1)) {
        // The last day may still be ahead of the class: it counts only when something is recorded for it
        if (timetabled(d) && (d < until || marked.has(d) || logged.has(d))) dates.set(d, true);
    }
    // Records of other dates since the enrollment; before the course starts only the student's own
    for (const d of [...marked.keys(), ...logged.keys()]) {
        if (d < enrollmentDate || d > until || dates.has(d)) continue;
        if (marked.has(d) ? d >= start || marked.get(d) : logged.get(d)!.status === 'conducted') dates.set(d, false);
    }
    const sessions: SessionEntry[] = [...dates.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, inTimetable]) => {
        const log = logged.get(date);
        const own = marked.get(date) ?? null;
        const extra = !inTimetable && log?.status === 'conducted';
        let state: SessionState;
        if (log?.status === 'cancelled') state = marked.has(date) ? 'conflict' : 'cancelled';
        else if (!inTimetable && !extra) state = 'unscheduled';
        else if (own === 'present' || own === 'late') state = 'present';
        else if (own === 'absent' || own === 'excused') state = own;
        else state = log || marked.has(date) ? 'missing' : 'unconfirmed';
        const note = state === 'conflict' ? 'Marked cancelled, but attendance exists'
            : state === 'unscheduled' ? (date < period.startDate ? 'Before the course starts' : lastDay && date > lastDay ? 'After the course ends' : 'Not a class day of the timetable')
                : log?.reason ?? null;
        return { date, scheduled: inTimetable || extra, extra, state, attendance: own, note };
    });
    // A returning student's earlier stay was settled at that transfer; otherwise earlier own records contradict the enrollment date
    const early = batch.returned ? [] : attendance.filter(a => a.own && a.session_date < enrollmentDate).map(a => a.session_date).sort();
    const count = (...states: SessionState[]) => sessions.filter(x => states.includes(x.state)).length;
    const unresolved = sessions.filter(x => ['missing', 'unconfirmed', 'conflict', 'unscheduled'].includes(x.state));

    // Sessions of the whole course for this student
    let totalCourseSessions = 0;
    if (lastDay && weekdays.size > 0) {
        for (let d = start; d <= lastDay; d = addDays(d, 1)) if (timetabled(d)) totalCourseSessions++;
    }

    const financials = await getEnrollmentFinancials(db, tenantId, enrollment);
    const courseFee = financials.courseFee;
    const counts = (x: SessionEntry) => x.state === 'present' || (x.state === 'absent' && policy.absentCounts) || (x.state === 'excused' && policy.excusedCounts)
        || (x.state === 'cancelled' && policy.cancelledCounts);

    const list = (all: string[]) => `${all.slice(0, 5).join(', ')}${all.length > 5 ? ', …' : ''}`;
    const warnings: string[] = [];
    const off = sessions.filter(x => x.state === 'unscheduled').map(x => x.date);
    const contradicting = sessions.filter(x => x.state === 'conflict').map(x => x.date);
    if (off.length > 0) warnings.push(`Attendance exists for ${off.length} date(s) that are not scheduled classes of this batch: ${list(off)}. They are not counted until authorized staff confirm an extra class.`);
    if (contradicting.length > 0) warnings.push(`${contradicting.length} class(es) are recorded as cancelled although attendance exists: ${list(contradicting)}.`);
    if (early.length > 0) warnings.push(`Attendance exists for ${early.length} date(s) before the enrollment date ${enrollmentDate}: ${list(early)}. They are not counted.`);

    const issues: string[] = [];
    if (early.length > 0) issues.push('Attendance before the enrollment date contradicts the enrollment record.');
    if (transfer?.reentered) issues.push('The student has returned to this batch since the transfer, so the earlier enrollment date is no longer known.');
    if (enrollmentDate > period.today) issues.push('The enrollment date is in the future.');
    if (!policy.configured) issues.push('No fee-consumption policy is configured for this course.');
    else if (policy.method === 'manual') issues.push('The policy requires a manual Finance review.');
    if (weekdays.size === 0) issues.push('The batch has no timetable, so conducted sessions are unknown.');
    if (courseFee <= 0) issues.push('The course has no fee on record.');
    if (policy.method === 'session' && totalCourseSessions === 0 && weekdays.size > 0) issues.push('The course has no end date or duration, so its total sessions are unknown.');
    if (policy.method === 'monthly' && !period.durationMonths) issues.push('The course has no duration, so its monthly fee is unknown.');

    // Latest Finance decision of this stay; it is stale once further sessions have taken place
    const [manual] = await db.query<{ consumed_amount: string; reason: string; until_date: string; created_at: string; actor: string | null }>(
        `SELECT r.consumed_amount::text, r.reason, r.until_date::text, r.created_at, u.full_name AS actor
         FROM billing.consumption_reviews r
         LEFT JOIN identity_app.users u ON u.user_id = r.created_by_actor_id
         WHERE r.tenant_id = $1 AND r.enrollment_id = $2 AND r.kind = 'manual' AND r.status = 'verified'
           AND r.until_date BETWEEN $3::date AND $4::date AND (r.transfer_id IS NULL OR r.transfer_id = $5::uuid)
           -- decisions of an earlier stay do not apply after the student came back
           AND r.created_at > COALESCE((SELECT MAX(i.created_at) FROM billing.course_transfers i WHERE i.to_enrollment_id = r.enrollment_id
                AND i.created_at < COALESCE((SELECT c.created_at FROM billing.course_transfers c WHERE c.transfer_id = $5::uuid), 'infinity'::timestamptz)), '-infinity'::timestamptz)
         ORDER BY r.created_at DESC LIMIT 1`, [tenantId, enrollment.enrollmentId, enrollmentDate, until, transfer?.transfer_id ?? null]);
    // Without a timetable nobody can tell whether further classes took place, so the decision holds only for its date
    const manualValid = Boolean(manual) && (manual.until_date === until || (weekdays.size > 0 && !sessions.some(x => x.date > manual.until_date)));
    const [request] = await db.query<{ created_at: string }>(
        `SELECT created_at FROM billing.consumption_reviews WHERE tenant_id = $1 AND enrollment_id = $2 AND kind = 'request' AND status = 'open'`,
        [tenantId, enrollment.enrollmentId]);

    let consumedAmount: number | null = null;
    let calculation: string | null = null;
    let method: ConsumptionMethod = policy.method;
    if (manualValid) {
        method = 'manual';
        consumedAmount = Number(manual.consumed_amount);
        calculation = `Entered by Finance: ${manual.reason}`;
    } else if (issues.length === 0 && unresolved.length === 0) {
        if (policy.method === 'session') {
            const eligible = sessions.filter(counts).length;
            consumedAmount = fromMinor(Math.min(toMinor(courseFee), Math.round((toMinor(courseFee) * eligible) / totalCourseSessions)));
            calculation = `${eligible} of ${totalCourseSessions} course sessions`;
        } else {
            const months = period.durationMonths!;
            let used = 0;
            for (let k = 0; k < months; k++) {
                const first = addMonths(start, k);
                const next = addMonths(start, k + 1);
                if (first > until) break;
                const complete = next <= until;
                // A period without any eligible session was not used; an unfinished one counts only if the policy says so
                if ((complete || policy.partialPeriod === 'full') && sessions.some(x => x.date >= first && x.date < next && counts(x))) used++;
            }
            consumedAmount = fromMinor(Math.min(toMinor(courseFee), Math.round((toMinor(courseFee) * used) / months)));
            calculation = `${used} of ${months} billing months`;
        }
    }
    const status: VerificationStatus = manualValid ? 'verified'
        : issues.length > 0 ? 'finance_review_required'
            : count('missing') > 0 ? 'attendance_missing'
                : unresolved.length > 0 ? 'pending_verification' : 'verified';

    return {
        enrollmentId: enrollment.enrollmentId, batchId: enrollment.batchId, batchName: enrollment.batchName, courseTitle: enrollment.courseTitle,
        enrollmentDate, courseStart: period.startDate, courseEnd: period.endDate, until, policy, hasTimetable: weekdays.size > 0,
        counts: {
            scheduled: sessions.filter(x => x.scheduled).length, conducted: count('present', 'absent', 'excused', 'missing'), marked: count('present', 'absent', 'excused'),
            present: count('present'), absent: count('absent', 'excused'), excused: count('excused'), cancelled: count('cancelled'), missing: count('missing'),
            unconfirmed: count('unconfirmed'), conflict: count('conflict'), unscheduled: count('unscheduled'),
        },
        totalCourseSessions, sessions, unresolved, courseFee, method, calculation, consumedAmount, status, issues, warnings,
        manualReview: manual ? { amount: Number(manual.consumed_amount), reason: manual.reason, reviewedBy: manual.actor, reviewedAt: manual.created_at, untilDate: manual.until_date } : null,
        verificationRequestedAt: request?.created_at ?? null,
    };
}

export const unresolvedMessage = (a: ConsumptionAssessment) => {
    if (a.status === 'finance_review_required') return `Finance review is required: ${a.issues.join(' ')}`;
    const dates = a.unresolved.slice(0, 5).map(x => x.date).join(', ');
    return `Attendance of ${a.batchName} is not resolved for ${a.unresolved.length} session(s): ${dates}${a.unresolved.length > 5 ? ', …' : ''}.`;
};

/** Short record of what a decision was based on. */
export const assessmentSnapshot = (a: ConsumptionAssessment) => ({
    until: a.until, status: a.status, method: a.method, calculation: a.calculation, consumedAmount: a.consumedAmount, courseFee: a.courseFee,
    counts: a.counts, totalCourseSessions: a.totalCourseSessions, policy: a.policy, issues: a.issues, warnings: a.warnings, unresolved: a.unresolved.map(x => `${x.date}:${x.state}`),
});

function requireReason(reason: unknown): string {
    const text = String(reason ?? '').trim();
    if (text.length < 3) throw billingError('invalid', 'Enter the reason.');
    return text.slice(0, 500);
}

function requireSession(assessment: ConsumptionAssessment, date: unknown): SessionEntry {
    const entry = assessment.sessions.find(x => x.date === String(date ?? ''));
    if (!entry) throw billingError('invalid', 'This date is not a session of the student in this batch.');
    return entry;
}

/** Records that a class took place or was cancelled. Attendance is not created or changed. */
export async function confirmClassSession(tx: Queryable, params: {
    tenantId: string; actorId: string; enrollment: EnrollmentInfo; date: unknown; status: unknown; reason: unknown;
}) {
    const { tenantId, actorId, enrollment } = params;
    if (params.status !== 'conducted' && params.status !== 'cancelled') throw billingError('invalid', 'Choose whether the class was conducted or cancelled.');
    const reason = requireReason(params.reason);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`class-session-${enrollment.batchId}`]);
    const { date, scheduled } = requireSession(await assessConsumption(tx, tenantId, enrollment, null), params.date);
    const [existing] = await tx.query<{ status: string; reason: string }>(
        `SELECT status, reason FROM academics.class_sessions WHERE batch_id = $1 AND session_date = $2::date`, [enrollment.batchId, date]);
    if (params.status === 'cancelled') {
        const [held] = await tx.query(`SELECT 1 FROM academics.attendance_records WHERE tenant_id = $1 AND batch_id = $2 AND session_date = $3::date LIMIT 1`,
            [tenantId, enrollment.batchId, date]);
        if (held) throw billingError('conflict', `Attendance is recorded for ${date}, so the class cannot be marked as cancelled.`);
    }
    await tx.query(
        `INSERT INTO academics.class_sessions (tenant_id, batch_id, session_date, status, reason, confirmed_by_actor_id)
         VALUES ($1, $2, $3::date, $4, $5, $6)
         ON CONFLICT (batch_id, session_date) DO UPDATE
         SET status = EXCLUDED.status, reason = EXCLUDED.reason, confirmed_by_actor_id = EXCLUDED.confirmed_by_actor_id, confirmed_at = clock_timestamp()`,
        [tenantId, enrollment.batchId, date, params.status, reason, actorId]);
    await writeAudit(tx, {
        tenantId, actorId, action: 'attendance.session_confirmed', entityType: 'batch', entityId: enrollment.batchId,
        details: { batch: enrollment.batchName, date, status: params.status, reason, extraClass: !scheduled, previous: existing ?? null, enrollmentId: enrollment.enrollmentId, studentId: enrollment.studentId },
    });
}

/** Adds a missing attendance record through the attendance module. An existing record is never overwritten here. */
export async function correctMissingAttendance(tx: Queryable, params: {
    tenantId: string; actorId: string; enrollment: EnrollmentInfo; date: unknown; status: unknown; reason: unknown;
}) {
    const { tenantId, actorId, enrollment } = params;
    const status = String(params.status ?? '');
    if (!['present', 'absent', 'late', 'excused'].includes(status)) throw billingError('invalid', 'Choose Present, Absent, Late or Excused.');
    const reason = requireReason(params.reason);
    await lockStudent(tx, tenantId, enrollment.studentId);
    const session = requireSession(await assessConsumption(tx, tenantId, enrollment, null), params.date);
    if (['present', 'absent', 'excused'].includes(session.state)) throw billingError('conflict', 'Attendance is already recorded for this date. Change it in the Attendance module.');
    if (session.state === 'cancelled') throw billingError('conflict', 'This class is recorded as cancelled.');
    if (session.state !== 'missing') throw billingError('conflict', 'First confirm that the class was conducted.');
    await tx.query(`SELECT academics.fn_attendance_mark_batch($1, $2, $3::date, $4::jsonb, $5)`,
        [tenantId, enrollment.batchId, session.date, JSON.stringify([{ studentId: enrollment.studentId, status, remarks: `Corrected: ${reason}` }]), actorId]);
    await writeAudit(tx, {
        tenantId, actorId, action: 'attendance.corrected', entityType: 'student', entityId: enrollment.studentId,
        details: { studentId: enrollment.studentId, enrollmentId: enrollment.enrollmentId, batch: enrollment.batchName, date: session.date, status, reason },
    });
}

/** Finance enters the consumed fee; what was unresolved at that moment is kept with the decision. */
export async function recordManualReview(tx: Queryable, params: {
    tenantId: string; actorId: string; enrollment: EnrollmentInfo; until: string | null; consumedAmount: number; reason: unknown; transferId?: string;
}) {
    const { tenantId, actorId, enrollment, consumedAmount } = params;
    const reason = requireReason(params.reason);
    const transferId = params.transferId ?? null;
    await lockStudent(tx, tenantId, enrollment.studentId);
    const assessment = await assessConsumption(tx, tenantId, enrollment, params.until, transferId);
    if (toMinor(consumedAmount) > toMinor(assessment.courseFee)) {
        throw billingError('invalid', `Consumed fee cannot exceed the course fee of ${assessment.courseFee.toFixed(2)}.`);
    }
    await tx.query(
        `INSERT INTO billing.consumption_reviews (tenant_id, enrollment_id, student_id, kind, status, until_date, consumed_amount, reason, snapshot, created_by_actor_id, transfer_id)
         VALUES ($1, $2, $3, 'manual', 'verified', $4::date, $5, $6, $7::jsonb, $8, $9)`,
        [tenantId, enrollment.enrollmentId, enrollment.studentId, assessment.until, consumedAmount, reason, JSON.stringify(assessmentSnapshot(assessment)), actorId, transferId]);
    await writeAudit(tx, {
        tenantId, actorId, action: 'billing.consumption_manual_review', entityType: 'enrollment', entityId: enrollment.enrollmentId,
        details: {
            studentId: enrollment.studentId, course: enrollment.courseTitle, amount: consumedAmount, reason, until: assessment.until,
            unresolvedSessions: assessment.unresolved.map(x => x.date), issues: assessment.issues,
        },
    });
}

/** Puts the enrollment in the verification queue of teachers, branch managers and Finance. */
export async function requestVerification(tx: Queryable, params: { tenantId: string; actorId: string; enrollment: EnrollmentInfo; until: string | null }) {
    const { tenantId, actorId, enrollment } = params;
    const assessment = await assessConsumption(tx, tenantId, enrollment, params.until);
    if (assessment.status === 'verified') throw billingError('conflict', 'The consumed fee is already verified.');
    const created = await tx.query<{ review_id: string }>(
        `INSERT INTO billing.consumption_reviews (tenant_id, enrollment_id, student_id, kind, status, until_date, snapshot, created_by_actor_id)
         VALUES ($1, $2, $3, 'request', 'open', $4::date, $5::jsonb, $6)
         ON CONFLICT (enrollment_id) WHERE kind = 'request' AND status = 'open' DO NOTHING RETURNING review_id`,
        [tenantId, enrollment.enrollmentId, enrollment.studentId, assessment.until, JSON.stringify(assessmentSnapshot(assessment)), actorId]);
    if (created.length > 0) {
        await writeAudit(tx, {
            tenantId, actorId, action: 'billing.consumption_verification_requested', entityType: 'enrollment', entityId: enrollment.enrollmentId,
            details: { studentId: enrollment.studentId, course: enrollment.courseTitle, status: assessment.status, unresolved: assessment.unresolved.length, issues: assessment.issues },
        });
    }
}

export async function closeVerificationRequest(tx: Queryable, tenantId: string, enrollmentId: string) {
    await tx.query(
        `UPDATE billing.consumption_reviews SET status = 'closed', closed_at = clock_timestamp()
         WHERE tenant_id = $1 AND enrollment_id = $2 AND kind = 'request' AND status = 'open'`, [tenantId, enrollmentId]);
}

export async function saveConsumptionPolicy(tx: Queryable, params: {
    tenantId: string; actorId: string; courseId: string | null; policy: Pick<ConsumptionPolicy, 'method' | 'absentCounts' | 'excusedCounts' | 'cancelledCounts' | 'partialPeriod' | 'requireVerification'>;
}) {
    const { tenantId, actorId, courseId, policy } = params;
    if (courseId) {
        const [course] = await tx.query(`SELECT 1 FROM academics.courses WHERE course_id = $1 AND tenant_id = $2`, [courseId, tenantId]);
        if (!course) throw billingError('not_found', 'Course not found.');
    }
    const [previous] = await tx.query(
        `SELECT method, absent_counts, excused_counts, cancelled_counts, partial_period, require_verification
         FROM billing.fee_consumption_policies WHERE tenant_id = $1 AND course_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`, [tenantId, courseId]);
    const values = [tenantId, courseId, policy.method, policy.absentCounts, policy.excusedCounts, policy.cancelledCounts, policy.partialPeriod, policy.requireVerification, actorId];
    if (previous) {
        await tx.query(
            `UPDATE billing.fee_consumption_policies SET method = $3, absent_counts = $4, excused_counts = $5, cancelled_counts = $6, partial_period = $7,
                    require_verification = $8, updated_by_actor_id = $9, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND course_id IS NOT DISTINCT FROM $2::uuid`, values);
    } else {
        await tx.query(
            `INSERT INTO billing.fee_consumption_policies (tenant_id, course_id, method, absent_counts, excused_counts, cancelled_counts, partial_period, require_verification, updated_by_actor_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, values);
    }
    await writeAudit(tx, {
        tenantId, actorId, action: 'billing.consumption_policy_saved', entityType: 'consumption_policy', entityId: courseId ?? tenantId,
        details: { courseId, previous: previous ?? null, policy },
    });
}
