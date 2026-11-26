import { query } from '@/lib/db/db';

export interface CourseCompletionPolicy {
    enabled: boolean;
    minAttendancePct: number;
    requiredSessions: number;
    requiredAssessments: number;
    minPassingMarks: number;
    requireApproval: boolean;
    checkAttendance: boolean;
    checkAssessments: boolean;
    checkMarks: boolean;
    checkSessions: boolean;
    checkDuration: boolean;
}

export const DEFAULT_COMPLETION_POLICY: CourseCompletionPolicy = {
    enabled: false,
    minAttendancePct: 75,
    requiredSessions: 0,
    requiredAssessments: 1,
    minPassingMarks: 40,
    requireApproval: true,
    checkAttendance: true,
    checkAssessments: true,
    checkMarks: true,
    checkSessions: false,
    checkDuration: false,
};

export interface StudentCourseProgress {
    enrollmentId: string;
    enrollmentStatus: string;
    studentId: string;
    studentName: string;
    enrollmentNumber: string;
    courseId: string;
    courseTitle: string;
    courseCode: string;
    batchId: string;
    batchName: string;
    branchId: string | null;
    branchName: string | null;
    startDate: string | null;
    endDate: string | null;
    durationMonths: number | null;
    durationElapsedMonths: number;
    durationSatisfied: boolean;
    sessionsTotal: number;
    sessionsAttended: number;
    sessionsExcused: number;
    sessionsAbsent: number;
    attendanceRate: number;
    attendanceSatisfied: boolean;
    sessionsSatisfied: boolean;
    assessmentsTotal: number;
    assessmentsCompleted: number;
    assessmentsPassed: number;
    assessmentsSatisfied: boolean;
    averageScore: number;
    marksSatisfied: boolean;
    tests: Array<{
        testId: string;
        title: string;
        testType: string;
        testDate: string;
        maxMarks: number;
        marksObtained: number | null;
        percentage: number | null;
        isAbsent: boolean;
        passed: boolean;
    }>;
    isEligible: boolean;
    unmetReasons: string[];
    completionRecord: {
        completionId: string;
        status: string;
        completionDate: string;
        finalResult: string;
        attendanceRate: number;
        sessionsAttended: number;
        sessionsTotal: number;
        assessmentsCompleted: number;
        averageScore: number;
        approvedByActorId: string | null;
        approvedByName?: string | null;
        remarks: string | null;
        returnRemarks: string | null;
        createdAt: string;
    } | null;
    financialSummary: {
        totalTuition: number;
        paidAmount: number;
        balanceAmount: number;
        isFeePaid: boolean;
    };
    completionPolicy: CourseCompletionPolicy;
    overallProgressPct: number;
}

/**
 * Calculates academic progress and completion eligibility for a specific student course enrollment.
 * Uses real records from attendance, sessions, tests, results, and courses.
 */
