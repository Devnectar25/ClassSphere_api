// Course transfer, credit ledger and installment payments, driven through the real API route handlers.
// Always runs on a throw-away in-memory database; DATABASE_URL is ignored on purpose.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

delete process.env.DATABASE_URL;
process.env.DATABASE_DIR = 'memory://';
process.env.AUTH_SECRET = 'test-secret-for-session-tokens-0123456789';
process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
process.env.RAZORPAY_KEY_SECRET = 'unit-secret';
delete process.env.RAZORPAY_WEBHOOK_SECRET;

const { NextRequest } = await import('next/server');
const { callFn, query, closeDb } = await import('@/lib/db/db');
const { applyScripts } = await import('../database/migrate.ts');
const { signToken } = await import('@/lib/auth');
const { buildSchedule, parseFeePlanInput } = await import('@/lib/billing/fee-plans');
const students = await import('@/app/api/v1/students/route');
const transfers = await import('@/app/api/v1/billing/transfers/route');
const credits = await import('@/app/api/v1/billing/credits/route');
const payments = await import('@/app/api/v1/payments/route');
const verify = await import('@/app/api/v1/payments/verify/route');
const portal = await import('@/app/api/v1/portal/route');
const webhook = await import('@/app/api/v1/webhooks/razorpay/route');
const scheduleApi = await import('@/app/api/v1/billing/schedule/route');
const consumption = await import('@/app/api/v1/billing/consumption/route');
const testsApi = await import('@/app/api/v1/tests/route');
const testPublish = await import('@/app/api/v1/tests/publish/route');
const testReport = await import('@/app/api/v1/tests/report/route');
const { addMonths, fittingInstallments } = await import('@/lib/billing/course-period');

type Handler = (req: InstanceType<typeof NextRequest>) => Promise<Response>;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let tenantId = '';
let branchId = '';
let otherBranchId = '';
const users: Record<string, string> = {};
let counter = 0;
const realFetch = globalThis.fetch;

async function createUser(role: string) {
    const [row] = await query<{ user_id: string }>(
        `INSERT INTO identity_app.users (email, full_name, password_hash) VALUES ($1, $2, 'x') RETURNING user_id`,
        [`${role.toLowerCase()}.${randomUUID().slice(0, 8)}@example.com`, `${role} User`]);
    return row.user_id;
}

async function call(handler: Handler, method: string, role: string, opts: { body?: Json; search?: string; key?: string; branch?: string | null; userId?: string } = {}) {
    const token = signToken({ sub: opts.userId ?? users[role], name: role, tid: tenantId, role: role as Json, bid: opts.branch ?? null, pa: false });
    const res = await handler(new NextRequest(`http://localhost/api/v1/x${opts.search ?? ''}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.key ? { 'idempotency-key': opts.key } : {}) },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    }));
    const json: Json = await res.json();
    return { status: res.status, data: json.data, detail: json.detail as string };
}

async function must(promise: ReturnType<typeof call>) {
    const res = await promise;
    assert.ok(res.status < 300, `expected success, got ${res.status}: ${res.detail}`);
    return res.data;
}

async function course(fee: number, title = `Course ${++counter}`, branch = branchId) {
    const [c] = await query<{ course_id: string }>(
        `INSERT INTO academics.courses (tenant_id, title, code, category, tuition_amount, duration_months) VALUES ($1, $2, $3, 'Test', $4, 12) RETURNING course_id`,
        [tenantId, title, `C${++counter}`, fee]);
    const [b] = await query<{ batch_id: string }>(
        `INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, start_date) VALUES ($1, $2, $3, $4, CURRENT_DATE - 30) RETURNING batch_id`,
        [tenantId, c.course_id, branch, `Batch ${++counter}`]);
    return { courseId: c.course_id, batchId: b.batch_id, title };
}

type Course = Awaited<ReturnType<typeof course>>;

async function student(...batchIds: string[]) {
    const s = await callFn<{ studentId: string }>('academics.fn_student_create', tenantId, 'Stu', 'Dent', `s${++counter}@example.com`, null,
        '2012-05-14', null, null, null, batchIds[0] ?? null, branchId, users.TenantAdmin);
    for (const b of batchIds.slice(1)) {
        await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status) VALUES ($1, $2, $3, 'enrolled')`, [tenantId, s.studentId, b]);
    }
    return s.studentId;
}

async function enrollmentOf(studentId: string, batchId: string) {
    const [row] = await query<{ enrollment_id: string; status: string }>(
        `SELECT enrollment_id, status FROM academics.enrollments WHERE student_id = $1 AND batch_id = $2`, [studentId, batchId]);
    return row;
}

const plan = (extra: Json = {}) => ({ paymentMode: 'installment', frequency: 'monthly', installmentCount: 3, firstDueDate: '2027-01-31', ...extra });

/** Gives an enrollment its fee plan through the API, then records an offline payment. */
async function bill(studentId: string, c: Course, installmentCount: number, paid: number) {
    const { enrollment_id } = await enrollmentOf(studentId, c.batchId);
    const created = await must(call(transfers.POST, 'POST', 'Finance', { body: { action: 'create_fee_plan', enrollmentId: enrollment_id, ...plan({ installmentCount }) } }));
    if (paid > 0) await pay(studentId, { enrollmentId: enrollment_id, amount: paid });
    return { enrollmentId: enrollment_id, invoices: created.installments as Json[] };
}

const pay = (studentId: string, body: Json, key: string = randomUUID()) =>
    must(call(payments.POST, 'POST', 'Finance', { key, body: { studentId, paymentMethod: 'Cash', ...body } }));

async function transfer(studentId: string, from: Course, to: Course, extra: Json = {}, role = 'TenantAdmin') {
    const { enrollment_id } = await enrollmentOf(studentId, from.batchId);
    return call(students.POST, 'POST', role, {
        body: {
            action: 'transfer-course', studentId, currentEnrollmentId: enrollment_id, destinationBranchId: branchId, destinationCourseId: to.courseId,
            destinationBatchId: to.batchId, transferDate: new Date().toISOString().slice(0, 10), transferReason: 'Test transfer', ...extra,
            ...(extra.review ? { review: reasoned(extra.review) } : {}),
        },
    });
}

