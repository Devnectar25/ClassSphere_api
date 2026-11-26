import { NextRequest, NextResponse } from 'next/server';
import { callFn, query, withTransaction } from '@/lib/db/db';
import { generatePassword, hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { can } from '@/lib/auth';
import { ok, fail, problem } from '@/lib/api/respond';
import { requireAssignedBatch, requireStudentInScope, staffScope, studentIdsInScope } from '@/lib/api/scope';
import { billingError, getCreditBalance, getEnrollment, getEnrollmentFinancials, parseAmount } from '@/lib/billing/credit-ledger';
import { carryForwardShortfall } from '@/lib/billing/installment-carry';
import { academyToday, assertInstallmentsWithinCourse, getBatchPeriod, getCoursePeriod } from '@/lib/billing/course-period';
import { assessConsumption, transferDay } from '@/lib/billing/fee-consumption';
import { parseDate } from '@/lib/billing/fee-plans';
import { parseFeePlanInput } from '@/lib/billing/fee-plans';
import { executeCourseTransfer, listTransfers, type TransferResult, type TransferSummary } from '@/lib/billing/course-transfer';
import { generateReceiptNumber } from '@/lib/billing/fee-installments';
import { calculateStudentCourseProgress } from '@/lib/academics/course-completion';

/**
 * Students Directory & Enrollment API — branch-scoped
 * Traceability: TDD Section 10.4, PLT-003, PLT-006
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'students.read');
    if (context instanceof Response) return context;
    const searchParams = req.nextUrl.searchParams;

    // Fast next student ID suggestion endpoint
    if (searchParams.get('action') === 'next-id') {
        try {
            const rows = await query<{ max_seq: number }>(
                `SELECT COALESCE(MAX(
                    CASE 
                        WHEN enrollment_number ~* '^STUD-([0-9]+)$' THEN
                            SUBSTRING(enrollment_number FROM '^STUD-([0-9]+)$')::INT
                        ELSE 0
                    END
                ), 0) + 1 AS max_seq
                FROM academics.students
                WHERE tenant_id = $1`,
                [context.tenantId]
            );
            let nextSeq = rows[0]?.max_seq || 1;
            let candidate = `STUD-${String(nextSeq).padStart(2, '0')}`;
            while (true) {
                const dupCheck = await query<{ student_id: string }>(
                    `SELECT student_id FROM academics.students WHERE tenant_id = $1 AND enrollment_number = $2`,
                    [context.tenantId, candidate]
                );
                if (dupCheck.length === 0) break;
                nextSeq++;
                candidate = `STUD-${String(nextSeq).padStart(2, '0')}`;
            }
            return ok(context, { nextId: candidate });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    // Single student profile & complete course enrollments endpoint
    const studentIdParam = searchParams.get('studentId');
    if (studentIdParam) {
        try {
            await requireStudentInScope(context, studentIdParam);
            const scope = await staffScope(context);
            const studentRows = await query<{
                student_id: string;
                enrollment_number: string;
                first_name: string;
                last_name: string;
                email: string;
                phone: string | null;
                date_of_birth: string | null;
                status: string;
                academic_standing: string | null;
                matriculation_year: number | null;
                branch_id: string | null;
                branch_name: string | null;
                photo: string | null;
                created_at: string;
            }>(
                `SELECT s.student_id, s.enrollment_number, s.first_name, s.last_name, s.email, s.phone,
                        s.date_of_birth, s.status, s.academic_standing, s.matriculation_year, s.branch_id,
                        br.name AS branch_name, s.profile->>'photo' AS photo, s.created_at
                 FROM academics.students s
                 LEFT JOIN tenant.branches br ON br.branch_id = s.branch_id
                 WHERE s.student_id = $1 AND s.tenant_id = $2`,
                [studentIdParam, context.tenantId]
            );

            if (studentRows.length === 0) {
                return problem(context, req, 404, 'Not Found', 'Student not found.');
            }

            const allEnrollments = await query<{
                enrollment_id: string;
                student_id: string;
                batch_id: string;
                batch_name: string;
                capacity: number;
                enrolled_count: number;
                course_id: string;
                course_title: string;
                course_code: string;
                tuition_amount: string;
                billing_period: string;
                branch_id: string;
                branch_name: string;
                status: string;
                enrolled_at: string;
                transfer_reason: string | null;
                remarks: string | null;
                transferred_at: string | null;
            }>(
                `SELECT e.enrollment_id, e.student_id, e.batch_id, b.name AS batch_name, b.capacity,
                        (SELECT COUNT(*) FROM academics.enrollments sub_e WHERE sub_e.batch_id = b.batch_id AND sub_e.status IN ('enrolled', 'confirmed', 'active', 'approved'))::int AS enrolled_count,
                        b.course_id, c.title AS course_title, c.code AS course_code, c.tuition_amount, c.billing_period,
                        b.branch_id, COALESCE(br.name, 'Main Campus') AS branch_name,
                        e.status, e.enrolled_at, e.transfer_reason, e.remarks, e.transferred_at
                 FROM academics.enrollments e
                 JOIN academics.batches b ON b.batch_id = e.batch_id
                 JOIN academics.courses c ON c.course_id = b.course_id
                 LEFT JOIN tenant.branches br ON br.branch_id = b.branch_id
                 WHERE e.student_id = $1 AND e.tenant_id = $2
                 ORDER BY e.enrolled_at DESC`,
                [studentIdParam, context.tenantId]
            );
            const enrollments = scope ? allEnrollments.filter(e => scope.batchIds.includes(e.batch_id)) : allEnrollments;

            // Fetch student invoices to calculate fee summary per enrollment
            const [studentInvoices, transferLogs, branchRows] = await Promise.all([
                query<{
                    invoice_id: string;
                    invoice_number: string | null;
                    designation: string;
                    total_amount: string;
                    paid_amount: string;
                    balance_amount: string;
                    due_date: string | null;
                    status: string;
                }>(
                    `SELECT invoice_id, invoice_number, designation, total_amount, paid_amount, balance_amount, due_date, status
                     FROM billing.invoices
                     WHERE student_id = $1 AND tenant_id = $2 AND status <> 'void'
                       AND ($3::uuid[] IS NULL OR enrollment_id IS NULL OR enrollment_id = ANY($3::uuid[]))
                     ORDER BY due_date ASC NULLS LAST, created_at ASC`,
                    [studentIdParam, context.tenantId, scope ? enrollments.map(e => e.enrollment_id) : null]
                ),
                query<{
                    log_id: string;
                    details: any;
                    created_at: string;
                }>(
                    `SELECT log_id, details, created_at
                     FROM audit.compliance_logs
                     WHERE action = 'student.course_transferred' AND entity_id = $1 AND tenant_id = $2
                     ORDER BY created_at DESC`,
                    [studentIdParam, context.tenantId]
                ),
                query<{ branch_id: string; name: string }>(
                    `SELECT branch_id, name FROM tenant.branches WHERE tenant_id = $1`,
                    [context.tenantId]
                )
            ]);

            const branchMap: Record<string, string> = {};
            for (const b of branchRows) {
                branchMap[b.branch_id] = b.name;
            }

            const student = studentRows[0];
            const [financialsList, academicProgressList] = await Promise.all([
                Promise.all(enrollments.map(async e => {
                    const info = await getEnrollment({ query }, context.tenantId, e.enrollment_id);
                    return [e.enrollment_id, await getEnrollmentFinancials({ query }, context.tenantId, info)] as const;
                })),
                Promise.all(enrollments.map(async e => {
                    return [e.enrollment_id, await calculateStudentCourseProgress(context.tenantId, e.enrollment_id)] as const;
                }))
            ]);
            const financials = new Map(financialsList);
            const academicProgressMap = new Map(academicProgressList);
            const creditBalance = await getCreditBalance({ query }, context.tenantId, studentIdParam);
            const recordedTransfers = new Map((await listTransfers({ query }, context.tenantId,
                { branchId: null, studentId: studentIdParam, transferId: null })).map(t => [t.transferId, t]));

            const transferList = transferLogs.map(l => {
                const d = l.details || {};
                const record = recordedTransfers.get(d.transferId);
                // Finance decides credit and fee plan after the transfer: show the current state, not the snapshot
                const f = !record ? (d.feeDetails || {}) : {
                    ...(d.feeDetails || {}),
                    oldCourseTotalFee: record.oldCourseFee, oldPaidAmount: record.oldPaid, oldOutstandingAmount: record.oldOutstanding,
                    consumedAmount: record.consumedAmount, availableCredit: record.eligibleCredit, newCourseBaseFee: record.plan?.netFee ?? record.newCourseFee,
                    approvedCreditAdjustment: record.plan?.creditApplied ?? 0, finalPayableAmount: record.plan?.payable ?? record.newCourseFee,
                    unusedRetainedCredit: Math.max(0, record.approvedCredit - (record.plan?.creditApplied ?? 0)),
                    newFeeStatus: record.feePlanStatus, creditStatus: record.creditStatus, feePlanStatus: record.feePlanStatus,
                };
                const fromEnr = enrollments.find(e => (e.course_title || '').toLowerCase() === (d.fromCourseTitle || '').toLowerCase());
                const toEnr = enrollments.find(e => (e.course_title || '').toLowerCase() === (d.toCourseTitle || '').toLowerCase());
                const toBranchName = d.toBranchName || (toEnr ? toEnr.branch_name : null) || branchMap[d.toBranchId] || 'Main Campus';
                const fromBranchName = d.fromBranchName || (fromEnr ? fromEnr.branch_name : null) || branchMap[d.fromBatchId] || student.branch_name || 'Main Campus';

                const oldTotalFee = Number(f.oldCourseTotalFee ?? (fromEnr ? fromEnr.tuition_amount : 0));
                const newCourseFee = Number(f.newCourseBaseFee ?? (toEnr ? toEnr.tuition_amount : 0));
                const creditAdj = Number(f.approvedCreditAdjustment ?? 0);
                const finalPayable = Number(f.finalPayableAmount ?? Math.max(0, newCourseFee - creditAdj));
                const selectedCreditOption = d.creditAdjustmentOption || f.creditAdjustmentOption || (creditAdj > 0 ? 'allowed' : 'not_allowed');
                const availableCredit = Number(f.availableCredit ?? f.verifiedUnusedCredit ?? 0);
                const consumedAmount = Number(f.consumedAmount ?? 0);
                const unusedRetainedCredit = Number(f.unusedRetainedCredit ?? Math.max(0, availableCredit - creditAdj));

                return {
                    transferId: l.log_id,
                    fromCourseTitle: d.fromCourseTitle || (fromEnr ? fromEnr.course_title : 'Previous Course'),
                    fromBatchName: d.fromBatchName || (fromEnr ? fromEnr.batch_name : 'Previous Batch'),
                    fromBranchName,
                    toCourseTitle: d.toCourseTitle || (toEnr ? toEnr.course_title : 'Destination Course'),
                    toBatchName: d.toBatchName || (toEnr ? toEnr.batch_name : 'Destination Batch'),
                    toBranchName,
                    transferDate: d.transferDate || l.created_at,
                    transferReason: d.transferReason || 'Course Transfer',
                    transferStatus: 'Transferred',
                    creditStatus: (record?.creditStatus ?? null) as string | null,
                    feePlanStatus: (record?.feePlanStatus ?? null) as string | null,
                    remarks: d.remarks || null,
                    selectedCreditOption,
                    availableCredit,
                    consumedAmount,
                    approvedCreditAdjustment: creditAdj,
                    unusedRetainedCredit,
                    finalPayableAmount: finalPayable,
                    previousFeeDetails: {
                        totalFee: oldTotalFee,
                        paidAmount: Number(f.oldPaidAmount ?? 0),
                        outstandingAmount: Number(f.oldOutstandingAmount ?? 0),
                        consumedAmount,
                        availableCredit,
                        waiveOldOutstanding: Boolean(f.waiveOldOutstanding),
                        waiverReason: f.waiverReason || null,
                    },
                    newFeeDetails: {
                        newCourseFee,
                        approvedCreditAdjustment: creditAdj,
                        finalPayableAmount: finalPayable,
                        feeStatus: f.newFeeStatus || 'pending'
                    }
                };
            });

            // Ensure any enrollment marked transferred has a record in transferList
            for (const e of enrollments.filter(enr => enr.status?.toLowerCase() === 'transferred')) {
                const alreadyIncluded = transferList.some(
                    t => (t.fromCourseTitle || '').toLowerCase() === (e.course_title || '').toLowerCase()
                );
                if (!alreadyIncluded) {
                    const activeOther = enrollments.find(o => o.status?.toLowerCase() !== 'transferred');
                    transferList.push({
                        transferId: `enr-${e.enrollment_id}`,
                        fromCourseTitle: e.course_title,
                        fromBatchName: e.batch_name,
                        fromBranchName: e.branch_name || 'Main Campus',
                        toCourseTitle: activeOther ? activeOther.course_title : 'Destination Course',
                        toBatchName: activeOther ? activeOther.batch_name : 'Destination Batch',
                        toBranchName: activeOther ? activeOther.branch_name : (e.branch_name || 'Main Campus'),
                        transferDate: e.transferred_at || e.enrolled_at,
                        transferReason: e.transfer_reason || 'Course Transfer',
                        transferStatus: 'Transferred',
                        creditStatus: null,
                        feePlanStatus: null,
                        remarks: e.remarks || null,
                        selectedCreditOption: 'not_allowed',
                        availableCredit: 0,
                        consumedAmount: 0,
                        approvedCreditAdjustment: 0,
                        unusedRetainedCredit: 0,
                        finalPayableAmount: activeOther ? Number(activeOther.tuition_amount) || 0 : 0,
                        previousFeeDetails: {
                            totalFee: Number(e.tuition_amount) || 0,
                            paidAmount: 0,
                            outstandingAmount: 0,
                            consumedAmount: 0,
                            availableCredit: 0,
                            waiveOldOutstanding: false,
                            waiverReason: null,
                        },
                        newFeeDetails: {
                            newCourseFee: activeOther ? Number(activeOther.tuition_amount) || 0 : 0,
                            approvedCreditAdjustment: 0,
                            finalPayableAmount: activeOther ? Number(activeOther.tuition_amount) || 0 : 0,
                            feeStatus: 'active'
                        }
                    });
                }
            }
            return ok(context, {
                student: {
                    studentId: student.student_id,
                    enrollmentNumber: student.enrollment_number,
                    firstName: student.first_name,
                    lastName: student.last_name,
                    email: student.email,
                    phone: student.phone,
                    dateOfBirth: student.date_of_birth,
                    status: student.status,
                    academicStanding: student.academic_standing,
                    matriculationYear: student.matriculation_year,
                    branchId: student.branch_id,
                    branchName: student.branch_name,
                    photo: student.photo,
                    createdAt: student.created_at
                },
                enrollments: enrollments.map(e => {
                    const fin = financials.get(e.enrollment_id)!;
                    const totalFee = fin.courseFee;
                    const paidAmount = fin.verifiedPaid;
                    const outstandingAmount = fin.outstanding;
                    const consumedAmount = fin.previouslyConsumed;
                    // Upper limit only: the consumed fee is confirmed by Finance at transfer
                    const availableCredit = fin.unusedCeiling;
                    const unusedCredit = fin.unusedCeiling;

                    return {
                        enrollmentId: e.enrollment_id,
                        studentId: e.student_id,
                        batchId: e.batch_id,
                        batchName: e.batch_name,
                        capacity: e.capacity,
                        enrolledCount: e.enrolled_count,
                        courseId: e.course_id,
                        courseTitle: e.course_title,
                        courseCode: e.course_code,
                        tuitionAmount: Number(e.tuition_amount) || 0,
                        oldCourseTotalFee: totalFee,
                        paidAmount,
                        outstandingAmount,
                        consumedAmount,
                        availableCredit,
                        unusedCredit,
                        creditReceived: fin.creditReceived,
                        pendingVerification: fin.pendingVerification,
                        hasDues: outstandingAmount > 0,
                        billingPeriod: e.billing_period,
                        branchId: e.branch_id,
                        branchName: e.branch_name,
                        status: e.status,
                        enrolledAt: e.enrolled_at,
                        transferReason: e.transfer_reason,
                        remarks: e.remarks,
                        transferredAt: e.transferred_at,
                        academicProgress: academicProgressMap.get(e.enrollment_id) || null
                    };
                }),
                invoices: studentInvoices.map(i => ({
                    invoiceId: i.invoice_id,
                    invoiceNumber: i.invoice_number || `INV-${i.invoice_id.slice(0, 8)}`,
                    designation: i.designation,
                    totalAmount: Number(i.total_amount) || 0,
                    paidAmount: Number(i.paid_amount) || 0,
                    balanceAmount: Number(i.balance_amount) || 0,
                    status: i.status,
                    dueDate: i.due_date || null
                })),
                feeSummary: {
                    totalFee: studentInvoices.reduce((sum, i) => sum + (Number(i.total_amount) || 0), 0),
                    paidAmount: studentInvoices.reduce((sum, i) => sum + (Number(i.paid_amount) || 0), 0),
                    balanceAmount: studentInvoices.reduce((sum, i) => sum + (Number(i.balance_amount) || 0), 0),
                },
                creditBalance,
                // Transfers name the student's other courses
                transfers: scope ? transferList.filter(t => enrollments.some(e => e.batch_name === t.toBatchName && e.course_title === t.toCourseTitle)) : transferList
            });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const branchParam = searchParams.get('branchId');
    const effectiveBranch = context.restrictedBranchId ?? ((branchParam && branchParam !== 'all') ? branchParam : (context.branchId || null));

    const courseParam = searchParams.get('courseId');
    const effectiveCourse = (courseParam && courseParam !== 'all') ? courseParam : null;

    const batchParam = searchParams.get('batchId');
    const effectiveBatch = (batchParam && batchParam !== 'all') ? batchParam : null;

    try {
        const allowed = await studentIdsInScope(context);
        const scope = await staffScope(context);
        if (allowed && scope) {
            // Staff: the same search, limited to the students of their batches
            const found = await callFn<{ students: Array<{ studentId: string; status: string }> }>('academics.fn_student_search',
                context.tenantId, effectiveBranch, searchParams.get('q') || null, null, 100000, 0,
                effectiveCourse && scope.courseIds.includes(effectiveCourse) ? effectiveCourse : effectiveCourse ? '00000000-0000-0000-0000-000000000000' : null,
                effectiveBatch && scope.batchIds.includes(effectiveBatch) ? effectiveBatch : effectiveBatch ? '00000000-0000-0000-0000-000000000000' : null);
            const mine = found.students.filter(s => allowed.has(s.studentId));
            const status = searchParams.get('status');
            const listed = status ? mine.filter(s => s.status === status) : mine;
            const statusCounts: Record<string, number> = {};
            for (const s of mine) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
            const page = listed.slice(offset, offset + limit);
            const names = new Map((await query<{ student_id: string; names: string }>(
                `SELECT e.student_id, string_agg(DISTINCT b.name, ', ' ORDER BY b.name) AS names FROM academics.enrollments e JOIN academics.batches b ON b.batch_id = e.batch_id
                 WHERE e.tenant_id = $1 AND e.student_id = ANY($2::uuid[]) AND e.batch_id = ANY($3::uuid[]) AND e.status IN ('enrolled', 'confirmed', 'active', 'approved') GROUP BY e.student_id`,
                [context.tenantId, page.map(s => s.studentId), scope.batchIds])).map(r => [r.student_id, r.names]));
            const res = ok(context, {
                total: listed.length, limit, offset, statusCounts, students: page.map(s => ({ ...s, batches: names.get(s.studentId) ?? null })),
            }) as NextResponse;
            res.headers.set('X-Total-Count', String(listed.length));
            return res;
        }
        const result = await callFn<{ total: number }>('academics.fn_student_search',
            context.tenantId, effectiveBranch, searchParams.get('q') || null, searchParams.get('status') || null, limit, offset, effectiveCourse, effectiveBatch);
        const res = ok(context, result) as NextResponse;
        res.headers.set('X-Total-Count', String(result.total));
        return res;
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'students.write');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();

        // Staff work only with their own students and batches; others are limited to their branch
        if (body.studentId) await requireStudentInScope(context, String(body.studentId));
        if (body.action === 'transfer-course') {
            await requireAssignedBatch(context, body.destinationBatchId, 'The destination batch is not assigned to you.');
            if (await staffScope(context)) {
                const [from] = await query<{ batch_id: string }>(`SELECT batch_id FROM academics.enrollments WHERE enrollment_id = $1 AND tenant_id = $2`, [String(body.currentEnrollmentId), context.tenantId]);
                await requireAssignedBatch(context, from?.batch_id);
            }
        } else {
            await requireAssignedBatch(context, body.batchId, 'Choose a batch that is assigned to you.');
        }

        // -------------------------------------------------------------
        // ACTION: Add Course / Multiple Course Enrollment
        // -------------------------------------------------------------
        if (body.action === 'add-course') {
            const studentId = String(body.studentId ?? '').trim();
            const branchId = String(body.branchId ?? '').trim();
            const courseId = String(body.courseId ?? '').trim();
            const batchId = String(body.batchId ?? '').trim();
            const enrollmentDateRaw = String(body.enrollmentDate ?? '').trim();
            const feePlanId = body.feePlanId ? String(body.feePlanId).trim() : null;
            const rawFeeAmount = body.feeAmount !== undefined && body.feeAmount !== null && body.feeAmount !== '' ? Number(body.feeAmount) : null;
            const feeStatus = body.feeStatus ? String(body.feeStatus).trim().toLowerCase() : 'none';

            // 1. Validate required fields
            if (!studentId || !branchId || !courseId || !batchId || !enrollmentDateRaw) {
                return problem(context, req, 400, 'Validation Error', 'Student, Branch, Course, Batch, and Enrollment Date are all required fields.');
            }

            const enrollmentDate = new Date(enrollmentDateRaw);
            if (isNaN(enrollmentDate.getTime())) {
                return problem(context, req, 400, 'Validation Error', 'Invalid enrollment date provided.');
            }

            // 2. Validate student exists and is active
            const studentRows = await query<{
                student_id: string;
                first_name: string;
                last_name: string;
                status: string;
                enrollment_number: string;
            }>(
                `SELECT student_id, first_name, last_name, status, enrollment_number
                 FROM academics.students
                 WHERE student_id = $1 AND tenant_id = $2`,
                [studentId, context.tenantId]
            );

            if (studentRows.length === 0) {
                return problem(context, req, 404, 'Not Found', 'Student not found.');
            }

            const student = studentRows[0];
            const inactiveStatuses = ['inactive', 'suspended', 'withdrawn', 'cancelled'];
            if (inactiveStatuses.includes(student.status.toLowerCase())) {
                return problem(context, req, 403, 'Forbidden', `Cannot enroll student with status '${student.status}'. Inactive or suspended students cannot be enrolled without reactivation.`);
            }

            // 3. Verify batch belongs to selected course and branch
            const batchRows = await query<{
                batch_id: string;
                name: string;
                course_id: string;
                branch_id: string | null;
                capacity: number;
                course_title: string;
                tuition_amount: string;
            }>(
                `SELECT b.batch_id, b.name, b.course_id, b.branch_id, b.capacity,
                        c.title AS course_title, c.tuition_amount
                 FROM academics.batches b
                 JOIN academics.courses c ON c.course_id = b.course_id
                 WHERE b.batch_id = $1 AND b.tenant_id = $2`,
                [batchId, context.tenantId]
            );

            if (batchRows.length === 0) {
                return problem(context, req, 404, 'Not Found', 'Selected batch does not exist.');
            }

            const batch = batchRows[0];
            if (batch.course_id !== courseId) {
                return problem(context, req, 400, 'Validation Error', `Batch '${batch.name}' belongs to a different course.`);
            }

            if (batch.branch_id && batch.branch_id !== branchId) {
                return problem(context, req, 400, 'Validation Error', `Batch '${batch.name}' does not belong to the selected branch.`);
            }

            // Also check branch scope if context is branch-scoped
            if (context.branchId && branchId !== context.branchId) {
                return problem(context, req, 403, 'Forbidden', 'Cannot enroll student into another branch batch.');
            }

            // 4. Check batch capacity
            const countRows = await query<{ enrolled_count: string }>(
                `SELECT COUNT(*)::text AS enrolled_count
                 FROM academics.enrollments
                 WHERE batch_id = $1 AND tenant_id = $2 AND status IN ('enrolled', 'confirmed', 'active', 'approved')`,
                [batchId, context.tenantId]
            );
            const currentEnrolled = parseInt(countRows[0]?.enrolled_count || '0', 10);
            const capacity = Number(batch.capacity) || 25;
            if (capacity > 0 && currentEnrolled >= capacity) {
                return problem(context, req, 400, 'Batch Full', `Selected batch '${batch.name}' has reached its maximum capacity (${currentEnrolled}/${capacity} seats).`);
            }

            // 5. Prevent duplicate active enrollment in the same course
            const dupCheck = await query<{ enrollment_id: string; batch_name: string }>(
                `SELECT e.enrollment_id, b.name AS batch_name
                 FROM academics.enrollments e
                 JOIN academics.batches b ON b.batch_id = e.batch_id
                 WHERE e.student_id = $1
                   AND b.course_id = $2
                   AND e.tenant_id = $3
                   AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')`,
                [studentId, courseId, context.tenantId]
            );

            if (dupCheck.length > 0) {
                return problem(context, req, 409, 'Conflict', `Student is already actively enrolled in this course ("${batch.course_title}") in batch "${dupCheck[0].batch_name}". Duplicate active enrollments in the same course are not allowed.`);
            }

            // 6. Create or update enrollment record for this student and batch
            const enrollmentRes = await query<{ enrollment_id: string }>(
                `INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status, enrolled_at)
                 VALUES ($1, $2, $3, 'enrolled', $4)
                 ON CONFLICT (student_id, batch_id)
                 DO UPDATE SET status = 'enrolled', enrolled_at = EXCLUDED.enrolled_at
                 RETURNING enrollment_id`,
                [context.tenantId, studentId, batchId, enrollmentDate.toISOString()]
            );
            const enrollmentId = enrollmentRes[0]?.enrollment_id;

            // 7. Process Fee Plan & Invoices if feeStatus is pending or paid
            let invoiceId: string | null = null;
            if (feeStatus === 'pending' || feeStatus === 'paid') {
                let amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : 0;
                if (amount === 0 && Number(batch.tuition_amount) > 0) {
                    amount = Number(batch.tuition_amount);
                }

                // If fee plan specified, apply discount if applicable
                if (feePlanId) {
                    const planRows = await query<{ discount_percent: string }>(
                        `SELECT discount_percent FROM billing.fee_plans WHERE plan_id = $1 AND tenant_id = $2`,
                        [feePlanId, context.tenantId]
                    );
                    if (planRows.length > 0) {
                        const discount = Number(planRows[0].discount_percent) || 0;
                        if (discount > 0 && amount > 0) {
                            amount = Math.round(amount * (1 - discount / 100));
                        }
                    }
                }

                if (amount > 0) {
                    const now = new Date();
                    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
                    const period = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
                    const invCountRows = await query<{ count: string }>(
                        `SELECT COUNT(*) as count FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                        [context.tenantId, `INV-${yyyymm}-%`]
                    );
                    const seq = parseInt(invCountRows[0]?.count || '0', 10) + 1;
                    const invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                    const designation = `${batch.course_title ? batch.course_title.trim() + ' ' : ''}Tuition (${batch.name}) — ${period}`;
                    const isPaid = feeStatus === 'paid';
                    const dueDate = isPaid ? now : new Date(Date.now() + 15 * 86400000);

                    const invRows = await query<{ invoice_id: string }>(
                        `INSERT INTO billing.invoices (
                            tenant_id, invoice_number, student_id, billing_period,
                            subtotal_amount, total_amount, paid_amount, balance_amount,
                            due_date, status, designation, idempotency_key, enrollment_id
                        ) VALUES (
                            $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12
                        ) RETURNING invoice_id`,
                        [
                            context.tenantId,
                            invNo,
                            studentId,
                            period,
                            amount,
                            isPaid ? amount : 0,
                            isPaid ? 0 : amount,
                            dueDate,
                            isPaid ? 'paid' : 'pending',
                            designation,
                            `ac-${studentId.slice(0, 12)}-${batchId.slice(0, 12)}-${Date.now()}`,
                            enrollmentId
                        ]
                    );

                    invoiceId = invRows[0]?.invoice_id;

                    if (isPaid && invoiceId) {
                        const rcpNo = generateReceiptNumber();
                        await query(
                            `INSERT INTO billing.payments (
                                tenant_id, invoice_id, student_id, payment_reference, amount,
                                payment_method, status, receipt_number, recorded_by_actor_id
                            ) VALUES (
                                $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                            )`,
                            [
                                context.tenantId,
                                invoiceId,
                                studentId,
                                `ENR-${student.enrollment_number || studentId.slice(0, 8)}`,
                                amount,
                                rcpNo,
                                context.actorId
                            ]
                        );
                    }
                }
            }

            // 8. Audit log
            await query(
                `INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
                 VALUES ($1, $2, 'student.course_enrolled', 'student', $3, gen_random_uuid(), $4::jsonb)`,
                [
                    context.tenantId,
                    context.actorId,
                    studentId,
                    JSON.stringify({
                        courseId,
                        courseTitle: batch.course_title,
                        batchId,
                        batchName: batch.name,
                        branchId,
                        enrollmentId,
                        invoiceId,
                        enrolledAt: enrollmentDate.toISOString()
                    })
                ]
            );

            return ok(context, {
                success: true,
                message: `Successfully enrolled ${student.first_name} ${student.last_name} in ${batch.course_title} (${batch.name}).`,
                enrollmentId,
                courseTitle: batch.course_title,
                batchName: batch.name,
                studentId
            }, 201);
        }

        // -------------------------------------------------------------
        // ACTION: Course Transfer
        // -------------------------------------------------------------
        if (body.action === 'transfer-course') {
            const studentId = String(body.studentId ?? '').trim();
            const currentEnrollmentId = String(body.currentEnrollmentId ?? '').trim();
            const destinationBranchId = String(body.destinationBranchId ?? '').trim();
            const destinationCourseId = String(body.destinationCourseId ?? '').trim();
            const destinationBatchId = String(body.destinationBatchId ?? '').trim();
            const transferDateRaw = String(body.transferDate ?? '').trim();
            const transferReason = String(body.transferReason ?? '').trim();
            const remarks = body.remarks ? String(body.remarks).trim() : null;

            // Finance steps: credit review, waiver and new fee plan need billing.write; without it Finance completes them later
            const wantsFinance = Boolean(body.review || body.feePlan || body.waiveOldOutstanding);
            if (wantsFinance && !context.isPlatformAdmin && !can(context.actorRole, 'billing.write')) {
                return problem(context, req, 403, 'Forbidden', 'Credit approval, waivers and fee plans require Finance permission.');
            }
            const optionalAmount = (value: unknown, label: string) => (value === undefined || value === null || value === '' ? null : parseAmount(value, label));
            const review = body.review ? {
                decision: body.review.decision === 'reject' ? 'reject' as const : 'approve' as const,
                consumedAmount: optionalAmount(body.review.consumedAmount, 'Consumed fee'),
                approvedCredit: optionalAmount(body.review.approvedCredit, 'Approved credit'),
                notes: body.review.notes ? String(body.review.notes).trim().slice(0, 1000) || null : null,
            } : null;
            const feePlan = body.feePlan ? parseFeePlanInput(body.feePlan) : null;
            const waiverReason = body.waiverReason ? String(body.waiverReason).trim() : '';
            if (body.waiveOldOutstanding && !waiverReason) {
                return problem(context, req, 400, 'Validation Error', 'An authorization reason is required to waive old outstanding dues.');
            }

            // 1. Validate required fields
            if (!studentId || !currentEnrollmentId || !destinationBranchId || !destinationCourseId || !destinationBatchId || !transferDateRaw || !transferReason) {
                return problem(context, req, 400, 'Validation Error', 'Student, current enrollment, destination branch, destination course, destination batch, transfer date, and transfer reason are all required.');
            }

            const transferDate = new Date(transferDateRaw);
            if (isNaN(transferDate.getTime())) {
                return problem(context, req, 400, 'Validation Error', 'Invalid transfer date provided.');
            }
            // The transfer takes effect at once, so it cannot be dated ahead
            if (transferDay(transferDate) > await academyToday({ query }, context.tenantId)) {
                return problem(context, req, 400, 'Validation Error', 'The transfer date cannot be in the future.');
            }

            // 2. Validate student exists and is active
            const studentRows = await query<{
                student_id: string;
                first_name: string;
                last_name: string;
                status: string;
                enrollment_number: string;
            }>(
                `SELECT student_id, first_name, last_name, status, enrollment_number
                 FROM academics.students
                 WHERE student_id = $1 AND tenant_id = $2`,
                [studentId, context.tenantId]
            );

            if (studentRows.length === 0) {
                return problem(context, req, 404, 'Not Found', 'Student not found.');
            }

            const student = studentRows[0];
            const inactiveStatuses = ['inactive', 'suspended', 'withdrawn', 'cancelled'];
            if (inactiveStatuses.includes(student.status.toLowerCase())) {
                return problem(context, req, 403, 'Forbidden', `Cannot transfer course for student with status '${student.status}'. Inactive or suspended students must be reactivated first.`);
            }

            // 3. Validate current enrollment
            const currentEnrRows = await query<{
                enrollment_id: string;
                batch_id: string;
                status: string;
                course_id: string;
                course_title: string;
                batch_name: string;
                branch_id: string | null;
                branch_name: string;
                tuition_amount: string;
            }>(
                `SELECT e.enrollment_id, e.batch_id, e.status, e.enrolled_at, b.course_id, c.title AS course_title, b.name AS batch_name,
                        b.branch_id, COALESCE(br.name, 'Main Campus') AS branch_name, c.tuition_amount
                 FROM academics.enrollments e
                 JOIN academics.batches b ON b.batch_id = e.batch_id
                 JOIN academics.courses c ON c.course_id = b.course_id
                 LEFT JOIN tenant.branches br ON br.branch_id = b.branch_id
                 WHERE e.enrollment_id = $1 AND e.student_id = $2 AND e.tenant_id = $3`,
                [currentEnrollmentId, studentId, context.tenantId]
            );

            if (currentEnrRows.length === 0) {
                return problem(context, req, 404, 'Not Found', 'Current enrollment record not found.');
            }

            const currentEnr = currentEnrRows[0];
            const { enrollmentDate } = await assessConsumption({ query }, context.tenantId, await getEnrollment({ query }, context.tenantId, currentEnrollmentId), null);
            if (transferDay(transferDate) < enrollmentDate) {
                return problem(context, req, 400, 'Validation Error', `The transfer date cannot be before the enrollment date (${enrollmentDate}).`);
            }
            const activeEnrStatuses = ['enrolled', 'confirmed', 'active', 'approved'];
            if (!activeEnrStatuses.includes(currentEnr.status.toLowerCase())) {
                return problem(context, req, 400, 'Validation Error', `Cannot transfer enrollment with status '${currentEnr.status}'. Only active enrollments can be transferred.`);
            }

            // 4. Same batch check
            if (currentEnr.batch_id === destinationBatchId) {
                return problem(context, req, 400, 'Validation Error', 'Destination batch cannot be the same as the student\'s current batch.');
            }

            // 5. Destination course and batch verification
            const destBatchRows = await query<{
                batch_id: string;
                name: string;
                course_id: string;
                branch_id: string | null;
                branch_name: string;
                capacity: number;
                course_title: string;
                course_code: string;
                tuition_amount: string;
                enrolled_count: number;
                batch_status: string;
                is_active: boolean;
            }>(
                `SELECT b.batch_id, b.name, b.course_id, b.branch_id, COALESCE(br.name, 'Main Campus') AS branch_name, b.capacity, b.status AS batch_status, c.is_active,
                        c.title AS course_title, c.code AS course_code, c.tuition_amount,
                        (SELECT COUNT(*) FROM academics.enrollments sub_e 
                         WHERE sub_e.batch_id = b.batch_id 
                           AND sub_e.status IN ('enrolled', 'confirmed', 'active', 'approved'))::int AS enrolled_count
                 FROM academics.batches b
                 JOIN academics.courses c ON c.course_id = b.course_id
                 LEFT JOIN tenant.branches br ON br.branch_id = b.branch_id
                 WHERE b.batch_id = $1 AND b.tenant_id = $2`,
                [destinationBatchId, context.tenantId]
            );

            if (destBatchRows.length === 0) {
                return problem(context, req, 404, 'Not Found', 'Destination batch not found.');
            }

            const destBatch = destBatchRows[0];
            if (destBatch.course_id !== destinationCourseId) {
                return problem(context, req, 400, 'Validation Error', `Destination batch '${destBatch.name}' belongs to a different course.`);
            }

            if (destBatch.branch_id && destBatch.branch_id !== destinationBranchId) {
                return problem(context, req, 400, 'Validation Error', `Destination batch '${destBatch.name}' does not belong to the selected destination branch.`);
            }
            if (destBatch.is_active === false && destinationCourseId !== currentEnr.course_id) {
                return problem(context, req, 400, 'Validation Error', `Course '${destBatch.course_title}' is not active.`);
            }
            if (['completed', 'inactive', 'cancelled'].includes(String(destBatch.batch_status).toLowerCase())) {
                return problem(context, req, 400, 'Validation Error', `Batch '${destBatch.name}' is ${destBatch.batch_status}.`);
            }

            // Also check branch scope if context is branch-scoped
            if (context.branchId && destinationBranchId !== context.branchId) {
                return problem(context, req, 403, 'Forbidden', 'Cannot transfer student into another branch batch.');
            }

            // 6. Check destination batch capacity
            const destCapacity = Number(destBatch.capacity) || 25;
            if (destCapacity > 0 && destBatch.enrolled_count >= destCapacity) {
                return problem(context, req, 409, 'Batch Full', `Destination batch '${destBatch.name}' has reached maximum capacity (${destBatch.enrolled_count}/${destCapacity} seats).`);
            }

            // 7. Prevent duplicate active enrollment in destination course (if transferring to a different course)
            if (destinationCourseId !== currentEnr.course_id) {
                const dupCheck = await query<{ enrollment_id: string; batch_name: string }>(
                    `SELECT e.enrollment_id, b.name AS batch_name
                     FROM academics.enrollments e
                     JOIN academics.batches b ON b.batch_id = e.batch_id
                     WHERE e.student_id = $1
                       AND b.course_id = $2
                       AND e.tenant_id = $3
                       AND e.enrollment_id <> $4
                       AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')`,
                    [studentId, destinationCourseId, context.tenantId, currentEnrollmentId]
                );

                if (dupCheck.length > 0) {
                    return problem(context, req, 409, 'Duplicate Active Enrollment',
                        `Student already has an active enrollment in course '${destBatch.course_title}' (Batch: ${dupCheck[0].batch_name}). Transferring to this course would result in a duplicate active enrollment.`);
                }
            }

            // 8. Timetable conflict check:
            // Check if destination batch schedule overlaps with any OTHER active batch of the student (excluding current batch being transferred from)
            const conflictRows = await query<{
                weekday: number;
                dest_start: string;
                dest_end: string;
                conflicting_batch_name: string;
                conflicting_course_title: string;
                other_start: string;
                other_end: string;
            }>(
                `SELECT 
                    s_dest.weekday,
                    s_dest.start_time AS dest_start,
                    s_dest.end_time AS dest_end,
                    b_other.name AS conflicting_batch_name,
                    c_other.title AS conflicting_course_title,
                    s_other.start_time AS other_start,
                    s_other.end_time AS other_end
                 FROM academics.batch_schedules s_dest
                 JOIN academics.batch_schedules s_other 
                     ON s_dest.weekday = s_other.weekday
                     AND s_dest.start_time < s_other.end_time
                     AND s_dest.end_time > s_other.start_time
                 JOIN academics.enrollments e_other 
                     ON e_other.batch_id = s_other.batch_id
                     AND e_other.student_id = $1
                     AND e_other.status IN ('enrolled', 'confirmed', 'active', 'approved')
                     AND e_other.enrollment_id <> $2
                     AND e_other.tenant_id = $3
                 JOIN academics.batches b_other ON b_other.batch_id = s_other.batch_id
                 JOIN academics.courses c_other ON c_other.course_id = b_other.course_id
                 WHERE s_dest.batch_id = $4
                   AND s_dest.tenant_id = $3
                 LIMIT 1`,
                [studentId, currentEnrollmentId, context.tenantId, destinationBatchId]
            );

            if (conflictRows.length > 0) {
                const conf = conflictRows[0];
                const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
                const dayName = weekdayNames[conf.weekday] || `Day ${conf.weekday}`;
                return problem(context, req, 409, 'Timetable Conflict',
                    `Timetable conflict detected: Destination batch schedule on ${dayName} (${conf.dest_start.slice(0, 5)} - ${conf.dest_end.slice(0, 5)}) overlaps with student's active enrollment in ${conf.conflicting_course_title} (${conf.conflicting_batch_name}: ${conf.other_start.slice(0, 5)} - ${conf.other_end.slice(0, 5)}).`);
            }

            // 9. Transfer, credit review and fee plan succeed or fail together
            const perform = (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]): Promise<TransferResult> => executeCourseTransfer(tx, {
                tenantId: context.tenantId, actorId: context.actorId, studentId, fromEnrollmentId: currentEnrollmentId, toBatchId: destinationBatchId,
                transferDate, reason: transferReason, remarks, review, feePlan,
                waiver: body.waiveOldOutstanding ? { reason: waiverReason } : null,
            });
            // The review shows exactly what the transfer would do: it is carried out and rolled back
            if (body.dryRun === true) {
                let preview: TransferResult | null = null;
                const rollback = new Error('transfer preview');
                await withTransaction(async tx => {
                    preview = await perform(tx);
                    throw rollback;
                }).catch(err => {
                    if (err !== rollback) throw err;
                });
                const { summary, feePlan: plan, creditStatus, feePlanStatus, from, to } = preview!;
                return ok(context, {
                    dryRun: true, summary, creditStatus, feePlanStatus, from, to,
                    installments: plan?.installments.map(i => ({ installmentNumber: i.installmentNumber, dueDate: i.dueDate, gross: i.gross, credit: i.credit, payable: i.payable })) ?? null,
                });
            }
            const result: TransferResult = await withTransaction<TransferResult>(async tx => {
                const done: TransferResult = await perform(tx);
                // What was reviewed is what is saved: a payment or attendance change in between asks for another review
                const reviewed = body.reviewed as Record<string, unknown> | undefined;
                const changed = reviewed ? (['verifiedPaid', 'consumedAmount', 'eligibleCredit', 'approvedCredit', 'creditApplied', 'remainingCredit', 'payable', 'remainingOutstanding'] as const)
                    .filter(k => k in reviewed && (reviewed[k] ?? null) !== (done.summary[k] ?? null)) : [];
                if (changed.length > 0) throw billingError('conflict', 'The fee position has changed since it was reviewed. Review the transfer again.');
                return done;
            });

            const next = result.feePlanStatus === 'pending' ? ' Finance can now review the credit and create the new fee plan.' : '';
            return ok(context, {
                success: true,
                message: `Course successfully transferred from ${currentEnr.course_title} (${currentEnr.batch_name}) to ${destBatch.course_title} (${destBatch.name}).${next}`,
                fromCourseTitle: currentEnr.course_title,
                fromBatchName: currentEnr.batch_name,
                toCourseTitle: destBatch.course_title,
                toBatchName: destBatch.name,
                transferId: result.transferId,
                newEnrollmentId: result.newEnrollmentId,
                creditStatus: result.creditStatus,
                feePlanStatus: result.feePlanStatus,
                approvedCredit: result.approvedCredit,
                creditBalance: result.creditBalance,
                oldOutstanding: result.oldOutstanding,
                summary: result.summary,
                feePlan: result.feePlan,
                studentId
            }, 200);
        }

        // Entitlement limit check (PLT-005, PLT-006)
        const check = await callFn<{ allowed: boolean; maximum: number; planTier: string }>(
            'tenant.fn_entitlement_check', context.tenantId, 'seats');
        if (!check.allowed) {
            return problem(context, req, 402, 'Subscription Entitlement Exceeded',
                `Seat limit of ${check.maximum} reached for ${check.planTier} tier. Upgrade subscription to enroll more students.`);
        }
        const firstName = String(body.firstName ?? '').trim();
        const lastName = String(body.lastName ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        const rawPhone = String(body.phone ?? '').trim();
        const countryCode = String(body.countryCode ?? '+91').trim();
        const photo = typeof body.photo === 'string' && body.photo ? body.photo.trim() : null;
        const { dateOfBirth, matriculationYear, academicStanding, batchId, branchId } = body;

        if (!firstName || !lastName || !email) {
            return problem(context, req, 400, 'Validation Error', 'First name, last name, and email are required fields.');
        }
        if (firstName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(firstName)) {
            return problem(context, req, 400, 'Validation Error', 'First name must be at least 2 characters and contain only letters.');
        }
        if (lastName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(lastName)) {
            return problem(context, req, 400, 'Validation Error', 'Last name must be at least 2 characters and contain only letters.');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return problem(context, req, 400, 'Validation Error', 'Enter a valid email address.');
        }
        if (photo && !/^data:image\/(png|jpeg|webp|jpg);base64,/.test(photo)) {
            return problem(context, req, 400, 'Validation Error', 'Student photo must be a valid PNG, JPG, or WebP image data URL.');
        }

        let formattedPhone: string | null = null;
        if (rawPhone) {
            let localDigits = rawPhone;
            if (countryCode && localDigits.startsWith(countryCode)) {
                localDigits = localDigits.slice(countryCode.length).trim();
            } else if (localDigits.startsWith('+')) {
                const parts = localDigits.split(/\s+/);
                if (parts.length > 1) {
                    localDigits = parts.slice(1).join('');
                }
            }
            const phoneDigits = localDigits.replace(/\D/g, '');
            const isIndia = countryCode === '+91' || rawPhone.startsWith('+91') || (!countryCode && phoneDigits.length === 10);
            if (isIndia) {
                if (phoneDigits.length !== 10 || !/^[6-9]\d{9}$/.test(phoneDigits)) {
                    return problem(context, req, 400, 'Validation Error', 'Enter a valid 10-digit mobile number starting with 6, 7, 8, or 9.');
                }
            } else {
                if (phoneDigits.length < 7 || phoneDigits.length > 15) {
                    return problem(context, req, 400, 'Validation Error', 'Enter a valid mobile number for the selected country.');
                }
            }
            formattedPhone = `${countryCode} ${phoneDigits}`.trim();
        }

        // Validate guardian information if provided
        const guardian = body.guardian;
        let formattedGuardianPhone: string | null = null;
        if (guardian) {
            if (guardian.mode === 'existing') {
                if (!guardian.guardianId) {
                    return problem(context, req, 400, 'Validation Error', 'Please select an existing guardian to link.');
                }
            } else {
                const gFirstName = String(guardian.firstName ?? '').trim();
                const gLastName = String(guardian.lastName ?? '').trim();
                const gEmail = String(guardian.email ?? '').trim().toLowerCase();
                const gRawPhone = String(guardian.phone ?? '').trim();
                const gCountryCode = String(guardian.countryCode ?? '+91').trim();

                if (!gFirstName || !gLastName) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian first and last name are required.');
                }
                if (gFirstName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(gFirstName)) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian first name must contain only letters and be at least 2 characters.');
                }
                if (gLastName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(gLastName)) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian last name must contain only letters and be at least 2 characters.');
                }
                if (!gEmail || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(gEmail)) {
                    return problem(context, req, 400, 'Validation Error', 'Enter a valid guardian email address.');
                }
                if (!gRawPhone) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian phone number is required.');
                }

                let gLocalDigits = gRawPhone;
                if (gCountryCode && gLocalDigits.startsWith(gCountryCode)) {
                    gLocalDigits = gLocalDigits.slice(gCountryCode.length).trim();
                } else if (gLocalDigits.startsWith('+')) {
                    const parts = gLocalDigits.split(/\s+/);
                    if (parts.length > 1) gLocalDigits = parts.slice(1).join('');
                }
                const gDigits = gLocalDigits.replace(/\D/g, '');
                const isGIndia = gCountryCode === '+91' || gRawPhone.startsWith('+91') || (!gCountryCode && gDigits.length === 10);
                if (isGIndia) {
                    if (gDigits.length !== 10 || !/^[6-9]\d{9}$/.test(gDigits)) {
                        return problem(context, req, 400, 'Validation Error', 'Enter a valid 10-digit mobile number for the guardian starting with 6, 7, 8, or 9.');
                    }
                } else {
                    if (gDigits.length < 7 || gDigits.length > 15) {
                        return problem(context, req, 400, 'Validation Error', 'Enter a valid mobile number for the guardian.');
                    }
                }
                formattedGuardianPhone = `${gCountryCode} ${gDigits}`.trim();
            }
        }

        // Process & validate Student ID (enrollment_number)
        const rawStudentCode = body.enrollmentNumber || body.studentCode || body.studentIdCode;
        let studentCode: string | null = null;
        if (typeof rawStudentCode === 'string' && rawStudentCode.trim()) {
            studentCode = rawStudentCode.trim().toUpperCase();
            if (!/^[A-Z0-9_-]{2,30}$/.test(studentCode)) {
                return problem(context, req, 400, 'Validation Error', 'Student ID must be 2 to 30 characters containing only letters, numbers, hyphens, and underscores (e.g. STUD-01).');
            }
            const existingCode = await query<{ student_id: string }>(
                `SELECT student_id FROM academics.students WHERE tenant_id = $1 AND enrollment_number = $2`,
                [context.tenantId, studentCode]
            );
            if (existingCode.length > 0) {
                return problem(context, req, 409, 'Conflict', `Student ID '${studentCode}' is already in use in your academy. Please choose a unique Student ID.`);
            }
        } else {
            // Auto-generate next sequential STUD-XX
            const rows = await query<{ max_seq: number }>(
                `SELECT COALESCE(MAX(
                    CASE 
                        WHEN enrollment_number ~* '^STUD-([0-9]+)$' THEN
                            SUBSTRING(enrollment_number FROM '^STUD-([0-9]+)$')::INT
                        ELSE 0
                    END
                ), 0) + 1 AS max_seq
                FROM academics.students
                WHERE tenant_id = $1`,
                [context.tenantId]
            );
            let nextSeq = rows[0]?.max_seq || 1;
            let candidate = `STUD-${String(nextSeq).padStart(2, '0')}`;
            while (true) {
                const dupCheck = await query<{ student_id: string }>(
                    `SELECT student_id FROM academics.students WHERE tenant_id = $1 AND enrollment_number = $2`,
                    [context.tenantId, candidate]
                );
                if (dupCheck.length === 0) break;
                nextSeq++;
                candidate = `STUD-${String(nextSeq).padStart(2, '0')}`;
            }
            studentCode = candidate;
        }

        // Installments chosen at registration must be paid within the course
        const planned: Array<{ dueDate?: string }> = Array.isArray(body.feeStructure?.installments) ? body.feeStructure.installments : [];
        if (planned.length > 1 || (planned.length === 1 && body.feeStructure.paymentType === 'installment')) {
            const dates = planned.map((i, n) => parseDate(i.dueDate, `Due date of installment ${n + 1}`));
            if (dates.some((d, n) => n > 0 && d <= dates[n - 1])) {
                return problem(context, req, 400, 'Validation Error', 'Due dates must be in order, each later than the one before.');
            }
            const courseId = body.courseId || body.feeStructure.courseId;
            const period = batchId ? await getBatchPeriod({ query }, context.tenantId, batchId)
                : courseId ? await getCoursePeriod({ query }, context.tenantId, courseId) : null;
            if (period) assertInstallmentsWithinCourse(period, dates);
        }

        // Branch-scoped users always enroll into their own branch
        const result = await callFn<{ studentId: string; enrollmentNumber: string }>('academics.fn_student_create',
            context.tenantId, firstName, lastName, email, formattedPhone, dateOfBirth || null, studentCode,
            matriculationYear || null, academicStanding || null, batchId || null,
            context.branchId ?? branchId ?? null, context.actorId);

        if (photo && result?.studentId) {
            await query(
                `UPDATE academics.students SET profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{photo}', $1::jsonb) WHERE student_id = $2 AND tenant_id = $3`,
                [JSON.stringify(photo), result.studentId, context.tenantId]
            );
        }

        // Process fee structure (One-time or Installments) or legacy fee status
        const feeStructure = body.feeStructure;
        if (result?.studentId && feeStructure && (Number(feeStructure.finalFee) > 0 || (Array.isArray(feeStructure.installments) && feeStructure.installments.length > 0))) {
            let courseTitle = feeStructure.courseTitle || '';
            if (!courseTitle && (body.courseId || batchId)) {
                if (batchId) {
                    const bRows = await query<{ course_title: string }>(
                        `SELECT c.title as course_title FROM academics.batches b JOIN academics.courses c ON c.course_id = b.course_id WHERE b.batch_id = $1 AND b.tenant_id = $2`,
                        [batchId, context.tenantId]
                    );
                    courseTitle = bRows[0]?.course_title || '';
                } else if (body.courseId) {
                    const cRows = await query<{ title: string }>(
                        `SELECT title FROM academics.courses WHERE course_id = $1 AND tenant_id = $2`,
                        [body.courseId, context.tenantId]
                    );
                    courseTitle = cRows[0]?.title || '';
                }
            }

            const now = new Date();
            const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
            const period = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });

            const maxInvRows = await query<{ max_inv: string | null }>(
                `SELECT MAX(invoice_number) as max_inv FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                [context.tenantId, `INV-${yyyymm}-%`]
            );
            let seq = 0;
            if (maxInvRows[0]?.max_inv) {
                const match = maxInvRows[0].max_inv.match(/INV-\d{6}-(\d+)/);
                if (match) seq = parseInt(match[1], 10);
            }
            const countRows = await query<{ count: string }>(
                `SELECT COUNT(*) as count FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                [context.tenantId, `INV-${yyyymm}-%`]
            );
            const initialCount = parseInt(countRows[0]?.count || '0', 10);
            if (initialCount > seq) seq = initialCount;

            const initialPayment = feeStructure.initialPayment;
            let remainingInitialPay = initialPayment && Number(initialPayment.amount) > 0 ? Number(initialPayment.amount) : 0;
            const payMethod = initialPayment?.paymentMethod || 'Cash';
            const payRef = initialPayment?.paymentReference || `ADM-${result.enrollmentNumber || result.studentId.slice(0, 8)}`;

            const installments: Array<{ installmentNumber: number; dueDate: string; amount: number; designation?: string }> =
                Array.isArray(feeStructure.installments) && feeStructure.installments.length > 0
                    ? feeStructure.installments
                    : [{
                        installmentNumber: 1,
                        dueDate: new Date().toISOString().split('T')[0],
                        amount: Number(feeStructure.finalFee || feeStructure.courseFee || 0),
                        designation: `${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition — ${period}`
                    }];

            let underpaidInvoiceId: string | null = null;
            for (let idx = 0; idx < installments.length; idx++) {
                const inst = installments[idx];
                seq++;
                let invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                while (true) {
                    const existing = await query<{ invoice_id: string }>(
                        `SELECT invoice_id FROM billing.invoices WHERE tenant_id = $1 AND invoice_number = $2 LIMIT 1`,
                        [context.tenantId, invNo]
                    );
                    if (existing.length === 0) break;
                    seq++;
                    invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                }
                const instAmount = Number(inst.amount) || 0;
                const dueDate = inst.dueDate ? new Date(inst.dueDate) : new Date(Date.now() + 15 * 86400000);
                const given = inst.designation?.trim();
                const named = given && courseTitle && !given.toLowerCase().includes(courseTitle.trim().toLowerCase())
                    ? `${given}: ${courseTitle.trim()} Tuition` : given;
                const designation = named || (installments.length > 1
                    ? `Installment ${inst.installmentNumber || (idx + 1)} of ${installments.length}: ${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition`
                    : `${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition — ${period}`);

                let paidAmount = 0;
                if (remainingInitialPay > 0) {
                    paidAmount = Math.min(instAmount, remainingInitialPay);
                    remainingInitialPay -= paidAmount;
                }
                const balanceAmount = Math.max(0, instAmount - paidAmount);
                const invStatus = balanceAmount <= 0 ? 'paid' : (paidAmount > 0 ? 'partially_paid' : 'pending');

                const invRows = await query<{ invoice_id: string }>(
                    `INSERT INTO billing.invoices (
                        tenant_id, invoice_number, student_id, billing_period,
                        subtotal_amount, total_amount, paid_amount, balance_amount,
                        due_date, status, designation, idempotency_key
                    ) VALUES (
                        $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11
                    ) RETURNING invoice_id`,
                    [
                        context.tenantId,
                        invNo,
                        result.studentId,
                        period,
                        instAmount,
                        paidAmount,
                        balanceAmount,
                        dueDate,
                        invStatus,
                        designation,
                        `student-create-inst-${result.studentId}-${idx}-${Date.now()}`
                    ]
                );

                // Less than the first installment was collected: the rest joins the remaining installments
                if (idx === 0 && paidAmount > 0 && balanceAmount > 0) underpaidInvoiceId = invRows[0]?.invoice_id ?? null;

                if (paidAmount > 0 && invRows.length > 0) {
                    const rcpNo = generateReceiptNumber();

                    await query(
                        `INSERT INTO billing.payments (
                            tenant_id, invoice_id, student_id, payment_reference, amount,
                            payment_method, status, receipt_number, recorded_by_actor_id
                        ) VALUES (
                            $1, $2, $3, $4, $5, $6, 'posted', $7, $8
                        )`,
                        [
                            context.tenantId,
                            invRows[0].invoice_id,
                            result.studentId,
                            payRef,
                            paidAmount,
                            payMethod,
                            rcpNo,
                            context.actorId
                        ]
                    );
                }
            }
            if (underpaidInvoiceId) {
                const invoiceId = underpaidInvoiceId;
                await withTransaction(tx => carryForwardShortfall(tx, { tenantId: context.tenantId, invoiceId, actorId: context.actorId }));
            }
        } else if (result?.studentId && (body.feeStatus === 'pending' || body.feeStatus === 'paid')) {
            const feeStatus = String(body.feeStatus).trim().toLowerCase();
            const rawFeeAmount = body.feeAmount !== undefined && body.feeAmount !== null && body.feeAmount !== '' ? Number(body.feeAmount) : null;
            let courseTitle = '';
            let amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : 0;

            if (batchId) {
                const batchRows = await query<{ course_title: string; tuition_amount: string }>(
                    `SELECT c.title as course_title, c.tuition_amount FROM academics.batches b JOIN academics.courses c ON c.course_id = b.course_id WHERE b.batch_id = $1 AND b.tenant_id = $2`,
                    [batchId, context.tenantId]
                );
                if (batchRows.length > 0) {
                    courseTitle = batchRows[0].course_title || '';
                    if (amount === 0 && Number(batchRows[0].tuition_amount) > 0) {
                        amount = Number(batchRows[0].tuition_amount);
                    }
                }
            }

            if (amount > 0) {
                const now = new Date();
                const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
                const period = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
                const countRows = await query<{ count: string }>(
                    `SELECT COUNT(*) as count FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                    [context.tenantId, `INV-${yyyymm}-%`]
                );
                const seq = parseInt(countRows[0]?.count || '0', 10) + 1;
                const invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                const designation = `${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition — ${period}`;
                const isPaid = feeStatus === 'paid';
                const dueDate = isPaid ? now : new Date(Date.now() + 15 * 86400000);

                const invRows = await query<{ invoice_id: string }>(
                    `INSERT INTO billing.invoices (
                        tenant_id, invoice_number, student_id, billing_period,
                        subtotal_amount, total_amount, paid_amount, balance_amount,
                        due_date, status, designation, idempotency_key
                    ) VALUES (
                        $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11
                    ) RETURNING invoice_id`,
                    [
                        context.tenantId,
                        invNo,
                        result.studentId,
                        period,
                        amount,
                        isPaid ? amount : 0,
                        isPaid ? 0 : amount,
                        dueDate,
                        isPaid ? 'paid' : 'pending',
                        designation,
                        `student-create-${result.studentId}`
                    ]
                );

                if (isPaid && invRows.length > 0) {
                    const rcpNo = generateReceiptNumber();
                    await query(
                        `INSERT INTO billing.payments (
                            tenant_id, invoice_id, student_id, payment_reference, amount,
                            payment_method, status, receipt_number, recorded_by_actor_id
                        ) VALUES (
                            $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                        )`,
                        [
                            context.tenantId,
                            invRows[0].invoice_id,
                            result.studentId,
                            `ADM-${result.enrollmentNumber || result.studentId.slice(0, 8)}`,
                            amount,
                            rcpNo,
                            context.actorId
                        ]
                    );
                }
            }
        }

        let guardianCredentials: { name: string; email: string; password?: string } | null = null;
        if (result?.studentId && guardian) {
            if (guardian.mode === 'existing' && guardian.guardianId) {
                await callFn('academics.fn_guardian_link_student', context.tenantId, guardian.guardianId, result.studentId, context.actorId);
            } else if (guardian.firstName && guardian.lastName) {
                const gFirstName = String(guardian.firstName).trim();
                const gLastName = String(guardian.lastName).trim();
                const gEmail = String(guardian.email).trim().toLowerCase();
                const createdGuardian = await callFn<{ guardianId: string }>('academics.fn_guardian_create',
                    context.tenantId, gFirstName, gLastName, guardian.relationship || 'Parent', formattedGuardianPhone || guardian.phone, gEmail, [result.studentId], context.actorId);

                if (guardian.createLogin && createdGuardian?.guardianId) {
                    const password = generatePassword();
                    const login = await callFn<{ email: string }>('academics.fn_guardian_portal_enable',
                        context.tenantId, createdGuardian.guardianId, hashPassword(password), context.actorId);
                    guardianCredentials = { name: `${gFirstName} ${gLastName}`, email: login.email, password };
                }
            }
        }

        return ok(context, { ...result, credentials: guardianCredentials }, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'students.write');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const studentId = body.studentId;
        if (!studentId) {
            return problem(context, req, 400, 'Validation Error', 'Student ID is required.');
        }
        await requireStudentInScope(context, String(studentId));
        if (context.restrictedBranchId && body.branchId && body.branchId !== context.restrictedBranchId) {
            return problem(context, req, 403, 'Forbidden', 'You cannot move a student to another branch.');
        }
        if (body.batchId) await requireAssignedBatch(context, body.batchId, 'Choose a batch that is assigned to you.');

        const firstName = String(body.firstName ?? '').trim();
        const lastName = String(body.lastName ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        const phone = body.phone ? String(body.phone).trim() : null;
        const status = body.status ? String(body.status).trim() : 'active';
        const branchId = body.branchId || null;
        const batchId = body.batchId || null;

        if (!firstName || !lastName || !email) {
            return problem(context, req, 400, 'Validation Error', 'First name, last name, and email are required fields.');
        }

        const rawStudentCode = body.enrollmentNumber || body.studentCode;
        let updateStudentCode: string | null = null;
        if (typeof rawStudentCode === 'string' && rawStudentCode.trim()) {
            updateStudentCode = rawStudentCode.trim().toUpperCase();
            if (!/^[A-Z0-9_-]{2,30}$/.test(updateStudentCode)) {
                return problem(context, req, 400, 'Validation Error', 'Student ID must be 2 to 30 characters containing only letters, numbers, hyphens, and underscores (e.g. STUD-01).');
            }
            const existingCode = await query<{ student_id: string }>(
                `SELECT student_id FROM academics.students WHERE tenant_id = $1 AND enrollment_number = $2 AND student_id <> $3`,
                [context.tenantId, updateStudentCode, studentId]
            );
            if (existingCode.length > 0) {
                return problem(context, req, 409, 'Conflict', `Student ID '${updateStudentCode}' is already in use by another student in your academy.`);
            }
        }

        // Check if student is being transferred/migrated to another branch
        const existingStudentRows = await query<{ branch_id: string }>(
            `SELECT branch_id FROM academics.students WHERE student_id = $1 AND tenant_id = $2`,
            [studentId, context.tenantId]
        );
        const oldBranchId = existingStudentRows[0]?.branch_id;
        const newBranchId = branchId || null;
        const isBranchSwitched = Boolean(newBranchId && oldBranchId && newBranchId !== oldBranchId);

        // Update student record with tenant scoping
        const updateRes = await query<{
            student_id: string;
            enrollment_number: string;
            first_name: string;
            last_name: string;
            email: string;
            phone: string | null;
            status: string;
        }>(
            `UPDATE academics.students
             SET first_name = $1,
                 last_name = $2,
                 email = $3,
                 phone = $4,
                 status = $5,
                 branch_id = COALESCE($6, branch_id),
                 enrollment_number = COALESCE($7, enrollment_number),
                 updated_at = clock_timestamp()
             WHERE student_id = $8 AND tenant_id = $9
             RETURNING student_id, enrollment_number, first_name, last_name, email, phone, status`,
            [firstName, lastName, email, phone, status, newBranchId, updateStudentCode, studentId, context.tenantId]
        );

        if (updateRes.length === 0) {
            return problem(context, req, 404, 'Not Found', 'Student not found.');
        }

        // Update or remove profile photo if provided
        const photo = body.photo;
        if (photo !== undefined) {
            const cleanPhoto = typeof photo === 'string' && photo.trim() ? photo.trim() : null;
            if (cleanPhoto) {
                if (!/^data:image\/(png|jpeg|webp|jpg);base64,/.test(cleanPhoto) && !cleanPhoto.startsWith('http')) {
                    return problem(context, req, 400, 'Validation Error', 'Student photo must be a valid base64-encoded image or image URL.');
                }
                await query(
                    `UPDATE academics.students
                     SET profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{photo}', $1::jsonb)
                     WHERE student_id = $2 AND tenant_id = $3`,
                    [JSON.stringify(cleanPhoto), studentId, context.tenantId]
                );
            } else {
                await query(
                    `UPDATE academics.students
                     SET profile = COALESCE(profile, '{}'::jsonb) - 'photo'
                     WHERE student_id = $1 AND tenant_id = $2`,
                    [studentId, context.tenantId]
                );
            }
        }

        // When switching/migrating student to another branch, remove them from batches belonging to the previous branch
        if (isBranchSwitched) {
            // Enrollments with fee records are closed, not deleted, so their history stays
            await query(
                `UPDATE academics.enrollments e
                 SET status = 'transferred', transfer_reason = 'Branch change', transferred_at = clock_timestamp()
                 WHERE e.student_id = $1 AND e.tenant_id = $2 AND e.status IN ('enrolled', 'confirmed', 'active', 'approved')
                   AND e.batch_id IN (SELECT batch_id FROM academics.batches WHERE branch_id <> $3 AND tenant_id = $2)
                   AND EXISTS (SELECT 1 FROM billing.invoices i WHERE i.enrollment_id = e.enrollment_id)`,
                [studentId, context.tenantId, newBranchId]
            );
            await query(
                `DELETE FROM academics.enrollments
                 WHERE student_id = $1
                   AND tenant_id = $2
                   AND NOT EXISTS (SELECT 1 FROM billing.invoices i WHERE i.enrollment_id = enrollments.enrollment_id)
                   AND NOT EXISTS (SELECT 1 FROM billing.course_transfers t WHERE enrollments.enrollment_id IN (t.from_enrollment_id, t.to_enrollment_id))
                   AND batch_id IN (
                       SELECT batch_id FROM academics.batches
                       WHERE branch_id <> $3 AND tenant_id = $2
                   )`,
                [studentId, context.tenantId, newBranchId]
            );
        }

        // If batchId is specified, enroll or update student batch enrollment
        if (batchId) {
            await query(
                `INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status)
                 VALUES ($1, $2, $3, 'enrolled')
                 ON CONFLICT (student_id, batch_id) DO UPDATE SET status = 'enrolled'
                 WHERE enrollments.status NOT IN ('transferred', 'completed')`,
                [context.tenantId, studentId, batchId]
            );
            await query(
                `UPDATE billing.invoices SET enrollment_id = billing.fn_invoice_enrollment_resolve(tenant_id, student_id, designation, TRUE)
                 WHERE tenant_id = $1 AND student_id = $2 AND enrollment_id IS NULL AND status <> 'void'
                   AND EXISTS (SELECT 1 FROM academics.courses c WHERE c.tenant_id = $1 AND position(lower(trim(c.title)) IN lower(designation)) > 0)`,
                [context.tenantId, studentId]
            );
        }

        // Process fee status update if provided
        const feeStatus = body.feeStatus ? String(body.feeStatus).trim().toLowerCase() : null;
        const rawFeeAmount = body.feeAmount !== undefined && body.feeAmount !== null && body.feeAmount !== '' ? Number(body.feeAmount) : null;

        // The shortcut rewrites the latest invoice, so it is only for a single unpaid one: never for a student on an
        // installment schedule or when that invoice has payments
        const [managed] = feeStatus ? await query<{ found: number }>(
            `SELECT 1 AS found FROM billing.enrollment_fee_plans WHERE student_id = $1 AND tenant_id = $2
             UNION ALL
             SELECT 1 FROM billing.invoices WHERE student_id = $1 AND tenant_id = $2 AND status <> 'void' AND designation ~ '^Installment [0-9]+ of [0-9]+'
             UNION ALL
             SELECT 1 FROM billing.payments p WHERE p.tenant_id = $2 AND p.status NOT IN ('rejected', 'refunded')
               AND p.invoice_id = (SELECT invoice_id FROM billing.invoices WHERE student_id = $1 AND tenant_id = $2 AND status <> 'void' ORDER BY created_at DESC LIMIT 1)
             LIMIT 1`,
            [studentId, context.tenantId]
        ) : [];
        if (feeStatus && !managed) {
            const existingInvoices = await query<{ invoice_id: string; total_amount: string; status: string; balance_amount: string }>(
                `SELECT invoice_id, total_amount, status, balance_amount FROM billing.invoices WHERE student_id = $1 AND tenant_id = $2 AND status <> 'void' ORDER BY created_at DESC LIMIT 1`,
                [studentId, context.tenantId]
            );

            if (existingInvoices.length > 0) {
                const inv = existingInvoices[0];
                const amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : Number(inv.total_amount);

                if (feeStatus === 'paid') {
                    await query(
                        `UPDATE billing.invoices SET total_amount = $1, subtotal_amount = $1, paid_amount = $1, balance_amount = 0, status = 'paid', updated_at = clock_timestamp() WHERE invoice_id = $2`,
                        [amount, inv.invoice_id]
                    );
                    const existingPayments = await query<{ payment_id: string }>(
                        `SELECT payment_id FROM billing.payments WHERE invoice_id = $1 AND tenant_id = $2`,
                        [inv.invoice_id, context.tenantId]
                    );
                    if (existingPayments.length === 0) {
                        const rcpNo = generateReceiptNumber();
                        await query(
                            `INSERT INTO billing.payments (
                                tenant_id, invoice_id, student_id, payment_reference, amount,
                                payment_method, status, receipt_number, recorded_by_actor_id
                            ) VALUES (
                                $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                            )`,
                            [
                                context.tenantId,
                                inv.invoice_id,
                                studentId,
                                `STU-UPD-${studentId.slice(0, 8)}`,
                                amount,
                                rcpNo,
                                context.actorId
                            ]
                        );
                    }
                } else if (feeStatus === 'pending') {
                    await query(
                        `UPDATE billing.invoices SET total_amount = $1, subtotal_amount = $1, paid_amount = 0, balance_amount = $1, status = 'pending', updated_at = clock_timestamp() WHERE invoice_id = $2`,
                        [amount, inv.invoice_id]
                    );
                } else if (feeStatus === 'none') {
                    await query(
                        `UPDATE billing.invoices SET status = 'void', balance_amount = 0, updated_at = clock_timestamp() WHERE invoice_id = $1`,
                        [inv.invoice_id]
                    );
                }
            } else if (feeStatus === 'pending' || feeStatus === 'paid') {
                let courseTitle = '';
                let amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : 0;

                const effectiveBatchId = batchId || (
                    await query<{ batch_id: string }>(
                        `SELECT batch_id FROM academics.enrollments WHERE student_id = $1 AND status = 'enrolled' LIMIT 1`,
                        [studentId]
                    )
                )[0]?.batch_id;

                if (effectiveBatchId) {
                    const batchRows = await query<{ course_title: string; tuition_amount: string }>(
                        `SELECT c.title as course_title, c.tuition_amount FROM academics.batches b JOIN academics.courses c ON c.course_id = b.course_id WHERE b.batch_id = $1`,
                        [effectiveBatchId]
                    );
                    if (batchRows.length > 0) {
                        courseTitle = batchRows[0].course_title || '';
                        if (amount === 0 && Number(batchRows[0].tuition_amount) > 0) {
                            amount = Number(batchRows[0].tuition_amount);
                        }
                    }
                }

                if (amount > 0) {
                    const now = new Date();
                    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
                    const period = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
                    const countRows = await query<{ count: string }>(
                        `SELECT COUNT(*) as count FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                        [context.tenantId, `INV-${yyyymm}-%`]
                    );
                    const seq = parseInt(countRows[0]?.count || '0', 10) + 1;
                    const invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                    const designation = `${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition — ${period}`;
                    const isPaid = feeStatus === 'paid';
                    const dueDate = isPaid ? now : new Date(Date.now() + 15 * 86400000);

                    const invRows = await query<{ invoice_id: string }>(
                        `INSERT INTO billing.invoices (
                            tenant_id, invoice_number, student_id, billing_period,
                            subtotal_amount, total_amount, paid_amount, balance_amount,
                            due_date, status, designation, idempotency_key
                        ) VALUES (
                            $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11
                        ) RETURNING invoice_id`,
                        [
                            context.tenantId,
                            invNo,
                            studentId,
                            period,
                            amount,
                            isPaid ? amount : 0,
                            isPaid ? 0 : amount,
                            dueDate,
                            isPaid ? 'paid' : 'pending',
                            designation,
                            `student-update-${studentId}-${Date.now()}`
                        ]
                    );

                    if (isPaid && invRows.length > 0) {
                        const rcpNo = generateReceiptNumber();
                        await query(
                            `INSERT INTO billing.payments (
                                tenant_id, invoice_id, student_id, payment_reference, amount,
                                payment_method, status, receipt_number, recorded_by_actor_id
                            ) VALUES (
                                $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                            )`,
                            [
                                context.tenantId,
                                invRows[0].invoice_id,
                                studentId,
                                `STU-UPD-${studentId.slice(0, 8)}`,
                                amount,
                                rcpNo,
                                context.actorId
                            ]
                        );
                    }
                }
            }
        }

        // Audit compliance log
        await query(
            `INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
             VALUES ($1, $2, 'student.updated', 'student', $3, gen_random_uuid(), $4::jsonb)`,
            [
                context.tenantId,
                context.actorId,
                studentId,
                JSON.stringify({
                    name: `${firstName} ${lastName}`,
                    status,
                    phone,
                    batchId: batchId || undefined,
                })
            ]
        );

        return ok(context, { success: true, student: updateRes[0] });
    } catch (err) {
        return fail(err, context, req);
    }
}
