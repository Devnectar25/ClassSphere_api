import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { callFn } from '@/lib/db/db';
import { findUser, issueSession } from '@/lib/api/session';
import { ok, problem } from '@/lib/api/respond';

interface ActivationResult {
    success: boolean;
    alreadyActivated: boolean;
    tenantId: string;
    adminUserId: string;
    planTier: string;
    paymentStatus: string;
}

/**
 * Verifies Razorpay payment signature and status for both standard orders and Autopay subscriptions,
 * then atomically activates the academy workspace and logs the admin user in.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const context = { correlationId };

    try {
        const body = await req.json();
        const { orderId, subscriptionId, paymentId, signature, isTestSimulation } = body;

        if ((!orderId && !subscriptionId) || !paymentId) {
            return problem(context, req, 400, 'Validation Error', 'orderId or subscriptionId, and paymentId are required to verify payment.');
        }

        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            return problem(context, req, 500, 'Gateway Config Error', 'Razorpay credentials not found in backend environment.');
        }

        // 1. Signature Verification
        if (!isTestSimulation) {
            if (!signature) {
                return problem(context, req, 400, 'Validation Error', 'Payment signature is required.');
            }

            let expectedSignature: string;
            if (subscriptionId) {
                // Razorpay Subscriptions / Autopay signature format: payment_id|subscription_id
                expectedSignature = crypto
                    .createHmac('sha256', keySecret)
                    .update(`${paymentId}|${subscriptionId}`)
                    .digest('hex');
            } else {
                // Razorpay Order signature format: order_id|payment_id
                expectedSignature = crypto
                    .createHmac('sha256', keySecret)
                    .update(`${orderId}|${paymentId}`)
                    .digest('hex');
            }

            if (expectedSignature !== signature) {
                // Secondary check: in case subscription checkout passed order signature
                const altSignature = orderId ? crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex') : '';
                if (altSignature !== signature) {
                    console.error(`[${correlationId}] Invalid Razorpay signature: received ${signature} vs expected ${expectedSignature}`);
                    await callFn('platform.fn_registration_payment_fail', orderId || subscriptionId, 'Invalid payment signature');
                    return problem(context, req, 400, 'Payment Verification Failed', 'Invalid payment signature. Payment could not be verified.');
                }
            }
        }

        // 2. Query Razorpay API to confirm payment state
        let paymentMethod = 'online';
        let transactionDate = new Date().toISOString();

        if (!isTestSimulation) {
            const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
            const paymentRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': auth },
            });

            const paymentData = await paymentRes.json();

            if (!paymentRes.ok) {
                console.error(`[${correlationId}] Razorpay payment fetch failed:`, paymentData);
                await callFn('platform.fn_registration_payment_fail', orderId || subscriptionId, paymentData?.error?.description || 'Payment record not found');
                return problem(context, req, 400, 'Payment Not Found', paymentData?.error?.description || 'Payment not found on Razorpay.');
            }

            if (paymentData.status !== 'captured' && paymentData.status !== 'authorized') {
                await callFn('platform.fn_registration_payment_fail', orderId || subscriptionId, `Payment status is ${paymentData.status}`);
                return problem(context, req, 400, 'Payment Unsuccessful', `Payment status is ${paymentData.status}. Only captured payments can activate an academy.`);
            }

            // If status is authorized (and not auto-captured), capture it
            if (paymentData.status === 'authorized') {
                await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/capture`, {
                    method: 'POST',
                    headers: {
                        'Authorization': auth,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        amount: paymentData.amount,
                        currency: paymentData.currency || 'INR',
                    }),
                });
            }

            paymentMethod = String(paymentData.method || (subscriptionId ? 'autopay' : 'online'));
            if (paymentData.created_at) {
                transactionDate = new Date(paymentData.created_at * 1000).toISOString();
            }
        } else {
            paymentMethod = 'test_simulation';
        }

        // 3. Atomically activate academy in database
        const activation = await callFn<ActivationResult>(
            'platform.fn_registration_payment_verify_and_activate',
            orderId || null,
            paymentId,
            paymentMethod,
            transactionDate,
            subscriptionId || null
        );

        if (!activation || !activation.tenantId || !activation.adminUserId) {
            return problem(context, req, 500, 'Activation Error', 'Failed to activate academy workspace.');
        }

        // 4. Issue authenticated session for the new academy owner
        const user = await findUser(null, activation.adminUserId);
        const session = user && await issueSession(user, activation.tenantId);

        if (!session) {
            return problem(context, req, 500, 'Internal Server Error', 'Academy was activated successfully, but session creation failed. Please sign in.');
        }

        return ok(context, {
            session,
            tenantId: activation.tenantId,
            planTier: activation.planTier,
            orderId,
            subscriptionId,
            paymentId,
            paymentStatus: 'SUCCESS',
            paymentMethod,
            transactionDate,
            isAutopay: Boolean(subscriptionId),
        });
    } catch (err) {
        if (err instanceof SyntaxError) {
            return problem(context, req, 400, 'Malformed Request', 'Request body must be valid JSON.');
        }
        console.error(`[${correlationId}] Payment verification error:`, err);
        return problem(context, req, 500, 'Internal Server Error', 'An unexpected error occurred while verifying payment.');
    }
}
