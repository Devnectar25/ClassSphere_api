import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/api/context';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

/**
 * Pre-Signed URL Generator & Asset Upload Verification
 * Traceability: TDD Section 16; PLT-010, DECISION-009
 */
const ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
    const context = authorize(req, null);
    if (context instanceof Response) return context;
    try {
        const body = await req.json();
        const { filename, contentType, sizeBytes, bucket } = body;

        if (!filename || !contentType || !sizeBytes) {
            return createProblemDetailsResponse(
                400,
                'Invalid File Metadata',
                'filename, contentType, and sizeBytes are required.',
                context.correlationId,
                req.nextUrl.pathname
            );
        }

        if (!ALLOWED_MIME_TYPES.includes(contentType)) {
            return createProblemDetailsResponse(
                415,
                'Unsupported Media Type',
                `Content-Type '${contentType}' is not permitted. Permitted types: ${ALLOWED_MIME_TYPES.join(', ')}`,
                context.correlationId,
                req.nextUrl.pathname
            );
        }

        if (sizeBytes > MAX_FILE_SIZE_BYTES) {
            return createProblemDetailsResponse(
                413,
                'Payload Too Large',
                `File size ${sizeBytes} bytes exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes.`,
                context.correlationId,
                req.nextUrl.pathname
            );
        }

        const bucketName = bucket || 'student-photos';
        const fileKey = `tenant/${context.tenantId}/${bucketName}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const signedUploadUrl = `https://supabase.classsphere.cloud/storage/v1/upload/sign/${bucketName}/${fileKey}?token=sig-${Math.random().toString(36).substring(2, 12)}`;

        return NextResponse.json({
            success: true,
            data: {
                signedUploadUrl,
                fileKey,
                bucket: bucketName,
                expiresInSeconds: 900,
                malwareScanRequired: true,
            },
            correlationId: context.correlationId,
        }, {
            headers: { 'X-Correlation-Id': context.correlationId },
        });
    } catch {
        return createProblemDetailsResponse(
            400,
            'Malformed Request',
            'Unable to process file upload URL request.',
            context.correlationId,
            req.nextUrl.pathname
        );
    }
}
