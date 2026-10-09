export interface FieldError {
  field: string;
  message: string;
}

/** An error whose message is safe to show to API clients. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errors: FieldError[] = [],
    public readonly code?: string,
    /** Structured, client-safe context (e.g. the matching leads of a duplicate conflict). */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message = 'Bad request', errors: FieldError[] = []) {
    return new ApiError(400, message, errors, 'BAD_REQUEST');
  }
  static validation(errors: FieldError[]) {
    return new ApiError(422, 'Validation failed', errors, 'VALIDATION_FAILED');
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, message, [], 'UNAUTHORIZED');
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, message, [], 'FORBIDDEN');
  }
  static notFound(entity = 'Resource') {
    return new ApiError(404, `${entity} not found`, [], 'NOT_FOUND');
  }
  static conflict(message: string, errors: FieldError[] = []) {
    return new ApiError(409, message, errors, 'CONFLICT');
  }
  static tooManyRequests(message = 'Too many requests, please try again later') {
    return new ApiError(429, message, [], 'RATE_LIMITED');
  }
}
