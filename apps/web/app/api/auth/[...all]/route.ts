import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

/**
 * Better Auth mounts its whole surface here — sign-up, sign-in, OAuth callbacks,
 * session, sign-out. Phase 2 builds the UI against it.
 */
const handler = toNextJsHandler(getAuth());

export const GET = handler.GET;
export const POST = handler.POST;
