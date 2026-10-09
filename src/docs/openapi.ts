import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from './zod.js';

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Access token from POST /auth/login or /auth/refresh',
});

export const ErrorResponse = registry.register(
  'ErrorResponse',
  z.object({
    success: z.literal(false),
    message: z.string(),
    code: z.string().optional(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })),
    details: z.unknown().optional(),
  }),
);

export const PaginationSchema = registry.register(
  'Pagination',
  z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() }),
);

export function generateOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Study Abroad CRM API',
      version: '1.0.0',
      description:
        'Multi-tenant CRM API. All responses use the `{ success, message, data }` envelope. ' +
        'The organization is always derived from the access token and never read from the request.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
