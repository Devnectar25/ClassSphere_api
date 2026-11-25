import { query } from '@/lib/db/db';
import { academyToday, dateIn } from '@/lib/billing/course-period';
import { ACTIVE_ENROLLMENT } from '@/lib/billing/credit-ledger';

export interface ScheduledTest {
    testId: string;
    title: string;
    testType: string;
    testDate: string;
    batchName: string;
    courseTitle: string;
    subjects: Array<{ name: string; maxMarks: number }>;
    /** 'upcoming' up to and including the test day, 'awaiting_results' after it or once marks are being entered */
    state: 'upcoming' | 'awaiting_results';
}

/**
 * Tests of the batches a student is currently in whose results are not published yet. Marks are never part of this:
 * those reach the portal only with the published report card.
 */
export async function scheduledTests(tenantId: string, studentIds: string[]): Promise<Map<string, ScheduledTest[]>> {
    const byStudent = new Map<string, ScheduledTest[]>();
    if (!studentIds.length) return byStudent;

    const today = await academyToday({ query }, tenantId);
    const rows = await query<{
        student_id: string; test_id: string; title: string; test_type: string; test_date: string; status: string;
        batch_name: string; course_title: string; enrolled_at: string | Date; timezone: string | null;
        subjects: Array<{ name: string; maxMarks: number }>;
    }>(
        `SELECT e.student_id, t.test_id, t.title, t.test_type, t.test_date::text AS test_date, t.status,
                b.name AS batch_name, c.title AS course_title, e.enrolled_at, o.timezone,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('name', s.name, 'maxMarks', x.max_marks) ORDER BY s.sort_order, s.name)
                          FROM academics.test_subjects x JOIN academics.course_subjects s ON s.subject_id = x.subject_id
                          WHERE x.test_id = t.test_id), '[]'::jsonb) AS subjects
         FROM academics.tests t
         JOIN academics.batches b ON b.batch_id = t.batch_id
         JOIN academics.courses c ON c.course_id = b.course_id
         JOIN academics.enrollments e ON e.batch_id = t.batch_id AND e.tenant_id = t.tenant_id
         JOIN tenant.organizations o ON o.tenant_id = t.tenant_id
         WHERE t.tenant_id = $1 AND t.status <> 'published' AND e.student_id = ANY($2::uuid[]) AND e.status = ANY($3::text[])
         ORDER BY t.test_date, t.created_at`,
        [tenantId, studentIds, ACTIVE_ENROLLMENT]);

    for (const r of rows) {
        const state = r.status === 'scheduled' && r.test_date >= today ? 'upcoming' : 'awaiting_results';
        // A test held before the student joined the batch has no result to wait for
        if (state === 'awaiting_results' && r.test_date < dateIn(r.timezone, new Date(r.enrolled_at))) continue;
        const list = byStudent.get(r.student_id) ?? [];
        list.push({
            testId: r.test_id, title: r.title, testType: r.test_type, testDate: r.test_date,
            batchName: r.batch_name, courseTitle: r.course_title, subjects: r.subjects, state
        });
        byStudent.set(r.student_id, list);
    }
    return byStudent;
}