export async function calculateStudentCourseProgress(
    tenantId: string,
    enrollmentId: string
): Promise<StudentCourseProgress | null> {
    // 1. Fetch enrollment, course, batch, and student details
    const [enrollment] = await query<{
        enrollment_id: string;
        enrollment_status: string;
        enrolled_at: string;
        student_id: string;
        student_first_name: string;
        student_last_name: string;
        enrollment_number: string;
        course_id: string;
        course_title: string;
        course_code: string;
        duration_months: number | null;
        course_start_date: string | null;
        completion_policy: CourseCompletionPolicy | null;
        batch_id: string;
        batch_name: string;
        batch_start_date: string | null;
        batch_end_date: string | null;
        branch_id: string | null;
        branch_name: string | null;
    }>(
        `SELECT 
            e.enrollment_id,
            e.status AS enrollment_status,
            e.enrolled_at::text,
            s.student_id,
            s.first_name AS student_first_name,
            s.last_name AS student_last_name,
            s.enrollment_number,
            c.course_id,
            c.title AS course_title,
            c.code AS course_code,
            c.duration_months,
            c.start_date::text AS course_start_date,
            c.completion_policy,
            b.batch_id,
            b.name AS batch_name,
            b.start_date::text AS batch_start_date,
            b.end_date::text AS batch_end_date,
            c.branch_id,
            br.name AS branch_name
        FROM academics.enrollments e
        JOIN academics.students s ON s.student_id = e.student_id AND s.tenant_id = e.tenant_id
        JOIN academics.batches b ON b.batch_id = e.batch_id AND b.tenant_id = e.tenant_id
        JOIN academics.courses c ON c.course_id = b.course_id AND c.tenant_id = e.tenant_id
        LEFT JOIN tenant.branches br ON br.branch_id = c.branch_id AND br.tenant_id = e.tenant_id
        WHERE e.enrollment_id = $1 AND e.tenant_id = $2`,
        [enrollmentId, tenantId]
    );

    if (!enrollment) return null;

    const policy: CourseCompletionPolicy = {
        ...DEFAULT_COMPLETION_POLICY,
        ...(enrollment.completion_policy || {})
    };

    // 2. Fetch conducted sessions and student attendance records for this batch
    // We look at both academics.class_sessions (conducted classes) and distinct attendance session_dates
    const sessionRows = await query<{
        conducted_sessions: number;
    }>(
        `SELECT COUNT(DISTINCT cs.session_date)::int AS conducted_sessions
         FROM academics.class_sessions cs
         WHERE cs.batch_id = $1 AND cs.tenant_id = $2 AND cs.status = 'conducted'`,
        [enrollment.batch_id, tenantId]
    );

    const attendanceDateRows = await query<{
        attendance_dates: number;
    }>(
        `SELECT COUNT(DISTINCT ar.session_date)::int AS attendance_dates
         FROM academics.attendance_records ar
         WHERE ar.batch_id = $1 AND ar.tenant_id = $2`,
        [enrollment.batch_id, tenantId]
    );

    const sessionsConducted = Math.max(
        sessionRows[0]?.conducted_sessions ?? 0,
        attendanceDateRows[0]?.attendance_dates ?? 0
    );

    const attendanceBreakdown = await query<{
        status: string;
        cnt: number;
    }>(
        `SELECT ar.status, COUNT(*)::int AS cnt
         FROM academics.attendance_records ar
         WHERE ar.batch_id = $1 AND ar.student_id = $2 AND ar.tenant_id = $3
         GROUP BY ar.status`,
        [enrollment.batch_id, enrollment.student_id, tenantId]
    );

    let sessionsAttended = 0;
    let sessionsExcused = 0;
    let sessionsAbsent = 0;

    for (const row of attendanceBreakdown) {
        if (row.status === 'present' || row.status === 'late') {
            sessionsAttended += row.cnt;
        } else if (row.status === 'excused') {
            sessionsExcused += row.cnt;
        } else if (row.status === 'absent') {
            sessionsAbsent += row.cnt;
        }
    }

    const attendanceRate = sessionsConducted > 0
        ? Math.round((sessionsAttended / sessionsConducted) * 1000) / 10
        : 0;

    // 3. Fetch assessments/tests and student results for this batch
    const testRows = await query<{
        test_id: string;
        title: string;
        test_type: string;
        test_date: string;
        total_max_marks: number;
        student_marks: number | null;
        is_absent: boolean | null;
    }>(
        `SELECT 
            t.test_id,
            t.title,
            t.test_type,
            t.test_date::text,
            COALESCE(SUM(ts.max_marks), 0)::float AS total_max_marks,
            SUM(tr.marks_obtained)::float AS student_marks,
            BOOL_OR(tr.is_absent) AS is_absent
        FROM academics.tests t
        LEFT JOIN academics.test_subjects ts ON ts.test_id = t.test_id
        LEFT JOIN academics.test_results tr ON tr.test_id = t.test_id AND tr.student_id = $2 AND tr.tenant_id = $3
        WHERE t.batch_id = $1 AND t.tenant_id = $3 AND t.status IN ('completed', 'published')
        GROUP BY t.test_id, t.title, t.test_type, t.test_date
        ORDER BY t.test_date ASC, t.created_at ASC`,
        [enrollment.batch_id, enrollment.student_id, tenantId]
    );

    const minPassMarksPct = policy.minPassingMarks ?? 40;
    let assessmentsCompleted = 0;
    let assessmentsPassed = 0;
    let totalScoreObtained = 0;
    let totalMaxScore = 0;

    const testSummaries = testRows.map(t => {
        const hasResult = t.student_marks !== null && !t.is_absent;
        const maxMarks = t.total_max_marks || 100;
        let percentage: number | null = null;
        let passed = false;

        if (hasResult) {
            percentage = Math.round(((t.student_marks || 0) / maxMarks) * 1000) / 10;
            passed = percentage >= minPassMarksPct;
            assessmentsCompleted += 1;
            if (passed) assessmentsPassed += 1;
            totalScoreObtained += t.student_marks || 0;
            totalMaxScore += maxMarks;
        }

        return {
            testId: t.test_id,
            title: t.title,
            testType: t.test_type,
            testDate: t.test_date,
            maxMarks,
            marksObtained: hasResult ? t.student_marks : null,
            percentage,
            isAbsent: Boolean(t.is_absent),
            passed
        };
    });

    const averageScore = totalMaxScore > 0
        ? Math.round((totalScoreObtained / totalMaxScore) * 1000) / 10
        : 0;

    // 4. Calculate Duration Progress
    const effectiveStartDate = enrollment.course_start_date || enrollment.batch_start_date || enrollment.enrolled_at;
    let durationElapsedMonths = 0;
    let durationSatisfied = true;

    if (effectiveStartDate) {
        const start = new Date(effectiveStartDate);
        const now = new Date();
        durationElapsedMonths = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
    }

    const durationMonths = enrollment.duration_months;
    if (policy.checkDuration && durationMonths && durationMonths > 0) {
        durationSatisfied = durationElapsedMonths >= durationMonths;
    }

    // 5. Evaluate Individual Criteria Satisfactions
    const attendanceSatisfied = !policy.checkAttendance || attendanceRate >= (policy.minAttendancePct ?? 75);
    const sessionsSatisfied = !policy.checkSessions || sessionsConducted >= (policy.requiredSessions ?? 0);
    const assessmentsSatisfied = !policy.checkAssessments || assessmentsCompleted >= (policy.requiredAssessments ?? 1);
    const marksSatisfied = !policy.checkMarks || (assessmentsCompleted > 0 && averageScore >= minPassMarksPct);

    // 6. Check Eligibility and Build Detailed Unmet Reasons
    const unmetReasons: string[] = [];

    if (enrollment.enrollment_status === 'transferred') {
        unmetReasons.push('Enrollment has been transferred to another course/batch and cannot be completed.');
    } else if (enrollment.enrollment_status === 'dropped') {
        unmetReasons.push('Enrollment has been dropped.');
    } else {
        if (policy.checkDuration && durationMonths && !durationSatisfied) {
            unmetReasons.push(`Course duration incomplete: ${durationElapsedMonths} of ${durationMonths} months elapsed.`);
        }
        if (policy.checkSessions && policy.requiredSessions > 0 && !sessionsSatisfied) {
            unmetReasons.push(`Required sessions not met: ${sessionsConducted} conducted of ${policy.requiredSessions} required.`);
        }
        if (policy.checkAttendance && !attendanceSatisfied) {
            unmetReasons.push(`Attendance below minimum: ${attendanceRate}% achieved (minimum required: ${policy.minAttendancePct}%).`);
        }
        if (policy.checkAssessments && !assessmentsSatisfied) {
            unmetReasons.push(`Required assessments incomplete: ${assessmentsCompleted} completed of ${policy.requiredAssessments} required.`);
        }
        if (policy.checkMarks && !marksSatisfied) {
            if (assessmentsCompleted === 0) {
                unmetReasons.push('No graded assessments found to verify passing marks.');
            } else {
                unmetReasons.push(`Passing marks not achieved: average score is ${averageScore}% (minimum required: ${minPassMarksPct}%).`);
            }
        }
    }

    const isEligible = unmetReasons.length === 0 && enrollment.enrollment_status === 'enrolled';

    // 7. Fetch Existing Course Completion Record if any
    const [completionRecord] = await query<{
        completion_id: string;
        status: string;
        completion_date: string;
        final_result: string;
        attendance_rate: number;
        sessions_attended: number;
        sessions_total: number;
        assessments_completed: number;
        average_score: number;
        approved_by_actor_id: string | null;
        approved_by_name: string | null;
        remarks: string | null;
        return_remarks: string | null;
        created_at: string;
    }>(
        `SELECT 
            cc.completion_id,
            cc.status,
            cc.completion_date::text,
            cc.final_result,
            cc.attendance_rate::float,
            cc.sessions_attended,
            cc.sessions_total,
            cc.assessments_completed,
            cc.average_score::float,
            cc.approved_by_actor_id,
            u.full_name AS approved_by_name,
            cc.remarks,
            cc.return_remarks,
            cc.created_at::text
        FROM academics.course_completions cc
        LEFT JOIN identity_app.users u ON u.user_id = cc.approved_by_actor_id
        WHERE cc.enrollment_id = $1 AND cc.tenant_id = $2`,
        [enrollmentId, tenantId]
    );

    // 8. Fetch Financial Summary (Course completion is separate from fees)
    const financialRows = await query<{
        total_invoiced: number;
        total_paid: number;
        total_balance: number;
    }>(
        `SELECT 
            COALESCE(SUM(i.total_amount), 0)::float AS total_invoiced,
            COALESCE(SUM(i.paid_amount), 0)::float AS total_paid,
            COALESCE(SUM(i.balance_amount), 0)::float AS total_balance
        FROM billing.invoices i
        WHERE i.enrollment_id = $1 AND i.tenant_id = $2`,
        [enrollmentId, tenantId]
    );

    const fin = financialRows[0] || { total_invoiced: 0, total_paid: 0, total_balance: 0 };
    const financialSummary = {
        totalTuition: fin.total_invoiced,
        paidAmount: fin.total_paid,
        balanceAmount: fin.total_balance,
        isFeePaid: fin.total_balance <= 0
    };

    // 9. Composite Academic Progress Percentage (Weighted average: 50% attendance/sessions + 50% assessments)
    let overallProgressPct = 0;
    if (policy.checkSessions && policy.requiredSessions > 0) {
        const sessionProgress = Math.min(100, Math.round((sessionsConducted / policy.requiredSessions) * 100));
        const testProgress = policy.requiredAssessments > 0 ? Math.min(100, Math.round((assessmentsCompleted / policy.requiredAssessments) * 100)) : 100;
        overallProgressPct = Math.round((sessionProgress * 0.5) + (testProgress * 0.5));
    } else {
        const attProgress = Math.min(100, Math.round((attendanceRate / (policy.minAttendancePct || 75)) * 100));
        const testProgress = policy.requiredAssessments > 0 ? Math.min(100, Math.round((assessmentsCompleted / policy.requiredAssessments) * 100)) : 100;
        overallProgressPct = Math.min(100, Math.round((attProgress * 0.5) + (testProgress * 0.5)));
    }

    if (enrollment.enrollment_status === 'completed') {
        overallProgressPct = 100;
    }

    return {
        enrollmentId: enrollment.enrollment_id,
        enrollmentStatus: enrollment.enrollment_status,
        studentId: enrollment.student_id,
        studentName: `${enrollment.student_first_name} ${enrollment.student_last_name}`.trim(),
        enrollmentNumber: enrollment.enrollment_number,
        courseId: enrollment.course_id,
        courseTitle: enrollment.course_title,
        courseCode: enrollment.course_code,
        batchId: enrollment.batch_id,
        batchName: enrollment.batch_name,
        branchId: enrollment.branch_id,
        branchName: enrollment.branch_name,
        startDate: enrollment.course_start_date || enrollment.batch_start_date,
        endDate: enrollment.batch_end_date,
        durationMonths,
        durationElapsedMonths,
        durationSatisfied,
        sessionsTotal: sessionsConducted,
        sessionsAttended,
        sessionsExcused,
        sessionsAbsent,
        attendanceRate,
        attendanceSatisfied,
        sessionsSatisfied,
        assessmentsTotal: testRows.length,
        assessmentsCompleted,
        assessmentsPassed,
        assessmentsSatisfied,
        averageScore,
        marksSatisfied,
        tests: testSummaries,
        isEligible,
        unmetReasons,
        completionRecord: completionRecord ? {
            completionId: completionRecord.completion_id,
            status: completionRecord.status,
            completionDate: completionRecord.completion_date,
            finalResult: completionRecord.final_result,
            attendanceRate: completionRecord.attendance_rate,
            sessionsAttended: completionRecord.sessions_attended,
            sessionsTotal: completionRecord.sessions_total,
            assessmentsCompleted: completionRecord.assessments_completed,
            averageScore: completionRecord.average_score,
            approvedByActorId: completionRecord.approved_by_actor_id,
            approvedByName: completionRecord.approved_by_name,
            remarks: completionRecord.remarks,
            returnRemarks: completionRecord.return_remarks,
            createdAt: completionRecord.created_at,
        } : null,
        financialSummary,
        completionPolicy: policy,
        overallProgressPct
    };
}

