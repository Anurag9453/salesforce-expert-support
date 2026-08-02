"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client.
 *
 * Sign-in and sign-out only. Nothing here is an authorization decision — the
 * server rebuilds the Actor from the database on every request (requirement 4).
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
});

export const { signIn, signUp, signOut, useSession } = authClient;
