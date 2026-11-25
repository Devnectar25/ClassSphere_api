import { NextRequest } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import { batchInScope, requireStudentInScope, staffScope } from '@/lib/api/scope';

/**
 * Attendance Log, Daily Roll Call, Student & Staff Attendance API
 * Traceability: TDD Section 10.4, PLT-006
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;
    const params = req.nextUrl.searchParams;
    const batchId = params.get('batchId');
    const from = params.get('from');
    const to = params.get('to');
    const studentId = params.get('studentId');
    const date = params.get('date');
    const type = params.get('type');

    // Case 0: Staff Attendance Roll Call by branch and session date
    if (type === 'staff' && date) {
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS tenant.staff_attendance_records (
                    attendance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    tenant_id UUID NOT NULL,
                    branch_id UUID,
                    user_id UUID NOT NULL,
                    session_date DATE NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'excused', 'late')),
                    remarks TEXT,
                    recorded_by_actor_id UUID NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                    UNIQUE(tenant_id, user_id, session_date)
                );
            `);

            const branchParam = params.get('branchId');
            const effectiveBranch = context.restrictedBranchId ?? ((branchParam && branchParam !== 'all') ? branchParam : context.branchId);
            const staffList = await callFn<Array<{
                membershipId: string;
                userId: string;
                fullName: string;
                email: string;
                phone: string;
                role: string;
                title: string;
                isActive: boolean;
                branchId: string;
                branchName: string;
                batches: string;
            }>>('tenant.fn_staff_list', context.tenantId, effectiveBranch);

            const existingRecords = await query<{
                user_id: string;
                status: string;
                remarks: string | null;
            }>(
                `SELECT user_id, status, remarks FROM tenant.staff_attendance_records WHERE tenant_id = $1 AND session_date = $2`,
                [context.tenantId, date]
            );

            const rates = await query<{
                user_id: string;
                total: string;
                present: string;
            }>(
                `SELECT user_id, COUNT(*) as total, COUNT(*) FILTER (WHERE status IN ('present', 'late')) as present 
                 FROM tenant.staff_attendance_records 
                 WHERE tenant_id = $1 GROUP BY user_id`,
                [context.tenantId]
            );

            const recordMap = new Map(existingRecords.map(r => [r.user_id, r]));
            const rateMap = new Map(rates.map(r => {
                const tot = Number(r.total || 0);
                const pr = Number(r.present || 0);
                return [r.user_id, { sessionsMarked: tot, sessionsAttended: pr }];
            }));

            const staffWithAttendance = (staffList || []).map(s => {
                const rec = recordMap.get(s.userId);
                return {
                    userId: s.userId,
                    name: s.fullName,
                    email: s.email,
                    phone: s.phone,
                    role: s.role,
                    title: s.title,
                    branchId: s.branchId,
                    branchName: s.branchName,
                    batches: s.batches,
                    status: rec?.status || null,
                    remarks: rec?.remarks || null,
                    ...(rateMap.get(s.userId) ?? { sessionsMarked: 0, sessionsAttended: 0 }),
                };
            });

            return ok(context, {
                sessionDate: date,
                branchId: effectiveBranch,
                staff: staffWithAttendance,
            });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    // Case 1: Particular student's daily attendance history and statistics
    if (studentId) {
        try {
            await requireStudentInScope(context, studentId);
            const data = await callFn<{ student: { enrolledBatches: Array<{ batchId: string }> }; records: Array<{ batchId: string; status: string }> }>('academics.fn_student_attendance_get',
                context.tenantId, studentId, from || null, to || null);
            const scope = await staffScope(context);
            if (!scope) return ok(context, data);
            const records = data.records.filter(r => scope.batchIds.includes(r.batchId));
            const count = (...statuses: string[]) => records.filter(r => statuses.includes(r.status)).length;
            return ok(context, {
                ...data, records,
                student: { ...data.student, enrolledBatches: data.student.enrolledBatches.filter(b => scope.batchIds.includes(b.batchId)) },
                summary: {
                    total: records.length, present: count('present'), absent: count('absent'), late: count('late'), excused: count('excused'),
                    rate: records.length > 0 ? Math.round((count('present', 'late') / records.length) * 100) : 100,
                },
            });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    // Case 2: Daily roll call for a batch on a specific session date
    if (batchId && date) {
        try {
            if (!(await batchInScope(context, batchId))) return problem(context, req, 403, 'Forbidden', 'This batch is not available to you.');
            const data = await callFn<{ students: Array<{ studentId: string }> }>('academics.fn_attendance_daily_get',
                context.tenantId, batchId, date);
            // Counts behind the overall rate (all batches): a student with no record has no rate, not 100%
            const counts = await query<{ student_id: string; marked: number; attended: number }>(
                `SELECT student_id, COUNT(*)::int AS marked, COUNT(*) FILTER (WHERE status IN ('present', 'late'))::int AS attended
                 FROM academics.attendance_records WHERE tenant_id = $1 AND student_id = ANY($2::uuid[]) GROUP BY student_id`,
                [context.tenantId, data.students.map(s => s.studentId)]);
            const byStudent = new Map(counts.map(c => [c.student_id, c]));
            return ok(context, {
                ...data,
                students: data.students.map(s => ({
                    ...s, sessionsMarked: byStudent.get(s.studentId)?.marked ?? 0, sessionsAttended: byStudent.get(s.studentId)?.attended ?? 0,
                })),
            });
        } catch (err) {
            return fail(err, context, req);
        }
    }

    // Case 3: Batch register grid over date range
    if (!batchId || !from || !to) {
        return problem(context, req, 400, 'Validation Error', 'batchId, from, and to (or studentId, or batchId and date) query parameters are required.');
    }

    try {
        if (!(await batchInScope(context, batchId))) return problem(context, req, 403, 'Forbidden', 'This batch is not available to you.');
        return ok(context, await callFn('academics.fn_attendance_register', context.tenantId, batchId, from, to));
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'attendance.write');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const { type, sessionDate, records, studentId, status, remarks } = body;
        let batchId = body.batchId;

        // Staff attendance bulk mark
        if (type === 'staff') {
            if (!sessionDate || !Array.isArray(records)) {
                return problem(context, req, 400, 'Validation Error', 'sessionDate and records array are required for staff attendance.');
            }

            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS tenant.staff_attendance_records (
                        attendance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        tenant_id UUID NOT NULL,
                        branch_id UUID,
                        user_id UUID NOT NULL,
                        session_date DATE NOT NULL,
                        status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'excused', 'late')),
                        remarks TEXT,
                        recorded_by_actor_id UUID NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                        UNIQUE(tenant_id, user_id, session_date)
                    );
                `);

                for (const r of records) {
                    if (!r.userId || !r.status) continue;
                    await query(`
                        INSERT INTO tenant.staff_attendance_records (
                            tenant_id, branch_id, user_id, session_date, status, remarks, recorded_by_actor_id
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (tenant_id, user_id, session_date)
                        DO UPDATE SET
                            status = EXCLUDED.status,
                            remarks = EXCLUDED.remarks,
                            recorded_by_actor_id = EXCLUDED.recorded_by_actor_id,
                            created_at = clock_timestamp();
                    `, [
                        context.tenantId,
                        r.branchId || null,
                        r.userId,
                        sessionDate,
                        r.status,
                        r.remarks || null,
                        context.actorId
                    ]);
                }

                return ok(context, { savedCount: records.length, sessionDate });
            } catch (err) {
                return fail(err, context, req);
            }
        }

        let effectiveRecords = records;
        if (!effectiveRecords && studentId) {
            effectiveRecords = [{ studentId, status: status || 'present', remarks: remarks || null }];
        }

        // Auto-resolve batchId from student enrollments if not explicitly provided
        if (!batchId && studentId) {
            const enrolled = await query<{ batch_id: string }>(
                `SELECT batch_id FROM academics.enrollments WHERE student_id = $1 AND tenant_id = $2 AND status = 'enrolled' LIMIT 1`,
                [studentId, context.tenantId]
            );
            batchId = enrolled[0]?.batch_id;
            if (!batchId) {
                const anyBatch = await query<{ batch_id: string }>(
                    `SELECT batch_id FROM academics.batches WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
                    [context.tenantId]
                );
                batchId = anyBatch[0]?.batch_id;
            }
        }

        if (!batchId || !sessionDate || !Array.isArray(effectiveRecords)) {
            return problem(context, req, 400, 'Validation Error', 'batchId, sessionDate, and records (or studentId) are required.');
        }
        if (!(await batchInScope(context, batchId))) {
            return problem(context, req, 403, 'Forbidden', 'This batch is not available to you.');
        }

        const result = await callFn('academics.fn_attendance_mark_batch',
            context.tenantId, batchId, sessionDate, JSON.stringify(effectiveRecords), context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function DELETE(req: NextRequest) {
    const context = await authorize(req, 'attendance.write');
    if (context instanceof Response) return context;

    try {
        const params = req.nextUrl.searchParams;
        const studentId = params.get('studentId');
        const sessionDate = params.get('sessionDate');

        if (!studentId || !sessionDate) {
            return problem(context, req, 400, 'Validation Error', 'studentId and sessionDate are required.');
        }

        await requireStudentInScope(context, studentId);
        // The day's records of the student are removed together: all of them must be in the user's batches
        for (const r of await query<{ batch_id: string }>(
            `SELECT DISTINCT batch_id FROM academics.attendance_records WHERE tenant_id = $1 AND student_id = $2 AND session_date = $3::date`, [context.tenantId, studentId, sessionDate])) {
            if (!(await batchInScope(context, r.batch_id))) return problem(context, req, 403, 'Forbidden', 'This day includes attendance of a batch that is not available to you.');
        }
        const result = await callFn('academics.fn_attendance_delete_record',
            context.tenantId, studentId, sessionDate, context.actorId);
        return ok(context, result);
    } catch (err) {
        return fail(err, context, req);
    }
}
