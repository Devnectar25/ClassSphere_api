import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Platform Global Settings API
 * Enforces role-based permissions:
 * - SuperAdmin: Full read and update access across all platform configurations.
 * - FinanceAdmin: View financial and billing-related settings; read-only.
 * - SupportAdmin: View support-relevant settings (profile, registration, cancellation); read-only.
 */

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export async function GET(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        // 1. Fetch current settings rows with timestamps and audit user IDs
        const rows = await query<{
            setting_key: string;
            category: string;
            value: any;
            updated_at: string;
            updated_by: string | null;
        }>('SELECT setting_key, category, value, updated_at, updated_by FROM platform.settings');

        // 2. Fetch admin updater details for audit tracking
        const userIds = Array.from(new Set(rows.map(r => r.updated_by).filter((id): id is string => Boolean(id))));
        let userMap: Record<string, { fullName: string; email: string }> = {};
        if (userIds.length > 0) {
            const users = await query<{ user_id: string; full_name: string; email: string }>(
                `SELECT user_id, full_name, email FROM identity_app.users WHERE user_id = ANY($1)`,
                [userIds]
            );
            userMap = Object.fromEntries(users.map(u => [u.user_id, { fullName: u.full_name, email: u.email }]));
        }

        // 3. Resolve requesting admin's role from platform.admin_users
        let actorAdminRole: 'SuperAdmin' | 'FinanceAdmin' | 'SupportAdmin' = 'SuperAdmin';
        if (context.actorId) {
            const [adminRow] = await query<{ role: string }>(
                `SELECT role FROM platform.admin_users WHERE user_id = $1 LIMIT 1`,
                [context.actorId]
            );
            if (adminRow?.role) {
                actorAdminRole = adminRow.role as any;
            }
        }

        // 4. Construct settings map with fallback defaults
        const settingsMap: Record<string, any> = {};
        const metaMap: Record<string, { updatedAt: string; updatedBy: string | null; updatedByName?: string; updatedByEmail?: string }> = {};

        for (const row of rows) {
            let val = row.value;

            // Ensure general setting has platformLogo, platformEmail, platformStatus defaults
            if (row.setting_key === 'general') {
                val = {
                    platformName: 'ClassShare',
                    platformLogo: '/brand-logo.svg',
                    platformEmail: 'admin@classshare.io',
                    supportEmail: 'support@classshare.io',
                    contactNumber: '+91 80000 12345',
                    address: 'Bangalore, KA, India',
                    platformStatus: 'Active',
                    ...val,
                };
            }

            // Ensure registration setting has defaults
            if (row.setting_key === 'registration') {
                val = {
                    defaultPaymentWindowHours: 48,
                    deadlineRules: 'Auto-expire after window',
                    cancellationNoticeHours: 24,
                    autoCancelUnpaid: true,
                    ...val,
                };
            }

            // Ensure cancellation setting has defaults
            if (row.setting_key === 'cancellation') {
                val = {
                    defaultPolicy: 'Full refund up to 48 hours before batch start',
                    allowAcademyOverrides: true,
                    refundProcessingDays: 5,
                    deductionPercentage: 0,
                    ...val,
                };
            }

            // Ensure settlement setting has defaults
            if (row.setting_key === 'settlement') {
                val = {
                    releaseSchedule: 'Weekly on Mondays',
                    payoutHoldingDays: 7,
                    minimumPayoutThreshold: 1000,
                    ...val,
                };
            }

            settingsMap[row.setting_key] = val;

            const userInfo = row.updated_by ? userMap[row.updated_by] : null;
            metaMap[row.setting_key] = {
                updatedAt: row.updated_at,
                updatedBy: row.updated_by,
                updatedByName: userInfo?.fullName,
                updatedByEmail: userInfo?.email,
            };
        }

        // 5. Construct permission flags based on role
        const permissions = {
            canEdit: actorAdminRole === 'SuperAdmin',
            canViewCommission: actorAdminRole === 'SuperAdmin' || actorAdminRole === 'FinanceAdmin',
            canViewSettlement: actorAdminRole === 'SuperAdmin' || actorAdminRole === 'FinanceAdmin',
            canViewFeatures: actorAdminRole === 'SuperAdmin',
            canViewRegistration: true,
            canViewCancellation: true,
            canViewGeneral: true,
        };

        // For SupportAdmin, mask sensitive commission and settlement details if queried
        if (actorAdminRole === 'SupportAdmin') {
            delete settingsMap.settlement;
            if (settingsMap.commission) {
                settingsMap.commission = {
                    defaultPercentage: settingsMap.commission.defaultPercentage,
                    taxOnCommission: settingsMap.commission.taxOnCommission,
                };
            }
        }

        return ok(context, {
            ...settingsMap,
            _meta: metaMap,
            _role: actorAdminRole,
            _permissions: permissions,
        });
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'platform');
    if (context instanceof Response) return context;

    try {
        // Enforce backend authorization: Only SuperAdmin can modify platform settings
        let actorAdminRole: 'SuperAdmin' | 'FinanceAdmin' | 'SupportAdmin' = 'SuperAdmin';
        if (context.actorId) {
            const [adminRow] = await query<{ role: string }>(
                `SELECT role FROM platform.admin_users WHERE user_id = $1 LIMIT 1`,
                [context.actorId]
            );
            if (adminRow?.role) {
                actorAdminRole = adminRow.role as any;
            }
        }

        if (actorAdminRole !== 'SuperAdmin') {
            return problem(
                context,
                req,
                403,
                'Forbidden',
                `Your administrator role (${actorAdminRole}) does not have permission to modify platform settings. Only Super Administrators can update global configuration.`
            );
        }

        const body = await req.json();
        const { key, value } = body;

        if (!key || value === undefined) {
            return problem(context, req, 400, 'Validation Error', 'Setting key and value are required.');
        }

        // Strict Server-side Validations
        if (key === 'commission') {
            const pct = Number(value.defaultPercentage);
            if (isNaN(pct) || pct < 0 || pct > 50) {
                return problem(context, req, 400, 'Validation Error', 'Default platform commission must be between 0% and 50%.');
            }
            const tax = Number(value.taxOnCommission);
            if (isNaN(tax) || tax < 0 || tax > 50) {
                return problem(context, req, 400, 'Validation Error', 'Tax on commission must be between 0% and 50%.');
            }
        } else if (key === 'registration') {
            const hours = Number(value.defaultPaymentWindowHours);
            if (isNaN(hours) || hours < 1 || hours > 168) {
                return problem(context, req, 400, 'Validation Error', 'Payment window must be between 1 and 168 hours.');
            }
            if (!value.deadlineRules || typeof value.deadlineRules !== 'string') {
                return problem(context, req, 400, 'Validation Error', 'Deadline rules policy description is required.');
            }
        } else if (key === 'cancellation') {
            if (!value.defaultPolicy || typeof value.defaultPolicy !== 'string') {
                return problem(context, req, 400, 'Validation Error', 'Default cancellation policy is required.');
            }
            if (value.refundProcessingDays !== undefined) {
                const days = Number(value.refundProcessingDays);
                if (isNaN(days) || days < 1 || days > 30) {
                    return problem(context, req, 400, 'Validation Error', 'Refund processing days must be between 1 and 30.');
                }
            }
        } else if (key === 'settlement') {
            const days = Number(value.payoutHoldingDays);
            if (isNaN(days) || days < 0 || days > 60) {
                return problem(context, req, 400, 'Validation Error', 'Payout holding days must be between 0 and 60.');
            }
            if (!value.releaseSchedule || typeof value.releaseSchedule !== 'string') {
                return problem(context, req, 400, 'Validation Error', 'Release schedule is required.');
            }
        } else if (key === 'general') {
            if (!value.platformName || typeof value.platformName !== 'string' || !value.platformName.trim()) {
                return problem(context, req, 400, 'Validation Error', 'Platform name is required.');
            }
            if (value.platformEmail && !EMAIL_REGEX.test(value.platformEmail.trim())) {
                return problem(context, req, 400, 'Validation Error', 'Please enter a valid platform email address.');
            }
            if (value.supportEmail && !EMAIL_REGEX.test(value.supportEmail.trim())) {
                return problem(context, req, 400, 'Validation Error', 'Please enter a valid support email address.');
            }
            if (value.platformStatus && !['Active', 'Maintenance', 'active', 'maintenance'].includes(value.platformStatus)) {
                return problem(context, req, 400, 'Validation Error', 'Platform status must be Active or Maintenance.');
            }
        } else if (key === 'features') {
            if (typeof value !== 'object' || value === null) {
                return problem(context, req, 400, 'Validation Error', 'Features payload must be an object.');
            }
        }

        // Persist setting update
        const result = await callFn<Record<string, unknown>>(
            'platform.fn_settings_update',
            key,
            JSON.stringify(value),
            context.actorId || null
        );

        // Fetch updater's name for return payload
        let updaterName: string | undefined;
        let updaterEmail: string | undefined;
        if (context.actorId) {
            const [user] = await query<{ full_name: string; email: string }>(
                'SELECT full_name, email FROM identity_app.users WHERE user_id = $1 LIMIT 1',
                [context.actorId]
            );
            updaterName = user?.full_name;
            updaterEmail = user?.email;
        }

        return ok(context, {
            ...result,
            updatedAt: new Date().toISOString(),
            updatedByName: updaterName,
            updatedByEmail: updaterEmail,
        });
    } catch (err) {
        return fail(err, context, req);
    }
}
