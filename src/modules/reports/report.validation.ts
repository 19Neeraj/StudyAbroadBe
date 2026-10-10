import { z } from '../../docs/zod.js';
import { REPORTS } from './report.catalog.js';

export const exportBody = z
  .object({
    report: z.enum(REPORTS.map((r) => r.key) as [string, ...string[]]),
    format: z.enum(['csv', 'xlsx']).default('xlsx'),
    params: z.record(z.string().max(60), z.string().max(4000)).default({}).openapi({ description: 'Same query parameters as the matching list screen (filters, dates, nested filter)' }),
  })
  .openapi('ReportExportRequest');
