import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@sfx/db";
import { getContainer } from "./container.js";
import { serverEnv } from "./env.js";

/**
 * Better Auth (§5, Q4).
 *
 * Identity lives in our own Postgres, which is what makes the future React
 * Native client possible without renting the user table (§29). The bearer/JWT
 * plugin for mobile is wired when mobile arrives; V1 is cookie-session web.
 *
 * The auth session model is named `AuthSession` in the schema so it cannot be
 * confused with `SupportSession` — in a support product, two things called
 * "session" is a footgun waiting for an incident.
 */
function build() {
  const env = serverEnv();

  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {};

  return betterAuth({
    appName: "Salesforce Expert Support",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      /*
        On, because every other vetting step assumes we can reach the person we
        approved. An expert is someone we will put in front of a customer's
        production org; "an admin clicked approve" means very little if the
        address on the account belongs to nobody.

        The cost is real and worth naming: with the console mailer the
        verification link is printed to the terminal rather than delivered, so a
        production launch needs a mail provider behind `Mailer` before anyone
        outside the team can register.
      */
      requireEmailVerification: true,
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      /*
        Routed through the same `Mailer` port as every other email rather than a
        provider SDK, so swapping the console mailer for a real one is a
        composition-root change and touches nothing here.
      */
      sendVerificationEmail: async ({ user, url }) => {
        const { mailer } = getContainer();
        await mailer.send({
          to: user.email,
          subject: "Confirm your email address",
          text: `Confirm your email address to finish setting up your account:\n\n${url}\n\nIf you did not sign up, ignore this message.`,
          html: `<p>Confirm your email address to finish setting up your account.</p><p><a href="${url}">Confirm my email</a></p><p>If you did not sign up, ignore this message.</p>`,
          // One send per user per link: a double-submitted form should not mean
          // two emails.
          idempotencyKey: `verify:${user.id}`,
        });
      },
    },

    socialProviders: google,

    // Map to our model names. `user`, `account`, `verification` already match.
    session: {
      modelName: "authSession",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    // Roles and status carry Prisma defaults (CUSTOMER / ACTIVE), so signup does
    // not need to declare them. Phase 2 owns role assignment and the admin path.
  });
}

export type Auth = ReturnType<typeof build>;

let cached: Auth | undefined;

/** Lazy so a missing BETTER_AUTH_SECRET fails on first use, not at import time. */
export function getAuth(): Auth {
  cached ??= build();
  return cached;
}
