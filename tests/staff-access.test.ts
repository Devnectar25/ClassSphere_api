// What Staff and branch users can reach, driven through the real API route handlers.
// Always runs on a throw-away in-memory database; DATABASE_URL is ignored on purpose.
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
const route = (path: string): Promise<any> => import(`@/app/api/v1/${path}/route`); // eslint-disable-line @typescript-eslint/no-explicit-any
const api = Object.fromEntries(await Promise.all(['courses', 'batches', 'branches', 'tenants', 'students', 'guardians', 'attendance', 'tests', 'achievements', 'fees', 'invoices',
    'payments', 'staff', 'notices', 'portal', 'billing/credits', 'billing/schedule', 'billing/transfers', 'billing/overdue', 'billing/overdue/summary', 'billing/consumption',
].map(async p => [p, await route(p)] as const)));

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let tenantId = '', north = '', south = '', admin = '';
const B: Record<string, { course: string; batch: string }> = {};
const S: Record<string, string> = {};
let n = 0;

async function call(path: string, method: string, user: { id: string; role: string; branch?: string | null }, opts: { body?: Json; search?: string; header?: string } = {}) {
    const token = signToken({ sub: user.id, name: user.role, tid: tenantId, role: user.role as Json, bid: user.branch ?? null, pa: false });
    const res = await api[path][method](new NextRequest(`http://localhost/x${opts.search ?? ''}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.header ? { 'x-branch-id': opts.header } : {}) }, ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    }));
    const json: Json = await res.json();
    return { status: res.status as number, data: json.data, detail: json.detail as string };
}
async function must(p: ReturnType<typeof call>) {
    const r = await p;
    assert.ok(r.status < 300, `${r.status} ${r.detail}`);
    return r.data;
}
async function user(role: string, branch: string | null = null) {
    const [u] = await query<{ user_id: string }>(`INSERT INTO identity_app.users (email, full_name, password_hash) VALUES ($1, $2, 'x') RETURNING user_id`, [`${role}${++n}@t.test`, `${role} ${n}`]);
    const [m] = await query<{ membership_id: string }>(`INSERT INTO tenant.memberships (tenant_id, user_id, role, branch_id) VALUES ($1, $2, $3, $4) RETURNING membership_id`, [tenantId, u.user_id, role, branch]);
    return { id: u.user_id, role, branch, membershipId: m.membership_id };
}
async function batch(name: string, branch: string, courseId?: string, courseBranch: string | null = branch) {
    const course = courseId ?? (await query<{ course_id: string }>(
        `INSERT INTO academics.courses (tenant_id, title, code, category, tuition_amount, duration_months, branch_id) VALUES ($1, $2, $2, 'T', 1000, 12, $3) RETURNING course_id`, [tenantId, `C-${name}`, courseBranch]))[0].course_id;
    const [b] = await query<{ batch_id: string }>(`INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, start_date) VALUES ($1, $2, $3, $4, CURRENT_DATE) RETURNING batch_id`, [tenantId, course, branch, name]);
    B[name] = { course, batch: b.batch_id };
}
async function pupil(name: string, branch: string, ...batches: string[]) {
    const s = await callFn<{ studentId: string }>('academics.fn_student_create', tenantId, name, 'Test', `${name.toLowerCase()}@t.test`, null, '2012-01-01', null, null, null, B[batches[0]].batch, branch, admin);
    for (const b of batches.slice(1)) await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status) VALUES ($1, $2, $3, 'confirmed')`, [tenantId, s.studentId, B[b].batch]);
    for (const b of batches) {
        const [e] = await query<{ enrollment_id: string }>(`SELECT enrollment_id FROM academics.enrollments WHERE student_id = $1 AND batch_id = $2`, [s.studentId, B[b].batch]);
        await query(`INSERT INTO billing.invoices (tenant_id, invoice_number, student_id, enrollment_id, billing_period, subtotal_amount, total_amount, balance_amount, due_date, designation)
            VALUES ($1, $2, $3, $4, 'x', 100, 100, 100, CURRENT_DATE - 5, $5)`, [tenantId, `I${++n}`, s.studentId, e.enrollment_id, `Fee ${b}`]);
    }
    await callFn('academics.fn_guardian_create', tenantId, `G${name}`, 'Test', 'Parent', `98765${10000 + ++n}`, `g${n}@t.test`, [s.studentId], admin);
    S[name] = s.studentId;
}
const assign = (u: { membershipId: string }, branchId: string | null, courses: string[], batches: string[], by = { id: admin, role: 'TenantAdmin' }) =>
    call('staff', 'PUT', by, { body: { action: 'assign', membershipId: u.membershipId, branchId, assignments: { courseIds: courses.map(c => B[c].course), batchIds: batches.map(b => B[b].batch) } } });
