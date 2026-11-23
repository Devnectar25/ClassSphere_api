import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { query } from '@/lib/db/db';

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

        const phoneDigits = phone.replace(/\D/g, '').slice(-10);
        let phoneTaken = false;
        let emailTaken = false;

        const checks: Promise<void>[] = [];

        if (phoneDigits.length === 10) {
            checks.push((async () => {
                const rows = await query<{ user_id: string }>(
                    `SELECT user_id FROM identity_app.users 
                     WHERE phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 
                     LIMIT 1`,
                    [phoneDigits]
                );
                phoneTaken = rows.length > 0;
            })());
        }

        if (email.includes('@')) {
            checks.push((async () => {
                const rows = await query<{ user_id: string }>(
                    `SELECT user_id FROM identity_app.users 
                     WHERE email IS NOT NULL AND lower(email) = lower($1) 
                     LIMIT 1`,
                    [email]
                );
                emailTaken = rows.length > 0;
            })());
        }

        await Promise.all(checks);

        return NextResponse.json({
            success: true,
            data: { phoneTaken, emailTaken },
            correlationId,
        });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}
