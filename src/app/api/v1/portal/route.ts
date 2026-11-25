import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize, type RequestContext } from '@/lib/api/context';
import { can } from '@/lib/auth';
import { ok, fail, problem } from '@/lib/api/respond';
import { staffScope, studentIdsInScope } from '@/lib/api/scope';
import { scheduledTests } from '@/lib/portal-tests';
import {
    getStudentCourseFeeBreakdown,
    captureFeePaymentOrder,
    checkFeePaymentOrder,
    createFeePaymentOrder,
    declareManualPayment,
    failFeePaymentOrder,
    reconcileFeePaymentOrders,
    type StudentCourseBreakdown
} from '@/lib/billing/fee-installments';

/**
 * Parent & Student Self-Service Portal API
 * Traceability: TDD Section 8, 9; FRD Parent & Student Portal
 *
 * Guardians see their own household (resolved from their signed-in user). Staff with portal access
 * may preview any household of their academy with ?guardianId=…
 */
interface Household {
    guardianId: string;
    householdId?: string;
    academicSession?: string;
    guardianName?: string;
    guardianEmail?: string;
    organizationName?: string;
    academyType?: string;
    currency?: string;
    logoUrl?: string | null;
    notices?: Array<any>;
    achievementBoard?: Array<any>;
    wards: Array<{
        id: string;
        name: string;
        preferredName: string;
        balance: number;
        creditBalance?: number;
        enrollmentNumber?: string;
        courses?: StudentCourseBreakdown[];
        invoices: Array<{
            id: string;
            invoiceNumber: string;
            billingPeriod?: string;
            designation: string;
            subtitle?: string;
            amount: number;
            balance: number;
            status: string;
            overdue_status?: string;
            late_fee_amount?: number;
            days_overdue?: number;
            receipt_number?: string;
            payment_method?: string;
        }>;
        payments: Array<{
            paymentId: string;
            receiptNumber: string;
            paidAt: string;
            amount: number;
            paymentMethod: string;
            reference: string;
            status: string;
            invoiceNumber?: string;
            designation?: string;
        }>;
        [key: string]: any;
    }>;
}

// Guardians, or staff allowed to preview the portal
async function authorizePortal(req: NextRequest) {
    const context = await authorize(req, null);
    if (context instanceof Response || context.actorRole === 'Guardian' || context.isPlatformAdmin || can(context.actorRole, 'portal.read')) {
        return context;
    }
    return await authorize(req, 'portal.read');
}