const names = async (p: ReturnType<typeof call>, key: string) => (await must(p)).map((x: Json) => x[key]).sort();
const listed = async (u: Json) => (await must(call('students', 'GET', u))).students.map((x: Json) => x.firstName).sort();

before(async () => {
    await applyScripts(['migrations', 'functions']);
    const t = await callFn<{ tenantId: string; branchId: string }>('tenant.fn_tenant_create', 'Access Academy', 'access', 'Tuition', 'INR', 'Asia/Kolkata', 'Enterprise', null, null, null, randomUUID());
    tenantId = t.tenantId; north = t.branchId;
    [{ branch_id: south }] = await query<{ branch_id: string }>(`INSERT INTO tenant.branches (tenant_id, name, code) VALUES ($1, 'South', 'S') RETURNING branch_id`, [tenantId]);
    admin = (await user('TenantAdmin')).id;
    await batch('A1', north); await batch('A2', north, B.A1.course); await batch('B1', north); await batch('X1', south);
    await batch('Shared', south, undefined, null); // a course of all branches, with a batch in South only
    await pupil('Ann', north, 'A1'); await pupil('Ben', north, 'A2'); await pupil('Cat', north, 'B1'); await pupil('Dan', south, 'X1'); await pupil('Eve', north, 'A1', 'B1');
});
after(closeDb);

test('staff of a branch without assignments see no courses, batches or students', async () => {
    const u = await user('Staff', north);
    assert.deepEqual([await names(call('courses', 'GET', u), 'title'), await names(call('batches', 'GET', u, { search: '?branchId=all' }), 'name'), await listed(u)], [[], [], []]);
    assert.deepEqual([await must(call('guardians', 'GET', u)), (await must(call('invoices', 'GET', u))).invoices, (await must(call('payments', 'GET', u))).payments], [[], [], []]);
    assert.deepEqual((await must(call('tenants', 'GET', u))).staffAccess, { courses: 0, batches: 0 });
    assert.equal((await call('students', 'GET', u, { search: `?studentId=${S.Ann}` })).status, 403);
    // an account without an active Staff membership reaches nothing either
    const [gone] = [await user('Staff', north)];
    await query(`UPDATE tenant.memberships SET is_active = false WHERE membership_id = $1`, [gone.membershipId]);
    assert.deepEqual(await listed(gone), []);
});

test('staff see only their branch and the assigned batch, whatever they ask for', async () => {
    const u = await user('Staff', north);
    await must(assign(u, north, ['A1'], ['A1']));
    assert.deepEqual(await names(call('courses', 'GET', u), 'title'), ['C-A1']);
    for (const search of ['', '?branchId=all', `?branchId=${south}`]) assert.deepEqual(await names(call('batches', 'GET', u, { search, header: south }), 'name'), ['A1'], search);
    assert.deepEqual(await names(call('branches', 'GET', u), 'branchId'), [north]);
    assert.deepEqual((await must(call('tenants', 'GET', u))).branches.map((b: Json) => b.branchId), [north]);
    const [c] = await must(call('courses', 'GET', u));
    assert.deepEqual([c.batchCount, c.studentCount], [1, 2]);

    const found = await must(call('students', 'GET', u, { search: `?branchId=${south}` }));
    assert.deepEqual([found.students.map((x: Json) => [x.firstName, x.batches]).sort(), found.total, found.statusCounts], [[['Ann', 'A1'], ['Eve', 'A1']], 2, { active: 2 }]);
    for (const search of [`?batchId=${B.B1.batch}`, `?courseId=${B.B1.course}`, `?batchId=${B.X1.batch}`]) assert.equal((await must(call('students', 'GET', u, { search }))).total, 0);
    assert.equal((await must(call('students', 'GET', u, { search: '?limit=1&offset=1' }))).students.length, 1);

    const eve = await must(call('students', 'GET', u, { search: `?studentId=${S.Eve}` }));
    assert.deepEqual([eve.enrollments.map((e: Json) => e.batchName), eve.invoices.map((i: Json) => i.designation)], [['A1'], ['Fee A1']], 'other courses of the student stay hidden');
    assert.deepEqual((await must(call('payments', 'GET', u, { search: `?studentId=${S.Eve}` }))).courses.map((x: Json) => x.batchName), ['A1']);
    const ledger = await must(call('invoices', 'GET', u));
    assert.deepEqual([ledger.invoices.map((i: Json) => i.designation), ledger.summary.overdueAmount, ledger.aging.days1To30, ledger.aging.counts.days1To30], [['Fee A1', 'Fee A1'], 200, 200, 2]);
    assert.equal((await must(call('billing/overdue', 'GET', u))).summary.totalOverdueAmount, 200);
    assert.deepEqual((await must(call('guardians', 'GET', u))).map((g: Json) => g.firstName).sort(), ['GAnn', 'GEve']);
    assert.ok((await must(call('portal', 'GET', u))).wards.every((w: Json) => [S.Ann, S.Eve].includes(w.id)));

    for (const id of [S.Ben, S.Cat, S.Dan]) {
        for (const path of ['students', 'payments', 'billing/credits', 'attendance']) assert.equal((await call(path, 'GET', u, { search: `?studentId=${id}` })).status, 403, `${path} ${id}`);
    }
    const [g] = await query<{ guardian_id: string }>(`SELECT guardian_id FROM academics.student_guardian_links WHERE student_id = $1`, [S.Cat]);
    assert.equal((await call('portal', 'GET', u, { search: `?guardianId=${g.guardian_id}` })).status, 403);
    const enr = async (s: string) => (await query<{ enrollment_id: string }>(`SELECT enrollment_id FROM academics.enrollments WHERE student_id = $1`, [s]))[0].enrollment_id;
    for (const path of ['billing/schedule', 'billing/consumption']) assert.equal((await call(path, 'GET', u, { search: `?enrollmentId=${await enr(S.Cat)}` })).status, 403, path);
    assert.equal((await call('billing/overdue/summary', 'GET', u)).status, 403);
    await must(call('billing/schedule', 'GET', u, { search: `?enrollmentId=${await enr(S.Ann)}` }));
});

