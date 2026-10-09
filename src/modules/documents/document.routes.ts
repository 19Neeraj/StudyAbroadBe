import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { z } from '../../docs/zod.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { checklistBody, createChecklist, documentDownloadUrl, documentListQuery, getDocument, listDocuments, reviewBody, reviewDocument, uploadDocument, uploadFields } from './document.service.js';

/** In-memory upload (bytes go straight to object storage); size enforced while streaming. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.DOCUMENT_MAX_MB * 1024 * 1024, files: 1, fields: 10 } }).single('file');
function uploadMiddleware(req: Request, res: Response, next: NextFunction) {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(ApiError.validation([{ field: 'file', message: err.code === 'LIMIT_FILE_SIZE' ? `Files must be ${env.DOCUMENT_MAX_MB} MB or smaller` : err.message }]));
    }
    next(err);
  });
}

const m = createModuleRouter('/documents', 'Documents');

m.route({ method: 'get', path: '/', summary: 'Documents of a student (or application) with a checklist summary', permissions: ['document.view'], query: documentListQuery, handler: async ({ ctx, query }) => ({ data: await listDocuments(ctx, query) }) });
m.route({ method: 'post', path: '/checklist', summary: 'Request documents: creates "required" checklist items', permissions: ['document.upload'], body: checklistBody, successStatus: 201, handler: async ({ ctx, body }) => ({ message: 'Checklist updated', data: await createChecklist(ctx, body) }) });
m.route({
  method: 'post',
  path: '/upload',
  summary: 'Upload a document (multipart/form-data: file + fields)',
  description: `PDF, JPG, PNG, WEBP, DOC or DOCX up to ${env.DOCUMENT_MAX_MB} MB, verified by file content. Re-uploading keeps previous versions.`,
  permissions: ['document.upload'],
  middlewares: [uploadMiddleware],
  body: uploadFields,
  successStatus: 201,
  handler: async ({ ctx, body, req }) => ({ message: 'Document uploaded', data: await uploadDocument(ctx, body, req.file) }),
});
m.route({ method: 'get', path: '/:id', summary: 'Document details and version history', permissions: ['document.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await getDocument(ctx, params.id) }) });
m.route({
  method: 'get',
  path: '/:id/download',
  summary: 'Signed, short-lived link to the file (or a previous version); access is audited',
  permissions: ['document.view'],
  params: idParams,
  query: z.object({ versionId: z.string().regex(/^[a-f\d]{24}$/i).optional(), inline: z.enum(['true', 'false']).optional() }),
  handler: async ({ ctx, params, query }) => ({ data: await documentDownloadUrl(ctx, params.id, query.versionId, query.inline === 'true') }),
});
m.route({
  method: 'patch',
  path: '/:id/review',
  summary: 'Approve, reject, request re-upload or mark under review',
  description: 'approve needs document.approve; reject/reupload need document.reject and a reason.',
  permissions: ['document.view'],
  params: idParams,
  body: reviewBody,
  handler: async ({ ctx, params, body }) => ({ message: 'Document reviewed', data: await reviewDocument(ctx, params.id, body) }),
});

export const documentModule = m;
