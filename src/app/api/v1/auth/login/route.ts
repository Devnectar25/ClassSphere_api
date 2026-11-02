import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser, issueSession } from '@/lib/api/session';

/**
 * Sign-in: email + password → session token for the user's academy (or platform scope).
 * Traceability: TDD Section 12; PLT-004
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const email = String(body.email ?? '').trim();
        const { password, tenantId } = body;
        if (!email || !password) return fail(400, 'Validation Error', 'Email and password are required.');

        const user = await findUser(email, null);
        if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
            return fail(401, 'Invalid Credentials', 'The email or password is incorrect.');
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
