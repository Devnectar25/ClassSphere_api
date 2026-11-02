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
function authorizePortal(req: NextRequest) {
    const context = authorize(req, null);
    if (context instanceof Response || context.actorRole === 'Guardian' || context.isPlatformAdmin || can(context.actorRole, 'portal.read')) {
        return context;
    }
    return authorize(req, 'portal.read');
}

function loadHousehold(context: RequestContext, guardianId: string | null) {
    return context.actorRole === 'Guardian'
        ? callFn<Household>('reporting.fn_guardian_household', context.tenantId, null, context.actorId)
        : callFn<Household>('reporting.fn_guardian_household', context.tenantId, guardianId, null);
}

export async function GET(req: NextRequest) {
    const context = authorizePortal(req);
    if (context instanceof Response) return context;
    try {
        return ok(context, await loadHousehold(context, req.nextUrl.searchParams.get('guardianId')));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = authorizePortal(req);
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
