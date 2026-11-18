import { NextRequest, NextResponse } from 'next/server';
import { callFn } from '@/lib/db/db';
import { hashPassword } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser, issueSession } from '@/lib/api/session';

const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const NAME = /^[a-zA-Z]+(?:[ '.-][a-zA-Z]*)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIONSHIPS = ['Parent', 'Mother', 'Father', 'Guardian'];

function isValidMobile(phone: string) {
    return /^[6-9]\d{9}$/.test(phone) && !/^(\d)\1{9}$/.test(phone);
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
 * Self-service registration for a Student or Parent / Guardian into an existing active academy.
 * Public (no session). Returns a live session ready for /portal.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const tidy = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');
        const role = String(body.role ?? '').trim().toLowerCase();
        const tenantId = String(body.tenantId ?? '').trim();
        const firstName = tidy(body.firstName);
        const lastName = tidy(body.lastName);
        const email = String(body.email ?? '').trim().toLowerCase();
        const phone = String(body.phone ?? '').replace(/\D/g, '');
        const password = typeof body.password === 'string' ? body.password : '';
        const acceptTerms = body.acceptTerms;
        const childFirstName = role === 'parent' ? tidy(body.childFirstName) : firstName;
        const childLastName = role === 'parent' ? tidy(body.childLastName) : lastName;
        const relationship = role === 'parent' ? tidy(body.relationship || 'Parent') : 'Self';

        if (role !== 'student' && role !== 'parent') {
            return fail(400, 'Validation Error', 'Role must be either student or parent.');
        }
        if (!UUID.test(tenantId)) {
            return fail(400, 'Validation Error', 'Please select your academy.');
        }
        if (!firstName || firstName.length < 2 || firstName.length > 50 || !NAME.test(firstName)) {
            return fail(400, 'Validation Error', 'First name must be 2 to 50 letters.');
        }
        if (!lastName || lastName.length > 50 || !NAME.test(lastName)) {
            return fail(400, 'Validation Error', 'Last name must be up to 50 letters.');
        }
        if (role === 'parent') {
            if (!childFirstName || childFirstName.length < 2 || childFirstName.length > 50 || !NAME.test(childFirstName)) {
                return fail(400, 'Validation Error', "Child's first name must be 2 to 50 letters.");
            }
            if (!childLastName || childLastName.length > 50 || !NAME.test(childLastName)) {
                return fail(400, 'Validation Error', "Child's last name must be up to 50 letters.");
            }
            if (!RELATIONSHIPS.includes(relationship)) {
                return fail(400, 'Validation Error', 'Please select a valid relationship.');
            }
        }
        if (email && (email.length > 254 || email.split('@')[0].length > 64 || /\.\./.test(email) || !EMAIL.test(email))) {
            return fail(400, 'Validation Error', 'Enter a valid email address.');
        }
        if (!isValidMobile(phone)) {
            return fail(400, 'Validation Error', 'Enter a valid 10-digit mobile number starting with 6–9.');
        }
        const pwErr = passwordProblem(password);
        if (pwErr) return fail(400, 'Validation Error', pwErr);
        if (acceptTerms !== true) {
            return fail(400, 'Validation Error', 'Please accept the Terms of Service and Privacy Policy.');
        }

        const result = await callFn<{ tenantId: string; userId: string; guardianId: string; studentId: string; enrollmentNumber: string }>(
            'tenant.fn_portal_register',
            tenantId,
            role,
            firstName,
            lastName,
            email || null,
            phone,
            hashPassword(password),
            childFirstName,
            childLastName,
            relationship,
        );

        const user = await findUser(null, result.userId);
        const session = user && await issueSession(user, result.tenantId);
        if (!session) {
            return fail(500, 'Internal Server Error', 'Your account was created. Please sign in to continue.');
        }

        return NextResponse.json({ success: true, data: session, correlationId }, { status: 201 });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        const pg = err as { code?: string; message?: string };
        if (pg.code === '23505') return fail(409, 'Conflict', pg.message ?? 'An account with this email or mobile number already exists.');
        if (pg.code === '22023') return fail(400, 'Validation Error', pg.message ?? 'Invalid registration details.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}