/** A consumed fee entered by hand always needs a reason; tests about something else use this one. */
const reasoned = (body: Json) => (body?.consumedAmount !== undefined && !body.notes ? { notes: 'Checked by Finance', ...body } : body);
const review = (transferId: string, body: Json, role = 'Finance') => call(transfers.POST, 'POST', role, { body: { action: 'review', transferId, ...reasoned(body) } });
const createPlan = (transferId: string, body: Json, role = 'Finance') => call(transfers.POST, 'POST', role, { body: { action: 'create_fee_plan', transferId, ...plan(body) } });
const breakdown = (studentId: string) => must(call(payments.GET, 'GET', 'Finance', { search: `?studentId=${studentId}` }));
const ledger = (studentId: string) => must(call(credits.GET, 'GET', 'Finance', { search: `?studentId=${studentId}` }));
const courseOf = (b: Json, c: Course) => b.courses.find((x: Json) => x.courseId === c.courseId);
const receiptsTotal = async (studentId: string) => Number((await query<{ t: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS t FROM billing.payments WHERE student_id = $1`, [studentId]))[0].t);

/** Every invoice must reconcile and the ledger must match its own running balance. */
async function assertConsistent(studentId: string) {
    const bad = await query(
        `SELECT invoice_number FROM billing.invoices WHERE student_id = $1 AND status <> 'void' AND waived_at IS NULL
         AND (total_amount - paid_amount + late_fee_amount <> balance_amount OR balance_amount < 0 OR credit_applied > discount_amount
              OR subtotal_amount - discount_amount + tax_amount <> total_amount)`, [studentId]);
    assert.deepEqual(bad, [], 'invoice totals reconcile');
    const [sum] = await query<{ paid: string; received: string; advance: string }>(
        `SELECT (SELECT COALESCE(SUM(paid_amount), 0) FROM billing.invoices WHERE student_id = $1)::text AS paid,
                (SELECT COALESCE(SUM(amount), 0) FROM billing.payments WHERE student_id = $1 AND status IN ('posted', 'reconciled'))::text AS received,
                (SELECT COALESCE(SUM(amount), 0) FROM billing.credit_ledger WHERE student_id = $1 AND entry_type = 'advance_payment')::text AS advance`, [studentId]);
    assert.equal(Number(sum.received) - Number(sum.advance), Number(sum.paid), 'money received equals money allocated plus advance credit');
}

before(async () => {
    await applyScripts(['migrations', 'functions']);
    const admin = randomUUID();
    const t = await callFn<{ tenantId: string; branchId: string }>('tenant.fn_tenant_create', 'Transfer Academy', 'transfer-academy', 'Tuition', 'INR',
        'Asia/Kolkata', 'Enterprise', null, null, null, admin);
    ({ tenantId, branchId } = t);
    const [other] = await query<{ branch_id: string }>(
        `INSERT INTO tenant.branches (tenant_id, name, code) VALUES ($1, 'Second', 'SEC') RETURNING branch_id`, [tenantId]);
    otherBranchId = other.branch_id;
    for (const role of ['TenantAdmin', 'Finance', 'Staff', 'Guardian', 'Instructor']) users[role] = await createUser(role);
    // Academy-wide front office: no branch, no assignments
    await query(`INSERT INTO tenant.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'Staff')`, [tenantId, users.Staff]);
    // This academy lets Finance decide consumed fees by hand after the transfer; tests of the attendance rules set their own course policy
    await must(call(consumption.POST, 'POST', 'Finance', { body: { action: 'save_policy', method: 'manual', requireVerification: false } }));
    globalThis.fetch = (async (url: Json) => {
        assert.match(String(url), /api\.razorpay\.com\/v1\/orders/);
        return new Response(JSON.stringify({ id: `order_${randomUUID().slice(0, 12)}` }), { status: 200 });
    }) as typeof fetch;
});

after(async () => {
    globalThis.fetch = realFetch;
    await closeDb();
});

test('1 / Scenario A: transfer with positive eligible credit', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const t = await must(transfer(s, a, b, {}, 'Staff'));
    assert.deepEqual([t.creditStatus, t.feePlanStatus, t.oldOutstanding], ['pending_review', 'pending', 20000]);
    assert.equal((await enrollmentOf(s, a.batchId)).status, 'transferred');
    assert.equal((await enrollmentOf(s, b.batchId)).status, 'enrolled');

    const waiting = courseOf(await breakdown(s), b);
    assert.deepEqual([waiting.feePlanPending, waiting.totalFee, waiting.installments.length], [true, 24000, 0]);
    assert.equal((await createPlan(t.transferId, {})).status, 409, 'plan waits for the credit decision');

    const r = await must(review(t.transferId, { decision: 'approve', consumedAmount: 4000 }));
    assert.deepEqual([r.eligibleCredit, r.approvedCredit], [6000, 6000]);
    const p = await must(createPlan(t.transferId, { applyCredit: 6000 }));
    assert.equal(p.payableAmount, 18000);
    assert.deepEqual(p.installments.map((i: Json) => i.payable), [6000, 6000, 6000]);
    assert.deepEqual(p.installments.map((i: Json) => i.dueDate), ['2027-01-31', '2027-02-28', '2027-03-31']);

    const after = await breakdown(s);
    const nw = courseOf(after, b);
    assert.deepEqual([nw.totalFee, nw.creditApplied, nw.paidAmount, nw.balanceAmount], [24000, 6000, 0, 18000]);
    const old = courseOf(after, a);
    assert.deepEqual([old.enrollmentStatus, old.paidAmount, old.balanceAmount, old.payments.length], ['transferred', 10000, 20000, 1]);
    assert.equal(after.creditBalance, 0);
    assert.equal(await receiptsTotal(s), 10000, 'credit is not recorded as a payment');
    await assertConsistent(s);
});

test('2 / Scenario B: zero credit creates no credit and a full-fee plan', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const t = await must(transfer(s, a, b));
    const r = await must(review(t.transferId, { decision: 'approve', consumedAmount: 10000 }));
    assert.deepEqual([r.creditStatus, r.approvedCredit], ['no_credit', 0]);
    assert.equal((await ledger(s)).entries.length, 0);
    assert.equal((await createPlan(t.transferId, { applyCredit: 1 })).status, 400, 'no credit to apply');
    const p = await must(createPlan(t.transferId, { installmentCount: 4 }));
    assert.deepEqual([p.payableAmount, p.installments.length], [24000, 4]);
    await assertConsistent(s);
});

test('3 / Scenario C: existing balance plus new transfer credit, each counted once', async () => {
    const [x, a, b] = [await course(5000), await course(30000), await course(24000)];
    const s = await student(x.batchId, a.batchId);
    const billX = await bill(s, x, 1, 0);
    const over = await pay(s, { enrollmentId: billX.enrollmentId, amount: 8000 });
    assert.equal(over.excessCredit, 3000);
    await bill(s, a, 3, 10000);
    const t = await must(transfer(s, a, b));
    const detail = await must(call(transfers.GET, 'GET', 'Finance', { search: `?transferId=${t.transferId}` }));
    assert.deepEqual([detail.creditBalance, detail.financials.unusedCeiling, detail.financials.verifiedPaid], [3000, 10000, 10000]);
    await must(review(t.transferId, { decision: 'approve', consumedAmount: 4000 }));
    assert.equal((await ledger(s)).balance, 9000);
    const p = await must(createPlan(t.transferId, { applyCredit: 9000 }));
    assert.deepEqual([p.payableAmount, p.creditBalance], [15000, 0]);
    await assertConsistent(s);
});

test('4 / Scenario D: old dues stay on the old enrollment and are never netted', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    const old = await bill(s, a, 3, 10000);
    const t = await must(transfer(s, a, b, {
        review: { decision: 'approve', consumedAmount: 4000 }, feePlan: plan({ applyCredit: 6000 }),
    }));
    assert.deepEqual([t.creditStatus, t.feePlanStatus, t.oldOutstanding, t.feePlan.payableAmount], ['approved', 'configured', 20000, 18000]);
    const view = await breakdown(s);
    assert.deepEqual([courseOf(view, a).balanceAmount, courseOf(view, b).balanceAmount, view.totalBalance], [20000, 18000, 38000]);
    // old dues can still be paid, without touching the new course
    await pay(s, { invoiceId: old.invoices[1].invoiceId, amount: 10000 });
    const later = await breakdown(s);
    assert.deepEqual([courseOf(later, a).balanceAmount, courseOf(later, b).balanceAmount], [10000, 18000]);
    // credit cannot be used on the closed enrollment
    const res = await call(credits.POST, 'POST', 'Finance', { key: randomUUID(), body: { action: 'apply', studentId: s, enrollmentId: old.enrollmentId, amount: 1, reason: 'x' } });
    assert.equal(res.status, 400);
    await assertConsistent(s);
});

test('5 / Scenario E: credit above the new fee stays in the ledger', async () => {
    const [a, b] = [await course(40000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 1, 40000);
    const t = await must(transfer(s, a, b));
    await must(review(t.transferId, { decision: 'approve', consumedAmount: 10000 }));
    assert.equal((await createPlan(t.transferId, { applyCredit: 30000 })).status, 400, 'never more than the course fee');
    const p = await must(createPlan(t.transferId, { paymentMode: 'one_time', applyCredit: 24000 }));
    assert.deepEqual([p.payableAmount, p.creditBalance, p.installments.length], [0, 6000, 1]);
    const view = await breakdown(s);
    const nw = courseOf(view, b);
    assert.deepEqual([nw.status, nw.installments[0].status, nw.balanceAmount, nw.creditApplied, view.creditBalance], ['paid', 'paid', 0, 24000, 6000]);
    await assertConsistent(s);
});

test('6 / Scenario F: no earlier payment means no artificial credit', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 0);
    const t = await must(transfer(s, a, b));
    assert.equal(t.creditStatus, 'not_applicable');
    assert.equal((await review(t.transferId, { decision: 'approve', consumedAmount: 0, approvedCredit: 500 })).status, 409);
    const p = await must(createPlan(t.transferId, { paymentMode: 'one_time' }));
    assert.equal(p.payableAmount, 24000);
    assert.equal((await ledger(s)).entries.length, 0);
});

test('7: new course fee paid in one payment', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    const t = await must(transfer(s, a, b));
    const p = await must(createPlan(t.transferId, { paymentMode: 'one_time' }));
    const paid = await pay(s, { invoiceId: p.installments[0].invoiceId, amount: 24000 });
    assert.deepEqual([paid.receipts.length, paid.remainingCourseBalance], [1, 0]);
    assert.equal(courseOf(await breakdown(s), b).status, 'paid');
    await assertConsistent(s);
});

test('8–10: installments, partial, several together, excess and early settlement', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    const t = await must(transfer(s, a, b));
    const p = await must(createPlan(t.transferId, { installmentCount: 4 })); // 4 × 6000
    const state = async () => courseOf(await breakdown(s), b).installments.map((i: Json) => [i.status, i.balanceAmount]);

    await pay(s, { invoiceId: p.installments[0].invoiceId, amount: 3000 }); // partial: 3000 left joins the other three
    assert.deepEqual(await state(), [['partially_paid', 0], ['pending', 7000], ['pending', 7000], ['pending', 7000]]);
    const excess = await pay(s, { invoiceId: p.installments[1].invoiceId, amount: 8000 }); // excess rolls over and is not a shortfall
    assert.deepEqual([excess.receipts.map((r: Json) => r.amount), excess.excessCredit], [[7000, 1000], 0]);
    assert.deepEqual((await state()).slice(1), [['paid', 0], ['partially_paid', 6000], ['pending', 7000]]);
    const early = await pay(s, { enrollmentId: t.newEnrollmentId, amount: 13000 }); // everything left
    assert.deepEqual([early.receipts.length, early.remainingCourseBalance], [2, 0]);
    await assertConsistent(s);
});

test('10b: payment beyond the course dues becomes credit once and can be applied to another course', async () => {
    const [a, b] = [await course(5000), await course(9000)];
    const s = await student(a.batchId, b.batchId);
    const billA = await bill(s, a, 1, 0);
    const billB = await bill(s, b, 3, 0);
    const over = await pay(s, { enrollmentId: billA.enrollmentId, amount: 6500 });
    assert.equal(over.excessCredit, 1500);
    assert.equal(courseOf(await breakdown(s), b).balanceAmount, 9000, 'not applied automatically');
    const key = randomUUID();
    const body = { action: 'apply', studentId: s, enrollmentId: billB.enrollmentId, amount: 1500, reason: 'Approved by finance' };
    const first = await must(call(credits.POST, 'POST', 'Finance', { key, body }));
    const again = await must(call(credits.POST, 'POST', 'Finance', { key, body }));
    assert.deepEqual([first.balance, again.replayed, again.balance], [0, true, 0]);
    assert.equal(courseOf(await breakdown(s), b).balanceAmount, 7500);
    assert.equal((await call(credits.POST, 'POST', 'Finance', { key: randomUUID(), body })).status, 400, 'balance cannot go negative');
    await assertConsistent(s);
});

test('11: credit applied to the first installment, partly and fully', async () => {
    const [a, b, c] = [await course(30000), await course(24000), await course(12000)];
    const s = await student(a.batchId);
    await bill(s, a, 1, 30000);
    const t = await must(transfer(s, a, b, { review: { decision: 'approve', consumedAmount: 24000 }, feePlan: plan({ applyCredit: 6000, creditAllocation: 'sequential' }) }));
    assert.deepEqual(t.feePlan.installments.map((i: Json) => [i.gross, i.credit, i.payable]), [[8000, 6000, 2000], [8000, 0, 8000], [8000, 0, 8000]]);
    // second transfer: value carried in by credit is not lost, and nothing is granted twice
    await pay(s, { enrollmentId: t.newEnrollmentId, amount: 2000 });
    const t2 = await must(transfer(s, b, c, { review: { decision: 'approve', consumedAmount: 1000 }, feePlan: plan({ applyCredit: 7000, creditAllocation: 'sequential' }) }));
    assert.equal(t2.approvedCredit, 7000); // 2000 cash + 6000 credit − 1000 consumed
    assert.deepEqual(t2.feePlan.installments.map((i: Json) => [i.credit, i.payable]), [[4000, 0], [3000, 1000], [0, 4000]]);
    const view = courseOf(await breakdown(s), c);
    assert.deepEqual(view.installments.map((i: Json) => i.status), ['paid', 'pending', 'pending']);
    await assertConsistent(s);
});

test('12: credit spread across several installments and custom schedules', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 1, 30000);
    const t = await must(transfer(s, a, b));
    await must(review(t.transferId, { decision: 'approve', consumedAmount: 23000, approvedCredit: 5000 }));
    const bad = await createPlan(t.transferId, { applyCredit: 5000, frequency: 'custom', installmentCount: 2, installments: [{ dueDate: '2027-01-10', amount: 10000 }, { dueDate: '2027-03-10', amount: 10000 }] });
    assert.equal(bad.status, 400, 'custom amounts must total the payable amount');
    const p = await must(createPlan(t.transferId, { applyCredit: 5000, frequency: 'custom', installmentCount: 2, installments: [{ dueDate: '2027-01-10', amount: 12000 }, { dueDate: '2027-03-10', amount: 7000 }] }));
    assert.deepEqual(p.installments.map((i: Json) => i.payable), [12000, 7000]);
    assert.equal(p.installments.reduce((x: number, i: Json) => x + i.credit, 0), 5000);
    assert.ok(p.installments.every((i: Json) => i.credit > 0));
    assert.equal((await createPlan(t.transferId, {})).status, 409, 'one fee plan per transfer');
    await assertConsistent(s);
});

test('13: guardian pays online through Razorpay; tampering is refused', async t13 => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    const stranger = await student(a.batchId);
    const t = await must(transfer(s, a, b));
    const p = await must(createPlan(t.transferId, {}));
    const g = await callFn<{ guardianId: string }>('academics.fn_guardian_create', tenantId, 'Pa', 'Rent', 'Parent', '9876543210', `g${++counter}@example.com`, [s], users.TenantAdmin);
    await query(`UPDATE academics.guardians SET user_id = $1 WHERE guardian_id = $2`, [users.Guardian, g.guardianId]);
    const post = (body: Json, key?: string) => call(portal.POST, 'POST', 'Guardian', { body, key });
    const sign = (order: string, payment: string) => createHmac('sha256', 'unit-secret').update(`${order}|${payment}`).digest('hex');
    const order = (amount: number, i = 0) => must(post({ action: 'create_payment_order', wardId: s, amount, invoiceId: p.installments[i].invoiceId }));

    const home = await must(call(portal.GET, 'GET', 'Guardian'));
    assert.deepEqual(home.wards.map((w: Json) => w.id), [s], 'only linked children');
    assert.equal(home.wards[0].courses.find((c: Json) => c.courseId === b.courseId).balanceAmount, 24000);

    await t13.test('exact installment, replayed callback and webhook post once', async () => {
        const o = await order(8000);
        const body = { action: 'pay_installment', wardId: s, amount: 99999, razorpayOrderId: o.orderId, razorpayPaymentId: 'pay_1', razorpaySignature: sign(o.orderId, 'pay_1') };
        const r = await must(post(body));
        assert.equal(r.totalAmountPaid, 8000, 'amount comes from the order, not the request');
        assert.equal((await must(post(body))).replayed, true);
        const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: o.orderId, amount: 800000 } } } });
        const hook = (sig: string | null) => webhook.POST(new NextRequest('http://localhost/hook', { method: 'POST', body: raw, headers: sig ? { 'x-razorpay-signature': sig } : {} }));
        assert.equal((await hook(createHmac('sha256', 'unit-secret').update(raw).digest('hex'))).status, 200);
        assert.equal((await hook(null)).status, 400, 'unsigned webhook refused');
        assert.equal(await receiptsTotal(s), 8000);
    });
    await t13.test('webhook alone completes a payment the browser never reported', async () => {
        const o = await order(3000, 1);
        const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_2', order_id: o.orderId, amount: 300000 } } } });
        const res = await webhook.POST(new NextRequest('http://localhost/hook', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': createHmac('sha256', 'unit-secret').update(raw).digest('hex') } }));
        assert.equal(res.status, 200);
        assert.equal(await receiptsTotal(s), 11000);
    });
    await t13.test('an underpaid installment is added to the next one', async () => {
        // #2 was paid 3000 of 8000 above, so its 5000 moved to #3 (8000 + 5000)
        const o = await order(13000, 2);
        const r = await must(post({ action: 'pay_installment', wardId: s, razorpayOrderId: o.orderId, razorpayPaymentId: 'pay_3', razorpaySignature: sign(o.orderId, 'pay_3') }));
        assert.deepEqual([r.receipts.length, r.remainingCourseBalance], [1, 0]);
    });
    await t13.test('refused: forged signature, simulation flag, no gateway, foreign student, over-amount', async () => {
        const [c1] = [await course(1000)];
        await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id) VALUES ($1, $2, $3)`, [tenantId, s, c1.batchId]);
        const billed = await bill(s, c1, 1, 0);
        const o = await must(post({ action: 'create_payment_order', wardId: s, amount: 1000, enrollmentId: billed.enrollmentId }));
        const base = { action: 'pay_installment', wardId: s, invoiceId: billed.invoices[0].invoiceId, amount: 1000 };
        assert.equal((await post({ ...base, razorpayOrderId: o.orderId, razorpayPaymentId: 'x', razorpaySignature: 'bad', isSimulation: true })).status, 400);
        assert.equal((await post({ ...base, razorpayOrderId: 'order_unknown', razorpayPaymentId: 'x' })).status, 404);
        assert.equal((await post({ ...base, paymentMethod: 'Card' })).status, 400);
        assert.equal((await post({ ...base, wardId: stranger })).status, 404);
        assert.equal((await post({ action: 'create_payment_order', wardId: s, amount: 1001, enrollmentId: billed.enrollmentId })).status, 400);
        const sb = await bill(stranger, a, 1, 0);
        assert.equal((await post({ action: 'create_payment_order', wardId: s, amount: 10, invoiceId: sb.invoices[0].invoiceId })).status, 403);
        assert.equal((await call(payments.GET, 'GET', 'Guardian', { search: `?studentId=${stranger}` })).status, 403);
        assert.equal((await call(transfers.GET, 'GET', 'Guardian')).status, 403);
        assert.equal(courseOf(await breakdown(s), c1).balanceAmount, 1000);
    });
    await t13.test('bank payment waits for Finance verification', async () => {
        const [c2] = [await course(4000)];
        await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id) VALUES ($1, $2, $3)`, [tenantId, s, c2.batchId]);
        const billed = await bill(s, c2, 2, 0);
        const before = (await breakdown(s)).totalPaid;
        const key = randomUUID();
        const body = { action: 'pay_installment', wardId: s, enrollmentId: billed.enrollmentId, amount: 3000, paymentMethod: 'BankWire', paymentReference: 'UTR1' };
        const declared = await must(post(body, key));
        assert.deepEqual(declared.receipts.map((r: Json) => r.amount), [2000, 1000]);
        assert.equal((await must(post(body, key))).receipts.length, 2, 'resubmitting does not duplicate');
        assert.equal((await post({ ...body, amount: 1500 }, randomUUID())).status, 400, 'cannot over-declare');
        const view = courseOf(await breakdown(s), c2);
        assert.deepEqual([view.balanceAmount, view.pendingVerification, (await breakdown(s)).totalPaid], [4000, 3000, before]);
        const first = declared.receipts[0].paymentId;
        const done = await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: first } }));
        assert.equal(done.status, 'reconciled');
        await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: first } })); // idempotent
        assert.equal((await call(verify.POST, 'POST', 'Finance', { body: { paymentId: declared.receipts[1].paymentId, decision: 'reject' } })).status, 400, 'reason required');
        await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: declared.receipts[1].paymentId, decision: 'reject', reason: 'Not received' } }));
        const end = courseOf(await breakdown(s), c2);
        assert.deepEqual([end.balanceAmount, end.pendingVerification, end.paidAmount], [2000, 0, 2000]);
    });
    await assertConsistent(s);
});

test('14: Finance records offline payments; duplicates are not posted', async () => {
    const a = await course(9000);
    const s = await student(a.batchId);
    const billed = await bill(s, a, 3, 0);
    const key = randomUUID();
    const body = { enrollmentId: billed.enrollmentId, amount: 4000, paymentMethod: 'Cheque', paymentReference: 'CHQ-1', paymentDate: '2026-11-01' };
    const first = await pay(s, body, key);
    const again = await pay(s, body, key);
    assert.deepEqual([first.receipts.length, again.replayed], [2, true]);
    assert.deepEqual(again.receipts.map((r: Json) => r.receiptNumber).sort(), first.receipts.map((r: Json) => r.receiptNumber).sort());
    await Promise.all([1, 2, 3].map(() => pay(s, { ...body, amount: 500 }, 'same-key')));
    assert.equal(await receiptsTotal(s), 4500);
    const v = await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: first.receipts[0].paymentId } }));
    assert.equal(v.status, 'reconciled');
    const totals = await callFn<Json>('billing.fn_payment_list', tenantId, null);
    assert.ok(totals.summary.offlineTotal >= 4500, 'verified payments still count as collected');
    assert.equal((await call(payments.POST, 'POST', 'Instructor', { body: { studentId: s, ...body } })).status, 403);
    assert.equal((await call(payments.POST, 'POST', 'Finance', { body: { studentId: s, amount: -5, enrollmentId: billed.enrollmentId } })).status, 400);
    await assertConsistent(s);
});

test('15: several courses keep separate plans and payments, even with overlapping titles', async () => {
    const [sci, master] = [await course(6000, 'Science'), await course(9000, 'Master Science')];
    const s = await student(sci.batchId, master.batchId);
    const one = await bill(s, sci, 2, 0);
    const two = await bill(s, master, 3, 0);
    await pay(s, { enrollmentId: one.enrollmentId, amount: 6000 });
    let view = await breakdown(s);
    assert.deepEqual([courseOf(view, sci).balanceAmount, courseOf(view, master).balanceAmount], [0, 9000]);
    await pay(s, { courseTitle: 'master science', amount: 3000 });
    view = await breakdown(s);
    assert.deepEqual([courseOf(view, sci).paidAmount, courseOf(view, master).paidAmount, courseOf(view, master).installments.length], [6000, 3000, 3]);
    const mixed = await call(payments.POST, 'POST', 'Finance', { body: { studentId: s, enrollmentId: one.enrollmentId, invoiceId: two.invoices[0].invoiceId, amount: 10 } });
    assert.equal(mixed.status, 400);
    const vague = await call(payments.POST, 'POST', 'Finance', { body: { studentId: s, amount: 10 } });
    assert.equal(vague.status, 400, 'a payment must name its course');
    await assertConsistent(s);
});

test('16: duplicate credit decisions, double transfers and negative balances are prevented', async () => {
    const [a, b, c] = [await course(30000), await course(24000), await course(20000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const [x, y] = await Promise.all([transfer(s, a, b), transfer(s, a, c)]);
    assert.deepEqual([x.status, y.status].map(v => (v === 200 ? 'ok' : 'refused')).sort(), ['ok', 'refused'], 'an enrollment is transferred once');
    const t = (x.status === 200 ? x : y).data;
    assert.equal((await review(t.transferId, { decision: 'approve' })).status, 409, 'consumed fee is never assumed');
    assert.equal((await review(t.transferId, { decision: 'approve', consumedAmount: 4000, approvedCredit: 6001 })).status, 400);
    assert.equal((await review(t.transferId, { decision: 'reject' })).status, 400, 'rejection needs a reason');
    const decisions = await Promise.all([1, 2].map(() => review(t.transferId, { decision: 'approve', consumedAmount: 4000 })));
    assert.deepEqual(decisions.map(d => d.status).sort(), [200, 409]);
    assert.equal((await ledger(s)).balance, 6000);
    await assert.rejects(query(`UPDATE billing.credit_ledger SET amount = 99999 WHERE student_id = $1`, [s]), /cannot be changed/);
    await assert.rejects(query(`DELETE FROM billing.credit_ledger WHERE student_id = $1`, [s]), /cannot be changed/);
    await assert.rejects(query(
        `INSERT INTO billing.credit_ledger (tenant_id, student_id, entry_type, amount, idempotency_key) VALUES ($1, $2, 'credit_applied', -6000.01, 'neg')`, [tenantId, s]), /exceeds the available/);
});

test('underpaid installment: 3 × 2000, first paid 1000, the rest becomes 2500 + 2500', async () => {
    const a = await course(6000);
    const s = await student(a.batchId);
    const billed = await bill(s, a, 3, 0);
    const list = async () => courseOf(await breakdown(s), a).installments.map((x: Json) => [x.amount, x.paidAmount, x.balanceAmount, x.status, x.carriedForward]);
    const key = randomUUID();
    const first = await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 1000 }, key);
    assert.match(first.message, /1,000 was added to the next 2 installment/);
    const expected = [[1000, 1000, 0, 'partially_paid', -1000], [2500, 0, 2500, 'pending', 500], [2500, 0, 2500, 'pending', 500]];
    assert.deepEqual(await list(), expected);
    await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 1000 }, key); // replay moves nothing again
    assert.deepEqual(await list(), expected);
    const view = courseOf(await breakdown(s), a);
    assert.deepEqual([view.totalFee, view.paidAmount, view.balanceAmount, view.advanceCredit], [6000, 1000, 5000, 0], 'course fee is unchanged');
    // second underpaid too: 2500 − 1500 = 1000 joins the third; the last one keeps its own balance
    await pay(s, { invoiceId: billed.invoices[1].invoiceId, amount: 1500 });
    await pay(s, { invoiceId: billed.invoices[2].invoiceId, amount: 3000 });
    assert.deepEqual((await list())[2], [3500, 3000, 500, 'partially_paid', 1500]);
    await pay(s, { invoiceId: billed.invoices[2].invoiceId, amount: 500 });
    assert.equal(courseOf(await breakdown(s), a).status, 'paid');
    assert.ok((await ledger(s)).audit.some((x: Json) => x.action === 'billing.installment_carried_forward'));
    assert.equal((await ledger(s)).entries.length, 0, 'no credit is created');
    await assertConsistent(s);
});

test('carry forward: rounding, paid out of order, late fee, other courses and one-time plans', async () => {
    const [a, b, c, d] = [await course(6000), await course(3000), await course(5000), await course(8000)];
    const s = await student(a.batchId, b.batchId, c.batchId, d.batchId);
    const [A, B, D] = [await bill(s, a, 4, 0), await bill(s, b, 3, 0), await bill(s, d, 2, 0)];
    const { enrollment_id } = await enrollmentOf(s, c.batchId);
    const one = await must(call(transfers.POST, 'POST', 'Finance', { body: { action: 'create_fee_plan', enrollmentId: enrollment_id, ...plan({ paymentMode: 'one_time' }) } }));
    const balances = async (x: Course) => courseOf(await breakdown(s), x).installments.map((v: Json) => v.balanceAmount);
    await pay(s, { invoiceId: A.invoices[1].invoiceId, amount: 499.99 }); // second paid before the first: only later ones change
    assert.deepEqual(await balances(a), [1500, 0, 2000, 2000.01]);
    assert.deepEqual(await balances(b), [1000, 1000, 1000], 'another course is untouched');
    await pay(s, { invoiceId: one.installments[0].invoiceId, amount: 2000 });
    assert.deepEqual(await balances(c), [3000], 'one-time plan keeps its balance');
    // late fee 500: a 300 payment leaves 200 late fee on the installment; only tuition moves
    await query(`UPDATE billing.invoices SET late_fee_amount = 500, balance_amount = balance_amount + 500 WHERE invoice_id = $1`, [D.invoices[0].invoiceId]);
    await pay(s, { invoiceId: D.invoices[0].invoiceId, amount: 300 });
    assert.deepEqual(await balances(d), [200, 8000]);
    await pay(s, { invoiceId: B.invoices[0].invoiceId, amount: 1000 }); // exact payment moves nothing
    assert.deepEqual(await balances(b), [0, 1000, 1000]);
    await assertConsistent(s);
});

test('carry forward after Finance verifies a declared partial payment', async () => {
    const a = await course(6000);
    const s = await student(a.batchId);
    const billed = await bill(s, a, 3, 0);
    const { declareManualPayment } = await import('@/lib/billing/fee-installments');
    const declare = (amount: number) => declareManualPayment({
        tenantId, studentId: s, invoiceId: billed.invoices[0].invoiceId, amount, paymentMethod: 'BankWire', idempotencyKey: randomUUID(), actorId: users.Guardian,
    });
    const [x, y] = [await declare(600), await declare(400)];
    const balances = async () => courseOf(await breakdown(s), a).installments.map((v: Json) => v.balanceAmount);
    await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: x.receipts[0].paymentId } }));
    assert.deepEqual(await balances(), [1400, 2000, 2000], 'waits for the other declaration');
    await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: y.receipts[0].paymentId } }));
    assert.deepEqual(await balances(), [0, 2500, 2500]);
    await assertConsistent(s);
});

test('registration with less than the first installment, and editing that student', async () => {
    const a = await course(6000, 'Robotics Lab');
    const email = `reg${++counter}@example.com`;
    const reg = await must(call(students.POST, 'POST', 'TenantAdmin', {
        body: {
            firstName: 'Reg', lastName: 'Student', email, batchId: a.batchId, branchId,
            feeStructure: {
                paymentType: 'installment', courseTitle: a.title, courseFee: 6000, finalFee: 6000,
                installments: [1, 2, 3].map(n => ({ installmentNumber: n, dueDate: `2027-0${n}-10`, amount: 2000, designation: `Installment ${n} of 3` })),
                initialPayment: { amount: 1000, paymentMethod: 'Cash' },
            },
        },
    }));
    const list = async () => courseOf(await breakdown(reg.studentId), a).installments.map((v: Json) => [v.paidAmount, v.balanceAmount]);
    assert.deepEqual(await list(), [[1000, 0], [0, 2500], [0, 2500]]);
    // the edit form used to overwrite the last installment with the whole fee
    for (const feeStatus of ['pending', 'paid', 'none']) {
        await must(call(students.PUT, 'PUT', 'TenantAdmin', { body: { studentId: reg.studentId, firstName: 'Reg', lastName: 'Student', email, branchId, batchId: a.batchId, feeStatus, feeAmount: 6000 } }));
        assert.deepEqual(await list(), [[1000, 0], [0, 2500], [0, 2500]], feeStatus);
    }
    const rest = await pay(reg.studentId, { courseTitle: a.title, amount: 1500 });
    assert.equal(rest.remainingCourseBalance, 3500);
    assert.deepEqual(await list(), [[1000, 0], [1500, 0], [0, 3500]]);
    await assertConsistent(reg.studentId);
});

test('rejected credit charges the full fee; audit history is complete', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const t = await must(transfer(s, a, b));
    const r = await must(review(t.transferId, { decision: 'reject', notes: 'Policy: after 30 days' }));
    assert.equal(r.creditStatus, 'rejected');
    await must(createPlan(t.transferId, { paymentMode: 'one_time' }));
    const h = await ledger(s);
    assert.equal(h.balance, 0);
    const actions = h.audit.map((x: Json) => x.action);
    for (const action of ['student.course_transferred', 'billing.transfer_credit_rejected', 'billing.fee_plan_created', 'billing.payment_posted']) assert.ok(actions.includes(action), action);
    assert.equal(courseOf(await breakdown(s), b).balanceAmount, 24000);
});

test('a failing step rolls the whole transfer back', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const snapshot = async () => JSON.stringify([
        await query(`SELECT * FROM academics.enrollments WHERE student_id = $1 ORDER BY enrollment_id`, [s]),
        await query(`SELECT * FROM billing.invoices WHERE student_id = $1 ORDER BY invoice_id`, [s]),
        await query(`SELECT * FROM billing.payments WHERE student_id = $1 ORDER BY payment_id`, [s]),
        await query(`SELECT * FROM billing.credit_ledger WHERE student_id = $1`, [s]),
        await query(`SELECT * FROM billing.course_transfers WHERE student_id = $1`, [s]),
        await query(`SELECT * FROM billing.enrollment_fee_plans WHERE student_id = $1`, [s]),
    ]);
    const before = await snapshot();
    const res = await transfer(s, a, b, { review: { decision: 'approve', consumedAmount: 4000 }, feePlan: plan({ applyCredit: 7000 }) }); // more than approved
    assert.equal(res.status, 400);
    assert.equal(await snapshot(), before);
});

test('permissions: academic staff transfer, only Finance decides money, branches stay separate', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    assert.equal((await transfer(s, a, b, { review: { decision: 'approve', consumedAmount: 0 } }, 'Staff')).status, 403);
    assert.equal((await transfer(s, a, b, { feePlan: plan() }, 'Staff')).status, 403);
    assert.equal((await transfer(s, a, b, { waiveOldOutstanding: true, waiverReason: 'x' }, 'Staff')).status, 403);
    assert.equal((await transfer(s, a, b, {}, 'Finance')).status, 403, 'Finance does not move students');
    const t = await must(transfer(s, a, b, {}, 'Staff'));
    assert.equal((await review(t.transferId, { decision: 'approve', consumedAmount: 4000 }, 'Staff')).status, 403);
    assert.equal((await call(transfers.GET, 'GET', 'Finance', { search: `?transferId=${t.transferId}`, branch: otherBranchId })).status, 404);
    assert.equal((await call(credits.GET, 'GET', 'Finance', { search: `?studentId=${s}`, branch: otherBranchId })).status, 403);
    assert.ok((await must(call(transfers.GET, 'GET', 'Finance'))).some((x: Json) => x.transferId === t.transferId && x.creditStatus === 'pending_review'));
});

test('waiver affects only the old enrollment and only when approved', async () => {
    const [a, b, other] = [await course(30000), await course(24000), await course(5000)];
    const s = await student(a.batchId, other.batchId);
    await bill(s, a, 3, 10000);
    await bill(s, other, 1, 0);
    assert.equal((await transfer(s, a, b, { waiveOldOutstanding: true })).status, 400);
    await must(transfer(s, a, b, { waiveOldOutstanding: true, waiverReason: 'Approved by principal' }));
    const view = await breakdown(s);
    assert.deepEqual([courseOf(view, a).balanceAmount, courseOf(view, a).paidAmount, courseOf(view, other).balanceAmount], [0, 10000, 5000]);
});

test('batch change within one course carries the fee plan instead of charging again', async () => {
    const a = await course(12000);
    const [b2] = await query<{ batch_id: string }>(
        `INSERT INTO academics.batches (tenant_id, course_id, branch_id, name, start_date) VALUES ($1, $2, $3, 'Evening', CURRENT_DATE) RETURNING batch_id`, [tenantId, a.courseId, branchId]);
    const s = await student(a.batchId);
    await bill(s, a, 3, 4000);
    const t = await must(transfer(s, a, { ...a, batchId: b2.batch_id }));
    assert.deepEqual([t.feePlanStatus, t.creditStatus], ['carried_over', 'not_applicable']);
    const view = await breakdown(s);
    assert.equal(view.courses.length, 1);
    assert.deepEqual([view.courses[0].paidAmount, view.courses[0].balanceAmount, view.courses[0].batchName], [4000, 8000, 'Evening']);
});

test('transferring out and back again counts consumed fee and credit once', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const t1 = await must(transfer(s, a, b, { review: { decision: 'approve', consumedAmount: 4000 }, feePlan: plan({ applyCredit: 6000 }) }));
    const t2 = await must(transfer(s, b, a, { review: { decision: 'approve', consumedAmount: 1000 }, feePlan: plan({ applyCredit: 5000 }) }));
    assert.deepEqual([t1.approvedCredit, t2.approvedCredit], [6000, 5000]);
    const t3 = await must(transfer(s, a, b));
    const r = await must(review(t3.transferId, { decision: 'approve', consumedAmount: 0 }));
    assert.equal(r.eligibleCredit, 5000, '10000 paid − 4000 − 1000 consumed');
    await assertConsistent(s);
});

test('refunded and unverified payments and late fees never become credit', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    const billed = await bill(s, a, 3, 0);
    const p1 = await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 2000 });
    await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 3000 });
    await query(`UPDATE billing.payments SET status = 'refunded' WHERE payment_id = $1`, [p1.receipts[0].paymentId]);
    await query(`UPDATE billing.invoices SET late_fee_amount = 500, balance_amount = balance_amount + 500 WHERE invoice_id = $1`, [billed.invoices[0].invoiceId]);
    const t = await must(transfer(s, a, b));
    const d = await must(call(transfers.GET, 'GET', 'Finance', { search: `?transferId=${t.transferId}` }));
    assert.deepEqual([d.financials.verifiedPaid, d.financials.refunded, d.financials.lateFeesPaid, d.financials.unusedCeiling], [3000, 2000, 500, 2500]);
    assert.equal(d.financials.paymentsMatchInvoices, false, 'the mismatch is flagged to Finance');
});

test('billing cycle does not bill an enrollment that has, or awaits, its own plan', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    const t = await must(transfer(s, a, b));
    const run = (key: string) => callFn('billing.fn_invoice_generate_cycle', tenantId, '2026-11-24', users.TenantAdmin, key);
    const count = async () => (await query(`SELECT 1 FROM billing.invoices WHERE student_id = $1`, [s])).length;
    await run('c1');
    assert.equal(await count(), 0);
    await must(createPlan(t.transferId, {}));
    await run('c2');
    assert.equal(await count(), 3);
});

test('editing a student keeps transferred enrollments closed', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await must(transfer(s, a, b));
    await callFn('academics.fn_student_update', tenantId, s, 'Stu', 'Dent', null, null, 'active', b.batchId, branchId, users.TenantAdmin);
    await callFn('academics.fn_student_update', tenantId, s, 'Stu', 'Dent', null, null, 'active', a.batchId, branchId, users.TenantAdmin);
    assert.deepEqual([(await enrollmentOf(s, a.batchId)).status, (await enrollmentOf(s, b.batchId)).status], ['transferred', 'enrolled']);
});

test('student profile reports the transfer with its current Finance state', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    const s = await student(a.batchId);
    await bill(s, a, 3, 10000);
    const t = await must(transfer(s, a, b));
    const profile = () => must(call(students.GET, 'GET', 'TenantAdmin', { search: `?studentId=${s}` }));
    assert.equal((await profile()).transfers[0].creditStatus, 'pending_review');
    await must(review(t.transferId, { decision: 'approve', consumedAmount: 4000 }));
    await must(createPlan(t.transferId, { applyCredit: 6000 }));
    const tr = (await profile()).transfers[0];
    assert.deepEqual([tr.creditStatus, tr.feePlanStatus, tr.approvedCreditAdjustment, tr.finalPayableAmount, tr.consumedAmount], ['approved', 'configured', 6000, 18000, 4000]);
});

test('invoices are linked to a course only when that is certain', async () => {
    const [a, b] = [await course(1000, 'Physics'), await course(1000, 'Applied Physics')];
    const s = await student(a.batchId);
    const link = async (designation: string) => (await query<{ enrollment_id: string | null }>(
        `INSERT INTO billing.invoices (tenant_id, invoice_number, student_id, billing_period, subtotal_amount, total_amount, balance_amount, due_date, designation)
         VALUES ($1, $2, $3, 'x', 1, 1, 1, CURRENT_DATE, $4) RETURNING enrollment_id`, [tenantId, `T-${++counter}`, s, designation]))[0].enrollment_id;
    const own = (await enrollmentOf(s, a.batchId)).enrollment_id;
    assert.equal(await link('Physics Tuition — Nov 2026'), own);
    assert.equal(await link('Installment 1 of 2'), own, 'sole enrollment');
    assert.equal(await link('Applied Physics Tuition — Nov 2026'), null, 'names a course the student does not take');
    await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id) VALUES ($1, $2, $3)`, [tenantId, s, b.batchId]);
    assert.equal(await link('Tuition — Nov 2026'), null, 'ambiguous');
    assert.equal(await link('Applied Physics Tuition'), (await enrollmentOf(s, b.batchId)).enrollment_id);
});

