import { NextRequest, NextResponse } from 'next/server';
import { callFn, query } from '@/lib/db/db';
import { generatePassword, hashPassword } from '@/lib/auth';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';

/**
 * Students Directory & Enrollment API — branch-scoped
 * Traceability: TDD Section 10.4, PLT-003, PLT-006
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'students.read');
    if (context instanceof Response) return context;
    const searchParams = req.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const branchParam = searchParams.get('branchId');
    const effectiveBranch = (branchParam && branchParam !== 'all') ? branchParam : context.branchId;

    try {
        const result = await callFn<{ total: number }>('academics.fn_student_search',
            context.tenantId, effectiveBranch, searchParams.get('q') || null, searchParams.get('status') || null, limit, offset);
        const res = ok(context, result) as NextResponse;
        res.headers.set('X-Total-Count', String(result.total));
        return res;
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    const context = await authorize(req, 'students.write');
    if (context instanceof Response) return context;

    try {
        // Entitlement limit check (PLT-005, PLT-006)
        const check = await callFn<{ allowed: boolean; maximum: number; planTier: string }>(
            'tenant.fn_entitlement_check', context.tenantId, 'seats');
        if (!check.allowed) {
            return problem(context, req, 402, 'Subscription Entitlement Exceeded',
                `Seat limit of ${check.maximum} reached for ${check.planTier} tier. Upgrade subscription to enroll more students.`);
        }

        const body = await req.json();
        const firstName = String(body.firstName ?? '').trim();
        const lastName = String(body.lastName ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        const rawPhone = String(body.phone ?? '').trim();
        const countryCode = String(body.countryCode ?? '+91').trim();
        const photo = typeof body.photo === 'string' && body.photo ? body.photo.trim() : null;
        const { dateOfBirth, matriculationYear, academicStanding, batchId, branchId } = body;

        if (!firstName || !lastName || !email) {
            return problem(context, req, 400, 'Validation Error', 'First name, last name, and email are required fields.');
        }
        if (firstName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(firstName)) {
            return problem(context, req, 400, 'Validation Error', 'First name must be at least 2 characters and contain only letters.');
        }
        if (lastName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(lastName)) {
            return problem(context, req, 400, 'Validation Error', 'Last name must be at least 2 characters and contain only letters.');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return problem(context, req, 400, 'Validation Error', 'Enter a valid email address.');
        }
        if (photo && !/^data:image\/(png|jpeg|webp|jpg);base64,/.test(photo)) {
            return problem(context, req, 400, 'Validation Error', 'Student photo must be a valid PNG, JPG, or WebP image data URL.');
        }

        let formattedPhone: string | null = null;
        if (rawPhone) {
            let localDigits = rawPhone;
            if (countryCode && localDigits.startsWith(countryCode)) {
                localDigits = localDigits.slice(countryCode.length).trim();
            } else if (localDigits.startsWith('+')) {
                const parts = localDigits.split(/\s+/);
                if (parts.length > 1) {
                    localDigits = parts.slice(1).join('');
                }
            }
            const phoneDigits = localDigits.replace(/\D/g, '');
            const isIndia = countryCode === '+91' || rawPhone.startsWith('+91') || (!countryCode && phoneDigits.length === 10);
            if (isIndia) {
                if (phoneDigits.length !== 10 || !/^[6-9]\d{9}$/.test(phoneDigits)) {
                    return problem(context, req, 400, 'Validation Error', 'Enter a valid 10-digit mobile number starting with 6, 7, 8, or 9.');
                }
            } else {
                if (phoneDigits.length < 7 || phoneDigits.length > 15) {
                    return problem(context, req, 400, 'Validation Error', 'Enter a valid mobile number for the selected country.');
                }
            }
            formattedPhone = `${countryCode} ${phoneDigits}`.trim();
        }

        // Validate guardian information if provided
        const guardian = body.guardian;
        let formattedGuardianPhone: string | null = null;
        if (guardian) {
            if (guardian.mode === 'existing') {
                if (!guardian.guardianId) {
                    return problem(context, req, 400, 'Validation Error', 'Please select an existing guardian to link.');
                }
            } else {
                const gFirstName = String(guardian.firstName ?? '').trim();
                const gLastName = String(guardian.lastName ?? '').trim();
                const gEmail = String(guardian.email ?? '').trim().toLowerCase();
                const gRawPhone = String(guardian.phone ?? '').trim();
                const gCountryCode = String(guardian.countryCode ?? '+91').trim();

                if (!gFirstName || !gLastName) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian first and last name are required.');
                }
                if (gFirstName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(gFirstName)) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian first name must contain only letters and be at least 2 characters.');
                }
                if (gLastName.length < 2 || !/^[a-zA-Z\s'-]+$/.test(gLastName)) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian last name must contain only letters and be at least 2 characters.');
                }
                if (!gEmail || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(gEmail)) {
                    return problem(context, req, 400, 'Validation Error', 'Enter a valid guardian email address.');
                }
                if (!gRawPhone) {
                    return problem(context, req, 400, 'Validation Error', 'Guardian phone number is required.');
                }

                let gLocalDigits = gRawPhone;
                if (gCountryCode && gLocalDigits.startsWith(gCountryCode)) {
                    gLocalDigits = gLocalDigits.slice(gCountryCode.length).trim();
                } else if (gLocalDigits.startsWith('+')) {
                    const parts = gLocalDigits.split(/\s+/);
                    if (parts.length > 1) gLocalDigits = parts.slice(1).join('');
                }
                const gDigits = gLocalDigits.replace(/\D/g, '');
                const isGIndia = gCountryCode === '+91' || gRawPhone.startsWith('+91') || (!gCountryCode && gDigits.length === 10);
                if (isGIndia) {
                    if (gDigits.length !== 10 || !/^[6-9]\d{9}$/.test(gDigits)) {
                        return problem(context, req, 400, 'Validation Error', 'Enter a valid 10-digit mobile number for the guardian starting with 6, 7, 8, or 9.');
                    }
                } else {
                    if (gDigits.length < 7 || gDigits.length > 15) {
                        return problem(context, req, 400, 'Validation Error', 'Enter a valid mobile number for the guardian.');
                    }
                }
                formattedGuardianPhone = `${gCountryCode} ${gDigits}`.trim();
            }
        }

        // Branch-scoped users always enroll into their own branch
        const result = await callFn<{ studentId: string; enrollmentNumber: string }>('academics.fn_student_create',
            context.tenantId, firstName, lastName, email, formattedPhone, dateOfBirth || null, null,
            matriculationYear || null, academicStanding || null, batchId || null,
            context.branchId ?? branchId ?? null, context.actorId);

        if (photo && result?.studentId) {
            await query(
                `UPDATE academics.students SET profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{photo}', $1::jsonb) WHERE student_id = $2 AND tenant_id = $3`,
                [JSON.stringify(photo), result.studentId, context.tenantId]
            );
        }

        // Process initial fee option if selected
        const feeStatus = body.feeStatus ? String(body.feeStatus).trim().toLowerCase() : 'none';
        const rawFeeAmount = body.feeAmount !== undefined && body.feeAmount !== null && body.feeAmount !== '' ? Number(body.feeAmount) : null;

        if (result?.studentId && (feeStatus === 'pending' || feeStatus === 'paid')) {
            let courseTitle = '';
            let amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : 0;

            if (batchId) {
                const batchRows = await query<{ course_title: string; tuition_amount: string }>(
                    `SELECT c.title as course_title, c.tuition_amount FROM academics.batches b JOIN academics.courses c ON c.course_id = b.course_id WHERE b.batch_id = $1 AND b.tenant_id = $2`,
                    [batchId, context.tenantId]
                );
                if (batchRows.length > 0) {
                    courseTitle = batchRows[0].course_title || '';
                    if (amount === 0 && Number(batchRows[0].tuition_amount) > 0) {
                        amount = Number(batchRows[0].tuition_amount);
                    }
                }
            }

            if (amount > 0) {
                const now = new Date();
                const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
                const period = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
                const countRows = await query<{ count: string }>(
                    `SELECT COUNT(*) as count FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                    [context.tenantId, `INV-${yyyymm}-%`]
                );
                const seq = parseInt(countRows[0]?.count || '0', 10) + 1;
                const invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                const designation = `${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition — ${period}`;
                const isPaid = feeStatus === 'paid';
                const dueDate = isPaid ? now : new Date(Date.now() + 15 * 86400000);

                const invRows = await query<{ invoice_id: string }>(
                    `INSERT INTO billing.invoices (
                        tenant_id, invoice_number, student_id, billing_period,
                        subtotal_amount, total_amount, paid_amount, balance_amount,
                        due_date, status, designation, idempotency_key
                    ) VALUES (
                        $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11
                    ) RETURNING invoice_id`,
                    [
                        context.tenantId,
                        invNo,
                        result.studentId,
                        period,
                        amount,
                        isPaid ? amount : 0,
                        isPaid ? 0 : amount,
                        dueDate,
                        isPaid ? 'paid' : 'pending',
                        designation,
                        `student-create-${result.studentId}`
                    ]
                );

                if (isPaid && invRows.length > 0) {
                    const rcpNo = `RCP-${yyyymm}-${String(seq).padStart(4, '0')}`;
                    await query(
                        `INSERT INTO billing.payments (
                            tenant_id, invoice_id, student_id, payment_reference, amount,
                            payment_method, status, receipt_number, recorded_by_actor_id
                        ) VALUES (
                            $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                        )`,
                        [
                            context.tenantId,
                            invRows[0].invoice_id,
                            result.studentId,
                            `ADM-${result.enrollmentNumber || result.studentId.slice(0, 8)}`,
                            amount,
                            rcpNo,
                            context.actorId
                        ]
                    );
                }
            }
        }

        let guardianCredentials: { name: string; email: string; password?: string } | null = null;
        if (result?.studentId && guardian) {
            if (guardian.mode === 'existing' && guardian.guardianId) {
                await callFn('academics.fn_guardian_link_student', context.tenantId, guardian.guardianId, result.studentId, context.actorId);
            } else if (guardian.firstName && guardian.lastName) {
                const gFirstName = String(guardian.firstName).trim();
                const gLastName = String(guardian.lastName).trim();
                const gEmail = String(guardian.email).trim().toLowerCase();
                const createdGuardian = await callFn<{ guardianId: string }>('academics.fn_guardian_create',
                    context.tenantId, gFirstName, gLastName, guardian.relationship || 'Parent', formattedGuardianPhone || guardian.phone, gEmail, [result.studentId], context.actorId);

                if (guardian.createLogin && createdGuardian?.guardianId) {
                    const password = generatePassword();
                    const login = await callFn<{ email: string }>('academics.fn_guardian_portal_enable',
                        context.tenantId, createdGuardian.guardianId, hashPassword(password), context.actorId);
                    guardianCredentials = { name: `${gFirstName} ${gLastName}`, email: login.email, password };
                }
            }
        }

        return ok(context, { ...result, credentials: guardianCredentials }, 201);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function PUT(req: NextRequest) {
    const context = await authorize(req, 'students.write');
    if (context instanceof Response) return context;

    try {
        const body = await req.json();
        const studentId = body.studentId;
        if (!studentId) {
            return problem(context, req, 400, 'Validation Error', 'Student ID is required.');
        }

        const firstName = String(body.firstName ?? '').trim();
        const lastName = String(body.lastName ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        const phone = body.phone ? String(body.phone).trim() : null;
        const status = body.status ? String(body.status).trim() : 'active';
        const branchId = body.branchId || null;
        const batchId = body.batchId || null;

        if (!firstName || !lastName || !email) {
            return problem(context, req, 400, 'Validation Error', 'First name, last name, and email are required fields.');
        }

        // Check if student is being transferred/migrated to another branch
        const existingStudentRows = await query<{ branch_id: string }>(
            `SELECT branch_id FROM academics.students WHERE student_id = $1 AND tenant_id = $2`,
            [studentId, context.tenantId]
        );
        const oldBranchId = existingStudentRows[0]?.branch_id;
        const newBranchId = branchId || null;
        const isBranchSwitched = Boolean(newBranchId && oldBranchId && newBranchId !== oldBranchId);

        // Update student record with tenant scoping
        const updateRes = await query<{
            student_id: string;
            enrollment_number: string;
            first_name: string;
            last_name: string;
            email: string;
            phone: string | null;
            status: string;
        }>(
            `UPDATE academics.students
             SET first_name = $1,
                 last_name = $2,
                 email = $3,
                 phone = $4,
                 status = $5,
                 branch_id = COALESCE($6, branch_id),
                 updated_at = clock_timestamp()
             WHERE student_id = $7 AND tenant_id = $8
             RETURNING student_id, enrollment_number, first_name, last_name, email, phone, status`,
            [firstName, lastName, email, phone, status, newBranchId, studentId, context.tenantId]
        );

        if (updateRes.length === 0) {
            return problem(context, req, 404, 'Not Found', 'Student not found.');
        }

        // When switching/migrating student to another branch, remove them from batches belonging to the previous branch
        if (isBranchSwitched) {
            await query(
                `DELETE FROM academics.enrollments
                 WHERE student_id = $1
                   AND tenant_id = $2
                   AND batch_id IN (
                       SELECT batch_id FROM academics.batches
                       WHERE branch_id <> $3 AND tenant_id = $2
                   )`,
                [studentId, context.tenantId, newBranchId]
            );
        }

        // If batchId is specified, enroll or update student batch enrollment
        if (batchId) {
            await query(
                `INSERT INTO academics.enrollments (tenant_id, student_id, batch_id, status)
                 VALUES ($1, $2, $3, 'enrolled')
                 ON CONFLICT (student_id, batch_id) DO UPDATE SET status = 'enrolled'`,
                [context.tenantId, studentId, batchId]
            );
        }

        // Process fee status update if provided
        const feeStatus = body.feeStatus ? String(body.feeStatus).trim().toLowerCase() : null;
        const rawFeeAmount = body.feeAmount !== undefined && body.feeAmount !== null && body.feeAmount !== '' ? Number(body.feeAmount) : null;

        if (feeStatus) {
            const existingInvoices = await query<{ invoice_id: string; total_amount: string; status: string; balance_amount: string }>(
                `SELECT invoice_id, total_amount, status, balance_amount FROM billing.invoices WHERE student_id = $1 AND tenant_id = $2 AND status <> 'void' ORDER BY created_at DESC LIMIT 1`,
                [studentId, context.tenantId]
            );

            if (existingInvoices.length > 0) {
                const inv = existingInvoices[0];
                const amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : Number(inv.total_amount);

                if (feeStatus === 'paid') {
                    await query(
                        `UPDATE billing.invoices SET total_amount = $1, subtotal_amount = $1, paid_amount = $1, balance_amount = 0, status = 'paid', updated_at = clock_timestamp() WHERE invoice_id = $2`,
                        [amount, inv.invoice_id]
                    );
                    const existingPayments = await query<{ payment_id: string }>(
                        `SELECT payment_id FROM billing.payments WHERE invoice_id = $1 AND tenant_id = $2`,
                        [inv.invoice_id, context.tenantId]
                    );
                    if (existingPayments.length === 0) {
                        const now = new Date();
                        const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
                        const countRows = await query<{ count: string }>(
                            `SELECT COUNT(*) as count FROM billing.payments WHERE tenant_id = $1 AND receipt_number LIKE $2`,
                            [context.tenantId, `RCP-${yyyymm}-%`]
                        );
                        const seq = parseInt(countRows[0]?.count || '0', 10) + 1;
                        const rcpNo = `RCP-${yyyymm}-${String(seq).padStart(4, '0')}`;
                        await query(
                            `INSERT INTO billing.payments (
                                tenant_id, invoice_id, student_id, payment_reference, amount,
                                payment_method, status, receipt_number, recorded_by_actor_id
                            ) VALUES (
                                $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                            )`,
                            [
                                context.tenantId,
                                inv.invoice_id,
                                studentId,
                                `STU-UPD-${studentId.slice(0, 8)}`,
                                amount,
                                rcpNo,
                                context.actorId
                            ]
                        );
                    }
                } else if (feeStatus === 'pending') {
                    await query(
                        `UPDATE billing.invoices SET total_amount = $1, subtotal_amount = $1, paid_amount = 0, balance_amount = $1, status = 'pending', updated_at = clock_timestamp() WHERE invoice_id = $2`,
                        [amount, inv.invoice_id]
                    );
                } else if (feeStatus === 'none') {
                    await query(
                        `UPDATE billing.invoices SET status = 'void', balance_amount = 0, updated_at = clock_timestamp() WHERE invoice_id = $1`,
                        [inv.invoice_id]
                    );
                }
            } else if (feeStatus === 'pending' || feeStatus === 'paid') {
                let courseTitle = '';
                let amount = rawFeeAmount !== null && !isNaN(rawFeeAmount) && rawFeeAmount > 0 ? rawFeeAmount : 0;

                const effectiveBatchId = batchId || (
                    await query<{ batch_id: string }>(
                        `SELECT batch_id FROM academics.enrollments WHERE student_id = $1 AND status = 'enrolled' LIMIT 1`,
                        [studentId]
                    )
                )[0]?.batch_id;

                if (effectiveBatchId) {
                    const batchRows = await query<{ course_title: string; tuition_amount: string }>(
                        `SELECT c.title as course_title, c.tuition_amount FROM academics.batches b JOIN academics.courses c ON c.course_id = b.course_id WHERE b.batch_id = $1`,
                        [effectiveBatchId]
                    );
                    if (batchRows.length > 0) {
                        courseTitle = batchRows[0].course_title || '';
                        if (amount === 0 && Number(batchRows[0].tuition_amount) > 0) {
                            amount = Number(batchRows[0].tuition_amount);
                        }
                    }
                }

                if (amount > 0) {
                    const now = new Date();
                    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
                    const period = now.toLocaleString('en-US', { month: 'short', year: 'numeric' });
                    const countRows = await query<{ count: string }>(
                        `SELECT COUNT(*) as count FROM billing.invoices WHERE tenant_id = $1 AND invoice_number LIKE $2`,
                        [context.tenantId, `INV-${yyyymm}-%`]
                    );
                    const seq = parseInt(countRows[0]?.count || '0', 10) + 1;
                    const invNo = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;
                    const designation = `${courseTitle ? courseTitle.trim() + ' ' : ''}Tuition — ${period}`;
                    const isPaid = feeStatus === 'paid';
                    const dueDate = isPaid ? now : new Date(Date.now() + 15 * 86400000);

                    const invRows = await query<{ invoice_id: string }>(
                        `INSERT INTO billing.invoices (
                            tenant_id, invoice_number, student_id, billing_period,
                            subtotal_amount, total_amount, paid_amount, balance_amount,
                            due_date, status, designation, idempotency_key
                        ) VALUES (
                            $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11
                        ) RETURNING invoice_id`,
                        [
                            context.tenantId,
                            invNo,
                            studentId,
                            period,
                            amount,
                            isPaid ? amount : 0,
                            isPaid ? 0 : amount,
                            dueDate,
                            isPaid ? 'paid' : 'pending',
                            designation,
                            `student-update-${studentId}-${Date.now()}`
                        ]
                    );

                    if (isPaid && invRows.length > 0) {
                        const rcpNo = `RCP-${yyyymm}-${String(seq).padStart(4, '0')}`;
                        await query(
                            `INSERT INTO billing.payments (
                                tenant_id, invoice_id, student_id, payment_reference, amount,
                                payment_method, status, receipt_number, recorded_by_actor_id
                            ) VALUES (
                                $1, $2, $3, $4, $5, 'Cash', 'posted', $6, $7
                            )`,
                            [
                                context.tenantId,
                                invRows[0].invoice_id,
                                studentId,
                                `STU-UPD-${studentId.slice(0, 8)}`,
                                amount,
                                rcpNo,
                                context.actorId
                            ]
                        );
                    }
                }
            }
        }

        // Audit compliance log
        await query(
            `INSERT INTO audit.compliance_logs (tenant_id, actor_id, action, entity_type, entity_id, correlation_id, details)
             VALUES ($1, $2, 'student.updated', 'student', $3, gen_random_uuid(), $4::jsonb)`,
            [
                context.tenantId,
                context.actorId,
                studentId,
                JSON.stringify({
                    name: `${firstName} ${lastName}`,
                    status,
                    phone,
                    batchId: batchId || undefined,
                })
            ]
        );

        return ok(context, { success: true, student: updateRes[0] });
    } catch (err) {
        return fail(err, context, req);
    }
}
