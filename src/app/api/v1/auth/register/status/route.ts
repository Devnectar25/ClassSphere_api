import { NextRequest } from 'next/server';
import { callFn } from '@/lib/db/db';
import { findUser, issueSession } from '@/lib/api/session';
import { ok, problem } from '@/lib/api/respond';

interface StatusRow {
    success: boolean;
    registrationId?: string;
    orderId?: string;
    paymentId?: string;
    planTier?: string;
    planName?: string;
    amount?: number;
    currency?: string;
    paymentStatus?: string;
    paymentMethod?: string;
    tenantId?: string;
    adminUserId?: string;
    errorMessage?: string;
    error?: string;
}

/**
 * Checks payment and registration status for a given orderId.
 * If status is pending, also actively queries Razorpay to verify if a background capture occurred.
 */
export async function GET(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const context = { correlationId };

    try {
        const orderId = req.nextUrl.searchParams.get('orderId');
        if (!orderId) {
            return problem(context, req, 400, 'Validation Error', 'orderId query parameter is required.');
        }

        const statusRes = await callFn<StatusRow>('platform.fn_registration_payment_status', orderId);
        if (!statusRes || !statusRes.success) {
            return problem(context, req, 404, 'Not Found', 'Registration order was not found.');
        }

        let currentStatus = statusRes.paymentStatus || 'pending';
        let tenantId = statusRes.tenantId;
        let adminUserId = statusRes.adminUserId;

        // If still pending, check live Razorpay order payments in case of frontend disconnection
        if (currentStatus === 'pending') {
            const keyId = process.env.RAZORPAY_KEY_ID;
            const keySecret = process.env.RAZORPAY_KEY_SECRET;

            if (keyId && keySecret) {
                try {
                    const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
                    const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${orderId}/payments`, {
                        headers: { 'Authorization': auth },
                    });

                    if (rzpRes.ok) {
                        const paymentsList = await rzpRes.json();
                        const capturedPayment = paymentsList.items?.find((p: any) => p.status === 'captured');

                        if (capturedPayment) {
                            const transactionDate = capturedPayment.created_at
                                ? new Date(capturedPayment.created_at * 1000).toISOString()
                                : new Date().toISOString();

                            const activated = await callFn<{
                                success: boolean;
                                tenantId: string;
                                adminUserId: string;
                                planTier: string;
                            }>(
                                'platform.fn_registration_payment_verify_and_activate',
                                orderId,
                                capturedPayment.id,
                                capturedPayment.method || 'online',
                                transactionDate
                            );

                            if (activated?.success) {
                                currentStatus = 'success';
                                tenantId = activated.tenantId;
                                adminUserId = activated.adminUserId;
                            }
                        }
                    }
                } catch (checkErr) {
                    console.warn(`[${correlationId}] Background Razorpay check failed for ${orderId}:`, checkErr);
                }
            }
        }

        // If successful and user exists, issue session for automatic login
        let session = null;
        if (currentStatus === 'success' && adminUserId && tenantId) {
            const user = await findUser(null, adminUserId);
            session = user && await issueSession(user, tenantId);
        }

        return ok(context, {
            orderId,
            registrationId: statusRes.registrationId,
            paymentStatus: currentStatus,
            planTier: statusRes.planTier,
            planName: statusRes.planName,
            amount: statusRes.amount,
            currency: statusRes.currency,
            tenantId,
            session,
            errorMessage: statusRes.errorMessage,
        });
    } catch (err) {
        console.error(`[${correlationId}] Status route error:`, err);
        return problem(context, req, 500, 'Internal Server Error', 'An unexpected error occurred while checking payment status.');
    }
}
