import { CreditError } from './credits';

export type ApiUser = {
  id: string;
  role: string;
  ageConfirmedAt: Date | null;
  deletionRequestedAt?: Date | null;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
type Contract<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
};
type RouteOptions<T> = {
  authenticate: (request: Request) => Promise<ApiUser | null>;
  schema?: Contract<T>;
  admin?: boolean;
  allowDeletionPending?: boolean;
  handler: (context: {
    user: ApiUser;
    input: T;
    request: Request;
  }) => Promise<unknown>;
};

function safeErrorCategory(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === '42P01' || code === '42703') return 'DATABASE_SCHEMA';
  if (code === '23505' || code === '23503' || code === '23514')
    return 'DATABASE_CONSTRAINT';
  if (
    typeof code === 'string' &&
    (/^08[0-9A-Z]{3}$/.test(code) || code === '53300')
  )
    return 'DATABASE_CONNECTION';
  return 'UNKNOWN';
}
export function createApiHandler<T = undefined>(options: RouteOptions<T>) {
  return async (request: Request): Promise<Response> => {
    try {
      const user = await options.authenticate(request);
      if (!user)
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      if (user.deletionRequestedAt && !options.allowDeletionPending)
        throw new ApiError(
          403,
          'ACCOUNT_DELETION_PENDING',
          'Account deletion is in progress. Use the deletion status page to retry.',
        );
      if (options.admin && user.role !== 'admin')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'This action is available to administrators only.',
        );
      let input: T = undefined as T;
      if (options.schema) {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new ApiError(
            400,
            'INVALID_INPUT',
            'Send a valid JSON request.',
          );
        }
        const parsed = options.schema.safeParse(body);
        if (!parsed.success)
          throw new ApiError(
            400,
            'INVALID_INPUT',
            'Check the information you entered.',
          );
        input = parsed.data;
      }
      const data = await options.handler({ user, input, request });
      return Response.json(
        { data },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      if (error instanceof ApiError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      if (error instanceof CreditError) {
        const status = {
          NOT_FOUND: 404,
          ACTION_IN_PROGRESS: 409,
          INSUFFICIENT_CREDITS: 402,
          INVALID_INPUT: 400,
          HOLD_NOT_ACTIVE: 409,
          ACCOUNT_DELETION_PENDING: 403,
        }[error.code];
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status },
        );
      }
      const incomingId = request.headers.get('x-request-id');
      const requestId =
        incomingId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          incomingId,
        )
          ? incomingId
          : crypto.randomUUID();
      console.error(
        JSON.stringify({
          event: 'api_failure',
          source: 'create_api_handler',
          code: 'INTERNAL_ERROR',
          category: safeErrorCategory(error),
          requestId,
        }),
      );
      return Response.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The request could not be completed. Try again.',
          },
        },
        { status: 500, headers: { 'X-Request-Id': requestId } },
      );
    }
  };
}
