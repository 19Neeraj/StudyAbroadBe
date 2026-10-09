import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { RouteConfig as OpenApiRoute } from '@asteasolutions/zod-to-openapi';
import { ErrorResponse, PaginationSchema, registry } from '../docs/openapi.js';
import { z } from '../docs/zod.js';
import {
  authenticate,
  authorize,
  type RequiredPermission,
} from '../middlewares/auth.middleware.js';
import { zodToFieldErrors } from '../middlewares/error.middleware.js';
import type { RequestMeta, ServiceContext } from '../types/auth.js';
import { ApiError, type FieldError } from './ApiError.js';
import { sendSuccess, type PaginationMeta } from './apiResponse.js';
import { asyncHandler } from './asyncHandler.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Schema = z.ZodType | undefined;
type ObjectSchema = z.ZodObject | undefined;
type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface HandlerResult {
  data: unknown;
  message?: string;
  status?: number;
  pagination?: PaginationMeta;
}

interface BaseInput<B extends Schema, Q extends ObjectSchema, P extends ObjectSchema> {
  req: Request;
  res: Response;
  body: Out<B>;
  query: Out<Q>;
  params: Out<P>;
  meta: RequestMeta;
}

interface BaseConfig<B extends Schema, Q extends ObjectSchema, P extends ObjectSchema> {
  method: Method;
  /** Express-style path relative to the module base path, e.g. "/:id". */
  path: string;
  summary: string;
  description?: string;
  body?: B;
  query?: Q;
  params?: P;
  /** Schema of `data` in the success envelope (documentation). */
  response?: z.ZodType;
  paginated?: boolean;
  successStatus?: number;
  middlewares?: RequestHandler[];
}

interface ProtectedConfig<
  B extends Schema,
  Q extends ObjectSchema,
  P extends ObjectSchema,
> extends BaseConfig<B, Q, P> {
  permissions?: RequiredPermission[];
  permissionMode?: 'all' | 'any';
  handler: (input: BaseInput<B, Q, P> & { ctx: ServiceContext }) => Promise<HandlerResult | void>;
}

interface PublicConfig<
  B extends Schema,
  Q extends ObjectSchema,
  P extends ObjectSchema,
> extends BaseConfig<B, Q, P> {
  handler: (input: BaseInput<B, Q, P>) => Promise<HandlerResult | void>;
}

export function requestMeta(req: Request): RequestMeta {
  const meta: RequestMeta = {};
  if (req.ip) meta.ip = req.ip;
  const ua = req.headers['user-agent'];
  if (ua) meta.userAgent = ua.slice(0, 512);
  if (req.requestId) meta.requestId = req.requestId;
  return meta;
}

function validate(config: BaseConfig<Schema, ObjectSchema, ObjectSchema>, req: Request) {
  const errors: FieldError[] = [];
  const parse = (schema: z.ZodType | undefined, value: unknown, prefix: string) => {
    if (!schema) return undefined;
    const result = schema.safeParse(value ?? {});
    if (!result.success) {
      errors.push(...zodToFieldErrors(result.error, prefix));
      return undefined;
    }
    return result.data;
  };
  const body = parse(config.body, req.body, 'body');
  const query = parse(config.query, req.query, 'query');
  const params = parse(config.params, req.params, 'params');
  if (errors.length) throw ApiError.validation(errors);
  return { body, query, params };
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/';
}

/**
 * Module router where every route declares its validation, permissions and docs in one place.
 * Registering a route automatically documents it in OpenAPI, so docs cannot drift from code.
 */
export function createModuleRouter(basePath: string, tag: string) {
  const router = Router();

  function document(
    config: BaseConfig<Schema, ObjectSchema, ObjectSchema>,
    permissions: RequiredPermission[] | null,
  ) {
    const dataSchema = config.response ?? z.unknown();
    const envelope = z.object({
      success: z.literal(true),
      message: z.string(),
      data: dataSchema,
      ...(config.paginated ? { pagination: PaginationSchema } : {}),
    });
    const errorContent = { content: { 'application/json': { schema: ErrorResponse } } };
    const responses: OpenApiRoute['responses'] = {
      [config.successStatus ?? 200]: {
        description: 'Success',
        content: { 'application/json': { schema: envelope } },
      },
      500: { description: 'Unexpected error', ...errorContent },
    };
    if (config.body || config.query || config.params)
      responses[422] = { description: 'Validation failed', ...errorContent };
    if (permissions) {
      responses[401] = { description: 'Missing or invalid access token', ...errorContent };
      responses[403] = { description: 'Insufficient permissions', ...errorContent };
    }
    if (config.params) responses[404] = { description: 'Not found', ...errorContent };

    const permissionNote = permissions
      ? permissions.length
        ? `**Permissions:** ${permissions.map((p) => `\`${p}\``).join(', ')}`
        : '**Permissions:** any authenticated user'
      : '**Public endpoint**';

    const request: OpenApiRoute['request'] = {};
    if (config.body) request.body = { content: { 'application/json': { schema: config.body } } };
    if (config.query) request.query = config.query;
    if (config.params) request.params = config.params;

    registry.registerPath({
      method: config.method,
      path: toOpenApiPath(`${basePath}${config.path}`),
      tags: [tag],
      summary: config.summary,
      description: [config.description, permissionNote].filter(Boolean).join('\n\n'),
      ...(permissions ? { security: [{ bearerAuth: [] }] } : {}),
      request,
      responses,
    });
  }

  function mount(
    config: BaseConfig<Schema, ObjectSchema, ObjectSchema>,
    guards: RequestHandler[],
    run: (input: BaseInput<Schema, ObjectSchema, ObjectSchema>) => Promise<HandlerResult | void>,
  ) {
    router[config.method](
      config.path,
      ...guards,
      ...(config.middlewares ?? []),
      asyncHandler(async (req, res) => {
        const { body, query, params } = validate(config, req);
        const result = await run({
          req,
          res,
          body,
          query,
          params,
          meta: requestMeta(req),
        } as BaseInput<Schema, ObjectSchema, ObjectSchema>);
        if (result && !res.headersSent) {
          sendSuccess(res, {
            data: result.data,
            message: result.message ?? 'OK',
            status: result.status ?? config.successStatus ?? 200,
            ...(result.pagination ? { pagination: result.pagination } : {}),
          });
        }
      }),
    );
  }

  return {
    basePath,
    router,

    route<
      B extends Schema = undefined,
      Q extends ObjectSchema = undefined,
      P extends ObjectSchema = undefined,
    >(config: ProtectedConfig<B, Q, P>) {
      const permissions = config.permissions ?? [];
      const guards: RequestHandler[] = [authenticate];
      if (permissions.length) guards.push(authorize(permissions, config.permissionMode));
      document(config, permissions);
      mount(config, guards, (input) => {
        const auth = input.req.auth;
        if (!auth) throw ApiError.unauthorized();
        return config.handler({
          ...(input as BaseInput<B, Q, P>),
          ctx: { ...auth, meta: input.meta },
        });
      });
    },

    publicRoute<
      B extends Schema = undefined,
      Q extends ObjectSchema = undefined,
      P extends ObjectSchema = undefined,
    >(config: PublicConfig<B, Q, P>) {
      document(config, null);
      mount(config, [], (input) => config.handler(input as BaseInput<B, Q, P>));
    },
  };
}

export type ModuleRouter = ReturnType<typeof createModuleRouter>;
