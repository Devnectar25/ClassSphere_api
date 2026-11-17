import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { callFn, query, closeDb } from '../src/lib/db/db.ts';
import { applyScripts } from '../database/migrate.ts';
import { createProblemDetailsResponse } from '../src/lib/api/problem-details.ts';
import { can, hashPassword, signToken, verifyPassword, verifyToken } from '../src/lib/auth.ts';

process.env.AUTH_SECRET ??= 'test-secret-for-session-tokens-0123456789';

// Runs against a fresh in-memory PGlite database with the schema applied, or against DATABASE_URL
// when set (each run then provisions isolated tenants and removes them afterwards).
if (!process.env.DATABASE_URL) process.env.DATABASE_DIR = 'memory://';
const createdTenants: string[] = [];
const actor = randomUUID();
const suffix = randomUUID().slice(0, 8);

interface TenantResult { tenantId: string; branchId: string; planTier: string }
interface StudentSearch { total: number; students: Array<{ studentId: string; firstName: string }> }
interface AuditSearch { total: number; logs: Array<{ action: string; entityType: string }> }

async function createTenant(name: string, planTier: string) {
    const tenant = await callFn<TenantResult>('tenant.fn_tenant_create',
        name, `${name.toLowerCase().replace(/\W+/g, '-')}-${suffix}`, 'Music', 'INR', 'UTC', planTier, null, null, null, actor);
    createdTenants.push(tenant.tenantId);
    return tenant;
}

async function createBatch(tenant: TenantResult, tuition: number) {
    const [course] = await query<{ course_id: string }>(
        `INSERT INTO academics.courses (tenant_id, title, code, category, tuition_amount)
         VALUES ($1, 'Test Course', 'TST-' || substr(md5(random()::text), 1, 6), 'Music', $2) RETURNING course_id`,
        [tenant.tenantId, tuition]);
    const [batch] = await query<{ batch_id: string }>(
        `INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, start_date)
         VALUES ($1, $2, $3, 'Test Batch', CURRENT_DATE) RETURNING batch_id`,
        [tenant.tenantId, course.course_id, tenant.branchId]);
    return batch.batch_id;
}

function createStudent(tenantId: string, firstName: string, batchId: string | null = null, branchId: string | null = null) {
    return callFn<{ studentId: string }>('academics.fn_student_create',
        tenantId, firstName, 'Tester', `${firstName.toLowerCase()}.${suffix}@example.com`, null, '2012-05-14', null, null, null, batchId, branchId, actor);
}

before(async () => {
    if (!process.env.DATABASE_URL) await applyScripts(['migrations', 'functions']);
});

after(async () => {
    for (const tenantId of createdTenants) {
        await query('DELETE FROM billing.payments WHERE tenant_id = $1', [tenantId]);
        await query('DELETE FROM billing.invoices WHERE tenant_id = $1', [tenantId]);
        await query('DELETE FROM integration.outbox_messages WHERE tenant_id = $1', [tenantId]);
        await query('DELETE FROM audit.compliance_logs WHERE tenant_id = $1', [tenantId]);
        await query('DELETE FROM platform.subscriptions WHERE tenant_id = $1', [tenantId]);
        await query('DELETE FROM tenant.organizations WHERE tenant_id = $1', [tenantId]);
    }
    await query(`DELETE FROM identity_app.users WHERE email LIKE '%' || $1 || '%'`, [suffix]);
    await closeDb();
});

