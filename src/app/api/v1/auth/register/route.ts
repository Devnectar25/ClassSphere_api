import { NextRequest, NextResponse } from 'next/server';
import { callFn } from '@/lib/db/db';
import { ACADEMY_TYPES, hashPassword } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser, issueSession } from '@/lib/api/session';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Self-service sign-up: a new academy owner creates their workspace and is signed in as its admin.
 * Public (no session). An email that already has a sign-in is refused with 409.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const academyName = String(body.academyName ?? '').trim();
        const firstName = String(body.firstName ?? '').trim();
        const lastName = String(body.lastName ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        const rawPhone = String(body.phone ?? '').trim();
        const countryCode = String(body.countryCode ?? '+91').trim();
        const { academyType, planTier, password, acceptTerms } = body;

        if (!academyName || !firstName || !lastName || !email || !rawPhone || !password) {
            return fail(400, 'Validation Error', 'Please fill in all required fields.');
        }
        if (academyName.length < 2) {
            return fail(400, 'Validation Error', 'Academy name must be at least 2 characters.');
        }
        if (!/^[a-zA-Z\s'-]+$/.test(firstName)) {
            return fail(400, 'Validation Error', 'First name can only contain letters.');
        }
        if (!/^[a-zA-Z\s'-]+$/.test(lastName)) {
            return fail(400, 'Validation Error', 'Last name can only contain letters.');
        }
        if (!EMAIL.test(email)) {
            return fail(400, 'Validation Error', 'Enter a valid email address.');
        }

        // Extract local digits by removing country code prefix if present
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
                return fail(400, 'Validation Error', 'Enter a valid 10-digit mobile number starting with 6, 7, 8, or 9.');
            }
        } else {
            if (phoneDigits.length < 7 || phoneDigits.length > 15) {
                return fail(400, 'Validation Error', 'Enter a valid mobile number for the selected country.');
            }
        }

        const formattedPhone = `${countryCode} ${phoneDigits}`.trim();
        if (String(password).length < 8) {
            return fail(400, 'Validation Error', 'Password must be at least 8 characters.');
        }
        if (!/[a-zA-Z]/.test(String(password)) || !/[0-9]/.test(String(password))) {
            return fail(400, 'Validation Error', 'Password must include at least one letter and one number.');
        }
        if (!ACADEMY_TYPES.includes(academyType)) {
            return fail(400, 'Validation Error', `Class category must be one of: ${ACADEMY_TYPES.join(', ')}.`);
        }
        if (acceptTerms !== true) {
            return fail(400, 'Validation Error', 'Please accept the Terms of Service and Privacy Policy.');
        }

        const result = await callFn<{ tenantId: string }>('tenant.fn_tenant_register',
            academyName, academyType, planTier || null, `${firstName} ${lastName}`, email, formattedPhone, hashPassword(String(password)));

        // Sign the new owner straight into their academy
        const user = await findUser(email, null);
        const session = user && await issueSession(user, result.tenantId);
        if (!session) return fail(500, 'Internal Server Error', 'Your academy was created. Please sign in to continue.');

        return NextResponse.json({ success: true, data: session, correlationId }, { status: 201 });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        const pg = err as { code?: string; message?: string };
        if (pg.code === '23505') return fail(409, 'Conflict', pg.message ?? 'An account with this email already exists.');
        if (pg.code === '22023') return fail(400, 'Validation Error', pg.message ?? 'Invalid sign-up details.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}
