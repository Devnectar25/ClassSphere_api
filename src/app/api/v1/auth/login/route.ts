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
        if (user.isSuspended) {
            return fail(403, 'Account Suspended', 'Your account has been suspended. Please contact ClassSphere support.');
        }

        // Check if the user has memberships that are suspended, rejected, or pending
        const activeMemberships = user.memberships.filter(m => m.orgStatus === 'active' || !m.orgStatus);
        const suspendedMembership = user.memberships.find(m => m.orgStatus === 'suspended' || m.verificationStatus === 'suspended');
        const rejectedMembership = user.memberships.find(m => m.verificationStatus === 'rejected');
        const pendingMembership = user.memberships.find(m => m.verificationStatus === 'pending');

        if (!user.isPlatformAdmin && activeMemberships.length === 0) {
            if (suspendedMembership) {
                return fail(403, 'Account Suspended', `Your academy "${suspendedMembership.tenantName}" has been suspended. Please contact ClassSphere support.`);
            }
            if (rejectedMembership) {
                return fail(403, 'Academy Rejected', `Your academy "${rejectedMembership.tenantName}" application was rejected: ${rejectedMembership.rejectionReason || 'Please contact support.'}`);
            }
            if (pendingMembership) {
                return fail(403, 'Academy Pending', `Your academy "${pendingMembership.tenantName}" is currently pending verification review.`);
            }
            return fail(403, 'No Academy Access', 'This account is not linked to an active academy.');
        }

        // Default academy: requested one, else the first active staff membership, else the platform scope
        const target = tenantId ?? (user.isPlatformAdmin ? null : activeMemberships[0]?.tenantId ?? null);
        const session = await issueSession(user, target);
        if (!session) return fail(403, 'No Academy Access', 'This account is not linked to an active academy.');

        return NextResponse.json({ success: true, data: session, correlationId });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}
