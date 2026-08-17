import { z } from "zod";

/**
 * Envelope shared by every /api/v1 response.
 *
 * A single shape means the future mobile client writes one response handler
 * rather than one per endpoint, and errors are never bare strings.
 */

export const apiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "ILLEGAL_STATE_TRANSITION",
  "RATE_LIMITED",
  "PAYMENT_REQUIRED",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  /** Field-level detail for VALIDATION_ERROR. */
  fields: z.record(z.array(z.string())).optional(),
  /** Correlates a client-visible failure with the server log line. */
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiSuccessSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

export const apiFailureSchema = z.object({ ok: z.literal(false), error: apiErrorSchema });

export function apiResponseSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion("ok", [apiSuccessSchema(data), apiFailureSchema]);
}

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = z.infer<typeof apiFailureSchema>;
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** HTTP status per error code, so route handlers never hand-pick one. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ILLEGAL_STATE_TRANSITION: 409,
  RATE_LIMITED: 429,
  PAYMENT_REQUIRED: 402,
  INTERNAL_ERROR: 500,
};

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  checks: z.record(z.object({ ok: z.boolean(), detail: z.string().optional() })),
  /**
   * Temporary: what the deployed function can see on disk.
   *
   * Present only on previews and locally, never in production. Here to settle
   * where Prisma's query engine actually lands in a Vercel function, after three
   * attempts that each looked correct locally and failed deployed. Remove this,
   * and its producer, once the engine loads.
   */
  diagnostics: z.record(z.string()).optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