/**
 * Lists candidates for course completion review across branches, courses, and batches.
 */
export async function listCourseCompletionCandidates(
    tenantId: string,
    filter: {
        branchId?: string;
        courseId?: string;
        batchId?: string;
        status?: string; // 'all', 'enrolled', 'completed', 'eligible', 'pending_approval', 'returned'
    } = {}
): Promise<StudentCourseProgress[]> {
    let sql = `
        SELECT e.enrollment_id
        FROM academics.enrollments e
        JOIN academics.batches b ON b.batch_id = e.batch_id AND b.tenant_id = e.tenant_id
        JOIN academics.courses c ON c.course_id = b.course_id AND c.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1
    `;
    const params: any[] = [tenantId];

    if (filter.branchId && filter.branchId !== 'all') {
        params.push(filter.branchId);
        sql += ` AND (c.branch_id = $${params.length} OR b.branch_id = $${params.length})`;
    }

    if (filter.courseId && filter.courseId !== 'all') {
        params.push(filter.courseId);
        sql += ` AND c.course_id = $${params.length}`;
    }

    if (filter.batchId && filter.batchId !== 'all') {
        params.push(filter.batchId);
        sql += ` AND b.batch_id = $${params.length}`;
    }

    if (filter.status === 'completed') {
        sql += ` AND e.status = 'completed'`;
    } else if (filter.status === 'transferred') {
        sql += ` AND e.status = 'transferred'`;
    } else if (filter.status === 'enrolled') {
        sql += ` AND e.status = 'enrolled'`;
    }

    sql += ` ORDER BY e.enrolled_at DESC LIMIT 200`;

    const rows = await query<{ enrollment_id: string }>(sql, params);
    const results: StudentCourseProgress[] = [];

    for (const r of rows) {
        const prog = await calculateStudentCourseProgress(tenantId, r.enrollment_id);
        if (!prog) continue;

        if (filter.status === 'eligible' && !prog.isEligible) continue;
        if (filter.status === 'returned' && prog.completionRecord?.status !== 'returned') continue;
        if (filter.status === 'pending_approval' && (!prog.isEligible || prog.enrollmentStatus === 'completed')) continue;

        results.push(prog);
    }

    return results;
}