test('schedules: rounding, frequencies and validation', () => {
    const input = (extra: Json) => parseFeePlanInput(plan(extra));
    const s = buildSchedule(10000, 0, input({ installmentCount: 3 }));
    assert.deepEqual(s.map(i => i.payable), [3333.33, 3333.33, 3333.34]);
    assert.deepEqual(buildSchedule(9000, 0, input({ frequency: 'quarterly', firstDueDate: '2026-11-30' })).map(i => i.dueDate), ['2026-11-30', '2027-02-28', '2027-05-30']);
    assert.deepEqual(buildSchedule(9000, 0, input({ frequency: 'every_2_months' })).map(i => i.dueDate), ['2027-01-31', '2027-03-31', '2027-05-31']);
    const c = buildSchedule(10000.01, 3333.33, input({ installmentCount: 7 }));
    assert.equal(Math.round(c.reduce((t, i) => t + i.payable, 0) * 100), 666668);
    assert.equal(Math.round(c.reduce((t, i) => t + i.credit, 0) * 100), 333333);
    for (const bad of [{ installmentCount: 0 }, { installmentCount: 37 }, { installmentCount: 1.5 }, { paymentMode: 'x' }, { frequency: 'weekly' }, { firstDueDate: '2027-02-30' }, { applyCredit: -1 }, { applyCredit: 1.234 }]) {
        assert.throws(() => input(bad), Error, JSON.stringify(bad));
    }
    assert.throws(() => buildSchedule(9000, 0, input({ frequency: 'custom' })), /due date/);
});

