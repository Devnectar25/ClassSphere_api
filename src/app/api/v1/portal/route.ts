import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { authorize, type RequestContext } from '@/lib/api/context';
import { can } from '@/lib/auth';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Parent & Student Self-Service Portal API
 * Traceability: TDD Section 8, 9; FRD Parent & Student Portal
 *
 * Guardians see their own household (resolved from their signed-in user). Staff with portal access
 * may preview any household of their academy with ?guardianId=…
 */
interface Household {
    guardianId: string;
    wards: Array<{ id: string; preferredName: string; invoices: Array<{ id: string; balance: number }> }>;
}

// Guardians, or staff allowed to preview the portal
async function authorizePortal(req: NextRequest) {
    const context = await authorize(req, null);
    if (context instanceof Response || context.actorRole === 'Guardian' || context.isPlatformAdmin || can(context.actorRole, 'portal.read')) {
        return context;
    }
    return await authorize(req, 'portal.read');
}

async function loadHousehold(context: RequestContext, guardianId: string | null) {
    if (context.actorRole === 'Guardian') {
        return callFn<Household>('reporting.fn_guardian_household', context.tenantId, null, context.actorId);
    }
    try {
        return await callFn<Household>('reporting.fn_guardian_household', context.tenantId, guardianId, null);
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

            return {
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
                        balance: 0,
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
                                id: 'inv-1',
                                invoiceNumber: 'INV-DEMO-001',
                                billingPeriod: 'Current Month',
                                designation: 'Monthly Tuition Fee',
                                subtitle: 'Paid',
                                amount: 2500,
                                balance: 0,
                                paymentMethod: 'UPI',
                                status: 'settled',
                                receiptNumber: 'REC-DEMO-001'
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
                                designation: 'Monthly Tuition Fee',
                                billingPeriod: 'Current Month'
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
        }
        throw err;
    }
}

export async function GET(req: NextRequest) {
    const context = await authorizePortal(req);
    if (context instanceof Response) return context;
    try {
        return ok(context, await loadHousehold(context, req.nextUrl.searchParams.get('guardianId')));
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
            case 'pay_invoice': {
                const invoice = ward.invoices.find(inv => inv.id === body.invoiceId);
                if (!invoice) {
                    return problem(context, req, 404, 'Not Found', 'Invoice not found for this ward.');
                }
                if (invoice.balance <= 0) {
                    return problem(context, req, 400, 'Validation Error', 'This invoice is already settled.');
                }
                const result = await callFn<{ receiptNumber: string; amountPaid: number }>('billing.fn_payment_post',
                    context.tenantId, invoice.id, invoice.balance, body.paymentMethod || 'Card',
                    null, null, context.idempotencyKey || null, context.actorId);
                return ok(context, {
                    message: `Payment of ${result.amountPaid.toFixed(2)} settled successfully. Receipt ${result.receiptNumber} generated.`,
                    ...result,
                });
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