async function loadHousehold(context: RequestContext, guardianId: string | null): Promise<Household> {
    let household: Household;
    // Staff preview only households of the students in their batches; with none, the sample household
    const students = await studentIdsInScope(context);
    if (students && !guardianId) {
        const [own] = await query<{ guardian_id: string }>(
            `SELECT l.guardian_id FROM academics.student_guardian_links l JOIN academics.guardians g ON g.guardian_id = l.guardian_id
             WHERE g.tenant_id = $1 AND l.student_id = ANY($2::uuid[]) ORDER BY g.user_id IS NULL, g.last_name, g.first_name LIMIT 1`, [context.tenantId, [...students]]);
        guardianId = own?.guardian_id ?? '00000000-0000-0000-0000-000000000000';
    }

    if (context.actorRole === 'Guardian') {
        household = await callFn<Household>('reporting.fn_guardian_household', context.tenantId, null, context.actorId);
    } else {
        try {
            household = await callFn<Household>('reporting.fn_guardian_household', context.tenantId, guardianId, null);
        } catch (err) {
            const msg = (err as Error)?.message ?? '';
            if (msg.includes('Guardian household not found')) {
                // Staff preview mode in an academy without any guardians registered yet
                const org = await callFn<{ organization: { name: string; currency: string; academyType: string; branding: { logoUrl: string | null } } } | null>(
                    'tenant.fn_tenant_get', context.tenantId, context.actorId
                ).catch(() => null);

                const orgName = org?.organization?.name ?? 'Academy';
                const currency = org?.organization?.currency ?? 'INR';
                const academyType = org?.organization?.academyType ?? 'General';
                const logoUrl = org?.organization?.branding?.logoUrl ?? null;

                household = {
                    guardianId: 'preview-mode',
                    householdId: 'PREVIEW',
                    academicSession: 'Current Academic Session',
                    guardianName: `${context.actorRole} Preview`,
                    guardianEmail: '',
                    organizationName: orgName,
                    academyType,
                    currency,
                    logoUrl,
                    notices: [
                        {
                            noticeId: 'demo-n1',
                            title: `Welcome to ${orgName} Parent Portal`,
                            content: 'This is a live preview of how notices, circulars, and announcements appear to parents and guardians.',
                            priority: 'normal',
                            publishedAt: new Date().toISOString(),
                            isPinned: true,
                            branchName: 'All Branches'
                        }
                    ],
                    achievementBoard: [],
                    wards: [
                        {
                            id: 'demo-ward-1',
                            name: 'Sample Student',
                            preferredName: 'Sample',
                            division: 'Main Division',
                            track: `${academyType} Track`,
                            matriculationYear: new Date().getFullYear().toString(),
                            standing: 'Good Standing',
                            branchName: 'Main Branch',
                            enrolledUnits: '2 Units',
                            enrolledSubjects: 'Foundation, Core',
                            practiceHours: 12,
                            practiceCohortDiff: '+10% vs. Cohort Average',
                            practiceStreakDays: 4,
                            practiceSuite: { room: 'Studio 1', schedule: 'Regular Schedule' },
                            weeklyPractice: [
                                { day: 'Monday', shortDay: 'M', hours: 2 },
                                { day: 'Tuesday', shortDay: 'T', hours: 2.5 },
                                { day: 'Wednesday', shortDay: 'W', hours: 2 },
                                { day: 'Thursday', shortDay: 'T', hours: 1.5 },
                                { day: 'Friday', shortDay: 'F', hours: 3 },
                                { day: 'Saturday', shortDay: 'S', hours: 1 },
                                { day: 'Sunday', shortDay: 'S', hours: 0 },
                            ],
                            balance: 2500,
                            nextDraftAmount: 2500,
                            nextDraftDate: '1st of Next Month',
                            paymentMethod: 'UPI / Online Card',
                            attendanceRate: 95,
                            sessionsCompleted: 19,
                            sessionsTotal: 20,
                            excusedAbsences: 1,
                            absenceNote: '1 excused absence on record',
                            nextClassTime: 'Upcoming Session',
                            primaryMentor: {
                                name: 'Lead Instructor',
                                title: 'Senior Faculty',
                                office: 'Faculty Room',
                                distinction: 'Faculty Lead',
                                email: null,
                            },
                            featuredEvent: null,
                            timetable: [
                                { id: 'tt-1', day: 'Mon', dateNum: 1, time: '10:00 AM – 11:30 AM', studio: 'Studio 1', subject: 'Core Session', faculty: 'Lead Instructor', type: 'Regular' },
                                { id: 'tt-2', day: 'Wed', dateNum: 3, time: '10:00 AM – 11:30 AM', studio: 'Studio 1', subject: 'Practice Lab', faculty: 'Lead Instructor', type: 'Lab' },
                            ],
                            distinctions: [],
                            invoices: [
                                {
                                    id: 'inv-demo-1',
                                    invoiceNumber: 'INV-DEMO-001',
                                    billingPeriod: 'Current Month',
                                    designation: 'Installment 1 of 2: Core Subject Tuition',
                                    subtitle: 'Paid',
                                    amount: 2500,
                                    balance: 0,
                                    payment_method: 'UPI',
                                    status: 'settled',
                                    receipt_number: 'REC-DEMO-001'
                                },
                                {
                                    id: 'inv-demo-2',
                                    invoiceNumber: 'INV-DEMO-002',
                                    billingPeriod: 'Next Month',
                                    designation: 'Installment 2 of 2: Core Subject Tuition',
                                    subtitle: 'Due next month',
                                    amount: 2500,
                                    balance: 2500,
                                    payment_method: 'Pending Online Checkout',
                                    status: 'pending',
                                    receipt_number: ''
                                }
                            ],
                            payments: [
                                {
                                    paymentId: 'pay-1',
                                    receiptNumber: 'REC-DEMO-001',
                                    paidAt: new Date().toISOString(),
                                    amount: 2500,
                                    paymentMethod: 'UPI',
                                    reference: 'DEMO-TXN-001',
                                    status: 'completed',
                                    invoiceNumber: 'INV-DEMO-001',
                                    designation: 'Installment 1 of 2: Core Subject Tuition'
                                }
                            ],
                            attendanceHistory: [
                                { date: new Date().toISOString().slice(0, 10), batch: 'Batch A', status: 'present', remarks: 'Present and engaged' },
                                { date: new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10), batch: 'Batch A', status: 'present', remarks: 'On time' },
                                { date: new Date(Date.now() - 86400000 * 5).toISOString().slice(0, 10), batch: 'Batch A', status: 'excused', remarks: 'Approved absence' },
                            ],
                            testResults: [
                                {
                                    test: { testId: 't-1', title: 'Periodic Assessment', testType: 'Class Test', testDate: new Date().toISOString().slice(0, 10), batchName: 'Batch A', courseTitle: 'Core Subject' },
                                    subjects: [{ subjectId: 's-1', name: 'Core Subject', maxMarks: 100 }],
                                    maxTotal: 100,
                                    summary: { classSize: 20, averagePercentage: 80, highestPercentage: 98 },
                                    result: {
                                        total: 92,
                                        percentage: 92,
                                        grade: 'A+',
                                        rank: 2,
                                        marks: { 's-1': { marks: 92, absent: false, grade: 'A+', remarks: 'Excellent' } }
                                    }
                                }
                            ]
                        }
                    ],
                } as unknown as Household;
            } else {
                throw err;
            }
        }
    }

    if (students && household.guardianId !== 'preview-mode') {
        household.wards = household.wards.filter(w => students.has(w.id));
        if (household.wards.length === 0) throw Object.assign(new Error('This household has no student in a batch assigned to you.'), { code: '42501' });
    }
    const scope = await staffScope(context);

    // Enrich wards with structured course fee breakdowns
    if (household && Array.isArray(household.wards)) {
        for (const ward of household.wards) {
            if (ward.id && ward.id !== 'demo-ward-1') {
                try {
                    const breakdown = await getStudentCourseFeeBreakdown(context.tenantId, ward.id);
                    ward.courses = scope ? breakdown.courses.filter(c => c.batchId && scope.batchIds.includes(c.batchId)) : breakdown.courses;
                    ward.balance = scope ? ward.courses.reduce((t, c) => t + c.balanceAmount, 0) : breakdown.totalBalance;
                    ward.creditBalance = breakdown.creditBalance;
                    ward.enrollmentNumber = breakdown.student.enrollmentNumber;
                    ward.academy = breakdown.academy;
                    // Same receipts as the Finance panel, from the payment records
                    ward.payments = ward.courses.flatMap(c => c.payments)
                        .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());
                    ward.enrollmentNumber = breakdown.student.enrollmentNumber;
                } catch (e) {
                    console.warn(`[Portal] Could not load course breakdown for ward ${ward.id}:`, (e as Error).message);
                }
            } else if (ward.id === 'demo-ward-1') {
                ward.courses = [
                    {
                        enrollmentId: null,
                        enrollmentStatus: null,
                        courseId: 'demo-c1',
                        courseTitle: 'Core Subject & Practice',
                        courseCode: 'CORE-101',
                        batchName: 'Batch A',
                        branchName: 'Main Branch',
                        totalFee: 5000,
                        paidAmount: 2500,
                        balanceAmount: 2500,
                        creditApplied: 0,
                        pendingVerification: 0,
                        feePlan: null,
                        feePlanPending: false,
                        reviewOutstanding: 0,
                        advanceCredit: 0,
                        status: 'partially_paid',
                        isFullyPaid: false,
                        finalInvoiceNumber: 'FINAL-INV-CORE101-DEMO',
                        installments: [
                            {
                                invoiceId: 'inv-demo-1',
                                invoiceNumber: 'INV-DEMO-001',
                                installmentNumber: 1,
                                designation: 'Installment 1 of 2: Core Subject Tuition',
                                dueDate: new Date().toISOString().slice(0, 10),
                                amount: 2500,
                                originalAmount: 2500,
                                creditApplied: 0,
                                carriedForward: 0,
                                scheduledAmount: 2500,
                                scheduledDueDate: new Date().toISOString().slice(0, 10),
                                carriedOutstanding: 0,
                                carriedIn: 0,
                                carriedOut: 0,
                                scheduleAdjustment: 0,
                                issuedAt: new Date().toISOString(),
                                failedAttempt: null,
                                pendingVerification: 0,
                                paidAmount: 2500,
                                balanceAmount: 0,
                                status: 'paid',
                                lateFeeAmount: 0,
                                daysOverdue: 0,
                                receiptNumber: 'REC-DEMO-001',
                                paymentMethod: 'UPI',
                                payments: [{ paymentId: 'pay-1', amount: 2500, receiptNumber: 'REC-DEMO-001', paymentMethod: 'UPI', reference: 'DEMO-TXN-001', status: 'posted', createdAt: new Date().toISOString(), recordedBy: null }]
                            },
                            {
                                invoiceId: 'inv-demo-2',
                                invoiceNumber: 'INV-DEMO-002',
                                installmentNumber: 2,
                                designation: 'Installment 2 of 2: Core Subject Tuition',
                                dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
                                amount: 2500,
                                originalAmount: 2500,
                                creditApplied: 0,
                                carriedForward: 0,
                                scheduledAmount: 2500,
                                scheduledDueDate: new Date().toISOString().slice(0, 10),
                                carriedOutstanding: 0,
                                carriedIn: 0,
                                carriedOut: 0,
                                scheduleAdjustment: 0,
                                issuedAt: new Date().toISOString(),
                                failedAttempt: null,
                                pendingVerification: 0,
                                paidAmount: 0,
                                balanceAmount: 2500,
                                status: 'pending',
                                lateFeeAmount: 0,
                                daysOverdue: 0,
                                payments: []
                            }
                        ],
                        payments: [
                            {
                                paymentId: 'pay-1',
                                receiptNumber: 'REC-DEMO-001',
                                amount: 2500,
                                paymentMethod: 'UPI',
                                reference: 'DEMO-TXN-001',
                                status: 'posted',
                                paidAt: new Date().toISOString(),
                                invoiceNumber: 'INV-DEMO-001',
                                designation: 'Installment 1 of 2: Core Subject Tuition',
                                recordedBy: null
                            }
                        ]
                    }
                ];
                ward.balance = 2500;
            }
        }
    }

    return household;
}

