import { NextRequest } from 'next/server';
import { authorize } from '@/lib/api/context';
import { ok, fail, problem } from '@/lib/api/respond';
import {
    calculateStudentCourseProgress,
    listCourseCompletionCandidates,
    approveCourseCompletion,
    returnCourseCompletion
} from '@/lib/academics/course-completion';

/**
 * Course Completion Management API
 * Step 1-5: Course completion progress tracking, eligibility, review, and finalization
 */
export async function GET(req: NextRequest) {
    const context = await authorize(req, 'academics.read');
    if (context instanceof Response) return context;

    try {
        const { searchParams } = new URL(req.url);
        const enrollmentId = searchParams.get('enrollmentId');

        if (enrollmentId) {
            const progress = await calculateStudentCourseProgress(context.tenantId, enrollmentId);
            if (!progress) {
                return problem(context, req, 404, 'Not Found', 'Course enrollment record not found.');
            }
            return ok(context, progress);
        }

        const branchId = searchParams.get('branchId') || undefined;
        const courseId = searchParams.get('courseId') || undefined;
        const batchId = searchParams.get('batchId') || undefined;
        const status = searchParams.get('status') || undefined;

        const candidates = await listCourseCompletionCandidates(context.tenantId, {
            branchId,
            courseId,
            batchId,
            status
        });

        return ok(context, candidates);
    } catch (err) {
        return fail(err, context, req);
    }
}

export async function POST(req: NextRequest) {
    let context = await authorize(req, 'students.write');
    if (context instanceof Response) {
        context = await authorize(req, 'tests.write');
        if (context instanceof Response) return context;
    }

    try {
        const body = await req.json();
        const { action, enrollmentId, remarks, finalResult, forceApprove } = body;

        if (!enrollmentId) {
            return problem(context, req, 400, 'Validation Error', 'enrollmentId is required.');
        }

        if (action === 'approve') {
            const result = await approveCourseCompletion(context.tenantId, context.actorId, {
                enrollmentId,
                remarks,
                finalResult,
                forceApprove: Boolean(forceApprove)
            });
            return ok(context, result, 200);
        } else if (action === 'return') {
            if (!remarks?.trim()) {
                return problem(context, req, 400, 'Validation Error', 'Remarks are required when returning a course completion for review.');
            }
            const result = await returnCourseCompletion(context.tenantId, context.actorId, {
                enrollmentId,
                remarks: remarks.trim()
            });
            return ok(context, result, 200);
        } else {
            return problem(context, req, 400, 'Validation Error', 'Invalid action. Supported actions are "approve" and "return".');
        }
    } catch (err: any) {
        return problem(context, req, 400, 'Course Completion Error', err.message || 'Operation failed.');
    }
}
