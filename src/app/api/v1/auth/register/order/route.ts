import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { hashPassword } from '@/lib/auth';
import { ok, problem } from '@/lib/api/respond';

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const NAME_REGEX = /^[a-zA-Z]+(?:[ '.-][a-zA-Z]*)*$/;
const ACADEMY_NAME_REGEX = /^[a-zA-Z][a-zA-Z &'.,()\-/]*$/;

function isValidMobile(phone: string) {
    if (!/^\+?[\d\s\-()]+$/.test(phone)) return false;
    const digits = phone.replace(/\D/g, '');
    const international = phone.startsWith('+');
    if (!international || digits.startsWith('91')) {
        let national = digits;
        if (international || (digits.length === 12 && digits.startsWith('91'))) national = digits.slice(2);
        else if (digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
        return /^[6-9]\d{9}$/.test(national) && !/^(\d)\1{9}$/.test(national);
    }
    return digits.length >= 7 && digits.length <= 15;
}

function passwordProblem(password: string): string | null {
    if (password.length < 8 || password.length > 64) return 'Password must be 8 to 64 characters.';
    if (/\s/.test(password)) return 'Password cannot contain spaces.';
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9\s]/.test(password)) {
        return 'Password must include an uppercase letter, a lowercase letter, a number and a special character.';
    }
    return null;
}

interface PlanRow {
    plan_tier: string;
    description: string;
    price_monthly: number;
    currency: string;
    razorpay_plan_id: string | null;
}

/**
 * Validates registration details and generates both a Razorpay Autopay Subscription (for recurring mandate)
 * and a standard Razorpay Order, preserving pending registration safely in the database.
 */
export async function POST(req: NextRequest) {
    const correlationId = crypto.randomUUID();
    const context = { correlationId };

    try {
        const body = await req.json();
        const tidy = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');

        const academyName = tidy(body.academyName);
        const firstName = tidy(body.firstName);
        const lastName = tidy(body.lastName);
        const email = String(body.email ?? '').trim().toLowerCase();
        const phone = String(body.phone ?? '').trim();
        const country = tidy(body.country) || 'India';
        const state = tidy(body.state);
        const city = tidy(body.city);
        const address = tidy(body.address);
        const location = tidy(body.location);
        const academyType = String(body.academyType ?? 'Tuition').trim();
        const planTier = String(body.planTier ?? 'Professional').trim();
        const password = typeof body.password === 'string' ? body.password : '';
        const acceptTerms = body.acceptTerms === true;

        // 1. Validation
        if (!academyName || !firstName || !lastName || !email || !phone || !password) {
            return problem(context, req, 400, 'Validation Error', 'Please fill in all required registration fields.');
        }
        if (academyName.length < 3 || academyName.length > 100 || !ACADEMY_NAME_REGEX.test(academyName)) {
            return problem(context, req, 400, 'Validation Error', "Academy name must be 3 to 100 characters, starting with a letter.");
        }
        if (firstName.length < 2 || firstName.length > 50 || !NAME_REGEX.test(firstName)) {
            return problem(context, req, 400, 'Validation Error', 'First name must be 2 to 50 letters.');
        }
        if (lastName.length > 50 || !NAME_REGEX.test(lastName)) {
            return problem(context, req, 400, 'Validation Error', 'Last name must be up to 50 letters.');
        }
        if (!EMAIL_REGEX.test(email)) {
            return problem(context, req, 400, 'Validation Error', 'Enter a valid email address.');
        }
        if (!isValidMobile(phone)) {
            return problem(context, req, 400, 'Validation Error', 'Enter a valid mobile number.');
        }
        const pwErr = passwordProblem(password);
        if (pwErr) return problem(context, req, 400, 'Validation Error', pwErr);
        if (location) {
            const isIndia = !country || country.toLowerCase() === 'india';
            if (isIndia) {
                const cleanDigits = location.replace(/\s/g, '');
                if (/^\d+$/.test(cleanDigits)) {
                    if (!/^[1-9][0-9]{5}$/.test(cleanDigits)) {
                        return problem(context, req, 400, 'Validation Error', 'PIN code must be a valid 6-digit number (e.g. 411038).');
                    }
                } else {
                    const pinMatches = location.match(/\b\d+\b/g);
                    const hasValidPin = pinMatches && pinMatches.some(p => /^[1-9][0-9]{5}$/.test(p));
                    if (!hasValidPin) {
                        return problem(context, req, 400, 'Validation Error', 'Please include a valid 6-digit PIN code in your location/area (e.g. 411038).');
                    }
                }
            }
        }
        if (!acceptTerms) {
            return problem(context, req, 400, 'Validation Error', 'Please accept the Terms of Service and Privacy Policy.');
        }

        // 2. Uniqueness check (fail fast before user sets up payment/autopay)
        const phoneDigits = phone.replace(/\D/g, '').slice(-10);
        const duplicateUsers = await query<{ email: string; phone: string }>(
            `SELECT email, phone FROM identity_app.users 
             WHERE (email IS NOT NULL AND lower(email) = $1)
                OR (phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2)
             LIMIT 1`,
            [email, phoneDigits]
        );
        if (duplicateUsers.length > 0) {
            const isEmail = duplicateUsers[0].email?.toLowerCase() === email;
            return problem(context, req, 409, 'Conflict',
                isEmail ? 'An account with this email already exists. Sign in instead.' : 'An account with this mobile number already exists. Sign in instead.');
        }

        // 3. Resolve plan pricing from database
        const planRows = await query<PlanRow>(
            `SELECT plan_tier, description, price_monthly, currency, razorpay_plan_id FROM platform.plans WHERE lower(plan_tier) = lower($1) LIMIT 1`,
            [planTier]
        );
        if (planRows.length === 0) {
            return problem(context, req, 400, 'Validation Error', `Invalid subscription plan: ${planTier}`);
        }
        const plan = planRows[0];
        const amountInPaise = Math.round(Number(plan.price_monthly) * 100);
        const currency = plan.currency || 'INR';

        // 4. Verify Razorpay credentials
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keyId || !keySecret) {
            return problem(context, req, 500, 'Gateway Config Error', 'Razorpay credentials not configured in backend.');
        }

        const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        const receipt = `cs_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

        // 5. Generate Razorpay Autopay Subscription if plan has a linked Razorpay plan ID
        let subscriptionId: string | null = null;
        if (plan.razorpay_plan_id) {
            try {
                const subRes = await fetch('https://api.razorpay.com/v1/subscriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': auth,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        plan_id: plan.razorpay_plan_id,
                        total_count: 12,
                        customer_notify: 1,
                        notes: {
                            academyName,
                            academyType,
                            planTier: plan.plan_tier,
                            adminName: `${firstName} ${lastName}`.trim(),
                            email,
                            phone,
                        },
                    }),
                });
                if (subRes.ok) {
                    const subData = await subRes.json();
                    subscriptionId = subData.id;
                }
            } catch (subErr) {
                console.warn(`[${correlationId}] Subscription creation warning:`, subErr);
            }
        }

        // 6. Generate Razorpay Order
        const rzpResponse = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
                'Authorization': auth,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                amount: amountInPaise,
                currency,
                receipt,
                notes: {
                    academyName,
                    academyType,
                    planTier: plan.plan_tier,
                    adminName: `${firstName} ${lastName}`.trim(),
                    email,
                    phone,
                    subscriptionId: subscriptionId || undefined,
                },
            }),
        });

        const rzpData = await rzpResponse.json();
        if (!rzpResponse.ok) {
            console.error(`[${correlationId}] Razorpay order creation failed:`, rzpData);
            return problem(context, req, rzpResponse.status, 'Payment Gateway Error', rzpData?.error?.description || 'Failed to initialize Razorpay transaction.');
        }

        // 7. Securely persist pending registration payload
        const registrationPayload = {
            academyName,
            academyType,
            firstName,
            lastName,
            email,
            phone,
            passwordHash: hashPassword(password),
            country,
            state: state || null,
            city: city || null,
            address: address || null,
            location: location || null,
            acceptTerms: true,
        };

        const regResult = await callFn<{ registrationId: string }>(
            'platform.fn_registration_order_create',
            rzpData.id,
            plan.plan_tier,
            `${plan.plan_tier} Plan`,
            Number(plan.price_monthly),
            currency,
            JSON.stringify(registrationPayload),
            subscriptionId
        );

        return ok(context, {
            orderId: rzpData.id,
            subscriptionId, // Populated for recurring UPI Autopay / Card Mandate
            amount: rzpData.amount,
            currency: rzpData.currency,
            keyId,
            planTier: plan.plan_tier,
            planName: `${plan.plan_tier} Plan`,
            priceMonthly: Number(plan.price_monthly),
            academyName,
            registrationId: regResult?.registrationId,
            isAutopay: Boolean(subscriptionId),
            customer: {
                name: `${firstName} ${lastName}`.trim(),
                email,
                phone,
            },
        });
    } catch (err) {
        if (err instanceof SyntaxError) {
            return problem(context, req, 400, 'Malformed Request', 'Request body must be valid JSON.');
        }
        console.error(`[${correlationId}] Order error:`, err);
        return problem(context, req, 500, 'Internal Server Error', 'An unexpected error occurred while initializing payment.');
    }
}
