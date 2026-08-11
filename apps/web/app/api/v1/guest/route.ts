import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { guestIntakeSchema } from "@sfx/contracts";
import { ANONYMOUS, RATE_LIMITS } from "@sfx/domain";
import { getAuth } from "@/lib/auth";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Guest intake — an account without the signup form.
 *
 * A customer with a broken production org is not in the mood to choose a
 * password, and asking them to is where they leave. So this takes a name and an
 * email and nothing else.
 *
 * ## Why it still creates a real account
 *
 * "No signup" cannot mean "no identity". Four things need one, and none of them
 * are optional:
 *
 *   - `createRequest` authorizes a customer and needs a customer profile.
 *   - Payment needs somebody to charge and an address for the receipt.
 *   - The realtime channel is derived from the session, so without one the
 *     customer sits on a dead page while matching happens.
 *   - Without an account they can never return to the request. Close the tab and
 *     it is gone.
 *
 * So the *password* is deferred, not the identity. The account is real from the
 * first moment; it simply has a password nobody knows.
 *
 * ## The unknown password
 *
 * Better Auth requires one, so we generate 32 cryptographically random bytes,
 * hand them straight to the signup call, and drop them. It is never logged,
 * never returned, and never stored anywhere we can read.
 *
 * That is a deliberate property rather than a workaround: an account whose
 * password is unguessable *and* unknown to us can only be re-entered through the
 * email the customer already gave, which is exactly the security posture we want.
 * They set a real password later if they choose.
 *
 * An existing email is NOT signed in here — that would be an account takeover
 * with a known email as the only credential. It returns a flag and the UI offers
 * sign-in instead.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    // Already signed in: nothing to do, and certainly nothing to create.
    const actor = await getActor();
    if (actor !== ANONYMOUS) {
      return apiOk({ created: false, alreadySignedIn: true, existingAccount: false });
    }

    // Keyed by IP rather than user — there is no user yet, and this endpoint
    // creates accounts, so it is the one that most needs a ceiling.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown";
    const limited = await enforceRateLimit(`guest:${ip}`, RATE_LIMITS.REQUEST_CREATE);
    if (limited) return limited;

    const body = await parseBody(request, guestIntakeSchema);
    if (!body.ok) return body.response;

    const auth = getAuth();
    const password = randomBytes(32).toString("base64url");

    try {
      const result = await auth.api.signUpEmail({
        body: { email: body.data.email, password, name: body.data.name },
        // Returning the response lets Better Auth set the session cookie, which
        // is the entire point — they must leave this call signed in.
        asResponse: true,
      });

      if (!result.ok) {
        // Overwhelmingly "that email already exists". Say so without confirming
        // it outright, and let the UI offer sign-in.
        return apiOk({ created: false, alreadySignedIn: false, existingAccount: true });
      }

      // Built by hand rather than through apiOk, because the whole point is to
      // forward Better Auth's Set-Cookie headers — the customer must leave this
      // call with a live session.
      const response = NextResponse.json(
        {
          ok: true as const,
          data: { created: true, alreadySignedIn: false, existingAccount: false },
        },
        { status: 201 },
      );
      for (const cookie of result.headers.getSetCookie()) {
        response.headers.append("set-cookie", cookie);
      }
      return response;
    } catch {
      return apiOk({ created: false, alreadySignedIn: false, existingAccount: true });
    }
  });
}