test('staff can change only their own batches and students', async () => {
    const u = await user('Staff', north);
    await must(assign(u, north, [], ['A1']));
    const today = new Date().toISOString().slice(0, 10);
    const mark = (b: string, s: string) => call('attendance', 'POST', u, { body: { batchId: B[b].batch, sessionDate: today, records: [{ studentId: s, status: 'present' }] } });
    await must(mark('A1', S.Ann));
    for (const b of ['A2', 'B1', 'X1']) {
        assert.equal((await mark(b, S.Ann)).status, 403);
        for (const search of [`?batchId=${B[b].batch}&date=${today}`, `?batchId=${B[b].batch}&from=${today}&to=${today}`]) assert.equal((await call('attendance', 'GET', u, { search })).status, 403);
    }
    await callFn('academics.fn_attendance_mark_batch', tenantId, B.B1.batch, today, JSON.stringify([{ studentId: S.Eve, status: 'absent' }]), admin);
    await must(mark('A1', S.Eve));
    const own = await must(call('attendance', 'GET', u, { search: `?studentId=${S.Eve}` }));
    assert.deepEqual([own.records.map((r: Json) => r.batchName), own.summary.total, own.summary.rate], [['A1'], 1, 100]);
    assert.equal((await call('attendance', 'DELETE', u, { search: `?studentId=${S.Eve}&sessionDate=${today}` })).status, 403, 'the day includes another batch');
    await must(call('attendance', 'DELETE', u, { search: `?studentId=${S.Ann}&sessionDate=${today}` }));

    const reg = (b: string | null, email: string) => call('students', 'POST', u, { body: { firstName: 'New', lastName: 'Pupil', email, branchId: south, batchId: b && B[b].batch } });
    for (const b of [null, 'A2', 'X1']) assert.equal((await reg(b, `r${++n}@t.test`)).status, 403);
    const made = await must(reg('A1', `r${++n}@t.test`));
    const [row] = await query<Json>(`SELECT branch_id FROM academics.students WHERE student_id = $1`, [made.studentId]);
    assert.equal(row.branch_id, north, 'always their own branch');
    const edit = (body: Json) => call('students', 'PUT', u, { body: { firstName: 'New', lastName: 'Pupil', email: `e${n}@t.test`, ...body } });
    assert.equal((await edit({ studentId: S.Cat })).status, 403);
    assert.equal((await edit({ studentId: made.studentId, batchId: B.B1.batch })).status, 403);
    assert.equal((await edit({ studentId: made.studentId, branchId: south })).status, 403);
    const enrolled = (b: string) => query<{ enrollment_id: string }>(`SELECT enrollment_id FROM academics.enrollments WHERE student_id = $1 AND batch_id = $2`, [S.Ann, B[b].batch]);
    const move = (b: string, s = S.Ann) => call('students', 'POST', u, { body: { action: 'transfer-course', studentId: s, currentEnrollmentId: randomUUID(), destinationBranchId: north, destinationCourseId: B[b].course, destinationBatchId: B[b].batch, transferDate: today, transferReason: 'x' } });
    for (const b of ['A2', 'B1']) assert.equal((await move(b)).status, 403);
    assert.equal((await enrolled('B1')).length, 0);
    assert.equal((await call('students', 'POST', u, { body: { action: 'add-course', studentId: S.Ann, branchId: north, courseId: B.B1.course, batchId: B.B1.batch, enrollmentDate: today } })).status, 403);
    assert.equal((await call('achievements', 'POST', u, { body: { studentId: S.Cat, title: 'x', category: 'y' } })).status, 403);
    assert.equal((await call('notices', 'POST', u, { body: { title: 'x', content: 'y', targetBatchId: B.B1.batch } })).status, 403);
});

