export interface ApiError {
  status: number;
  error: string;
  detail: string;
}

export function makeError(
  status: number,
  error: string,
  detail: string
): ApiError {
  return { status, error, detail };
}

export const Errors = {
  unauthorized: (detail = 'Authorization header required'): ApiError =>
    makeError(401, 'unauthorized', detail),

  forbidden: (detail = 'Insufficient permissions'): ApiError =>
    makeError(403, 'forbidden', detail),

  notFound: (resource = 'Resource'): ApiError =>
    makeError(404, 'not_found', `${resource} not found`),

  conflict: (detail = 'Resource already exists'): ApiError =>
    makeError(409, 'conflict', detail),

  badRequest: (detail: string): ApiError =>
    makeError(400, 'bad_request', detail),

  validationError: (detail: string): ApiError =>
    makeError(400, 'validation_error', detail),

  payloadTooLarge: (detail = 'Request body too large'): ApiError =>
    makeError(413, 'payload_too_large', detail),

  unprocessable: (detail: string): ApiError =>
    makeError(422, 'unprocessable', detail),

  serviceUnavailable: (detail = 'Service temporarily unavailable'): ApiError =>
    makeError(503, 'service_unavailable', detail),

  internalError: (detail = 'Internal server error'): ApiError =>
    makeError(500, 'internal_error', detail),
};