test('PLT-001: RFC 7807 Problem Details Format & Correlation Propagation', async (t) => {
    await t.test('generates valid RFC 7807 payload with required headers', async () => {
        const correlationId = 'test-corr-12345';
        const res = createProblemDetailsResponse(
            403,
            'Forbidden Workspace Operation',
            'Cross-tenant data mutation is strictly prohibited.',
            correlationId,
            '/api/v1/billing'
        );

        assert.equal(res.status, 403);
        assert.equal(res.headers.get('Content-Type'), 'application/problem+json');
        assert.equal(res.headers.get('X-Correlation-Id'), correlationId);

        const body = await res.json();
        assert.equal(body.status, 403);
        assert.equal(body.title, 'Forbidden Workspace Operation');
        assert.equal(body.detail, 'Cross-tenant data mutation is strictly prohibited.');
        assert.equal(body.instance, '/api/v1/billing');
        assert.equal(body.correlationId, correlationId);
        assert.match(body.type, /^https:\/\/classsphere\.io\/errors\//);
    });
});

test('PLT-006 & PLT-007: Stored Functions & Multi-Tenant Isolation', async (t) => {
    const tenantAlpha = await createTenant('Alpha Conservatory of Strings', 'Starter');
    const tenantBeta = await createTenant('Beta Academy of Performing Arts', 'Enterprise');
    assert.notEqual(tenantAlpha.tenantId, tenantBeta.tenantId);

    await t.test('strict data isolation across student records', async () => {
        const studentAlpha = await createStudent(tenantAlpha.tenantId, 'Aria');
        const studentBeta = await createStudent(tenantBeta.tenantId, 'Benjamin');

        const searchAlpha = await callFn<StudentSearch>('academics.fn_student_search', tenantAlpha.tenantId, null, null, null, 50, 0);
        const searchBeta = await callFn<StudentSearch>('academics.fn_student_search', tenantBeta.tenantId, null, null, null, 50, 0);

        assert.equal(searchAlpha.total, 1);
        assert.equal(searchAlpha.students[0].studentId, studentAlpha.studentId);
        assert.equal(searchAlpha.students[0].firstName, 'Aria');

        assert.equal(searchBeta.total, 1);
        assert.equal(searchBeta.students[0].studentId, studentBeta.studentId);
        assert.equal(searchBeta.students[0].firstName, 'Benjamin');
    });

    await t.test('entitlement check enforces plan tier quotas', async () => {
        const entAlpha = await callFn<{ planTier: string; maximum: number }>('tenant.fn_entitlement_check', tenantAlpha.tenantId, 'branches');
        const entBeta = await callFn<{ planTier: string; maximum: number }>('tenant.fn_entitlement_check', tenantBeta.tenantId, 'branches');

        assert.equal(entAlpha.planTier, 'Starter');
        assert.equal(entAlpha.maximum, 1);
        assert.equal(entBeta.planTier, 'Enterprise');
        assert.equal(entBeta.maximum, 25);
    });

    await t.test('attendance stored function marks batch records and records audit', async () => {
        const batchId = await createBatch(tenantAlpha, 100);
        const student = await createStudent(tenantAlpha.tenantId, 'Cora', batchId);

        const res = await callFn<{ success: boolean; markedCount: number }>('academics.fn_attendance_mark_batch',
            tenantAlpha.tenantId, batchId, '2026-10-21',
            JSON.stringify([{ studentId: student.studentId, status: 'present', remarks: 'Arrived early' }]), actor);
        assert.equal(res.success, true);
        assert.equal(res.markedCount, 1);

        const audit = await callFn<AuditSearch>('reporting.fn_audit_search', tenantAlpha.tenantId, 'attendance.marked_batch', 50, 0);
        assert.ok(audit.logs.length >= 1);
        assert.equal(audit.logs[0].entityType, 'batch');
    });

    await t.test('attendance rejects students from another tenant', async () => {
        const batchId = await createBatch(tenantAlpha, 100);
        const foreign = await createStudent(tenantBeta.tenantId, 'Dmitri');
        await assert.rejects(
            callFn('academics.fn_attendance_mark_batch', tenantAlpha.tenantId, batchId, '2026-10-21',
                JSON.stringify([{ studentId: foreign.studentId, status: 'present' }]), actor),
            { code: '22023' });
    });
});

test('PLT-010: Financial Mutations & Idempotency Replay Protection', async (t) => {
    const tenantGamma = await createTenant('Gamma Philharmonic Guild', 'Enterprise');
    const batchId = await createBatch(tenantGamma, 250);
    await createStudent(tenantGamma.tenantId, 'Elena', batchId);
    const idempotencyKeyBilling = `idem-bill-cycle-${suffix}`;

    await t.test('billing cycle generation creates invoices once and replays idempotently', async () => {
        const res1 = await callFn<{ success: boolean; invoicesGenerated: number; totalBilled: number }>(
            'billing.fn_invoice_generate_cycle', tenantGamma.tenantId, '2026-10-01', actor, idempotencyKeyBilling);
        assert.equal(res1.success, true);
        assert.equal(res1.invoicesGenerated, 1);
        assert.equal(res1.totalBilled, 250);

        const res2 = await callFn<{ idempotentReplay: boolean; invoicesGenerated: number; totalBilled: number }>(
            'billing.fn_invoice_generate_cycle', tenantGamma.tenantId, '2026-10-01', actor, idempotencyKeyBilling);
        assert.equal(res2.idempotentReplay, true);
        assert.equal(res2.invoicesGenerated, 1);
        assert.equal(res2.totalBilled, 250);

        const ledger = await callFn<{ invoices: unknown[] }>('billing.fn_invoice_list', tenantGamma.tenantId, null);
        assert.equal(ledger.invoices.length, 1);
    });

    await t.test('payment posting updates invoice ledger and replays idempotently', async () => {
        const ledger = await callFn<{ invoices: Array<{ invoiceId: string }> }>('billing.fn_invoice_list', tenantGamma.tenantId, null);
        const invoiceId = ledger.invoices[0].invoiceId;
        const idempotencyKeyPayment = `idem-pay-${suffix}`;

        await assert.rejects(
            callFn('billing.fn_payment_post', tenantGamma.tenantId, invoiceId, 999, 'Card', null, null, null, actor),
            { code: '22023' }, 'over-payment must be rejected');

        const pay1 = await callFn<{ amountPaid: number; remainingBalance: number; invoiceStatus: string; receiptNumber: string }>(
            'billing.fn_payment_post', tenantGamma.tenantId, invoiceId, 250, 'Card', null, 'gw-ch-99410', idempotencyKeyPayment, actor);
        assert.equal(pay1.amountPaid, 250);
        assert.equal(pay1.remainingBalance, 0);
        assert.equal(pay1.invoiceStatus, 'paid');
        assert.ok(pay1.receiptNumber);

        const pay2 = await callFn<{ idempotentReplay: boolean; receiptNumber: string }>(
            'billing.fn_payment_post', tenantGamma.tenantId, invoiceId, 250, 'Card', null, 'gw-ch-99410', idempotencyKeyPayment, actor);
        assert.equal(pay2.idempotentReplay, true);
        assert.equal(pay2.receiptNumber, pay1.receiptNumber);

        const payments = await callFn<{ payments: unknown[] }>('billing.fn_payment_list', tenantGamma.tenantId, null);
        assert.equal(payments.payments.length, 1);
    });
});

test('PLT-005: Outbox Transactional Event Publishing', async (t) => {
    const tenant = await createTenant('Delta Outbox Academy', 'Starter');

    await t.test('publishing circular notice stages event to transactional outbox', async () => {
        const noticeRes = await callFn<{ success: boolean; noticeId: string }>('engagement.fn_notice_publish',
            tenant.tenantId, 'Annual Concerto Auditions Announced', 'Auditions will be held in the Concert Hall next Tuesday.',
            'announcement', 'published', 'urgent', 'students', null, null, ['in-app', 'email'], null, actor, true);
        assert.equal(noticeRes.success, true);
        assert.ok(noticeRes.noticeId);

        type Message = { messageId: string; eventType: string; payload: { noticeId: string; title: string } };
        const claimed = await callFn<Message[]>('integration.fn_outbox_claim', 500);
        const noticeEvent = claimed.find(m => m.eventType === 'engagement.notice_published' && m.payload.noticeId === noticeRes.noticeId);
        assert.ok(noticeEvent);
        assert.equal(noticeEvent.payload.title, 'Annual Concerto Auditions Announced');

        const markRes = await callFn<{ success: boolean }>('integration.fn_outbox_mark_processed', noticeEvent.messageId);
        assert.equal(markRes.success, true);

        const nextClaim = await callFn<Message[]>('integration.fn_outbox_claim', 500);
        assert.ok(!nextClaim.some(m => m.messageId === noticeEvent.messageId));
    });
});

test('PLT-008 & PLT-012: Platform Telemetry & Audit Search', async (t) => {
    const tenant = await createTenant('Epsilon Reporting Studio', 'Professional');

    await t.test('fn_platform_metrics aggregates multi-tenant SaaS telemetry', async () => {
        const metrics = await callFn<{ totalTenants: number; totalMrr: number }>('reporting.fn_platform_metrics');
        assert.ok(metrics.totalTenants >= 1);
        assert.equal(typeof metrics.totalMrr, 'number');
    });

    await t.test('fn_fee_aging accurately buckets receivables', async () => {
        const aging = await callFn<{ current: number; totalOutstanding: number; overdueInvoices: unknown[] }>(
            'reporting.fn_fee_aging', tenant.tenantId, null);
        assert.equal(aging.current, 0);
        assert.equal(aging.totalOutstanding, 0);
        assert.ok(Array.isArray(aging.overdueInvoices));
    });

    await t.test('fn_audit_search filters compliance events', async () => {
        const res = await callFn<AuditSearch>('reporting.fn_audit_search', tenant.tenantId, 'tenant.created', 50, 0);
        assert.equal(res.total, 1);
        assert.ok(res.logs.every(l => l.action.includes('tenant.created')));
    });

    await t.test('fn_dashboard_summary returns six-month trends for an empty tenant', async () => {
        const summary = await callFn<{ revenueTrend: unknown[]; stats: { activeStudents: number } }>(
            'reporting.fn_dashboard_summary', tenant.tenantId, null);
        assert.equal(summary.revenueTrend.length, 6);
        assert.equal(summary.stats.activeStudents, 0);
    });
});

test('PLT-004: Sign-in, Session Tokens & Role Permissions', async (t) => {
    await t.test('passwords are salted scrypt hashes that verify only the right password', () => {
        const hash = hashPassword('Correct#Horse9');
        assert.match(hash, /^scrypt\$/);
        assert.notEqual(hash, hashPassword('Correct#Horse9'));
        assert.equal(verifyPassword('Correct#Horse9', hash), true);
        assert.equal(verifyPassword('wrong-password', hash), false);
    });

    await t.test('session tokens reject tampering', () => {
        const token = signToken({ sub: actor, name: 'Tester', tid: null, role: 'Finance', bid: null, pa: false });
        assert.equal(verifyToken(token)?.role, 'Finance');
        const [payload, signature] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), role: 'TenantAdmin' })).toString('base64url');
        assert.equal(verifyToken(`${forged}.${signature}`), null);
    });

    await t.test('role permissions follow least privilege', () => {
        assert.equal(can('Finance', 'billing.write'), true);
        assert.equal(can('Finance', 'students.write'), false);
        assert.equal(can('Instructor', 'attendance.write'), true);
        assert.equal(can('Instructor', 'billing.read'), false);
        assert.equal(can('BranchManager', 'settings.write'), false);
        assert.equal(can('Guardian', 'students.read'), false);
    });
});

