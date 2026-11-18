import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser } from '@/lib/api/session';

/**
 * Sign-up availability check: is this mobile number / email already linked to a sign-in?
 * Public (no session). Lets the sign-up form refuse a duplicate before the OTP step;
 * tenant.fn_tenant_register enforces the same rule again on create.
 * Mobile numbers are compared on their last 10 digits (same rule as sign-in).
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const phone = String(body.phone ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        if (!phone && !email) return fail(400, 'Validation Error', 'Provide a mobile number or an email address.');

        const phoneDigits = phone.replace(/\D/g, '');
        const [phoneUser, emailUser] = await Promise.all([
            phoneDigits.length >= 10 ? findUser(phoneDigits, null) : null,
            email.includes('@') ? findUser(email, null) : null,
        ]);

        return NextResponse.json({
            success: true,
            data: { phoneTaken: Boolean(phoneUser), emailTaken: Boolean(emailUser) },
            correlationId,
        });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}
