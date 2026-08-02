import { API_ERROR_STATUS, type ApiErrorCode } from "@sfx/contracts";
import { isDomainError, ValidationError } from "@sfx/domain";
import { NextResponse } from "next/server";
import { type z } from "zod";
import { getContainer } from "./container.js";

/**
 * The thin layer between HTTP and the domain (§36).
 *
 * Route handlers do three things: authenticate, validate, and translate. All
 * business rules and every authorization decision live in the domain services
 * these call.
 */

export function apiOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true as const, data }, { status });
}

export function apiFail(
  code: ApiErrorCode,
  message: string,
  fields?: Record<string, string[]>,
): NextResponse {
  return NextResponse.json(
    { ok: false as const, error: { code, message, ...(fields ? { fields } : {}) } },
    { status: API_ERROR_STATUS[code] },
  );
}

/**
 * Maps a thrown domain error to its HTTP response.
 *
 * Domain errors carry their own ApiErrorCode, so the status is not re-derived
 * from a message string. Anything else is logged and returned as a generic 500:
 * an unexpected failure must not leak a stack trace or a query fragment to the
 * caller (§30).
 */
export async function handleRoute(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      return apiFail("VALIDATION_ERROR", error.message, error.fields);
    }
    if (isDomainError(error)) {
      return apiFail(error.code, error.message);
    }
    getContainer().logger.error("unhandled route error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return apiFail("INTERNAL_ERROR", "Something went wrong.");
  }
}

/** Parse a JSON body against a schema, or produce a field-level 400. */
export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: apiFail("VALIDATION_ERROR", "Request body must be valid JSON.") };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_";
      (fields[key] ??= []).push(issue.message);
    }
    return { ok: false, response: apiFail("VALIDATION_ERROR", "Invalid request.", fields) };
  }
  return { ok: true, data: result.data };
}