// ---------------------------------------------------------------- Flexible installments
const getPlan = (enrollmentId: string) => must(call(scheduleApi.GET, 'GET', 'Finance', { search: `?enrollmentId=${enrollmentId}` }));
const adjust = (enrollmentId: string, body: Json, role = 'Finance', opts: Json = {}) =>
    call(scheduleApi.POST, 'POST', role, { ...opts, body: { action: 'adjust', enrollmentId, reason: 'Family request', ...body } });
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
async function coursePeriod(c: Course, start: string, months: number, end: string | null = null) {
    await query('UPDATE academics.batches SET start_date = $1, end_date = $2 WHERE batch_id = $3', [start, end, c.batchId]);
    await query('UPDATE academics.courses SET duration_months = $1, start_date = NULL WHERE course_id = $2', [months, c.courseId]);
}

test('flexible: frequency options follow the course duration', async () => {
    assert.equal(addMonths('2027-08-31', 6), '2028-02-29');
    for (const [months, expected] of [[12, [12, 6, 4, 2]], [6, [6, 3, 2, 1]], [3, [3, 2, 1, 1]], [24, [24, 12, 8, 4]], [1, [1, 1, 1, 1]]] as Array<[number, number[]]>) {
        const end = addMonths('2027-01-01', months);
        assert.deepEqual([1, 2, 3, 6].map(step => fittingInstallments('2027-01-01', end, step)), expected, `${months} months`);
    }
    assert.equal(fittingInstallments('2027-01-01', null, 1), 1, 'no duration on record');

    const c = await course(12000);
    await coursePeriod(c, '2027-04-01', 12);
    const s = await student(c.batchId);
    const { enrollment_id: e } = await enrollmentOf(s, c.batchId);
    const view = await getPlan(e);
    assert.deepEqual([view.period.startDate, view.period.endDate, view.period.durationMonths, view.period.firstDueDate], ['2027-04-01', '2028-04-01', 12, '2027-04-01']);
    assert.deepEqual(view.period.suggestedCounts, { monthly: 12, every_2_months: 6, quarterly: 4, half_yearly: 2 });

    // due dates start with the course when none is given
    const created = await must(call(transfers.POST, 'POST', 'Finance', { body: { action: 'create_fee_plan', enrollmentId: e, paymentMode: 'installment', frequency: 'half_yearly', installmentCount: 2 } }));
    assert.deepEqual(created.installments.map((x: Json) => [x.dueDate, x.payable]), [['2027-04-01', 6000], ['2027-10-01', 6000]]);
    // a batch end date and a later course start take precedence
    await query(`UPDATE academics.courses SET start_date = '2027-05-01' WHERE course_id = $1`, [c.courseId]);
    await query(`UPDATE academics.batches SET end_date = '2027-12-31' WHERE batch_id = $1`, [c.batchId]);
    const changed = await getPlan(e);
    assert.deepEqual([changed.period.startDate, changed.period.endDate], ['2027-05-01', '2027-12-31']);
});

test('flexible: installments of an enrollment or transfer are always within the course', async () => {
    const c = await course(6000);
    await coursePeriod(c, '2027-01-01', 3);
    const s = await student(c.batchId);
    const { enrollment_id: e } = await enrollmentOf(s, c.batchId);
    const make = (extra: Json) => call(transfers.POST, 'POST', 'Finance', { body: { action: 'create_fee_plan', enrollmentId: e, paymentMode: 'installment', frequency: 'quarterly', installmentCount: 3, firstDueDate: '2027-01-01', ...extra } });
    const refused = await make({});
    assert.equal(refused.status, 400);
    assert.match(refused.detail, /Installment 2 is due on 2027-04-01, after the course ends.*from 2027-01-01 to 2027-03-31\. At most 1 installment fit/);
    assert.equal((await make({ allowBeyondDuration: true, beyondDurationReason: 'Principal approved' })).status, 400, 'no override when installments are chosen');
    assert.match((await make({ firstDueDate: '2026-12-15', frequency: 'monthly' })).detail, /before the course starts/);
    const custom = (dates: string[]) => make({ frequency: 'custom', firstDueDate: null, installmentCount: dates.length, installments: dates.map(dueDate => ({ dueDate, amount: null })) });
    assert.equal((await custom(['2027-01-01', '2027-04-01'])).status, 400, 'the day after the last day of the course');
    assert.equal((await make({ frequency: 'monthly', installmentCount: 4 })).status, 400);
    await query(`UPDATE academics.courses SET duration_months = NULL WHERE course_id = $1`, [c.courseId]);
    assert.match((await make({ frequency: 'monthly' })).detail, /Set the course duration/);
    await query(`UPDATE academics.courses SET duration_months = 3 WHERE course_id = $1`, [c.courseId]);
    // the batch may end earlier, but a later batch end does not extend the course duration
    await query(`UPDATE academics.batches SET end_date = '2027-02-15' WHERE batch_id = $1`, [c.batchId]);
    assert.match((await make({ frequency: 'monthly' })).detail, /to 2027-02-15\. At most 2 installments fit/);
    await query(`UPDATE academics.batches SET end_date = '2027-12-31' WHERE batch_id = $1`, [c.batchId]);
    assert.equal((await make({ frequency: 'monthly', installmentCount: 4 })).status, 400);
    assert.deepEqual((await must(custom(['2027-01-01', '2027-02-10', '2027-03-31']))).installments.map((x: Json) => x.dueDate), ['2027-01-01', '2027-02-10', '2027-03-31']);
    await query(`UPDATE academics.batches SET end_date = NULL WHERE batch_id = $1`, [c.batchId]);

    // a course transfer is refused as a whole, then accepted once the schedule fits
    const from = await course(3000);
    const moved = await student(from.batchId);
    const move = (count: number, extra: Json = {}) => transfer(moved, from, c, { feePlan: { paymentMode: 'installment', frequency: 'monthly', installmentCount: count, firstDueDate: '2027-01-01', ...extra } });
    const late = await move(4, { allowBeyondDuration: true, beyondDurationReason: 'Authorized on course transfer' });
    assert.equal(late.status, 400);
    assert.match(late.detail, /At most 3 installments fit/);
    assert.equal((await enrollmentOf(moved, from.batchId)).status, 'enrolled', 'nothing was transferred');
    await must(move(3));

    // registration is held to the same rule
    const reg = (dates: string[], role = 'Staff', extra: Json = {}) => call(students.POST, 'POST', role, {
        body: {
            firstName: 'Long', lastName: 'Plan', email: `lp${++counter}@example.com`, batchId: c.batchId, branchId,
            feeStructure: { courseTitle: c.title, finalFee: 6000, installments: dates.map((dueDate, i) => ({ installmentNumber: i + 1, dueDate, amount: 3000 })), ...extra },
        },
    });
    assert.equal((await reg(['2027-01-10', '2027-08-10'])).status, 400);
    for (const role of ['Staff', 'TenantAdmin']) {
        assert.equal((await reg(['2027-01-10', '2027-08-10'], role, { allowBeyondDuration: true, beyondDurationReason: 'x' })).status, 400, 'no override at registration');
    }
    assert.equal((await reg(['2027-01-10', '2027-04-01'])).status, 400);
    assert.equal((await reg(['2026-12-10', '2027-02-10'])).status, 400, 'before the course starts');
    assert.equal((await reg(['2027-02-10', '2027-01-10'])).status, 400, 'out of order');
    assert.equal((await reg(['2027-01-10', ''])).status, 400, 'no date');
    assert.equal((await reg(['2027-05-10'], 'Staff', { paymentType: 'installment' })).status, 400);
    await must(reg(['2027-03-01', '2027-03-31']));
    await must(reg(['2027-01-10', '2027-02-10']));
});

test('flexible: several partial payments on the same installment', async () => {
    const c = await course(6000);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 3, 0);
    const list = async () => courseOf(await breakdown(s), c).installments.map((x: Json) => [x.status, x.paidAmount, x.balanceAmount, x.carriedOutstanding]);
    const first = billed.invoices[0].invoiceId;
    await pay(s, { invoiceId: first, amount: 1000 });
    assert.deepEqual(await list(), [['partially_paid', 1000, 0, 1000], ['pending', 0, 2500, 0], ['pending', 0, 2500, 0]]);
    await pay(s, { invoiceId: first, amount: 400 }); // second partial: 400 comes back out of #2 and #3
    assert.deepEqual(await list(), [['partially_paid', 1400, 0, 600], ['pending', 0, 2300, 0], ['pending', 0, 2300, 0]]);
    await pay(s, { invoiceId: first, amount: 600 }); // third completes it
    assert.deepEqual(await list(), [['paid', 2000, 0, 0], ['pending', 0, 2000, 0], ['pending', 0, 2000, 0]]);
    const extra = await pay(s, { invoiceId: first, amount: 500 }); // nothing left on it: normal rollover
    assert.equal(extra.receipts[0].invoiceId, billed.invoices[1].invoiceId);
    const view = courseOf(await breakdown(s), c);
    assert.deepEqual([view.totalFee, view.paidAmount, view.balanceAmount, view.payments.length], [6000, 2500, 3500, 4]);
    assert.deepEqual(view.installments.map((x: Json) => [x.scheduledAmount, x.scheduledDueDate]), [[2000, '2027-01-31'], [2000, '2027-02-28'], [2000, '2027-03-31']], 'original schedule is kept');
    await assertConsistent(s);
});

test('flexible: repeat partial with rounding, over-restore and a settled later installment', async () => {
    const c = await course(6000);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 4, 0); // 4 × 1500
    const list = async () => courseOf(await breakdown(s), c).installments.map((x: Json) => x.balanceAmount);
    await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 500 }); // 1000 over 3: 333.33, 333.33, 333.34
    assert.deepEqual(await list(), [0, 1833.33, 1833.33, 1833.34]);
    await pay(s, { invoiceId: billed.invoices[1].invoiceId, amount: 1833.33 }); // #2 settled with its share
    const r = await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 900 }); // only 666.67 can still return; the rest pays ahead
    assert.deepEqual(r.receipts.map((x: Json) => x.amount), [666.67, 233.33]);
    assert.deepEqual(await list(), [0, 0, 1266.67, 1500]);
    const clear = await pay(s, { enrollmentId: billed.enrollmentId, amount: 2766.67 });
    assert.equal(clear.remainingCourseBalance, 0);
    assert.deepEqual(courseOf(await breakdown(s), c).installments.map((x: Json) => x.status), ['paid', 'paid', 'paid', 'paid'], 'early full payment settles all');
    await assertConsistent(s);
});

test('flexible: declared payment on a carried installment, verified by Finance', async () => {
    const c = await course(6000);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 3, 0);
    const { declareManualPayment } = await import('@/lib/billing/fee-installments');
    await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 1000 });
    const declare = (amount: number) => declareManualPayment({ tenantId, studentId: s, invoiceId: billed.invoices[0].invoiceId, amount, paymentMethod: 'BankWire', idempotencyKey: randomUUID(), actorId: users.Guardian });
    await assert.rejects(declare(1200), /Up to 1000.00/);
    const d = await declare(600);
    await assert.rejects(declare(600), /Up to 400.00/, 'already declared money is counted');
    const status = async () => courseOf(await breakdown(s), c).installments.map((x: Json) => [x.status, x.balanceAmount]);
    assert.deepEqual((await status())[0], ['verification_pending', 0]);
    assert.equal(courseOf(await breakdown(s), c).balanceAmount, 5000, 'not received until verified');
    await must(call(verify.POST, 'POST', 'Finance', { body: { paymentId: d.receipts[0].paymentId } }));
    assert.deepEqual(await status(), [['partially_paid', 0], ['pending', 2200], ['pending', 2200]]);
    assert.equal((await ledger(s)).balance, 0);
    await assertConsistent(s);
});