test('a course without chosen batches means all of its batches in the branch; changes apply at once', async () => {
    const u = await user('Staff', north);
    await must(assign(u, north, ['A1'], []));
    assert.deepEqual([await names(call('batches', 'GET', u), 'name'), await listed(u).then(l => l.filter((x: string) => x !== 'New'))], [['A1', 'A2'], ['Ann', 'Ben', 'Eve']]);
    await must(assign(u, north, ['A1', 'B1'], ['A2']));
    assert.deepEqual(await names(call('batches', 'GET', u), 'name'), ['A2', 'B1']);
    // the old token still names the first branch
    await must(assign(u, south, [], ['X1']));
    assert.deepEqual([await names(call('batches', 'GET', u), 'name'), await listed(u), await names(call('branches', 'GET', u), 'branchId')], [['X1'], ['Dan'], [south]]);
    const logs = await query<Json>(`SELECT details FROM audit.compliance_logs WHERE action = 'staff.access_changed' AND entity_id = $1 ORDER BY created_at`, [u.membershipId]);
    assert.deepEqual([logs.length, logs[2].details.previous.branchId, logs[2].details.batchIds], [3, north, [B.X1.batch]]);
});

test('staff without a branch work across the academy until something is assigned', async () => {
    const u = await user('Staff');
    assert.equal((await names(call('batches', 'GET', u, { search: '?branchId=all' }), 'name')).length, 5);
    assert.equal((await must(call('tenants', 'GET', u))).staffAccess, null);
    await must(assign(u, null, [], ['A1', 'X1']));
    assert.deepEqual([await names(call('batches', 'GET', u, { search: '?branchId=all' }), 'name'), (await names(call('branches', 'GET', u), 'branchId')).length], [['A1', 'X1'], 2]);
    assert.ok((await listed(u)).includes('Dan') && !(await listed(u)).includes('Cat'));
});

test('assignments are managed by academy admins, validated and only for Staff', async () => {
    const u = await user('Staff', north);
    for (const role of ['Staff', 'BranchManager', 'Finance', 'Instructor']) assert.equal((await assign(u, north, [], ['A1'], await user(role, north))).status, 403, role);
    assert.equal((await assign(u, north, [], ['X1'])).status, 400, 'batch of another branch');
    assert.equal((await assign(u, north, ['X1'], [])).status, 400, 'course of another branch');
    assert.equal((await assign(await user('Instructor', north), north, [], ['A1'])).status, 400);
    const foreign = randomUUID();
    assert.equal((await call('staff', 'PUT', { id: admin, role: 'TenantAdmin' }, { body: { action: 'assign', membershipId: u.membershipId, branchId: north, assignments: { batchIds: [foreign] } } })).status, 400);
    const created = await must(call('staff', 'POST', { id: admin, role: 'TenantAdmin' }, { body: { fullName: 'S T', email: 'st@t.test', password: 'Password1!', role: 'Staff', branchId: north, assignments: { courseIds: [B.A1.course], batchIds: [B.A2.batch] } } }));
    const member = (await must(call('staff', 'GET', { id: admin, role: 'TenantAdmin' }))).find((x: Json) => x.membershipId === created.membershipId);
    assert.deepEqual([member.assignments, member.assignedTo], [{ courseIds: [B.A1.course], batchIds: [B.A2.batch] }, ['C-A1: A2']]);
    assert.equal((await call('staff', 'POST', { id: admin, role: 'TenantAdmin' }, { body: { fullName: 'S U', email: 'su@t.test', password: 'Password1!', role: 'Staff', branchId: north, assignments: { batchIds: [B.X1.batch] } } })).status, 400);
    assert.equal((await query(`SELECT 1 FROM identity_app.users WHERE email = 'su@t.test'`)).length, 0, 'nothing is created');
});

