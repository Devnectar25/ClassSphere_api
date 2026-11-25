import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { callFn } from '@/lib/db/db';
import { captureFeePaymentOrder, failFeePaymentOrder } from '@/lib/billing/fee-installments';

/**
 * Razorpay Webhook Handler
 * Verifies webhook signatures and processes payment.captured, order.paid, and payment.failed events idempotently.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();

    try {
        const rawBody = await req.text();
        const signature = req.headers.get('x-razorpay-signature');

        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
        if (!webhookSecret) {
            console.error(`[${correlationId}] Webhook secret not configured in backend.`);
            return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
        }

        // Verify webhook signature (an unsigned call is never trusted)
        const expectedSig = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
        const actualSig = Buffer.from(signature ?? '', 'hex');
        if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
            console.warn(`[${correlationId}] Invalid Razorpay webhook signature.`);
            return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 400 });
        }

        const data = JSON.parse(rawBody);
        const event = data.event;
        const payload = data.payload;

        console.log(`[${correlationId}] Processing Razorpay webhook event: ${event}`);

        if (event === 'payment.captured' || event === 'order.paid') {
            const payment = payload?.payment?.entity;
            const order = payload?.order?.entity;

            const orderId = payment?.order_id || order?.id;
            const paymentId = payment?.id;
            const method = payment?.method || 'online';
            const transactionDate = payment?.created_at
                ? new Date(payment.created_at * 1000).toISOString()
                : new Date().toISOString();

            if (orderId && paymentId) {
                // Course fee order: posted here when the guardian's browser did not report it
                const fee = await captureFeePaymentOrder({
                    orderId, paymentId, paymentMethod: 'Razorpay', capturedPaise: Number(payment.amount),
                });
                if (fee) {
                    console.log(`[${correlationId}] Webhook ${fee.replayed ? 'confirmed' : 'posted'} fee order ${orderId}.`);
                    return NextResponse.json({ status: 'ok', received: true, correlationId });
                }
                const result = await callFn(
                    'platform.fn_registration_payment_verify_and_activate',
                    orderId,
                    paymentId,
                    method,
                    transactionDate
                );
                console.log(`[${correlationId}] Webhook activated academy for order ${orderId}:`, result);
            }
        } else if (event === 'payment.failed') {
            const payment = payload?.payment?.entity;
            const orderId = payment?.order_id;
            const errorDesc = payment?.error_description || 'Payment failed via webhook';

            if (orderId && await failFeePaymentOrder({ orderId, reason: errorDesc })) {
                console.log(`[${correlationId}] Webhook recorded a failed attempt on fee order ${orderId}.`);
            } else if (orderId) {
                await callFn('platform.fn_registration_payment_fail', orderId, errorDesc, 'failed');
                console.log(`[${correlationId}] Webhook marked order ${orderId} as failed.`);
            }
        }

        return NextResponse.json({ status: 'ok', received: true, correlationId });
    } catch (err) {
        console.error(`[${correlationId}] Webhook processing error:`, err);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