test('flexible: Finance adjusts amounts, dates, frequency and count; paid installments stay', async () => {
    const c = await course(6000);
    await coursePeriod(c, day(-10), 12);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 3, 0);
    const e = billed.enrollmentId;
    await pay(s, { invoiceId: billed.invoices[0].invoiceId, amount: 1000 });
    const before = await query(`SELECT * FROM billing.payments WHERE student_id = $1`, [s]);
    const plan1 = await getPlan(e);
    assert.deepEqual([plan1.adjustableTotal, plan1.installments.map((x: Json) => x.adjustable)], [5000, [false, true, true]]);
    const [i2, i3] = plan1.installments.slice(1);

    const bad: Array<[Json, RegExp]> = [
        [{ installments: [{ invoiceId: i2.invoiceId, dueDate: day(30), amount: 4000 }] }, /5000.00 is still to be collected/],
        [{ installments: [{ invoiceId: i2.invoiceId, dueDate: day(-1), amount: 2500 }, { invoiceId: i3.invoiceId, dueDate: day(60), amount: 2500 }] }, /past/],
        [{ installments: [{ invoiceId: i2.invoiceId, dueDate: day(60), amount: 2500 }, { invoiceId: i3.invoiceId, dueDate: day(30), amount: 2500 }] }, /order/],
        [{ installments: [{ invoiceId: i2.invoiceId, dueDate: day(30), amount: 5000 }, { invoiceId: i3.invoiceId, dueDate: day(60), amount: 0 }] }, /greater than zero/],
        [{ installments: [{ invoiceId: billed.invoices[0].invoiceId, dueDate: day(30), amount: 5000 }] }, /paid or changed/],
        [{ installments: [{ invoiceId: i2.invoiceId, dueDate: day(30), amount: 2500 }, { invoiceId: i3.invoiceId, dueDate: day(600), amount: 2500 }] }, /after the course ends/],
        [{ reason: '', installments: [{ invoiceId: i2.invoiceId, dueDate: day(30), amount: 5000 }] }, /reason/],
    ];
    for (const [body, message] of bad) {
        const r = await adjust(e, body);
        assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(body));
        assert.match(r.detail, message);
    }
    for (const role of ['Staff', 'Guardian', 'Instructor']) assert.equal((await adjust(e, { installments: [{ invoiceId: i2.invoiceId, dueDate: day(30), amount: 5000 }] }, role)).status, 403, role);
    assert.equal((await adjust(e, { installments: [{ invoiceId: i2.invoiceId, dueDate: day(30), amount: 5000 }] }, 'Finance', { branch: otherBranchId })).status, 403);

    // uneven distribution, new dates and one more installment
    const done = await must(adjust(e, { frequency: 'every_2_months', installments: [
        { invoiceId: i2.invoiceId, dueDate: day(20), amount: 1000 }, { invoiceId: i3.invoiceId, dueDate: day(80), amount: 1500 }, { dueDate: day(140), amount: 2500 }] }));
    assert.deepEqual(done.installments.map((x: Json) => [x.installmentNumber, x.originalAmount, x.amount, x.dueDate === x.originalDueDate]), [[1, 2000, 1000, true], [2, 2000, 1000, false], [3, 2000, 1500, false], [4, 0, 2500, true]]);
    assert.equal(done.frequency, 'every_2_months');
    assert.ok(done.history.some((h: Json) => h.action === 'schedule_adjusted' && h.reason === 'Family request' && h.actorName === 'Finance User' && h.oldValue.amount === 2500 && h.newValue.amount === 1000));
    assert.deepEqual(await query(`SELECT * FROM billing.payments WHERE student_id = $1`, [s]), before, 'payments untouched');

    // fewer installments again; partial payments keep working on the adjusted plan
    const now = done.installments.slice(1);
    const fewer = await must(adjust(e, { installments: [{ invoiceId: now[0].invoiceId, dueDate: day(20), amount: 2000 }, { invoiceId: now[2].invoiceId, dueDate: day(100), amount: 3000 }] }));
    assert.deepEqual(fewer.installments.map((x: Json) => x.balanceAmount), [0, 2000, 3000]);
    await pay(s, { invoiceId: now[0].invoiceId, amount: 500 });
    const view = courseOf(await breakdown(s), c);
    assert.deepEqual([view.totalFee, view.paidAmount, view.installments.map((x: Json) => x.balanceAmount)], [6000, 1500, [0, 0, 4500]]);
    assert.ok((await ledger(s)).audit.some((x: Json) => x.action === 'billing.schedule_adjusted'));
    await assertConsistent(s);
});

test('flexible: removing an installment keeps its credit', async () => {
    const [a, b] = [await course(30000), await course(24000)];
    await coursePeriod(b, day(-5), 24);
    const s = await student(a.batchId);
    await bill(s, a, 1, 30000);
    const t = await must(transfer(s, a, b, { review: { decision: 'approve', consumedAmount: 24000 }, feePlan: plan({ applyCredit: 6000 }) }));
    const p = await getPlan(t.newEnrollmentId);
    await must(adjust(t.newEnrollmentId, { installments: [{ invoiceId: p.installments[1].invoiceId, dueDate: day(90), amount: 18000 }] }));
    const view = courseOf(await breakdown(s), b);
    assert.deepEqual([view.totalFee, view.creditApplied, view.balanceAmount, view.installments.length], [24000, 6000, 18000, 1]);
    await assertConsistent(s);
});