/**
 * Approves a course completion for a student enrollment.
 * Idempotently finalizes the course, sets enrollment status = 'completed',
 * writes completion record with snapshot, and logs audit compliance.
 */
export async function approveCourseCompletion(
    tenantId: string,
    actorId: string,
    params: {
        enrollmentId: string;
        finalResult?: string;
        remarks?: string;
        forceApprove?: boolean;
    }
): Promise<{ success: boolean; completionId: string; message: string }> {
    const progress = await calculateStudentCourseProgress(tenantId, params.enrollmentId);
    if (!progress) {
        throw new Error('Course enrollment record not found.');
    }

    if (progress.enrollmentStatus === 'transferred') {
        throw new Error('Cannot complete a transferred enrollment. Transferred enrollments must remain Transferred.');
    }

    if (progress.enrollmentStatus === 'completed') {
        throw new Error('This course enrollment has already been completed.');
    }

    if (!progress.isEligible && !params.forceApprove) {
        throw new Error(`Student is not yet eligible for course completion: ${progress.unmetReasons.join('; ')}`);
    }

    const finalResult = params.finalResult?.trim() || (
        progress.averageScore >= 85 ? 'Distinction' :
        progress.averageScore >= 60 ? 'First Class' :
        progress.averageScore >= 40 ? 'Passed' : 'Completed'
    );

    const snapshot = {
        studentId: progress.studentId,
        studentName: progress.studentName,
        courseId: progress.courseId,
        courseTitle: progress.courseTitle,
        batchId: progress.batchId,
        batchName: progress.batchName,
        attendanceRate: progress.attendanceRate,
        sessionsAttended: progress.sessionsAttended,
        sessionsTotal: progress.sessionsTotal,
        assessmentsCompleted: progress.assessmentsCompleted,
        averageScore: progress.averageScore,
        financialSummary: progress.financialSummary,
        completionDate: new Date().toISOString().split('T')[0],
    };

    // 1. Insert or update academics.course_completions
    const [rec] = await query<{ completion_id: string }>(
        `INSERT INTO academics.course_completions (
            tenant_id, enrollment_id, student_id, course_id, batch_id,
            status, completion_date, final_result, attendance_rate,
            sessions_attended, sessions_total, assessments_completed,
            assessments_total, average_score, approved_by_actor_id,
            remarks, metrics_snapshot, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5,
            'completed', CURRENT_DATE, $6, $7,
            $8, $9, $10,
            $11, $12, $13,
            $14, $15::jsonb, clock_timestamp()
        )
        ON CONFLICT (enrollment_id) DO UPDATE SET
            status = 'completed',
            completion_date = CURRENT_DATE,
            final_result = EXCLUDED.final_result,
            attendance_rate = EXCLUDED.attendance_rate,
            sessions_attended = EXCLUDED.sessions_attended,
            sessions_total = EXCLUDED.sessions_total,
            assessments_completed = EXCLUDED.assessments_completed,
            average_score = EXCLUDED.average_score,
            approved_by_actor_id = EXCLUDED.approved_by_actor_id,
            remarks = EXCLUDED.remarks,
            metrics_snapshot = EXCLUDED.metrics_snapshot,
            updated_at = clock_timestamp()
        RETURNING completion_id`,
        [
            tenantId,
            params.enrollmentId,
            progress.studentId,
            progress.courseId,
            progress.batchId,
            finalResult,
            progress.attendanceRate,
            progress.sessionsAttended,
            progress.sessionsTotal,
            progress.assessmentsCompleted,
            progress.assessmentsTotal,
            progress.averageScore,
            actorId,
            params.remarks?.trim() || null,
            JSON.stringify(snapshot)
        ]
    );

    // 2. Update academics.enrollments status = 'completed'
    await query(
        `UPDATE academics.enrollments
         SET status = 'completed'
         WHERE enrollment_id = $1 AND tenant_id = $2`,
        [params.enrollmentId, tenantId]
    );

    // 3. Write compliance audit log
    await query(
        `INSERT INTO audit.compliance_logs (
            tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details
        ) VALUES (
            $1, $2, 'course.complete', 'course_completion', $3, gen_random_uuid()::text, $4::jsonb
        )`,
        [
            tenantId,
            actorId,
            rec.completion_id,
            JSON.stringify({
                enrollmentId: params.enrollmentId,
                studentId: progress.studentId,
                courseId: progress.courseId,
                courseTitle: progress.courseTitle,
                finalResult,
                remarks: params.remarks || null
            })
        ]
    );

    return {
        success: true,
        completionId: rec.completion_id,
        message: `Course "${progress.courseTitle}" successfully marked as completed with result: ${finalResult}.`
    };
}

