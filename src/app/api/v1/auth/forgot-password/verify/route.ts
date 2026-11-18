import { NextRequest, NextResponse } from 'next/server';
import { verifyResetChallenge } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

/**
 * Verifies the 6-digit password-reset OTP against the signed challenge token before
 * allowing the user to set a new password.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const resetToken = typeof body.resetToken === 'string' ? body.resetToken.trim() : '';
        const otp = String(body.otp ?? '').trim();

        if (!resetToken) {
            return fail(400, 'Validation Error', 'Reset session is missing. Please send a new OTP.');
        }
        if (!/^\d{6}$/.test(otp)) {
            return fail(400, 'Validation Error', 'Please enter a valid 6-digit OTP.');
        }

        const challenge = verifyResetChallenge(resetToken, otp);
        if (!challenge.valid) {
            if (challenge.reason === 'expired') {
                return fail(400, 'OTP Expired', 'This OTP has expired. Please resend.');
            }
            if (challenge.reason === 'wrong_otp') {
                return fail(400, 'Invalid OTP', 'Incorrect OTP. Please try again.');
            }
            return fail(400, 'Invalid Reset Session', 'Reset session is invalid. Please send a new OTP.');
        }

        return NextResponse.json({
            success: true,
            data: { verified: true },
            correlationId,
        });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}