test('flexible: registration schedules can be adjusted and other courses are untouched', async () => {
    const [c, other] = [await course(6000, 'Guitar Basics'), await course(4000)];
    await coursePeriod(c, day(-5), 12);
    const reg = await must(call(students.POST, 'POST', 'TenantAdmin', {
        body: {
            firstName: 'Adj', lastName: 'Reg', email: `adj${++counter}@example.com`, batchId: c.batchId, branchId,
            feeStructure: { courseTitle: c.title, finalFee: 6000, installments: [1, 2, 3].map(n => ({ installmentNumber: n, dueDate: day(n * 30), amount: 2000, designation: `Installment ${n} of 3` })) },
        },
    }));
    await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id) VALUES ($1, $2, $3)`, [tenantId, reg.studentId, other.batchId]);
    await bill(reg.studentId, other, 2, 0);
    const { enrollment_id: e } = await enrollmentOf(reg.studentId, c.batchId);
    const p = await getPlan(e);
    assert.deepEqual(p.installments.map((x: Json) => x.adjustable), [true, true, true]);
    await must(adjust(e, { frequency: 'quarterly', installments: [{ invoiceId: p.installments[0].invoiceId, dueDate: day(10), amount: 5000 }, { invoiceId: p.installments[1].invoiceId, dueDate: day(100), amount: 1000 }] }));
    const view = await breakdown(reg.studentId);
    assert.deepEqual(courseOf(view, c).installments.map((x: Json) => x.balanceAmount), [5000, 1000]);
    assert.deepEqual(courseOf(view, other).installments.map((x: Json) => x.balanceAmount), [2000, 2000]);
    assert.equal(courseOf(view, c).feePlan.frequency, 'quarterly');
    await pay(reg.studentId, { invoiceId: p.installments[0].invoiceId, amount: 4000 });
    assert.deepEqual(courseOf(await breakdown(reg.studentId), c).installments.map((x: Json) => x.balanceAmount), [0, 2000]);
    await assertConsistent(reg.studentId);
});

test('flexible: outstanding with no installment left is shown for Finance review and can be rescheduled', async () => {
    const c = await course(4000);
    await coursePeriod(c, day(-60), 12);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 2, 2000);
    const e = billed.enrollmentId;
    const last = billed.invoices[1].invoiceId;
    assert.equal(courseOf(await breakdown(s), c).reviewOutstanding, 0);
    await pay(s, { invoiceId: last, amount: 1200 });
    assert.equal(courseOf(await breakdown(s), c).reviewOutstanding, 800);
    await query(`UPDATE billing.invoices SET due_date = CURRENT_DATE - 5, overdue_status = 'overdue' WHERE invoice_id = $1`, [last]);
    const view = courseOf(await breakdown(s), c);
    assert.deepEqual([view.reviewOutstanding, view.installments.find((x: Json) => x.invoiceId === last).status], [800, 'overdue']);
    const p = await getPlan(e);
    assert.deepEqual([p.isReview, p.adjustableTotal], [true, 800]);
    assert.equal((await adjust(e, { installments: [{ dueDate: day(30), amount: 800 }] })).status, 400, 'a part-paid installment is not removed');
    await must(adjust(e, { installments: [{ invoiceId: last, dueDate: day(-5), amount: 0 }, { dueDate: day(30), amount: 400 }, { dueDate: day(60), amount: 400 }] }));
    const after = courseOf(await breakdown(s), c);
    assert.deepEqual([after.reviewOutstanding, after.installments.map((x: Json) => `${x.status} ${x.balanceAmount}`).sort()], [0, ['paid 0', 'paid 0', 'pending 400', 'pending 400']]);
    await assertConsistent(s);
});

test('flexible: overdue installments are not changed while future ones exist', async () => {
    const c = await course(6000);
    await coursePeriod(c, day(-60), 12);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 3, 0);
    await query(`UPDATE billing.invoices SET due_date = CURRENT_DATE - 3 WHERE invoice_id = $1`, [billed.invoices[0].invoiceId]);
    const p = await getPlan(billed.enrollmentId);
    assert.deepEqual([p.installments.map((x: Json) => x.adjustable), p.adjustableTotal], [[false, true, true], 4000]);
});

test('flexible: failed online attempt is shown, changes no money and can be retried', async () => {
    const c = await course(3000);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 2, 0);
    const g = await callFn<{ guardianId: string }>('academics.fn_guardian_create', tenantId, 'Fa', 'Il', 'Parent', '9876500000', `f${++counter}@example.com`, [s], users.TenantAdmin);
    const guardian = await createUser('Guardian');
    await query('UPDATE academics.guardians SET user_id = $1 WHERE guardian_id = $2', [guardian, g.guardianId]);
    const post = (body: Json) => call(portal.POST, 'POST', 'Guardian', { userId: guardian, body: { wardId: s, ...body } });
    const invoiceId = billed.invoices[0].invoiceId;
    const o = await must(post({ action: 'create_payment_order', amount: 700, invoiceId }));
    await must(post({ action: 'payment_failed', razorpayOrderId: o.orderId, reason: 'Card declined' }));
    let first = courseOf(await breakdown(s), c).installments[0];
    assert.deepEqual([first.status, first.failedAttempt.reason, first.balanceAmount, await receiptsTotal(s)], ['failed', 'Card declined', 1500, 0]);
    const sig = createHmac('sha256', 'unit-secret').update(`${o.orderId}|pay_retry`).digest('hex');
    const ok = await must(post({ action: 'pay_installment', razorpayOrderId: o.orderId, razorpayPaymentId: 'pay_retry', razorpaySignature: sig }));
    assert.equal(ok.receipts.length, 1, 'receipt only after verification');
    first = courseOf(await breakdown(s), c).installments[0];
    assert.deepEqual([first.status, first.failedAttempt, first.paidAmount, first.carriedOutstanding], ['partially_paid', null, 700, 800]);
    // paid orders cannot be marked failed, nor another family's
    await must(post({ action: 'payment_failed', razorpayOrderId: o.orderId, reason: 'late' }));
    assert.equal((await query<{ status: string }>('SELECT status FROM billing.payment_orders WHERE order_id = $1', [o.orderId]))[0].status, 'paid');
    // the guardian completes the same installment online, and a failed event from the gateway is recorded
    const o2 = await must(post({ action: 'create_payment_order', amount: 800, invoiceId }));
    const raw = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { order_id: o2.orderId, error_description: 'Bank down' } } } });
    await webhook.POST(new NextRequest('http://localhost/hook', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': createHmac('sha256', 'unit-secret').update(raw).digest('hex') } }));
    const sig2 = createHmac('sha256', 'unit-secret').update(`${o2.orderId}|pay_more`).digest('hex');
    await must(post({ action: 'pay_installment', razorpayOrderId: o2.orderId, razorpayPaymentId: 'pay_more', razorpaySignature: sig2 }));
    const list = courseOf(await breakdown(s), c).installments;
    assert.deepEqual(list.map((x: Json) => [x.status, x.paidAmount, x.balanceAmount]), [['paid', 1500, 0], ['pending', 0, 1500]]);
    await assertConsistent(s);
});

test('flexible: an online payment captured for a removed installment still reaches the course', async () => {
    const c = await course(6000);
    await coursePeriod(c, day(-5), 12);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 3, 0);
    const { createFeePaymentOrder, captureFeePaymentOrder } = await import('@/lib/billing/fee-installments');
    const o = await createFeePaymentOrder({ tenantId, studentId: s, invoiceId: billed.invoices[2].invoiceId, amount: 2000, actorId: users.Guardian });
    await must(adjust(billed.enrollmentId, { installments: [{ invoiceId: billed.invoices[0].invoiceId, dueDate: day(30), amount: 3000 }, { invoiceId: billed.invoices[1].invoiceId, dueDate: day(60), amount: 3000 }] }));
    const r = await captureFeePaymentOrder({ orderId: o.orderId, paymentId: 'pay_void', paymentMethod: 'Razorpay', capturedPaise: 200000 });
    assert.equal(r!.totalAmountPaid, 2000);
    const view = courseOf(await breakdown(s), c);
    assert.deepEqual([view.paidAmount, view.balanceAmount], [2000, 4000]);
    await assertConsistent(s);
});

test('flexible: an academy with an unknown time zone still works', async () => {
    const c = await course(3000);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 2, 0);
    await query(`UPDATE tenant.organizations SET timezone = 'Not/AZone' WHERE tenant_id = $1`, [tenantId]);
    try {
        assert.match((await getPlan(billed.enrollmentId)).period.today, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(courseOf(await breakdown(s), c).installments.length, 2);
    } finally {
        await query(`UPDATE tenant.organizations SET timezone = 'Asia/Kolkata' WHERE tenant_id = $1`, [tenantId]);
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// Attendance-based consumed fee. A class every day for 20 days (10 of them past), fee 20000, so one session is worth 1000.
// ---------------------------------------------------------------------------------------------------------------------
const attendanceApi = await import('@/app/api/v1/attendance/route');
const { dateIn: calendarDate } = await import('@/lib/billing/course-period');
const local = (offset: number) => calendarDate('Asia/Kolkata', new Date(Date.now() + offset * 86400000));

const policy = (courseId: string | null, body: Json, role = 'Finance', opts: Json = {}) =>
    call(consumption.POST, 'POST', role, { ...opts, body: { action: 'save_policy', courseId, ...body } });
const act = (action: string, enrollmentId: string, body: Json, role: string, opts: Json = {}) =>
    call(consumption.POST, 'POST', role, { ...opts, body: { action, enrollmentId, reason: 'Checked the class register', ...body } });
const look = (enrollmentId: string, role = 'Finance', until = '') => call(consumption.GET, 'GET', role, { search: `?enrollmentId=${enrollmentId}${until && `&until=${until}`}` });
const assessed = async (enrollmentId: string, until = '') => (await must(look(enrollmentId, 'Finance', until))).assessment;
const audits = (action: string, entityId: string) => query<{ actor_id: string; changes: Json }>(
    `SELECT * FROM audit.compliance_logs WHERE action = $1 AND entity_id::text = $2`, [action, entityId]);

async function sessionCourse(method: 'session' | 'monthly' | 'manual' | null, extra: Json = {}, timetable = true) {
    const c = await course(20000);
    users.BranchManager ??= await createUser('BranchManager');
    await query(`UPDATE academics.batches SET start_date = $2, end_date = $3, instructor_user_id = $4 WHERE batch_id = $1`, [c.batchId, local(-10), local(9), users.Instructor]);
    if (timetable) {
        await query(`INSERT INTO academics.batch_schedules (tenant_id, batch_id, weekday, start_time, end_time) SELECT $1, $2, d, '10:00', '11:00' FROM generate_series(1, 7) d`, [tenantId, c.batchId]);
    }
    if (method) await must(policy(c.courseId, { method, ...extra }));
    return c;
}

/** Student enrolled on the first day who paid 15000 of 20000. */
async function attending(c: Course, paid = 15000) {
    const s = await student(c.batchId);
    await query(`UPDATE academics.enrollments SET enrolled_at = $2 WHERE student_id = $1`, [s, `${local(-10)}T06:00:00Z`]);
    const enrollmentId = (await enrollmentOf(s, c.batchId)).enrollment_id;
    await must(call(transfers.POST, 'POST', 'Finance', { body: { action: 'create_fee_plan', enrollmentId, ...plan({ installmentCount: 1, firstDueDate: local(0) }) } }));
    if (paid > 0) await pay(s, { enrollmentId, amount: paid });
    return { s, enrollmentId };
}

const mark = (c: Course, studentId: string, date: string, status = 'present', role = 'Instructor') =>
    must(call(attendanceApi.POST, 'POST', role, { body: { batchId: c.batchId, sessionDate: date, records: [{ studentId, status }] } }));
async function markDays(c: Course, studentId: string, from: number, to: number, status = 'present') {
    for (let d = from; d <= to; d++) await mark(c, studentId, local(d), status);
}
const on = (date: string) => ({ transferDate: date });

test('consumption: present – every class marked, credit follows the verified calculation', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -1);
    const v = await must(look(enrollmentId));
    assert.deepEqual([v.assessment.status, v.assessment.counts.scheduled, v.assessment.counts.conducted, v.assessment.counts.present, v.assessment.totalCourseSessions], ['verified', 10, 10, 10, 20]);
    assert.deepEqual([v.assessment.consumedAmount, v.credit.verifiedPayments, v.credit.eligibleCredit], [10000, 15000, 5000]);
    const t = await must(transfer(s, a, b, { ...on(local(0)), review: { decision: 'approve' }, feePlan: plan({ applyCredit: 5000 }) }));
    assert.deepEqual([t.creditStatus, t.approvedCredit, t.feePlan.payableAmount], ['approved', 5000, 19000]);
    assert.deepEqual([courseOf(await breakdown(s), b).balanceAmount, courseOf(await breakdown(s), a).balanceAmount], [19000, 5000]);
    const [row] = await query<Json>(`SELECT consumption_method, consumption_snapshot FROM billing.course_transfers WHERE transfer_id = $1`, [t.transferId]);
    assert.deepEqual([row.consumption_method, row.consumption_snapshot.counts.present], ['session', 10]);
    await assertConsistent(s);
});

test('consumption: absent – not refundable unless the academy policy says so; excused has its own rule', async () => {
    const strict = await sessionCourse('session', { excusedCounts: false });
    const one = await attending(strict);
    await markDays(strict, one.s, -10, -6);
    await markDays(strict, one.s, -5, -2, 'absent');
    await mark(strict, one.s, local(-1), 'excused');
    assert.deepEqual([(await assessed(one.enrollmentId)).consumedAmount, (await assessed(one.enrollmentId)).counts.absent, (await assessed(one.enrollmentId)).counts.excused], [9000, 5, 1]);
    await must(policy(strict.courseId, { method: 'session', absentCounts: false, excusedCounts: false }));
    assert.equal((await assessed(one.enrollmentId)).consumedAmount, 5000);
});

test('consumption: missing attendance – nothing is assumed, the credit waits until the teacher corrects it', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    const other = await student(a.batchId);
    await markDays(a, s, -10, -3);
    await mark(a, other, local(-2)); // the class took place, this student was not marked
    await mark(a, s, local(-1));
    let v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.consumedAmount, v.counts.missing, v.unresolved.map((x: Json) => x.date)], ['attendance_missing', null, 1, [local(-2)]]);

    for (const extra of [{}, { review: { decision: 'approve' }, feePlan: plan() }]) {
        assert.equal((await transfer(s, a, b, { ...on(local(0)), ...extra })).status, 409, 'credit is never generated from missing attendance');
    }
    assert.equal((await enrollmentOf(s, a.batchId)).status, 'enrolled', 'original enrollment preserved');
    assert.equal(await enrollmentOf(s, b.batchId), undefined);
    assert.equal((await ledger(s)).balance, 0);

    await must(act('request_verification', enrollmentId, {}, 'Staff'));
    await must(act('request_verification', enrollmentId, {}, 'Staff'));
    const queue = async (role: string, opts: Json = {}) => (await must(call(consumption.GET, 'GET', role, { search: '?view=queue', ...opts }))).filter((x: Json) => x.enrollmentId === enrollmentId);
    assert.equal((await queue('Instructor')).length, 1, 'one request, seen by the responsible teacher');
    assert.equal((await queue('Instructor', { userId: await createUser('Instructor') })).length, 0);
    assert.equal((await queue('BranchManager', { branch: branchId })).length, 1);
    assert.equal((await queue('BranchManager', { branch: otherBranchId })).length, 0);
    assert.equal((await queue('Finance'))[0].status, 'attendance_missing');

    const fix = { date: local(-2), status: 'present' };
    assert.equal((await act('correct_attendance', enrollmentId, fix, 'Finance')).status, 403, 'Finance never changes attendance');
    assert.equal((await act('correct_attendance', enrollmentId, fix, 'Staff')).status, 403);
    assert.equal((await act('correct_attendance', enrollmentId, fix, 'Instructor', { userId: await createUser('Instructor') })).status, 403, 'only the responsible teacher');
    assert.equal((await act('correct_attendance', enrollmentId, fix, 'BranchManager', { branch: otherBranchId })).status, 403);
    assert.equal((await act('correct_attendance', enrollmentId, { ...fix, reason: ' ' }, 'Instructor')).status, 400, 'reason is mandatory');
    assert.equal((await act('correct_attendance', enrollmentId, { ...fix, date: local(-40) }, 'Instructor')).status, 400);
    assert.equal((await act('confirm_session', enrollmentId, { date: local(-2), status: 'cancelled' }, 'Instructor')).status, 409, 'a class with attendance was not cancelled');
    await must(act('correct_attendance', enrollmentId, fix, 'Instructor'));
    assert.equal((await act('correct_attendance', enrollmentId, { ...fix, status: 'absent' }, 'BranchManager')).status, 409, 'never overwritten');
    const [log] = await audits('attendance.corrected', s);
    assert.equal(log.actor_id, users.Instructor);
    assert.match(JSON.stringify(log), /Checked the class register/);
    const records = await query<Json>(`SELECT status, remarks FROM academics.attendance_records WHERE student_id = $1 AND session_date = $2`, [s, local(-2)]);
    assert.deepEqual(records, [{ status: 'present', remarks: 'Corrected: Checked the class register' }]);

    v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.consumedAmount], ['verified', 10000]);
    await must(transfer(s, a, b, { ...on(local(0)), review: { decision: 'approve' }, feePlan: plan({ applyCredit: 5000 }) }));
    assert.equal((await queue('Finance')).length, 0, 'request closed by the transfer');
});

test('consumption: nothing recorded – pending until someone confirms that the class was held', async () => {
    const a = await sessionCourse('session');
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -2);
    assert.deepEqual([(await assessed(enrollmentId)).status, (await assessed(enrollmentId)).counts.unconfirmed], ['pending_verification', 1]);
    const at = { date: local(-1) };
    assert.equal((await act('correct_attendance', enrollmentId, { ...at, status: 'present' }, 'Instructor')).status, 409, 'class first has to be confirmed');
    assert.equal((await act('confirm_session', enrollmentId, { ...at, status: 'conducted' }, 'Finance')).status, 403);
    assert.equal((await act('confirm_session', enrollmentId, { ...at, status: 'maybe' }, 'Instructor')).status, 400);
    await must(act('confirm_session', enrollmentId, { ...at, status: 'conducted' }, 'BranchManager', { branch: branchId }));
    assert.equal((await assessed(enrollmentId)).status, 'attendance_missing', 'a held class does not make the student present');
    await must(act('correct_attendance', enrollmentId, { ...at, status: 'absent' }, 'BranchManager', { branch: branchId }));
    assert.deepEqual([(await assessed(enrollmentId)).status, (await assessed(enrollmentId)).consumedAmount], ['verified', 10000]);
});

test('consumption: cancelled class is kept on record and not consumed unless the policy requires it', async () => {
    const a = await sessionCourse('session');
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -2);
    await must(act('confirm_session', enrollmentId, { date: local(-1), status: 'cancelled', reason: 'Heavy rain' }, 'Instructor'));
    const v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.counts.cancelled, v.counts.conducted, v.consumedAmount], ['verified', 1, 9, 9000]);
    const [saved] = await query<Json>(`SELECT status, reason, confirmed_by_actor_id FROM academics.class_sessions WHERE batch_id = $1`, [a.batchId]);
    assert.deepEqual(saved, { status: 'cancelled', reason: 'Heavy rain', confirmed_by_actor_id: users.Instructor });
    assert.equal((await audits('attendance.session_confirmed', a.batchId)).length, 1);
    await must(policy(a.courseId, { method: 'session', cancelledCounts: true }));
    assert.equal((await assessed(enrollmentId)).consumedAmount, 10000);

    await mark(a, s, local(-1)); // contradicting record
    assert.deepEqual([(await assessed(enrollmentId)).status, (await assessed(enrollmentId)).counts.conflict], ['pending_verification', 1]);
    await must(act('confirm_session', enrollmentId, { date: local(-1), status: 'conducted', reason: 'Class was held online' }, 'Instructor'));
    assert.equal((await assessed(enrollmentId)).status, 'verified');
});

test('consumption: missing timetable or policy goes to Finance, whatever was marked', async () => {
    const b = await course(24000);
    const noTimetable = await sessionCourse('session', {}, false);
    const one = await attending(noTimetable);
    await markDays(noTimetable, one.s, -10, -1);
    const v = await assessed(one.enrollmentId);
    assert.deepEqual([v.status, v.hasTimetable, v.consumedAmount], ['finance_review_required', false, null]);
    assert.equal((await transfer(one.s, noTimetable, b, on(local(0)))).status, 409);

    const noPolicy = await sessionCourse('session');
    const two = await attending(noPolicy);
    await markDays(noPolicy, two.s, -10, -1);
    await query(`DELETE FROM billing.fee_consumption_policies WHERE course_id = $1`, [noPolicy.courseId]);
    const [fallback] = await query<Json>(`DELETE FROM billing.fee_consumption_policies WHERE tenant_id = $1 AND course_id IS NULL RETURNING policy_id`, [tenantId]);
    assert.ok(fallback);
    try {
        const w = await assessed(two.enrollmentId);
        assert.deepEqual([w.status, w.policy.configured, w.policy.requireVerification], ['finance_review_required', false, true]);
    } finally {
        await must(policy(null, { method: 'manual', requireVerification: false }));
    }
});

test('consumption: monthly – completed periods only, unfinished one by policy', async () => {
    const a = await sessionCourse('monthly');
    await query(`UPDATE academics.batches SET start_date = $2, end_date = NULL WHERE batch_id = $1`, [a.batchId, local(-75)]);
    const { s, enrollmentId } = await attending(a);
    await query(`UPDATE academics.enrollments SET enrolled_at = $2 WHERE enrollment_id = $1`, [enrollmentId, `${local(-75)}T06:00:00Z`]);
    await query(`INSERT INTO academics.attendance_records (tenant_id, batch_id, student_id, session_date, status, recorded_by_actor_id)
                 SELECT $1, $2, $3, d::date, 'present', $4 FROM generate_series($5::date, $6::date, '1 day') d`, [tenantId, a.batchId, s, users.Instructor, local(-75), local(-1)]);
    const v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.calculation, v.consumedAmount], ['verified', '2 of 12 billing months', 3333.33]);
    await must(policy(a.courseId, { method: 'monthly', partialPeriod: 'full' }));
    assert.equal((await assessed(enrollmentId)).consumedAmount, 5000);
    // Enrollment duration alone does not consume a month: without any eligible class it is not counted
    await query(`UPDATE academics.attendance_records SET status = 'absent' WHERE student_id = $1 AND session_date < $2::date + interval '1 month'`, [s, local(-75)]);
    await must(policy(a.courseId, { method: 'monthly', absentCounts: false }));
    assert.equal((await assessed(enrollmentId)).calculation, '1 of 12 billing months');
    await query(`DELETE FROM academics.attendance_records WHERE student_id = $1 AND session_date = $2`, [s, local(-20)]);
    assert.deepEqual([(await assessed(enrollmentId)).status, (await assessed(enrollmentId)).consumedAmount], ['pending_verification', null]);
});

test('consumption: session method – extra classes, unmarked today and late joining are handled once each', async () => {
    const a = await sessionCourse('session');
    const { s, enrollmentId } = await attending(a);
    await query(`UPDATE academics.enrollments SET enrolled_at = $2 WHERE enrollment_id = $1`, [enrollmentId, `${local(-5)}T06:00:00Z`]);
    await markDays(a, s, -5, -1);
    let v = await assessed(enrollmentId);
    assert.deepEqual([v.counts.scheduled, v.totalCourseSessions, v.consumedAmount], [5, 15, 6666.67], 'classes before joining are not counted');
    await mark(a, s, local(0));
    v = await assessed(enrollmentId);
    assert.deepEqual([v.counts.present, v.consumedAmount], [6, 8000], 'today counts once it is marked');
    assert.equal((await assessed(enrollmentId, local(-3))).counts.present, 3, 'classes after the transfer date do not count; its own day only when marked');
    await query(`DELETE FROM academics.batch_schedules WHERE batch_id = $1 AND weekday = $2`, [a.batchId, new Date(`${local(-2)}T00:00:00Z`).getUTCDay() || 7]);
    v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.counts.scheduled, v.counts.present, v.counts.unscheduled, v.consumedAmount], ['pending_verification', 5, 5, 1, null], 'off the timetable: not counted until confirmed');
    await must(act('confirm_session', enrollmentId, { date: local(-2), status: 'conducted', reason: 'Extra class' }, 'Instructor'));
    v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.counts.scheduled, v.counts.conducted, v.counts.present], ['verified', 6, 6, 6], 'a confirmed extra class is a class');
});

test('consumption: manual Finance review – reason, audit, unresolved classes kept, never above the eligible credit', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -4);
    assert.equal((await act('manual_review', enrollmentId, { consumedAmount: 8000, reason: '' }, 'Finance')).status, 400);
    assert.equal((await act('manual_review', enrollmentId, { consumedAmount: 20001 }, 'Finance')).status, 400);
    assert.equal((await act('manual_review', enrollmentId, { consumedAmount: -1 }, 'Finance')).status, 400);
    for (const role of ['Instructor', 'Staff']) assert.equal((await act('manual_review', enrollmentId, { consumedAmount: 8000 }, role)).status, 403);
    assert.equal((await act('manual_review', enrollmentId, { consumedAmount: 8000 }, 'Guardian')).status, 403);
    const hidden = await must(look(enrollmentId, 'Instructor'));
    assert.deepEqual([hidden.credit, hidden.assessment.courseFee, hidden.assessment.consumedAmount], [null, null, null], 'teachers see attendance, not money');

    const missing = [local(-3), local(-2), local(-1)];
    const done = await must(act('manual_review', enrollmentId, { consumedAmount: 8000, reason: 'Agreed with the guardian' }, 'Finance'));
    assert.deepEqual([done.assessment.status, done.assessment.method, done.assessment.consumedAmount, done.credit.eligibleCredit], ['verified', 'manual', 8000, 7000]);
    assert.deepEqual(done.assessment.unresolved.map((x: Json) => x.date), missing, 'the unmarked classes stay unmarked');
    const [log] = await audits('billing.consumption_manual_review', enrollmentId);
    assert.equal(log.actor_id, users.Finance);
    assert.match(JSON.stringify(log), /Agreed with the guardian/);
    assert.equal((await query(`SELECT 1 FROM academics.attendance_records WHERE student_id = $1`, [s])).length, 7, 'attendance untouched');

    assert.equal((await transfer(s, a, b, { ...on(local(0)), review: { decision: 'approve', approvedCredit: 7001 } })).status, 400);
    assert.equal((await enrollmentOf(s, a.batchId)).status, 'enrolled');
    const t = await must(transfer(s, a, b, { ...on(local(0)), review: { decision: 'approve', approvedCredit: 6000, notes: 'Agreed with the guardian' }, feePlan: plan({ applyCredit: 6000 }) }));
    assert.equal(t.approvedCredit, 6000);
    assert.equal((await review(t.transferId, { decision: 'approve' })).status, 409, 'decided once');
});

test('consumption: a manual review expires when more classes take place and is not reused for another stay', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -5);
    await must(act('manual_review', enrollmentId, { consumedAmount: 5000, until: local(-4) }, 'Finance'));
    assert.equal((await assessed(enrollmentId, local(-4))).status, 'verified');
    assert.equal((await assessed(enrollmentId)).status, 'pending_verification', 'later classes were not part of the decision');

    const loose = await sessionCourse('manual', {}, false);
    const two = await attending(loose);
    await must(act('manual_review', two.enrollmentId, { consumedAmount: 5000, until: local(-3) }, 'Finance'));
    assert.equal((await assessed(two.enrollmentId)).status, 'finance_review_required', 'without a timetable the decision holds for its date only');
    await must(act('manual_review', two.enrollmentId, { consumedAmount: 6000 }, 'Finance'));
    await must(transfer(two.s, loose, b, { ...on(local(0)), review: { decision: 'approve' }, feePlan: plan() }));
    await must(act('manual_review', (await enrollmentOf(two.s, b.batchId)).enrollment_id, { consumedAmount: 0 }, 'Finance'));
    await must(transfer(two.s, b, loose, on(local(0))));
    const back = await assessed(two.enrollmentId);
    assert.deepEqual([back.status, back.manualReview], ['finance_review_required', null], 'the first decision does not cover the second stay');
});

test('consumption: a late decision on an earlier transfer is not taken over by the next one', async () => {
    const [a, b] = [await sessionCourse('manual', { requireVerification: false }), await sessionCourse('manual', { requireVerification: false })];
    const { s, enrollmentId } = await attending(a);
    const t1 = await must(transfer(s, a, b, on(local(0))));
    await must(transfer(s, b, a, on(local(0))));
    assert.match((await call(transfers.GET, 'GET', 'Finance', { search: `?transferId=${t1.transferId}` })).data.assessment.issues.join(), /returned to this batch/);
    assert.equal((await review(t1.transferId, { decision: 'approve' })).status, 409);
    await must(review(t1.transferId, { decision: 'approve', consumedAmount: 4000 }));
    assert.deepEqual([(await assessed(enrollmentId)).status, (await assessed(enrollmentId)).manualReview], ['finance_review_required', null]);
    await assertConsistent(s);
});

test('consumption: transfer without verification in advance keeps the credit pending, up to the transfer date', async () => {
    const [a, b] = [await sessionCourse('session', { requireVerification: false }), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -5);
    const t = await must(transfer(s, a, b, on(local(-3)), 'Staff'));
    assert.equal(t.creditStatus, 'pending_review');
    const queued = async () => (await must(call(consumption.GET, 'GET', 'Instructor', { search: '?view=queue' }))).filter((x: Json) => x.enrollmentId === enrollmentId);
    assert.deepEqual((await queued()).map((x: Json) => [x.status, x.unresolved]), [['pending_verification', 1]], 'the teacher is asked, up to the transfer date');
    const detail = (await must(call(transfers.GET, 'GET', 'Finance', { search: `?transferId=${t.transferId}` })));
    assert.deepEqual([detail.assessment.status, detail.assessment.until, detail.assessment.unresolved.map((x: Json) => x.date)], ['pending_verification', local(-3), [local(-4)]]);
    assert.equal((await review(t.transferId, { decision: 'approve' })).status, 409);
    assert.equal((await act('correct_attendance', enrollmentId, { date: local(-2), status: 'present' }, 'Instructor')).status, 400, 'after the transfer date');
    await must(act('confirm_session', enrollmentId, { date: local(-4), status: 'conducted' }, 'Instructor'));
    await must(act('correct_attendance', enrollmentId, { date: local(-4), status: 'present' }, 'Instructor'));
    const r = await must(review(t.transferId, { decision: 'approve' }));
    assert.deepEqual([r.consumedAmount, r.eligibleCredit], [7000, 8000]);
    assert.equal((await queued()).length, 0, 'closed by the decision');
    assert.equal((await ledger(s)).balance, 8000);
});

test('consumption: nothing paid needs no verification; rejecting needs a reason but no attendance', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const unpaid = await attending(a, 0);
    assert.equal((await must(transfer(unpaid.s, a, b, on(local(0)), 'Staff'))).creditStatus, 'not_applicable');
    const paid = await attending(a);
    const t = await must(transfer(paid.s, a, b, { ...on(local(0)), review: { decision: 'reject', notes: 'Left without notice' }, feePlan: plan() }));
    assert.deepEqual([t.creditStatus, t.approvedCredit, (await ledger(paid.s)).balance], ['rejected', 0, 0]);
});

test('consumption: policy is set by academy Finance only and every change is audited', async () => {
    const a = await course(1000);
    assert.equal((await policy(a.courseId, { method: 'session' }, 'Staff')).status, 403);
    assert.equal((await policy(a.courseId, { method: 'session' }, 'BranchManager', { branch: branchId })).status, 403);
    assert.equal((await policy(a.courseId, { method: 'weekly' })).status, 400);
    assert.equal((await policy(randomUUID(), { method: 'session' })).status, 404);
    await must(policy(a.courseId, { method: 'session' }));
    await must(policy(a.courseId, { method: 'monthly', absentCounts: false }));
    assert.equal((await audits('billing.consumption_policy_saved', a.courseId)).length, 2);
    const list = await must(call(consumption.GET, 'GET', 'Finance', { search: '?view=policy' }));
    assert.deepEqual(list.filter((x: Json) => x.courseId === a.courseId).map((x: Json) => [x.method, x.absentCounts]), [['monthly', false]]);
    assert.equal((await call(consumption.GET, 'GET', 'Instructor', { search: '?view=policy' })).status, 403);
});

test('portal: online fees settle only by a captured Razorpay payment, also when the browser never reports it', async () => {
    const c = await course(6000);
    const s = await student(c.batchId);
    const billed = await bill(s, c, 2, 0);
    const guardian = await callFn<{ guardianId: string }>('academics.fn_guardian_create', tenantId, 'Par', 'Ent', 'Parent', '9876500000', `g${++counter}@example.com`, [s], users.TenantAdmin);
    const send = (body: Json) => call(portal.POST, 'POST', 'TenantAdmin', { key: randomUUID(), body: { wardId: s, guardianId: guardian.guardianId, ...body } });
    const paid = async () => courseOf(await breakdown(s), c).paidAmount;

    for (const paymentMethod of ['AutoPay', 'autopay', 'UPI', 'Razorpay', undefined]) {
        assert.equal((await send({ action: 'pay_installment', paymentMethod, isAutopay: true, enrollmentId: billed.enrollmentId, amount: 6000 })).status, 400, `${paymentMethod} without a gateway payment`);
    }
    const order = await must(send({ action: 'create_payment_order', invoiceId: billed.invoices[0].invoiceId, amount: 3000 }));
    for (const signature of ['autopay_simulated', 'simulated', '']) {
        assert.equal((await send({ action: 'pay_installment', paymentMethod: 'AutoPay', razorpayOrderId: order.orderId, razorpayPaymentId: 'pay_x', razorpaySignature: signature })).status, 400);
    }
    assert.equal(await paid(), 0);

    const previous = globalThis.fetch;
    let items: Json[] = [];
    const base = { id: 'pay_qr', status: 'captured', amount: 300000, currency: 'INR', order_id: order.orderId };
    globalThis.fetch = (async (url: Json) => {
        assert.equal(String(url), `https://api.razorpay.com/v1/orders/${order.orderId}/payments`);
        return new Response(JSON.stringify({ items }), { status: 200 });
    }) as typeof fetch;
    try {
        const status = () => send({ action: 'payment_status', razorpayOrderId: order.orderId });
        for (const wrong of [[], [{ ...base, status: 'authorized' }], [{ ...base, status: 'failed' }], [{ ...base, amount: 100 }], [{ ...base, currency: 'USD' }], [{ ...base, order_id: 'order_other' }]]) {
            items = wrong;
            assert.equal((await must(status())).status, 'pending');
        }
        assert.equal(await paid(), 0);
        const stranger = await student(c.batchId);
        const other = await callFn<{ guardianId: string }>('academics.fn_guardian_create', tenantId, 'Oth', 'Er', 'Parent', '9876500001', `g${++counter}@example.com`, [stranger], users.TenantAdmin);
        items = [base];
        assert.equal((await call(portal.POST, 'POST', 'TenantAdmin', { body: { action: 'payment_status', wardId: stranger, guardianId: other.guardianId, razorpayOrderId: order.orderId } })).status, 404);
        const results = await Promise.all([status(), status(), send({ action: 'payment_status' })]);
        assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
        assert.equal((await must(status())).status, 'paid');
        assert.equal(await paid(), 3000, 'posted once');
        assert.equal((await must(send({ action: 'payment_status' }))).settled, 0);
    } finally {
        globalThis.fetch = previous;
    }
    await assertConsistent(s);
});

