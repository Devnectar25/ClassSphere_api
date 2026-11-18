import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { signResetChallenge } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser } from '@/lib/api/session';

const OTP_TTL_SECONDS = 5 * 60;

function maskIdentifier(identifier: string): string {
    if (identifier.includes('@')) {
        const [local, domain] = identifier.split('@');
        const visible = local.length <= 2 ? local[0] ?? '*' : `${local.slice(0, 2)}***`;
        return `${visible}@${domain}`;
    }
    const digits = identifier.replace(/\D/g, '');
    return `******${digits.slice(-4)}`;
}

/**
 * Initiates a password reset: validates the email or 10-digit mobile number, confirms the
 * account exists and is active, and issues a short-lived signed OTP reset challenge.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const identifier = String(body.identifier ?? '').trim();

        if (!identifier) {
            return fail(400, 'Validation Error', 'Email or mobile number is required.');
        }
        if (!identifier.includes('@') && !/^\d{10}$/.test(identifier)) {
            return fail(400, 'Validation Error', 'Enter a valid 10-digit mobile number or email address.');
        }

        const user = await findUser(identifier, null);
        if (!user) {
            return fail(404, 'Account Not Found', 'No account found with this email or mobile number.');
        }
        if (!user.isActive) {
            return fail(403, 'Account Inactive', 'This account is inactive. Please contact your administrator.');
        }

        const otp = String(randomInt(100000, 1000000));
        const resetToken = signResetChallenge(user.userId, otp, OTP_TTL_SECONDS);

        return NextResponse.json({
            success: true,
            data: {
                resetToken,
                expiresInSeconds: OTP_TTL_SECONDS,
                maskedTarget: maskIdentifier(identifier),
                // Demo mode: no SMS/email gateway is wired yet, so return the OTP like registration does
                demoOtp: otp,
            },
            correlationId,
        });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}

