import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser, issueSession } from '@/lib/api/session';

/**
 * Sign-in: email or mobile number + password → session token for the user's academy (or platform scope).
 * Traceability: TDD Section 12; PLT-004
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        // Identifier: an email address or a mobile number (`email` is accepted for older clients)
        const identifier = String(body.identifier ?? body.email ?? '').trim();
        const { password, tenantId } = body;
        if (!identifier || !password) return fail(400, 'Validation Error', 'Email or mobile number and password are required.');
        if (!identifier.includes('@') && !/^\d{10}$/.test(identifier)) {
            return fail(400, 'Validation Error', 'Enter a valid 10-digit mobile number or email address.');
        }

        const user = await findUser(identifier, null);
        if (!user) {
            return fail(404, 'Account Not Found', 'No account found with this email or mobile number. Please sign up first.');
        }
        if (!user.isActive) {
            return fail(403, 'Account Inactive', 'This account is inactive. Please contact your administrator.');
        }
        if (!verifyPassword(password, user.passwordHash)) {
            return fail(401, 'Invalid Credentials', 'Incorrect password. Please try again.');
        }

        // Default academy: requested one, else the first staff membership, else the platform scope
        const target = tenantId ?? (user.isPlatformAdmin ? null : user.memberships[0]?.tenantId ?? null);
        const session = await issueSession(user, target);
        if (!session) return fail(403, 'No Academy Access', 'This account is not linked to an active academy.');

        return NextResponse.json({ success: true, data: session, correlationId });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}
