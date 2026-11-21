import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { callFn } from '@/lib/db/db';
import { ACADEMY_TYPES, hashPassword } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser, issueSession } from '@/lib/api/session';

const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const NAME = /^[a-zA-Z]+(?:[ '.-][a-zA-Z]*)*$/;
const ACADEMY_NAME = /^[a-zA-Z][a-zA-Z &'.,()\-/]*$/;

/** Indian numbers (optionally +91 / 91 / 0 prefixed): 10 digits starting 6–9. Other +country numbers: 7–15 digits. */
function isValidMobile(phone: string) {
    if (!/^\+?[\d\s\-()]+$/.test(phone)) return false;
    const digits = phone.replace(/\D/g, '');
    const international = phone.startsWith('+');
    if (!international || digits.startsWith('91')) {
        let national = digits;
        if (international || (digits.length === 12 && digits.startsWith('91'))) national = digits.slice(2);
        else if (digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
        return /^[6-9]\d{9}$/.test(national) && !/^(\d)\1{9}$/.test(national);
    }
    return digits.length >= 7 && digits.length <= 15;
}

function passwordProblem(password: string): string | null {
    if (password.length < 8 || password.length > 64) return 'Password must be 8 to 64 characters.';
    if (/\s/.test(password)) return 'Password cannot contain spaces.';
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9\s]/.test(password)) {
        return 'Password must include an uppercase letter, a lowercase letter, a number and a special character.';
    }
    return null;
}

/**
 * Self-service sign-up: a new academy owner creates their workspace and is signed in as its admin.
 * Public (no session). Email is optional (mobile-only owners sign in with their mobile number).
 * An email or mobile number that already has a sign-in is refused with 409.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const tidy = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');
        const academyName = tidy(body.academyName);
        const firstName = tidy(body.firstName);
        const lastName = tidy(body.lastName);
        const email = String(body.email ?? '').trim().toLowerCase();
        const phone = String(body.phone ?? '').trim();
        const country = tidy(body.country) || 'India';
        const state = tidy(body.state);
        const city = tidy(body.city);
        const address = tidy(body.address);
        const location = tidy(body.location);
        const { academyType, planTier, acceptTerms, gatewayPaymentId, gatewayOrderId, gatewaySignature } = body;
        const password = typeof body.password === 'string' ? body.password : '';

        // If Razorpay payment details are provided, verify signature
        const rzpSecret = process.env.RAZORPAY_KEY_SECRET;
        if (rzpSecret && gatewayOrderId && gatewayPaymentId && gatewaySignature) {
            const expectedSig = crypto
                .createHmac('sha256', rzpSecret)
                .update(`${gatewayOrderId}|${gatewayPaymentId}`)
                .digest('hex');
            if (expectedSig !== gatewaySignature) {
                return fail(400, 'Payment Verification Failed', 'Invalid Razorpay payment signature.');
            }
        }

        if (!academyName || !firstName || !lastName || !email || !phone || !password) {
            return fail(400, 'Validation Error', 'Please fill in all required fields (including email address).');
        }
        if (academyName.length < 3 || academyName.length > 100 || !ACADEMY_NAME.test(academyName)) {
            return fail(400, 'Validation Error', "Academy name must be 3 to 100 characters, starting with a letter, using letters, spaces and & ' . , ( ) - / only (no numbers).");
        }
        if (firstName.length < 2 || firstName.length > 50 || !NAME.test(firstName)) {
            return fail(400, 'Validation Error', 'First name must be 2 to 50 letters (spaces, apostrophes, hyphens and dots allowed).');
        }
        if (lastName.length > 50 || !NAME.test(lastName)) {
            return fail(400, 'Validation Error', 'Last name must be up to 50 letters (spaces, apostrophes, hyphens and dots allowed).');
        }
        if (!email || email.length > 254 || email.split('@')[0].length > 64 || /\.\./.test(email) || !EMAIL.test(email)) {
            return fail(400, 'Validation Error', 'Enter a valid email address.');
        }
        if (!isValidMobile(phone)) {
            return fail(400, 'Validation Error', 'Enter a valid mobile number (10 digits starting 6–9, or with a country code).');
        }
        const pwProblem = passwordProblem(password);
        if (pwProblem) return fail(400, 'Validation Error', pwProblem);
        const isKnownType = ACADEMY_TYPES.includes(academyType);
        const isValidCustomType = typeof academyType === 'string' &&
            academyType.trim().length >= 2 &&
            academyType.trim().length <= 50 &&
            !/\d/.test(academyType) &&
            ACADEMY_NAME.test(academyType.trim());
        if (!isKnownType && !isValidCustomType) {
            return fail(400, 'Validation Error', 'Class category name must be 2 to 50 characters and cannot contain numbers.');
        }
        if (acceptTerms !== true) {
            return fail(400, 'Validation Error', 'Please accept the Terms of Service and Privacy Policy.');
        }

        const result = await callFn<{ tenantId: string; adminUserId: string }>('tenant.fn_tenant_register',
            academyName, academyType, planTier || null, `${firstName} ${lastName}`, email || null, phone, hashPassword(String(password)),
            country, state || null, city || null, address || null, location || null);

        // Sign the new owner straight into their academy
        const user = await findUser(null, result.adminUserId);
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