test('Academies, branch-wise management & role-based users', async (t) => {
    const email = `admin.${suffix}@sports.example.com`;
    const academy = await callFn<TenantResult & { adminUserId: string }>('tenant.fn_tenant_create',
        'Zeta Sports Academy', `zeta-sports-${suffix}`, 'Sports', 'INR', 'Asia/Kolkata', 'Professional',
        'Zeta Admin', email, hashPassword('Admin#Pass1'), actor);
    createdTenants.push(academy.tenantId);

    await t.test('academy provisioning creates an admin sign-in with academy membership', async () => {
        const user = await callFn<{ passwordHash: string; memberships: Array<{ tenantId: string; role: string; academyType: string }> }>(
            'identity_app.fn_user_auth_lookup', email, null);
        assert.equal(verifyPassword('Admin#Pass1', user.passwordHash), true);
        assert.deepEqual(user.memberships.map(m => [m.tenantId, m.role, m.academyType]), [[academy.tenantId, 'TenantAdmin', 'Sports']]);
    });

    await t.test('students are managed branch-wise with a consolidated view', async () => {
        const branch = await callFn<{ branchId: string }>('tenant.fn_branch_create', academy.tenantId, 'North Ground', 'NORTH', null, null, actor);
        await createStudent(academy.tenantId, 'Mainer');
        await createStudent(academy.tenantId, 'Northy', null, branch.branchId);

        const all = await callFn<StudentSearch>('academics.fn_student_search', academy.tenantId, null, null, null, 50, 0);
        const north = await callFn<StudentSearch>('academics.fn_student_search', academy.tenantId, branch.branchId, null, null, 50, 0);
        const main = await callFn<StudentSearch>('academics.fn_student_search', academy.tenantId, academy.branchId, null, null, 50, 0);
        assert.equal(all.total, 2);
        assert.deepEqual(north.students.map(s => s.firstName), ['Northy']);
        assert.deepEqual(main.students.map(s => s.firstName), ['Mainer']);
    });

    await t.test('role-based users require valid roles and branch managers require a branch', async () => {
        await assert.rejects(callFn('tenant.fn_staff_create', academy.tenantId, 'X', `x.${suffix}@e.com`, null, hashPassword('Password#1'),
            'Overlord', null, null, actor), { code: '22023' });
        await assert.rejects(callFn('tenant.fn_staff_create', academy.tenantId, 'Y', `y.${suffix}@e.com`, null, hashPassword('Password#1'),
            'BranchManager', null, null, actor), { code: '22023' });

        const coach = await callFn<{ membershipId: string }>('tenant.fn_staff_create', academy.tenantId, 'Coach Kim',
            `coach.${suffix}@e.com`, null, hashPassword('Password#1'), 'Instructor', academy.branchId, 'Head Coach', actor);
        const staff = await callFn<Array<{ fullName: string; role: string }>>('tenant.fn_staff_list', academy.tenantId, academy.branchId);
        assert.ok(staff.some(s => s.fullName === 'Coach Kim' && s.role === 'Instructor'));

        await callFn('tenant.fn_membership_set_active', academy.tenantId, coach.membershipId, false, actor);
        const lookup = await callFn<{ memberships: unknown[] }>('identity_app.fn_user_auth_lookup', `coach.${suffix}@e.com`, null);
        assert.equal(lookup.memberships.length, 0, 'deactivated members lose academy access');
    });

    await t.test('guardians get a parent-portal sign-in linked to their household', async () => {
        const student = await createStudent(academy.tenantId, 'Kiddo');
        const [guardian] = await query<{ guardian_id: string }>(
            `INSERT INTO academics.guardians (tenant_id, household_code, first_name, last_name, phone, email)
             VALUES ($1, 'HH-1', 'Pat', 'Parent', '1', $2) RETURNING guardian_id`, [academy.tenantId, `parent.${suffix}@e.com`]);
        await query(`INSERT INTO academics.student_guardian_links (tenant_id, student_id, guardian_id) VALUES ($1, $2, $3)`,
            [academy.tenantId, student.studentId, guardian.guardian_id]);

        const enabled = await callFn<{ userId: string }>('academics.fn_guardian_portal_enable', academy.tenantId, guardian.guardian_id, hashPassword('Parent#Pass1'), actor);
        const household = await callFn<{ academyType: string; wards: Array<{ name: string; payments: unknown[]; attendanceHistory: unknown[] }>; notices: unknown[]; achievementBoard: unknown[] }>(
            'reporting.fn_guardian_household', academy.tenantId, null, enabled.userId);
        assert.equal(household.academyType, 'Sports');
        assert.deepEqual(household.wards.map(w => w.name), ['Kiddo Tester']);
        assert.ok(Array.isArray(household.wards[0].payments) && Array.isArray(household.wards[0].attendanceHistory));
        assert.ok(Array.isArray(household.notices) && Array.isArray(household.achievementBoard));
    });
});

