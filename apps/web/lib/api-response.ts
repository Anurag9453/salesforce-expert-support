import { API_ERROR_STATUS, type ApiError, type ApiErrorCode } from "@sfx/contracts";
import { NextResponse } from "next/server";

/**
 * Every /api/v1 route returns the same envelope, so the future mobile client
 * writes one response handler rather than one per endpoint (§29).
 */
export function apiOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true as const, data }, { status: 200, ...init });
}

export function apiFail(
  code: ApiErrorCode,
  message: string,
  extra?: Pick<ApiError, "fields" | "requestId">,
): NextResponse {
  return NextResponse.json(
    { ok: false as const, error: { code, message, ...extra } },
    { status: API_ERROR_STATUS[code] },
  );
}
