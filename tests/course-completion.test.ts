import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

delete process.env.DATABASE_URL;
process.env.DATABASE_DIR = 'memory://';
process.env.AUTH_SECRET = 'test-secret-for-session-tokens-0123456789';

const { NextRequest } = await import('next/server');
const { callFn, query, closeDb } = await import('@/lib/db/db');
const { applyScripts } = await import('../database/migrate.ts');
const { signToken } = await import('@/lib/auth');
const completionApi = await import('@/app/api/v1/courses/completion/route');
const studentsApi = await import('@/app/api/v1/students/route');

type Handler = (req: InstanceType<typeof NextRequest>) => Promise<Response>;
type Json = any;

let tenantId = '';
let branchId = '';
const users: Record<string, string> = {};
let counter = 0;

async function createUser(role: string) {
    const [row] = await query<{ user_id: string }>(
        `INSERT INTO identity_app.users (email, full_name, password_hash) VALUES ($1, $2, 'x') RETURNING user_id`,
        [`${role.toLowerCase()}.${randomUUID().slice(0, 8)}@example.com`, `${role} User`]
    );
    return row.user_id;
}

async function call(handler: Handler, method: string, role: string, opts: { body?: Json; search?: string; branch?: string | null; userId?: string } = {}) {
    const token = signToken({ sub: opts.userId ?? users[role], name: role, tid: tenantId, role: role as Json, bid: opts.branch ?? null, pa: false });
    const res = await handler(new NextRequest(`http://localhost/api/v1/completion${opts.search ?? ''}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    }));
    const json: Json = await res.json();
    return { status: res.status, data: json.data, detail: json.detail as string };
}

let course1Id = '';
let course2Id = '';
let batch1Id = '';
let batch2Id = '';
let subject1Id = '';
let student1Id = '';
let student2Id = '';
let enr1Id = '';
let enr2Id = '';
let enrTransferredId = '';

before(async () => {
    await applyScripts(['migrations', 'functions']);
    const admin = randomUUID();
    const t = await callFn<{ tenantId: string; branchId: string }>('tenant.fn_tenant_create',
        'Completion Academy', 'completion-academy', 'Tuition', 'INR',
        'Asia/Kolkata', 'Enterprise', null, null, null, admin
    );
    tenantId = t.tenantId;
    branchId = t.branchId;

    for (const role of ['TenantAdmin', 'BranchManager', 'Instructor', 'Staff']) {
        users[role] = await createUser(role);
    }

    // 1. Create course 1 with completion policy
    const policy = {
        enabled: true,
        minAttendancePct: 75,
        requiredSessions: 4,
        requiredAssessments: 1,
        minPassingMarks: 50,
        requireApproval: true,
        checkAttendance: true,
        checkAssessments: true,
        checkMarks: true,
        checkSessions: true,
        checkDuration: false
    };

    const c1 = await callFn<{ courseId: string }>('academics.fn_course_create',
        tenantId, 'Guitar Mastery', 'GTR-101', 'Music', 'Intermediate', 6,
        12000, 'monthly', 'Comprehensive guitar training', ['Fretboard Theory'], users.TenantAdmin
    );
    course1Id = c1.courseId;

    await query(
        `UPDATE academics.courses SET completion_policy = $1::jsonb WHERE course_id = $2`,
        [JSON.stringify(policy), course1Id]
    );

    const [subRow] = await query<{ subject_id: string }>(
        `SELECT subject_id FROM academics.course_subjects WHERE course_id = $1 LIMIT 1`,
        [course1Id]
    );
    subject1Id = subRow.subject_id;

    // 2. Create batch for course 1
    const [b1] = await query<{ batch_id: string }>(
        `INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, capacity, status, start_date)
         VALUES ($1, $2, $3, 'Guitar Batch A', 25, 'active', '2026-01-01')
         RETURNING batch_id`,
        [tenantId, course1Id, branchId]
    );
    batch1Id = b1.batch_id;

    // 3. Create course 2 (for multi-course independence check)
    const c2 = await callFn<{ courseId: string }>('academics.fn_course_create',
        tenantId, 'Piano Advanced', 'PNO-201', 'Music', 'Advanced', 3,
        6000, 'monthly', 'Advanced piano', ['Chords'], users.TenantAdmin
    );
    course2Id = c2.courseId;

    const [b2] = await query<{ batch_id: string }>(
        `INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, capacity, status, start_date)
         VALUES ($1, $2, $3, 'Piano Batch A', 20, 'active', '2026-02-01')
         RETURNING batch_id`,
        [tenantId, course2Id, branchId]
    );
    batch2Id = b2.batch_id;

    // 4. Create Student 1 (enrolled in Course 1 and Course 2)
    const s1 = await callFn<{ studentId: string }>('academics.fn_student_create',
        tenantId, 'Aarav', 'Sharma', `aarav.${Date.now()}@example.com`, null,
        '2010-05-15', null, null, null, batch1Id, branchId, users.TenantAdmin
    );
    student1Id = s1.studentId;

    const [e1] = await query<{ enrollment_id: string }>(
        `SELECT enrollment_id FROM academics.enrollments WHERE student_id = $1 AND batch_id = $2`,
        [student1Id, batch1Id]
    );
    enr1Id = e1.enrollment_id;

    // Enroll in Batch 2 (Multi-course)
    const [e2] = await query<{ enrollment_id: string }>(
        `INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status, enrolled_at)
         VALUES ($1, $2, $3, 'enrolled', '2026-02-05')
         RETURNING enrollment_id`,
        [tenantId, student1Id, batch2Id]
    );
    enr2Id = e2.enrollment_id;

    // Create an invoice with pending fee balance for Enrollment 1 to verify fee separation
    await query(
        `INSERT INTO billing.invoices (
            tenant_id, student_id, enrollment_id, invoice_number, designation, billing_period, due_date,
            subtotal_amount, paid_amount, balance_amount, total_amount, status
        ) VALUES (
            $1, $2, $3, 'INV-TEST-001', 'Tuition Part 1', '2026-01', '2026-02-01', 12000, 6000, 6000, 12000, 'pending'
        )`,
        [tenantId, student1Id, enr1Id]
    );

    // 5. Create Student 2 (Transferred student)
    const s2 = await callFn<{ studentId: string }>('academics.fn_student_create',
        tenantId, 'Diya', 'Verma', `diya.${Date.now()}@example.com`, null,
        '2011-08-20', null, null, null, batch1Id, branchId, users.TenantAdmin
    );
    student2Id = s2.studentId;

    await query(
        `UPDATE academics.enrollments SET status = 'transferred', transfer_reason = 'Transferred to Weekend Batch'
         WHERE student_id = $1 AND batch_id = $2`,
        [student2Id, batch1Id]
    );

    const [et] = await query<{ enrollment_id: string }>(
        `SELECT enrollment_id FROM academics.enrollments WHERE student_id = $1 AND batch_id = $2`,
        [student2Id, batch1Id]
    );
    enrTransferredId = et.enrollment_id;
});

after(async () => {
    await closeDb();
});

test('Course Completion Management System', async (t) => {
    // 1. Initial Ineligibility
    await t.test('Student is initially ineligible when requirements are unmet', async () => {
        const res = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr1Id}`
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.isEligible, false);
        assert.ok(res.data.unmetReasons.length >= 2);
        assert.ok(res.data.unmetReasons.some((r: string) => r.includes('Required sessions not met') || r.includes('conducted')));
        assert.ok(res.data.unmetReasons.some((r: string) => r.includes('Required assessments incomplete')));
    });

    // 2. Attendance Below Minimum
    await t.test('Student is ineligible when attendance is below minimum percentage', async () => {
        // Conduct 4 sessions
        const dates = ['2026-02-01', '2026-02-08', '2026-02-15', '2026-02-22'];
        for (const d of dates) {
            await query(
                `INSERT INTO academics.class_sessions (tenant_id, batch_id, session_date, status, reason, confirmed_by_actor_id)
                 VALUES ($1, $2, $3, 'conducted', 'Regular class', $4)
                 ON CONFLICT (batch_id, session_date) DO NOTHING`,
                [tenantId, batch1Id, d, users.Instructor]
            );
        }

        // Student attended 2 of 4 sessions = 50%
        await query(
            `INSERT INTO academics.attendance_records (tenant_id, batch_id, student_id, session_date, status, recorded_by_actor_id)
             VALUES 
                ($1, $2, $3, '2026-02-01', 'present', $4),
                ($1, $2, $3, '2026-02-08', 'present', $4),
                ($1, $2, $3, '2026-02-15', 'absent', $4),
                ($1, $2, $3, '2026-02-22', 'absent', $4)`,
            [tenantId, batch1Id, student1Id, users.Instructor]
        );

        const res = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr1Id}`
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.attendanceRate, 50);
        assert.equal(res.data.attendanceSatisfied, false);
        assert.equal(res.data.isEligible, false);
        assert.ok(res.data.unmetReasons.some((r: string) => r.includes('Attendance below minimum')));
    });

    // 3. Assessment Below Passing Marks
    await t.test('Student is ineligible when test marks are below passing threshold', async () => {
        // Update attendance: mark 3rd session present -> 3/4 = 75%
        await query(
            `UPDATE academics.attendance_records SET status = 'present'
             WHERE batch_id = $1 AND student_id = $2 AND session_date = '2026-02-15'`,
            [batch1Id, student1Id]
        );

        // Schedule test and record score 35% (< 50% min passing marks)
        const [testRow] = await query<{ test_id: string }>(
            `INSERT INTO academics.tests (tenant_id, batch_id, title, test_type, test_date, status, created_by_actor_id)
             VALUES ($1, $2, 'Mid-Term Evaluation', 'Assessment', '2026-03-01', 'published', $3)
             RETURNING test_id`,
            [tenantId, batch1Id, users.Instructor]
        );
        await query(
            `INSERT INTO academics.test_subjects (test_id, subject_id, max_marks) VALUES ($1, $2, 100)`,
            [testRow.test_id, subject1Id]
        );
        await query(
            `INSERT INTO academics.test_results (test_id, student_id, subject_id, tenant_id, marks_obtained, is_absent, recorded_by_actor_id)
             VALUES ($1, $2, $3, $4, 35, FALSE, $5)`,
            [testRow.test_id, student1Id, subject1Id, tenantId, users.Instructor]
        );

        const res = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr1Id}`
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.attendanceRate, 75);
        assert.equal(res.data.attendanceSatisfied, true);
        assert.equal(res.data.assessmentsCompleted, 1);
        assert.equal(res.data.averageScore, 35);
        assert.equal(res.data.marksSatisfied, false);
        assert.equal(res.data.isEligible, false);
        assert.ok(res.data.unmetReasons.some((r: string) => r.includes('Passing marks not achieved')));
    });

    // 4. Meets All Academic Requirements with Outstanding Balance
    await t.test('Student becomes eligible when criteria met, independent of outstanding tuition balance', async () => {
        // Update test marks to 85%
        await query(
            `UPDATE academics.test_results SET marks_obtained = 85 WHERE student_id = $1 AND tenant_id = $2`,
            [student1Id, tenantId]
        );

        const res = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr1Id}`
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.attendanceSatisfied, true);
        assert.equal(res.data.sessionsSatisfied, true);
        assert.equal(res.data.assessmentsSatisfied, true);
        assert.equal(res.data.marksSatisfied, true);
        assert.equal(res.data.isEligible, true);
        assert.equal(res.data.unmetReasons.length, 0);

        // Step 7 Verification: Outstanding balance of ₹6000 exists, but academic eligibility is TRUE
        assert.equal(res.data.financialSummary.balanceAmount, 6000);
        assert.equal(res.data.financialSummary.isFeePaid, false);
    });

    // 5. Return for Review
    await t.test('Staff can return completion request for review with required remarks', async () => {
        // Remarks missing -> 400
        const badRes = await call(completionApi.POST, 'POST', 'BranchManager', {
            body: { action: 'return', enrollmentId: enr1Id, remarks: '' }
        });
        assert.equal(badRes.status, 400);

        const res = await call(completionApi.POST, 'POST', 'BranchManager', {
            body: { action: 'return', enrollmentId: enr1Id, remarks: 'Please submit the recording of your assignment 3.' }
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.success, true);

        // Check enrollment remains 'enrolled' and return remarks are saved
        const progressRes = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr1Id}`
        });
        assert.equal(progressRes.data.enrollmentStatus, 'enrolled');
        assert.equal(progressRes.data.completionRecord?.status, 'returned');
        assert.equal(progressRes.data.completionRecord?.returnRemarks, 'Please submit the recording of your assignment 3.');
    });

    // 6. Approve Course Completion
    await t.test('Staff approves course completion, transitions status to completed and records final result', async () => {
        const res = await call(completionApi.POST, 'POST', 'BranchManager', {
            body: {
                action: 'approve',
                enrollmentId: enr1Id,
                finalResult: 'Distinction',
                remarks: 'Outstanding performance in all modules.'
            }
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.success, true);

        const progressRes = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr1Id}`
        });
        assert.equal(progressRes.data.enrollmentStatus, 'completed');
        assert.equal(progressRes.data.completionRecord?.status, 'completed');
        assert.equal(progressRes.data.completionRecord?.finalResult, 'Distinction');
        assert.equal(progressRes.data.completionRecord?.remarks, 'Outstanding performance in all modules.');
        assert.equal(progressRes.data.overallProgressPct, 100);

        // Verify database table
        const [dbRow] = await query<{ status: string; final_result: string }>(
            `SELECT status, final_result FROM academics.course_completions WHERE enrollment_id = $1`,
            [enr1Id]
        );
        assert.equal(dbRow.status, 'completed');
        assert.equal(dbRow.final_result, 'Distinction');
    });

    // 7. Duplicate Approval Prevention
    await t.test('Duplicate completion approval is rejected', async () => {
        const res = await call(completionApi.POST, 'POST', 'BranchManager', {
            body: { action: 'approve', enrollmentId: enr1Id }
        });
        assert.equal(res.status, 400);
        assert.match(res.detail, /already been completed/);
    });

    // 8. Multi-Course Isolation
    await t.test('Completing Course 1 does not affect student enrollment in Course 2', async () => {
        const res = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enr2Id}`
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.enrollmentStatus, 'enrolled');
        assert.equal(res.data.completionRecord, null);
    });

    // 9. Transferred Enrollment Protection
    await t.test('Transferred enrollment cannot be completed and remains transferred', async () => {
        const getRes = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?enrollmentId=${enrTransferredId}`
        });
        assert.equal(getRes.status, 200);
        assert.equal(getRes.data.enrollmentStatus, 'transferred');
        assert.equal(getRes.data.isEligible, false);

        const approveRes = await call(completionApi.POST, 'POST', 'BranchManager', {
            body: { action: 'approve', enrollmentId: enrTransferredId }
        });
        assert.equal(approveRes.status, 400);
        assert.match(approveRes.detail, /transferred enrollment/);
    });

    // 10. Candidates Listing and Filtering
    await t.test('Completion candidate list filters by status', async () => {
        const res = await call(completionApi.GET, 'GET', 'BranchManager', {
            search: `?courseId=${course1Id}&status=completed`
        });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.ok(res.data.some((c: any) => c.enrollmentId === enr1Id));
    });

    // 11. Student Profile Integration
    await t.test('Student profile API includes academic progress on enrollments', async () => {
        const token = signToken({ sub: users.BranchManager, name: 'BranchManager', tid: tenantId, role: 'BranchManager', bid: branchId, pa: false });
        const req = new NextRequest(`http://localhost/api/v1/students?studentId=${student1Id}`, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` }
        });
        const res = await studentsApi.GET(req);
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.ok(json.data.enrollments.length >= 2);
        const enr1 = json.data.enrollments.find((e: any) => e.enrollmentId === enr1Id);
        assert.ok(enr1);
        assert.equal(enr1.status, 'completed');
        assert.ok(enr1.academicProgress);
        assert.equal(enr1.academicProgress.completionRecord?.finalResult, 'Distinction');
    });
});
