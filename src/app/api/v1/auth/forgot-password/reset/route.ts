import { NextRequest, NextResponse } from 'next/server';
import { callFn } from '@/lib/db/db';
import { hashPassword, verifyPassword, verifyResetChallenge } from '@/lib/auth';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { findUser } from '@/lib/api/session';

function passwordProblem(password: string): string | null {
    if (!password) return 'New password is required.';
    if (password.length < 8 || password.length > 64) return 'Password must be 8 to 64 characters.';
    if (/\s/.test(password)) return 'Password cannot contain spaces.';
    if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
    if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter.';
    if (!/[0-9]/.test(password)) return 'Password must include a number.';
    if (!/[^a-zA-Z0-9\s]/.test(password)) return 'Password must include a special character (!@#$…).';
    return null;
}

/**
 * Completes a password reset: verifies the signed OTP challenge, validates the new password
 * against strength and confirmation rules, and updates the stored scrypt password hash.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const fail = (status: number, title: string, detail: string) =>
        createProblemDetailsResponse(status, title, detail, correlationId, req.nextUrl.pathname);

    try {
        const body = await req.json();
        const resetToken = typeof body.resetToken === 'string' ? body.resetToken.trim() : '';
        const otp = String(body.otp ?? '').trim();
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
        const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

        if (!resetToken) {
            return fail(400, 'Validation Error', 'Reset session is missing. Please request a new OTP.');
        }
        if (!/^\d{6}$/.test(otp)) {
            return fail(400, 'Validation Error', 'Please enter a valid 6-digit OTP.');
        }

        const challenge = verifyResetChallenge(resetToken, otp);
        if (!challenge.valid) {
            if (challenge.reason === 'expired') {
                return fail(400, 'OTP Expired', 'This OTP has expired. Please request a new one.');
            }
            if (challenge.reason === 'wrong_otp') {
                return fail(400, 'Invalid OTP', 'Incorrect OTP. Please check the code and try again.');
            }
            return fail(400, 'Invalid Reset Session', 'Reset session is invalid. Please request a new OTP.');
        }

        const pwErr = passwordProblem(newPassword);
        if (pwErr) return fail(400, 'Validation Error', pwErr);
        if (newPassword !== confirmPassword) {
            return fail(400, 'Validation Error', 'Confirm password does not match the new password.');
        }

        const user = await findUser(null, challenge.userId);
        if (!user || !user.isActive) {
            return fail(404, 'Account Not Found', 'Account not found or inactive.');
        }

        if (verifyPassword(newPassword, user.passwordHash)) {
            return fail(400, 'Validation Error', 'New password must be different from your current password.');
        }

        const personalTerms = [user.fullName, user.email?.split('@')[0] ?? '']
            .flatMap(s => s.split(/\s+/))
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length >= 3);
        const lowerPw = newPassword.toLowerCase();
        if (personalTerms.some(term => lowerPw.includes(term))) {
            return fail(400, 'Validation Error', 'Password should not contain your name or email.');
        }

        await callFn('identity_app.fn_user_password_reset', user.userId, hashPassword(newPassword));

        return NextResponse.json({
            success: true,
            data: { message: 'Your password has been reset successfully. You can now sign in with your new password.' },
            correlationId,
        });
    } catch (err) {
        if (err instanceof SyntaxError) return fail(400, 'Malformed Request', 'Request payload must be valid JSON.');
        const pg = err as { code?: string; message?: string };
        if (pg.code === '22023') return fail(400, 'Validation Error', pg.message ?? 'Unable to reset password.');
        console.error(`[${correlationId}]`, err);
        return fail(500, 'Internal Server Error', 'An unexpected error occurred.');
    }
}

