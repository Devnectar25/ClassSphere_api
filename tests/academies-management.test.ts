import test from 'node:test';
import assert from 'node:assert/strict';
import { callFn } from '../src/lib/db/db.ts';

test('Academies Management Workflows & Authorization', async (t) => {
    // 1. Test listing & subsection counts
    await t.test('listing returns pagination and 5 live subsection counts', async () => {
        const list = await callFn<{
            total: number;
            counts: { all: number; pending: number; verified: number; rejected: number; suspended: number };
            academies: Array<{ tenantId: string; name: string; verificationStatus: string; commissionRate: number }>;
        }>('platform.fn_academies_list', null, 'all', 10, 0);

        assert.ok(typeof list.total === 'number');
        assert.ok(list.total >= 20);
        assert.ok(typeof list.counts.all === 'number');
        assert.ok(typeof list.counts.pending === 'number');
        assert.ok(typeof list.counts.verified === 'number');
        assert.ok(typeof list.counts.rejected === 'number');
        assert.ok(typeof list.counts.suspended === 'number');
        assert.ok(list.academies.length > 0);
    });

    // 2. Test 10-tab dossier
    await t.test('fn_academy_detail returns all 10 dossier tabs', async () => {
        const list = await callFn<{ academies: Array<{ tenantId: string }> }>('platform.fn_academies_list', null, 'all', 1, 0);
        const tenantId = list.academies[0].tenantId;

        const detail = await callFn<Record<string, unknown>>('platform.fn_academy_detail', tenantId);

        const requiredTabs = [
            'overview',
            'owner',
            'academy',
            'documents',
            'courses',
            'batches',
            'registrations',
            'payments',
            'payoutHistory',
            'activityHistory',
        ];

        for (const tab of requiredTabs) {
            assert.ok(tab in detail, `Tab ${tab} must be present in dossier`);
        }
    });

    // 3. Test verification rejection and suspension validation rules
    await t.test('rejection requires minimum 10 char reason', async () => {
        const list = await callFn<{ academies: Array<{ tenantId: string }> }>('platform.fn_academies_list', null, 'all', 1, 0);
        const tenantId = list.academies[0].tenantId;

        await assert.rejects(
            async () => {
                await callFn('platform.fn_academy_action', tenantId, 'reject', 'short');
            },
            {
                message: /mandatory rejection reason of at least 10 characters/,
            }
        );
    });

    await t.test('suspension requires minimum 10 char reason', async () => {
        const list = await callFn<{ academies: Array<{ tenantId: string }> }>('platform.fn_academies_list', null, 'all', 1, 0);
        const tenantId = list.academies[0].tenantId;

        await assert.rejects(
            async () => {
                await callFn('platform.fn_academy_action', tenantId, 'suspend', 'too short');
            },
            {
                message: /mandatory suspension reason of at least 10 characters/,
            }
        );
    });

    // 4. Test commission configuration validation
    await t.test('commission must be between 0 and 50 percent', async () => {
        const list = await callFn<{ academies: Array<{ tenantId: string }> }>('platform.fn_academies_list', null, 'all', 1, 0);
        const tenantId = list.academies[0].tenantId;

        await assert.rejects(
            async () => {
                await callFn('platform.fn_academy_action', tenantId, 'commission', null, 75);
            },
            {
                message: /Commission rate must be between 0 and 50 percent/,
            }
        );

        // Valid commission rate works
        const result = await callFn<{ success: boolean }>('platform.fn_academy_action', tenantId, 'commission', null, 12.5);
        assert.strictEqual(result.success, true);
    });

    // 5. Test course creation authorization guard: unverified or suspended academies cannot publish courses
    await t.test('course creation guard rejects unverified or suspended academies', async () => {
        const pendingList = await callFn<{ academies: Array<{ tenantId: string }> }>('platform.fn_academies_list', null, 'pending', 1, 0);
        if (pendingList.academies.length > 0) {
            const pendingTenantId = pendingList.academies[0].tenantId;
            await assert.rejects(
                async () => {
                    await callFn(
                        'academics.fn_course_create',
                        pendingTenantId,
                        'Test Course',
                        'TEST-101',
                        'Music',
                        'Beginner',
                        3,
                        5000,
                        'monthly',
                        'Description',
                        ['Subject A'],
                        null
                    );
                },
                {
                    message: /requires a verified and active academy status/,
                }
            );
        }
    });

    // 6. Test export function
    await t.test('export function returns matching academy records', async () => {
        const exported = await callFn<{ academies: Array<{ tenantId: string; name: string }> }>('platform.fn_academies_export', null, 'all', null);
        assert.ok(Array.isArray(exported.academies));
        assert.ok(exported.academies.length >= 20);
    });
});