test('Self-service academy sign-up', async (t) => {
    const email = `owner.${suffix}@signup.example.com`;
    const register = (ownerEmail: string) => callFn<TenantResult & { adminUserId: string; slug: string }>('tenant.fn_tenant_register',
        'Ravi Math Academy', 'Tuition', 'Starter', 'Ravi Kumar', ownerEmail, '+91 98400 00000', hashPassword('Owner#Pass1'));
    const academy = await register(email);
    createdTenants.push(academy.tenantId);

    await t.test('creates the academy, main branch, subscription and an owner who can sign in as admin', async () => {
        const user = await callFn<{ passwordHash: string; memberships: Array<{ tenantId: string; role: string; academyType: string }> }>(
            'identity_app.fn_user_auth_lookup', email, null);
        assert.equal(verifyPassword('Owner#Pass1', user.passwordHash), true);
        assert.deepEqual(user.memberships.map(m => [m.tenantId, m.role, m.academyType]), [[academy.tenantId, 'TenantAdmin', 'Tuition']]);
        assert.equal(academy.planTier, 'Starter');
        assert.ok(academy.branchId);

        const [stored] = await query<{ phone: string; contact: { email: string; phone: string } }>(
            `SELECT u.phone, o.settings->'contact' AS contact FROM identity_app.users u, tenant.organizations o
             WHERE u.user_id = $1 AND o.tenant_id = $2`, [academy.adminUserId, academy.tenantId]);
        assert.equal(stored.phone, '+91 98400 00000');
        assert.equal(stored.contact.email, email);
    });

    await t.test('a second academy with the same name gets its own workspace slug', async () => {
        const second = await register(`second.${suffix}@signup.example.com`);
        createdTenants.push(second.tenantId);
        assert.notEqual(second.slug, academy.slug);
    });

    await t.test('an email that already has a sign-in is refused', async () => {
        await assert.rejects(register(email.toUpperCase()), (err: { code?: string }) => err.code === '23505');
    });
});