/**
 * Returns a course completion request for review with required staff remarks.
 */
export async function returnCourseCompletion(
    tenantId: string,
    actorId: string,
    params: {
        enrollmentId: string;
        remarks: string;
    }
): Promise<{ success: boolean; message: string }> {
    if (!params.remarks?.trim()) {
        throw new Error('Remarks are required when returning a completion request for review.');
    }

    const progress = await calculateStudentCourseProgress(tenantId, params.enrollmentId);
    if (!progress) {
        throw new Error('Course enrollment record not found.');
    }

    if (progress.enrollmentStatus === 'completed') {
        throw new Error('Cannot return an already completed course enrollment.');
    }

    await query(
        `INSERT INTO academics.course_completions (
            tenant_id, enrollment_id, student_id, course_id, batch_id,
            status, completion_date, final_result, attendance_rate,
            sessions_attended, sessions_total, assessments_completed,
            average_score, approved_by_actor_id, return_remarks, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5,
            'returned', CURRENT_DATE, 'Pending Review', $6,
            $7, $8, $9,
            $10, $11, $12, clock_timestamp()
        )
        ON CONFLICT (enrollment_id) DO UPDATE SET
            status = 'returned',
            return_remarks = EXCLUDED.return_remarks,
            approved_by_actor_id = EXCLUDED.approved_by_actor_id,
            updated_at = clock_timestamp()`,
        [
            tenantId,
            params.enrollmentId,
            progress.studentId,
            progress.courseId,
            progress.batchId,
            progress.attendanceRate,
            progress.sessionsAttended,
            progress.sessionsTotal,
            progress.assessmentsCompleted,
            progress.averageScore,
            actorId,
            params.remarks.trim()
        ]
    );

    // Audit log
    await query(
        `INSERT INTO audit.compliance_logs (
            tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details
        ) VALUES (
            $1, $2, 'course.return_review', 'course_completion', $3, gen_random_uuid()::text, $4::jsonb
        )`,
        [
            tenantId,
            actorId,
            params.enrollmentId,
            JSON.stringify({
                enrollmentId: params.enrollmentId,
                studentId: progress.studentId,
                courseTitle: progress.courseTitle,
                returnRemarks: params.remarks.trim()
            })
        ]
    );

    return {
        success: true,
        message: `Course completion returned for review with remarks: "${params.remarks.trim()}".`
    };
}