export async function GET(req: NextRequest) {
    const context = await authorizePortal(req);
    if (context instanceof Response) return context;
    try {
        const household = await loadHousehold(context, req.nextUrl.searchParams.get('guardianId'));
        const tests = await scheduledTests(context.tenantId, household.wards.map(w => w.id).filter(id => id !== 'demo-ward-1'));
        for (const ward of household.wards) ward.scheduledTests = tests.get(ward.id) ?? [];
        return ok(context, household);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorizePortal(req);
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { action, wardId } = body;
        const household = await loadHousehold(context, body.guardianId || null);
        const ward = household.wards.find(w => w.id === wardId);
        if (!ward) {
            return problem(context, req, 404, 'Not Found', 'Ward not found in this household.');
        }
        const args = [context.tenantId, household.guardianId, ward.id] as const;

        switch (action) {
            case 'submit_practice_log': {
                const hours = Number(body.hours);
                const result = await callFn<{ totalHours: number }>('engagement.fn_practice_log_create',
                    ...args, body.date || null, hours, body.piece || null, body.notes || null, context.actorId);
                return ok(context, { message: `Practice session of ${hours} hrs logged for ${ward.preferredName}!`, ...result });
            }
            case 'request_absence': {
                if (!body.date || !body.reason) {
                    return problem(context, req, 400, 'Validation Error', 'date and reason are required.');
                }
                const result = await callFn('academics.fn_absence_request_create',
                    ...args, body.date, body.reason, Boolean(body.makeupRequested), context.actorId);
                return ok(context, { message: `Absence request for ${ward.preferredName} on ${body.date} submitted to registrar.`, result });
            }

            // Create Razorpay payment order for online payment; the amount is checked against the course dues
            case 'create_payment_order': {
                return ok(context, await createFeePaymentOrder({
                    tenantId: context.tenantId,
                    studentId: ward.id,
                    enrollmentId: body.enrollmentId || null,
                    invoiceId: body.invoiceId || null,
                    amount: Number(body.amount),
                    currency: household.currency || 'INR',
                    actorId: context.actorId,
                }));
            }

            // Polled while the checkout (QR) is open; without an order, recent attempts are checked once
            case 'payment_status': {
                const scope = { tenantId: context.tenantId, studentId: ward.id };
                if (!body.razorpayOrderId) return ok(context, { settled: await reconcileFeePaymentOrders(scope) });
                const { status, result } = await checkFeePaymentOrder({ ...scope, orderId: String(body.razorpayOrderId) });
                return ok(context, { status, message: result?.message ?? null });
            }

            case 'payment_failed': {
                await failFeePaymentOrder({
                    orderId: String(body.razorpayOrderId || ''),
                    reason: String(body.reason || 'Payment failed'),
                    portal: { tenantId: context.tenantId, studentId: ward.id },
                });
                return ok(context, { recorded: true });
            }

            // Online payments settle only through a captured gateway order; the stored order decides course and amount.
            // Bank / counter payments are declarations that Finance verifies.
            case 'pay_installment':
            case 'pay_invoice':
            case 'clear_course_balance': {
                if (body.razorpayOrderId && body.razorpayPaymentId) {
                    const result = await captureFeePaymentOrder({
                        orderId: String(body.razorpayOrderId),
                        paymentId: String(body.razorpayPaymentId),
                        paymentMethod: 'Razorpay',
                        portal: { tenantId: context.tenantId, studentId: ward.id, signature: String(body.razorpaySignature || '') },
                    });
                    if (!result) return problem(context, req, 404, 'Not Found', 'Payment order not found.');
                    return ok(context, result);
                }

                if (body.paymentMethod !== 'BankWire') {
                    return problem(context, req, 400, 'Validation Error', 'Online payments must be completed through the payment gateway.');
                }
                return ok(context, await declareManualPayment({
                    tenantId: context.tenantId,
                    studentId: ward.id,
                    enrollmentId: body.enrollmentId || null,
                    invoiceId: body.invoiceId || null,
                    amount: Number(body.amount),
                    paymentMethod: 'BankWire',
                    paymentReference: body.paymentReference ? String(body.paymentReference).trim() : undefined,
                    idempotencyKey: context.idempotencyKey,
                    actorId: context.actorId,
                }));
            }

            case 'claim_seats': {
                const result = await callFn<{ guaranteedSeats: number; title: string }>('engagement.fn_event_seats_claim',
                    ...args, body.eventId, context.actorId);
                return ok(context, { message: `${result.guaranteedSeats} patron seats claimed for ${result.title}.`, ...result });
            }
            case 'book_advisory': {
                if (!body.slotDate || !body.topic) {
                    return problem(context, req, 400, 'Validation Error', 'slotDate and topic are required.');
                }
                const result = await callFn<{ mentorName: string }>('engagement.fn_advisory_book',
                    ...args, body.slotDate, body.topic, context.actorId);
                return ok(context, {
                    message: `Advisory consultation with ${result.mentorName} requested for ${body.slotDate}. Topic: "${body.topic}".`,
                    ...result,
                });
            }
            default:
                return problem(context, req, 400, 'Validation Error', `Unrecognized action '${action}'.`);
        }
    } catch (err) {
        return fail(err, context, req);
    }
}
