#!/usr/bin/env node
/**
 * Grant a role to an existing user.
 *
 * The bootstrap problem: the admin queue needs an admin, and there is
 * deliberately no self-service route to the ADMIN role — a UI that can mint
 * admins is a UI that can be abused into minting one. So the first admin is
 * created out of band, by someone with database access, and the action is
 * written to the audit log like any other privilege change.
 *
 *   pnpm --filter @sfx/db grant-role -- <email> ADMIN
 */
import { PrismaClient } from "@prisma/client";

const VALID_ROLES = ["CUSTOMER", "EXPERT", "ADMIN"];

const [email, role] = process.argv.slice(2);

if (!email || !role) {
  console.error("usage: grant-role <email> <CUSTOMER|EXPERT|ADMIN>");
  process.exit(1);
}
if (!VALID_ROLES.includes(role)) {
  console.error(`invalid role "${role}" — expected one of ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, roles: true },
  });

  if (!user) {
    console.error(`no user with email ${email} — they must sign up first`);
    process.exit(1);
  }

  if (user.roles.includes(role)) {
    console.log(`${user.email} already has ${role} (roles: ${user.roles.join(", ")})`);
    process.exit(0);
  }

  const nextRoles = [...user.roles, role];

  // The grant and its audit row commit together, so a privilege change can
  // never exist without a record of it.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { roles: { set: nextRoles } } });
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorType: "SYSTEM",
        action: "user.role_granted",
        entityType: "User",
        entityId: user.id,
        before: { roles: user.roles },
        after: { roles: nextRoles, grantedVia: "grant-role script", role },
      },
    });
  });

  console.log(`${user.email} → ${nextRoles.join(", ")}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