test('Courses, subjects, tests, grading & parent portal results', async (t) => {
    const academy = await createTenant('Theta Tuition Centre', 'Professional');

    const course = await callFn<{ courseId: string }>('academics.fn_course_create', academy.tenantId, 'Class 10 Science', 'sci10',
        'Science', 'Class 10', 12, 1500, 'monthly', null, ['Physics', 'Chemistry', 'Biology'], actor);
    const [batch] = await query<{ batch_id: string }>(
        `INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, start_date) VALUES ($1, $2, $3, 'Science 10A', CURRENT_DATE) RETURNING batch_id`,
        [academy.tenantId, course.courseId, academy.branchId]);
    const asha = await createStudent(academy.tenantId, 'Asha', batch.batch_id);
    const ravi = await createStudent(academy.tenantId, 'Ravi', batch.batch_id);

    await t.test('courses carry their subjects and accept new ones', async () => {
        await callFn('academics.fn_course_subject_add', academy.tenantId, course.courseId, 'Practicals', actor);
        const courses = await callFn<Array<{ code: string; subjects: Array<{ name: string }> }>>('academics.fn_course_list', academy.tenantId);
        assert.equal(courses[0].code, 'SCI10');
        assert.deepEqual(courses[0].subjects.map(s => s.name), ['Physics', 'Chemistry', 'Biology', 'Practicals']);
    });

    const subjects = (await callFn<Array<{ subjects: Array<{ subjectId: string; name: string }> }>>('academics.fn_course_list', academy.tenantId))[0].subjects;
    const physics = subjects.find(s => s.name === 'Physics')!.subjectId;
    const chemistry = subjects.find(s => s.name === 'Chemistry')!.subjectId;
    const test1 = await callFn<{ testId: string }>('academics.fn_test_schedule', academy.tenantId, batch.batch_id, 'Unit Test 1', 'Unit Test',
        '2026-10-20', JSON.stringify([{ subjectId: physics, maxMarks: 50 }, { subjectId: chemistry, maxMarks: 50 }]), actor);

    await t.test('marks above the maximum are rejected', async () => {
        await assert.rejects(callFn('academics.fn_test_results_save', academy.tenantId, test1.testId,
            JSON.stringify([{ studentId: asha.studentId, subjectId: physics, marks: 51 }]), actor), { code: '22023' });
    });

    await t.test('report card computes totals, percentage, grade and rank', async () => {
        await callFn('academics.fn_test_results_save', academy.tenantId, test1.testId, JSON.stringify([
            { studentId: asha.studentId, subjectId: physics, marks: 48 }, { studentId: asha.studentId, subjectId: chemistry, marks: 45 },
            { studentId: ravi.studentId, subjectId: physics, marks: 30 }, { studentId: ravi.studentId, subjectId: chemistry, absent: true },
        ]), actor);
        type Row = { name: string; total: number; percentage: number; grade: string; rank: number; marks: Record<string, { grade: string | null; absent: boolean }> };
        const report = await callFn<{ test: { status: string }; students: Row[]; summary: { averagePercentage: number } }>(
            'academics.fn_test_report', academy.tenantId, test1.testId);
        assert.equal(report.test.status, 'completed');
        const [first, second] = report.students;
        assert.deepEqual([first.name, first.total, first.percentage, first.grade, first.rank], ['Asha Tester', 93, 93, 'A+', 1]);
        assert.deepEqual([second.name, second.total, second.percentage, second.grade, second.rank], ['Ravi Tester', 30, 30, 'F', 2]);
        assert.equal(second.marks[chemistry].absent, true);
        assert.equal(first.marks[physics].grade, 'A+');
    });

    await t.test('a parent with two children sees both children and only published results', async () => {
        const guardian = await callFn<{ guardianId: string }>('academics.fn_guardian_create', academy.tenantId, 'Meera', 'Tester', 'Mother',
            '9000000000', `meera.${suffix}@example.com`, [asha.studentId, ravi.studentId], actor);
        const login = await callFn<{ userId: string }>('academics.fn_guardian_portal_enable', academy.tenantId, guardian.guardianId, hashPassword('Parent#Pass2'), actor);

        type Household = { wards: Array<{ name: string; testResults: Array<{ test: { title: string }; result: { grade: string; rank: number } }> }> };
        const before = await callFn<Household>('reporting.fn_guardian_household', academy.tenantId, null, login.userId);
        assert.deepEqual(before.wards.map(w => w.name), ['Asha Tester', 'Ravi Tester']);
        assert.equal(before.wards[0].testResults.length, 0, 'unpublished results stay hidden');

        await callFn('academics.fn_test_publish', academy.tenantId, test1.testId, actor);
        const after = await callFn<Household>('reporting.fn_guardian_household', academy.tenantId, null, login.userId);
        const asha1 = after.wards.find(w => w.name === 'Asha Tester')!.testResults[0];
        assert.equal(asha1.test.title, 'Unit Test 1');
        assert.deepEqual([asha1.result.grade, asha1.result.rank], ['A+', 1]);
    });
});