test('other branch users stay within their branch; admins see everything', async () => {
    for (const role of ['BranchManager', 'Instructor', 'Finance']) {
        const u = await user(role, south);
        for (const search of ['', '?branchId=all', `?branchId=${north}`]) assert.deepEqual(await names(call('batches', 'GET', u, { search }), 'name'), ['Shared', 'X1'], role);
        assert.deepEqual(await names(call('courses', 'GET', u), 'title'), ['C-Shared', 'C-X1']);
        assert.deepEqual(await names(call('branches', 'GET', u), 'branchId'), [south]);
        assert.equal((await call('students', 'GET', u, { search: `?studentId=${S.Ann}` })).status, 403);
        assert.deepEqual((await must(call('students', 'GET', u, { search: `?branchId=${north}` }))).students.map((x: Json) => x.firstName), ['Dan']);
    }
    const boss = { id: admin, role: 'TenantAdmin' };
    assert.equal((await names(call('batches', 'GET', boss, { search: '?branchId=all', header: north }), 'name')).length, 5, 'a selected branch view is not a restriction');
    assert.equal((await names(call('courses', 'GET', boss, { header: north }), 'title')).length, 4);
    assert.equal((await must(call('students', 'GET', boss, { search: `?studentId=${S.Dan}`, header: north }))).enrollments.length, 1);
});

test('losing an assigned batch never opens the rest of its course', async () => {
    await batch('Tmp', north, B.A1.course);
    const u = await user('Staff', north);
    await must(assign(u, north, ['B1'], ['Tmp']));
    const row = async () => (await must(call('staff', 'GET', { id: admin, role: 'TenantAdmin' }))).find((x: Json) => x.membershipId === u.membershipId);
    assert.deepEqual((await row()).assignedTo, ['C-A1: Tmp', 'C-B1: all batches']);
    await query(`DELETE FROM academics.batches WHERE batch_id = $1`, [B.Tmp.batch]);
    assert.deepEqual([await names(call('batches', 'GET', u), 'name'), await names(call('courses', 'GET', u), 'title')], [['B1'], ['C-B1']]);
    const now = await row();
    assert.deepEqual([now.assignments.batchIds, now.assignedTo], [[], ['C-B1: all batches']]);
    await must(call('staff', 'PUT', { id: admin, role: 'TenantAdmin' }, { body: { action: 'assign', membershipId: u.membershipId, branchId: north, assignments: now.assignments } }));
});

test('a batch belongs to the branch of its course, and moving it is saved', async () => {
    const boss = { id: admin, role: 'TenantAdmin' };
    const body = { name: 'New batch', courseId: B.X1.course, startDate: '2027-01-01', schedules: [{ weekday: 1, startTime: '10:00', endTime: '11:00' }] };
    assert.equal((await call('batches', 'POST', boss, { body: { ...body, branchId: north } })).status, 400);
    const branch = async (id: string) => (await query<Json>(`SELECT branch_id FROM academics.batches WHERE batch_id = $1`, [id]))[0].branch_id;
    const made = await must(call('batches', 'POST', boss, { body, header: north }));
    assert.equal(await branch(made.batchId), south, 'the branch of the course, not the selected view');
    await must(call('batches', 'POST', boss, { body: { ...body, branchId: south }, header: north }));
    assert.equal((await call('batches', 'POST', await user('TenantAdmin'), { body: { ...body, branchId: randomUUID(), courseId: B.Shared.course } })).status, 400);

    const edit = (extra: Json, u: Json = boss) => call('batches', 'PUT', u, { body: { ...body, batchId: B.Shared.batch, courseId: B.Shared.course, name: 'Shared', ...extra } });
    await must(edit({ branchId: north }));
    assert.equal(await branch(B.Shared.batch), north);
    assert.equal((await query(`SELECT 1 FROM audit.compliance_logs WHERE action = 'batch.branch_changed' AND entity_id = $1`, [B.Shared.batch])).length, 1);
    await must(edit({}));
    assert.equal(await branch(B.Shared.batch), north, 'kept when not sent');
    assert.equal((await edit({ courseId: B.X1.course })).status, 400, 'a South course cannot move into a North batch');
    // a batch saved earlier in the wrong branch can still be edited, and corrected
    await query(`UPDATE academics.batches SET branch_id = $2 WHERE batch_id = $1`, [made.batchId, north]);
    const fix = (extra: Json) => call('batches', 'PUT', boss, { body: { ...body, batchId: made.batchId, ...extra } });
    await must(fix({ branchId: north }));
    await must(fix({ branchId: south }));
    assert.equal(await branch(made.batchId), south);
    assert.equal((await fix({ branchId: north })).status, 400);
});