test('a scheduled test reaches the parent portal of the batch it is for, without marks until published', async () => {
    const c = await course(1000), elsewhere = await course(1000);
    const subject = async (id: string) => (await query<{ subject_id: string }>(
        `INSERT INTO academics.course_subjects (tenant_id, course_id, name) VALUES ($1, $2, 'Algebra') RETURNING subject_id`, [tenantId, id]))[0].subject_id;
    const algebra = await subject(c.courseId), other = await subject(elsewhere.courseId);
    const s = await student(c.batchId);
    const guardian = await callFn<Json>('academics.fn_guardian_create', tenantId, 'Test', 'Parent', 'Parent', '9876500009', `g${++counter}@example.com`, [s], users.TenantAdmin);
    const day = (o: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + o * 864e5));
    const schedule = async (batchId: string, title: string, o: number, subjectId = algebra): Promise<string> =>
        (await must(call(testsApi.POST, 'POST', 'TenantAdmin', { body: { batchId, title, testType: 'Mid Term', testDate: day(o), subjects: [{ subjectId, maxMarks: 50 }] } }))).testId;
    const ward = async () => (await must(call(portal.GET, 'GET', 'TenantAdmin', { search: `?guardianId=${guardian.guardianId}` }))).wards[0];
    const listed = async () => (await ward()).scheduledTests.map((t: Json) => [t.title, t.state]);

    const later = await schedule(c.batchId, 'Later', 5);
    await schedule(c.batchId, 'Today', 0);
    await schedule(c.batchId, 'Before joining', -3);
    await schedule(elsewhere.batchId, 'Another batch', 2, other);
    assert.deepEqual(await listed(), [['Today', 'upcoming'], ['Later', 'upcoming']]);
    const first = (await ward()).scheduledTests[1];
    assert.deepEqual([first.testDate, first.testType, first.subjects], [day(5), 'Mid Term', [{ name: 'Algebra', maxMarks: 50 }]]);

    for (const status of ['enrolled', 'confirmed', 'active', 'approved']) {
        await query(`UPDATE academics.enrollments SET status = $2 WHERE student_id = $1`, [s, status]);
        assert.equal((await listed()).length, 2, status);
    }
    for (const status of ['transferred', 'cancelled', 'pending', 'waitlisted']) {
        await query(`UPDATE academics.enrollments SET status = $2 WHERE student_id = $1`, [s, status]);
        assert.deepEqual(await listed(), [], status);
    }
    await query(`UPDATE academics.enrollments SET status = 'enrolled', enrolled_at = now() - interval '10 days' WHERE student_id = $1`, [s]);
    assert.deepEqual(await listed(), [['Before joining', 'awaiting_results'], ['Today', 'upcoming'], ['Later', 'upcoming']]);

    await must(call(testReport.PUT, 'PUT', 'TenantAdmin', { body: { testId: later, results: [{ studentId: s, subjectId: algebra, marks: 41.25 }] } }));
    let w = await ward();
    assert.equal(w.scheduledTests.find((t: Json) => t.testId === later).state, 'awaiting_results');
    assert.equal(w.testResults.length, 0);
    assert.ok(!JSON.stringify(w.scheduledTests).includes('41.25'), 'no marks before publishing');
    await must(call(testPublish.POST, 'POST', 'TenantAdmin', { body: { testId: later } }));
    w = await ward();
    assert.ok(!w.scheduledTests.some((t: Json) => t.testId === later));
    assert.equal(w.testResults[0].result.total, 41.25);
});

// ---------------------------------------------------------------------------------------------------------------------
// Transfer workflow: attendance figures, summary, decisions and atomicity
// ---------------------------------------------------------------------------------------------------------------------
/** Scheduled, conducted, present, absent and missing always add up. */
function assertCounts(a: Json) {
    const c = a.counts;
    assert.equal(c.present + c.absent + c.missing, c.conducted, 'present + absent + missing = conducted');
    assert.equal(c.conducted + c.cancelled + c.unconfirmed + c.conflict, c.scheduled, 'conducted classes are scheduled classes');
    assert.equal(new Set(a.sessions.map((x: Json) => x.date)).size, a.sessions.length, 'every date once');
    assert.ok(a.sessions.every((x: Json) => x.date >= a.enrollmentDate && x.date <= a.until), 'only between enrollment and review date');
}
const review0 = { decision: 'approve' };

