export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public override readonly message: string,
    public readonly code: string = 'http_error',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'bad_request', details);

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, message, 'unauthorized');

export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, message, 'forbidden');

export const notFound = (message = 'Resource not found') =>
  new HttpError(404, message, 'not_found');

export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, message, 'conflict', details);

export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, message, 'unprocessable_entity', details);

export const bankAccountRequired = (message?: string) =>
  new HttpError(403, message ?? 'Link a bank account to continue', 'bank_account_required');