test('workflow: attendance before the batch starts is never "scheduled 0, conducted 1"', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    await query(`UPDATE academics.batches SET start_date = $2 WHERE batch_id = $1`, [a.batchId, local(5)]);
    await query(`INSERT INTO academics.attendance_records (tenant_id, batch_id, student_id, session_date, status, recorded_by_actor_id) VALUES ($1, $2, $3, $4, 'present', $5)`,
        [tenantId, a.batchId, s, local(-1), users.Instructor]);
    const v = await assessed(enrollmentId);
    assert.deepEqual([v.counts.scheduled, v.counts.conducted, v.counts.present, v.counts.missing, v.counts.unscheduled], [0, 0, 0, 0, 1]);
    assert.deepEqual([v.status, v.consumedAmount, v.sessions[0].attendance, v.sessions[0].note], ['pending_verification', null, 'present', 'Before the course starts']);
    assert.match(v.warnings[0], /not scheduled classes/);
    assertCounts(v);
    assert.equal((await transfer(s, a, b, on(local(0)))).status, 409, 'needs an authorized review');
    await must(act('confirm_session', enrollmentId, { date: local(-1), status: 'conducted', reason: 'Trial class' }, 'Instructor'));
    const w = await assessed(enrollmentId);
    assert.deepEqual([w.status, w.counts.scheduled, w.counts.conducted, w.warnings], ['verified', 1, 1, []]);
    assertCounts(w);
    const [log] = await audits('attendance.session_confirmed', a.batchId);
    assert.match(JSON.stringify(log), /"extraClass":\s*true/);
});

test('workflow: every kind of session at once adds up and lists its dates', async () => {
    const a = await sessionCourse('session');
    const { s, enrollmentId } = await attending(a);
    const other = await student(a.batchId);
    // two lessons on one weekday are one session
    await query(`INSERT INTO academics.batch_schedules (tenant_id, batch_id, weekday, start_time, end_time) SELECT $1, $2, d, '15:00', '16:00' FROM generate_series(1, 7) d`, [tenantId, a.batchId]);
    await markDays(a, s, -10, -8);
    await mark(a, s, local(-7), 'late');
    await mark(a, s, local(-6), 'absent');
    await mark(a, s, local(-5), 'excused');
    await mark(a, other, local(-4));
    await must(act('confirm_session', enrollmentId, { date: local(-3), status: 'cancelled', reason: 'Holiday' }, 'Instructor'));
    const v = await assessed(enrollmentId);
    assert.deepEqual([v.counts.scheduled, v.counts.conducted, v.counts.present, v.counts.absent, v.counts.missing, v.counts.cancelled, v.counts.unconfirmed], [10, 7, 4, 2, 1, 1, 2]);
    assertCounts(v);
    assert.deepEqual(v.sessions.map((x: Json) => [x.state, x.attendance]).slice(0, 8), [['present', 'present'], ['present', 'present'], ['present', 'present'], ['present', 'late'],
        ['absent', 'absent'], ['excused', 'excused'], ['missing', null], ['cancelled', null]]);
    assertCounts(await assessed(enrollmentId, local(-6)));
    // attendance from before the enrollment is not counted and needs Finance
    await query(`UPDATE academics.enrollments SET enrolled_at = $2 WHERE enrollment_id = $1`, [enrollmentId, `${local(-8)}T06:00:00Z`]);
    const w = await assessed(enrollmentId);
    assert.deepEqual([w.status, w.counts.scheduled, w.counts.present], ['finance_review_required', 8, 2]);
    assert.match(w.warnings.join(' '), /before the enrollment date/);
    assertCounts(w);
});

test('workflow: classes after the course ends and a batch without timetable are not scheduled classes', async () => {
    const a = await sessionCourse('session');
    const { s, enrollmentId } = await attending(a);
    await query(`UPDATE academics.batches SET end_date = $2 WHERE batch_id = $1`, [a.batchId, local(-5)]);
    await markDays(a, s, -10, -5);
    const v = await assessed(enrollmentId);
    assert.deepEqual([v.status, v.counts.scheduled, v.totalCourseSessions, v.consumedAmount], ['verified', 6, 6, 20000], 'nothing to confirm after the end');
    await query(`INSERT INTO academics.attendance_records (tenant_id, batch_id, student_id, session_date, status, recorded_by_actor_id) VALUES ($1, $2, $3, $4, 'present', $5)`,
        [tenantId, a.batchId, s, local(-2), users.Instructor]);
    const w = await assessed(enrollmentId);
    assert.deepEqual([w.counts.scheduled, w.counts.unscheduled, w.sessions.at(-1).note], [6, 1, 'After the course ends']);
    await query(`DELETE FROM academics.batch_schedules WHERE batch_id = $1`, [a.batchId]);
    const n = await assessed(enrollmentId);
    assert.deepEqual([n.status, n.counts.scheduled, n.counts.conducted, n.counts.unscheduled], ['finance_review_required', 0, 0, 7]);
    assertCounts(n);
});

test('workflow: the review is the transfer itself, rolled back, and is checked again when saving', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a);
    await markDays(a, s, -10, -1);
    const rows = async () => (await query<Json>(
        `SELECT (SELECT COUNT(*) FROM academics.enrollments)::int e, (SELECT COUNT(*) FROM billing.course_transfers)::int t, (SELECT COUNT(*) FROM billing.credit_ledger)::int l,
                (SELECT COUNT(*) FROM billing.invoices)::int i, (SELECT COUNT(*) FROM audit.compliance_logs)::int c, (SELECT COUNT(*) FROM billing.consumption_reviews)::int r`))[0];
    const before = await rows();
    const request = { ...on(local(0)), review: { ...review0, approvedCredit: 4000, notes: 'Partial' }, feePlan: plan({ installmentCount: 2, applyCredit: 3000 }) };
    const p = await must(transfer(s, a, b, { ...request, dryRun: true }));
    assert.deepEqual(await rows(), before, 'the preview saves nothing');
    assert.equal((await enrollmentOf(s, a.batchId)).status, 'enrolled');
    const { verifiedPaid, consumedAmount, eligibleCredit, existingCredit, approvedCredit, creditApplied, remainingCredit, newCourseFee, payable, oldOutstanding, remainingOutstanding } = p.summary;
    assert.deepEqual([verifiedPaid, consumedAmount, eligibleCredit, existingCredit, approvedCredit, creditApplied, remainingCredit, newCourseFee, payable, oldOutstanding, remainingOutstanding],
        [15000, 10000, 5000, 0, 4000, 3000, 1000, 24000, 21000, 5000, 5000]);
    assert.deepEqual(p.installments.map((x: Json) => x.payable), [10500, 10500]);
    // money arrives between review and confirmation
    await pay(s, { enrollmentId, amount: 1000 });
    const stale = await transfer(s, a, b, { ...request, reviewed: p.summary });
    assert.equal(stale.status, 409);
    assert.match(stale.detail, /changed since it was reviewed/);
    assert.equal((await enrollmentOf(s, a.batchId)).status, 'enrolled');
    const again = await must(transfer(s, a, b, { ...request, dryRun: true }));
    const done = await must(transfer(s, a, b, { ...request, reviewed: again.summary }));
    assert.deepEqual(done.summary, again.summary);
    assert.equal((await enrollmentOf(s, a.batchId)).status, 'transferred');
    assert.equal((await ledger(s)).balance, 1000, 'unused credit stays');
    assert.ok((await transfer(s, a, b, request)).status >= 400, 'cannot be done twice');
    await assertConsistent(s);
});

test('workflow: no, partial and full credit; more credit than the new fee stays in the ledger', async () => {
    for (const [fee, applied, payable, left] of [[24000, 0, 24000, 5000], [24000, 2000, 22000, 3000], [24000, 5000, 19000, 0], [3000, 3000, 0, 2000]]) {
        const [a, b] = [await sessionCourse('session'), await course(fee)];
        const { s } = await attending(a);
        await markDays(a, s, -10, -1);
        for (const bad of [5001, fee + 1]) {
            assert.equal((await transfer(s, a, b, { ...on(local(0)), review: review0, feePlan: plan({ applyCredit: bad }) })).status, 400);
        }
        const t = await must(transfer(s, a, b, { ...on(local(0)), review: review0, feePlan: { paymentMode: 'one_time', firstDueDate: local(0), applyCredit: applied } }));
        assert.deepEqual([t.summary.eligibleCredit, t.summary.approvedCredit, t.summary.creditApplied, t.summary.payable, t.summary.remainingCredit], [5000, 5000, applied, payable, left]);
        assert.equal(await receiptsTotal(s), 15000, 'credit is not a payment');
        assert.equal((await review(t.transferId, review0)).status, 409, 'credit is decided once');
        await assertConsistent(s);
    }
    // approving less than the eligible credit is a manual adjustment
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const { s } = await attending(a);
    await markDays(a, s, -10, -1);
    assert.equal((await transfer(s, a, b, { ...on(local(0)), review: { ...review0, approvedCredit: 0 } })).status, 400, 'reason required');
    const t = await must(transfer(s, a, b, { ...on(local(0)), review: { ...review0, approvedCredit: 0, notes: 'Waived by the guardian' }, feePlan: plan() }));
    assert.deepEqual([t.creditStatus, t.summary.remainingCredit], ['no_credit', 0]);
});

test('workflow: retained dues stay with the old enrollment; a waiver needs Finance and a reason and is no payment', async () => {
    const [a, b] = [await sessionCourse('session'), await course(24000)];
    const keep = await attending(a);
    await markDays(a, keep.s, -10, -1);
    const kept = await must(transfer(keep.s, a, b, { ...on(local(0)), review: review0, feePlan: plan({ applyCredit: 5000 }) }));
    assert.deepEqual([kept.summary.waivedAmount, kept.summary.remainingOutstanding, kept.summary.payable], [0, 5000, 19000], 'not added to the new course, not deducted from credit');
    const [a2, b2] = [await sessionCourse('session'), await course(24000)];
    const { s, enrollmentId } = await attending(a2);
    await markDays(a2, s, -10, -1);
    const waive = { ...on(local(0)), waiveOldOutstanding: true, waiverReason: 'Agreed by the principal' };
    assert.equal((await transfer(s, a2, b2, waive, 'Staff')).status, 403);
    assert.equal((await transfer(s, a2, b2, { ...waive, waiverReason: ' ' })).status, 400);
    const t = await must(transfer(s, a2, b2, { ...waive, review: review0, feePlan: plan({ applyCredit: 5000 }) }));
    assert.deepEqual([t.summary.oldOutstanding, t.summary.waivedAmount, t.summary.remainingOutstanding, t.summary.eligibleCredit], [5000, 5000, 0, 5000]);
    const [inv] = await query<Json>(`SELECT paid_amount::text, balance_amount::text, waived_reason, waived_by_actor_id, waived_at IS NOT NULL AS at FROM billing.invoices WHERE enrollment_id = $1`, [enrollmentId]);
    assert.deepEqual(inv, { paid_amount: '15000.00', balance_amount: '0.00', waived_reason: 'Agreed by the principal', waived_by_actor_id: users.TenantAdmin, at: true });
    assert.equal(await receiptsTotal(s), 15000);
    assert.match(JSON.stringify(await audits('student.course_transferred', s)), /"waivedAmount":\s*5000/);
});

test('workflow: destination, dates and permissions are validated; a refused transfer changes nothing', async () => {
    const [a, b, elsewhere] = [await sessionCourse('session'), await course(24000), await course(9000, undefined, otherBranchId)];
    const { s } = await attending(a);
    await markDays(a, s, -10, -1);
    const refused = async (extra: Json, status: number, to: Course = b, role = 'TenantAdmin') => {
        const r = await transfer(s, a, to, { ...on(local(0)), ...extra }, role);
        assert.equal(r.status, status, r.detail);
        assert.equal((await enrollmentOf(s, a.batchId)).status, 'enrolled');
    };
    await refused({}, 400, elsewhere);
    await refused({ destinationCourseId: a.courseId }, 400);
    await refused(on(local(1)), 400);
    await refused(on(local(-11)), 400);
    await refused({ review: review0 }, 403, b, 'Staff');
    await refused({ feePlan: plan() }, 403, b, 'Staff');
    for (const role of ['Finance', 'Instructor']) await refused({}, 403, b, role);
    await query(`UPDATE academics.batches SET status = 'completed' WHERE batch_id = $1`, [b.batchId]);
    await refused({}, 400);
    await query(`UPDATE academics.batches SET status = 'active' WHERE batch_id = $1`, [b.batchId]);
    await query(`UPDATE academics.courses SET is_active = false WHERE course_id = $1`, [b.courseId]);
    await refused({}, 400);
    await query(`UPDATE academics.courses SET is_active = true WHERE course_id = $1`, [b.courseId]);
    await query(`UPDATE academics.batches SET capacity = 1 WHERE batch_id = $1`, [b.batchId]);
    await student(b.batchId);
    await refused({}, 409);
    await query(`UPDATE academics.batches SET capacity = 20 WHERE batch_id = $1`, [b.batchId]);
    // the plan fails last: credit, waiver and the new enrollment are undone too
    await refused({ review: review0, waiveOldOutstanding: true, waiverReason: 'Test', feePlan: plan({ installmentCount: 30 }) }, 400);
    assert.deepEqual([(await ledger(s)).balance, await enrollmentOf(s, b.batchId)], [0, undefined]);
    const t = await must(transfer(s, a, b, on(local(0)), 'Staff'));
    assert.deepEqual([t.creditStatus, t.feePlanStatus, t.summary.eligibleCredit], ['pending_review', 'pending', null], 'Finance decides later');
});

test('workflow: the new course has its own schedule; partial and excess payments work; other courses are untouched', async () => {
    const [a, b, other] = [await sessionCourse('session'), await course(24000), await course(6000)];
    const { s } = await attending(a);
    await query(`INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status) VALUES ($1, $2, $3, 'enrolled')`, [tenantId, s, other.batchId]);
    await bill(s, other, 2, 1000);
    await markDays(a, s, -10, -1);
    const t = await must(transfer(s, a, b, { ...on(local(0)), review: review0, feePlan: {
        paymentMode: 'installment', frequency: 'custom', installmentCount: 3, applyCredit: 5000,
        installments: [{ dueDate: local(1), amount: 9000 }, { dueDate: local(20), amount: 6000 }, { dueDate: local(60), amount: 4000 }],
    } }));
    assert.equal(t.feePlan.installments.reduce((sum: number, i: Json) => sum + i.payable, 0), t.summary.payable);
    await pay(s, { invoiceId: t.feePlan.installments[0].invoiceId, amount: 8000 });
    assert.deepEqual(courseOf(await breakdown(s), b).installments.map((x: Json) => x.balanceAmount), [0, 6500, 4500]);
    await pay(s, { invoiceId: t.feePlan.installments[1].invoiceId, amount: 7500 });
    assert.deepEqual(courseOf(await breakdown(s), b).installments.map((x: Json) => x.balanceAmount), [0, 0, 3500]);
    assert.deepEqual([courseOf(await breakdown(s), a).balanceAmount, courseOf(await breakdown(s), other).balanceAmount], [5000, 5000]);
    const [st] = await query<Json>(`SELECT COUNT(*)::int n FROM academics.students WHERE student_id = $1`, [s]);
    assert.equal(st.n, 1, 'same student');
    await assertConsistent(s);
});
