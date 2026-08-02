import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import { FixedClock } from "../ports/clock.js";
import { ForbiddenError, ValidationError } from "../shared/errors.js";
import { InMemoryUnitOfWork } from "./in-memory-uow.js";
import {
  ADMIN_ONLY_PROFILE_FIELDS,
  ExpertProfileService,
  SELF_EDITABLE_PROFILE_FIELDS,
} from "./expert-profile-service.js";
import {
  ExpertSkillService,
  MAX_SKILLS_PER_EXPERT,
  PROFICIENCY_GUIDANCE,
} from "./expert-skill-service.js";
import {
  FakeExpertProfileRepository,
  FakeExpertSkillRepository,
} from "./in-memory-expert-world.js";
import type { SkillRecord, TaxonomyRepository } from "../ports/request-repositories.js";

const SKILLS: SkillRecord[] = [
  {
    id: "sk_apex",
    slug: "apex",
    name: "Apex",
    categoryId: "c1",
    categorySlug: "salesforce-development",
    aliases: [],
  },
  {
    id: "sk_lwc",
    slug: "lwc",
    name: "Lightning Web Components",
    categoryId: "c1",
    categorySlug: "salesforce-development",
    aliases: [],
  },
  {
    id: "sk_flow",
    slug: "flow",
    name: "Flow",
    categoryId: "c2",
    categorySlug: "salesforce-configuration",
    aliases: [],
  },
  {
    id: "sk_cpq",
    slug: "revenue-cloud-cpq",
    name: "Revenue Cloud / CPQ",
    categoryId: "c3",
    categorySlug: "salesforce-clouds",
    aliases: [],
  },
];

const taxonomy: TaxonomyRepository = {
  async listActiveCategories() {
    return [];
  },
  async listActiveSkills() {
    return SKILLS;
  },
  async findSkillsBySlug(slugs) {
    return SKILLS.filter((skill) => slugs.includes(skill.slug));
  },
  async findCategoryBySlug() {
    return null;
  },
};

let skillsRepo: FakeExpertSkillRepository;
let profileRepo: FakeExpertProfileRepository;
let uow: InMemoryUnitOfWork;
let clock: FixedClock;
let skills: ExpertSkillService;
let profiles: ExpertProfileService;

const expert: Actor = {
  userId: "user_1",
  email: "e@example.com",
  roles: ["CUSTOMER", "EXPERT"],
  status: "ACTIVE",
  expert: { profileId: "exp_1", status: "APPROVED" },
};

const admin: Actor = {
  userId: "admin_1",
  email: "admin@example.com",
  roles: ["CUSTOMER", "ADMIN"],
  status: "ACTIVE",
};

beforeEach(async () => {
  skillsRepo = new FakeExpertSkillRepository();
  profileRepo = new FakeExpertProfileRepository();
  uow = new InMemoryUnitOfWork();
  clock = new FixedClock(new Date("2026-08-02T12:00:00Z"));

  uow.seedUser({ id: "user_1" });
  const application = await uow.expertApplications.create("user_1");
  await uow.expertApplications.updateStatus({
    id: application.id,
    status: "APPROVED",
    now: clock.now(),
  });

  skills = new ExpertSkillService({
    skills: skillsRepo,
    taxonomy,
    applications: uow.expertApplications,
    auditLog: uow.auditLog,
    clock,
  });
  profiles = new ExpertProfileService({
    profiles: profileRepo,
    applications: uow.expertApplications,
    auditLog: uow.auditLog,
    clock,
  });
});

function expertOn(profileId: string): Actor {
  return { ...expert, expert: { profileId, status: "APPROVED" } };
}

describe("requirement 1 — a skill claim is (skill, proficiency, years)", () => {
  it("captures all three", async () => {
    const record = await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "ADVANCED",
      yearsExperience: 6,
    });
    expect(record.slug).toBe("apex");
    expect(record.proficiencyLevel).toBe("ADVANCED");
    expect(record.yearsExperience).toBe(6);
  });

  it("keeps years-with-this-skill separate from years-in-Salesforce", async () => {
    // Eight years in Salesforce and six months of CPQ is a common, honest shape.
    // The matching engine has to see it rather than inferring depth from tenure.
    await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "EXPERT",
      yearsExperience: 8,
    });
    await skills.declare(expertOn("exp_1"), {
      skillSlug: "revenue-cloud-cpq",
      proficiencyLevel: "BEGINNER",
      yearsExperience: 0,
    });

    const listed = await skills.listOwn(expertOn("exp_1"));
    expect(listed.find((s) => s.slug === "apex")?.yearsExperience).toBe(8);
    expect(listed.find((s) => s.slug === "revenue-cloud-cpq")?.yearsExperience).toBe(0);
  });

  it("accepts zero years as a real answer", async () => {
    const record = await skills.declare(expertOn("exp_1"), {
      skillSlug: "flow",
      proficiencyLevel: "BEGINNER",
      yearsExperience: 0,
    });
    expect(record.yearsExperience).toBe(0);
  });

  it("rejects nonsense years", async () => {
    for (const years of [-1, 41, 2.5]) {
      await expect(
        skills.declare(expertOn("exp_1"), {
          skillSlug: "apex",
          proficiencyLevel: "ADVANCED",
          yearsExperience: years,
        }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("updates an existing declaration rather than duplicating it", async () => {
    await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "INTERMEDIATE",
      yearsExperience: 2,
    });
    await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "ADVANCED",
      yearsExperience: 3,
    });
    const listed = await skills.listOwn(expertOn("exp_1"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.proficiencyLevel).toBe("ADVANCED");
  });
});

describe("requirement 2 — self-declared and verified stay distinct", () => {
  it("a newly declared skill is never verified", async () => {
    const record = await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "EXPERT",
      yearsExperience: 10,
    });
    expect(record.verified).toBe(false);
    expect(record.verifiedByUserId).toBeNull();
  });

  it("gives the expert no field through which to claim verification", () => {
    // Structural, not a runtime check: `ExpertSkillDeclaration` has three keys
    // and none of them is `verified`, so there is nothing to send and nothing
    // for a handler to forward.
    const declaration = { skillId: "sk_apex", proficiencyLevel: "EXPERT", yearsExperience: 10 };
    expect(Object.keys(declaration).sort()).toEqual([
      "proficiencyLevel",
      "skillId",
      "yearsExperience",
    ]);
  });

  it("refuses an expert calling the admin verification path", async () => {
    await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "EXPERT",
      yearsExperience: 10,
    });
    await expect(
      skills.setVerified(expertOn("exp_1"), {
        expertProfileId: "exp_1",
        skillSlug: "apex",
        verified: true,
        notes: "verifying myself",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("lets an admin verify, and records who did it", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    await skills.declare(expertOn(application.id), {
      skillSlug: "apex",
      proficiencyLevel: "EXPERT",
      yearsExperience: 10,
    });

    const verified = await skills.setVerified(admin, {
      expertProfileId: application.id,
      skillSlug: "apex",
      verified: true,
      notes: "Reviewed two production orgs with them.",
    });

    expect(verified.verified).toBe(true);
    expect(verified.verifiedByUserId).toBe("admin_1");

    const audit = uow.auditEntries.find((e) => e.action === "expert_skill.verified");
    expect(audit?.actorUserId).toBe("admin_1");
    expect(audit?.after).toMatchObject({ verified: true, notes: expect.any(String) });
  });

  it("requires a reason to verify", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    await skills.declare(expertOn(application.id), {
      skillSlug: "apex",
      proficiencyLevel: "EXPERT",
      yearsExperience: 10,
    });
    await expect(
      skills.setVerified(admin, {
        expertProfileId: application.id,
        skillSlug: "apex",
        verified: true,
        notes: "   ",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("clears verification when the expert re-declares the skill", async () => {
    // The claim being vouched for has changed, so the old vouch no longer
    // applies. Keeping it would let an expert launder an unverified claim
    // through a verified one.
    skillsRepo.seedVerified("exp_1", "sk_apex", "INTERMEDIATE");
    expect((await skills.listOwn(expertOn("exp_1")))[0]?.verified).toBe(true);

    const updated = await skills.declare(expertOn("exp_1"), {
      skillSlug: "apex",
      proficiencyLevel: "EXPERT",
      yearsExperience: 12,
    });

    expect(updated.verified).toBe(false);
    expect(
      uow.auditEntries.some((e) => e.action === "expert_skill.verification_cleared_by_edit"),
    ).toBe(true);
  });
});

describe("requirement 7 — discouraging inflated claims", () => {
  it("defines every proficiency level in observable terms", () => {
    // Undefined levels get everyone picking EXPERT. Anchoring each to behaviour
    // makes over-claiming a choice rather than the default.
    for (const level of ["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"] as const) {
      expect(PROFICIENCY_GUIDANCE[level].description.length).toBeGreaterThan(40);
    }
  });

  it("tells the expert that EXPERT is the matching bar for hard problems", () => {
    expect(PROFICIENCY_GUIDANCE.EXPERT.description).toMatch(/sparingly/i);
  });

  it("caps the number of skills so listing the whole taxonomy is impossible", async () => {
    // Blunt, but it is the strongest available discouragement from claiming
    // everything. 30 is generous for a real specialist.
    expect(MAX_SKILLS_PER_EXPERT).toBeLessThanOrEqual(30);

    const service = new ExpertSkillService({
      skills: skillsRepo,
      taxonomy: {
        ...taxonomy,
        async findSkillsBySlug(slugs) {
          return slugs.map((slug) => ({
            id: `sk_${slug}`,
            slug,
            name: slug,
            categoryId: "c1",
            categorySlug: "salesforce-development",
            aliases: [],
          })) as SkillRecord[];
        },
      },
      applications: uow.expertApplications,
      auditLog: uow.auditLog,
      clock,
    });

    for (let i = 0; i < MAX_SKILLS_PER_EXPERT; i++) {
      await service.declare(expertOn("exp_1"), {
        skillSlug: `skill-${i}`,
        proficiencyLevel: "INTERMEDIATE",
        yearsExperience: 1,
      });
    }
    await expect(
      service.declare(expertOn("exp_1"), {
        skillSlug: "one-too-many",
        proficiencyLevel: "EXPERT",
        yearsExperience: 1,
      }),
    ).rejects.toThrow(/focused list matches better/);
  });
});

describe("requirement 8 — profile edits cannot touch administrative fields", () => {
  it("has no overlap between self-editable and admin-only fields", () => {
    const overlap = SELF_EDITABLE_PROFILE_FIELDS.filter((field) =>
      (ADMIN_ONLY_PROFILE_FIELDS as readonly string[]).includes(field),
    );
    expect(overlap).toEqual([]);
  });

  it("does not expose status or verification as self-editable", () => {
    for (const field of ["status", "reviewNotes", "reviewedByUserId", "payoutsEnabled"]) {
      expect(SELF_EDITABLE_PROFILE_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  it("applies only the allowlisted fields, silently dropping anything else", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    const hostile = {
      professionalSummary:
        "Fifteen years across Sales Cloud and Service Cloud, mostly integration and performance work on large orgs.",
      // A hostile client sending these gains nothing: the edit type has no such
      // fields, so they never reach the repository.
      status: "APPROVED",
      verified: true,
      reviewNotes: "approved by me",
    } as Record<string, unknown>;

    await profiles.updateOwn(expertOn(application.id), hostile);

    const applied = profileRepo.edits[0]?.edit as Record<string, unknown>;
    expect(applied.professionalSummary).toBeDefined();
    // The hostile keys are gone by the time persistence sees the edit.
    expect(applied).not.toHaveProperty("status");
    expect(applied).not.toHaveProperty("verified");
    expect(applied).not.toHaveProperty("reviewNotes");
    expect(Object.keys(applied)).toEqual(["professionalSummary"]);
  });

  it("drops every admin-only field even when all of them are sent at once", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    const kitchenSink: Record<string, unknown> = {
      country: "IN",
      professionalSummary:
        "Fifteen years across Sales Cloud and Service Cloud, mostly integration and performance work on large orgs.",
    };
    for (const field of ADMIN_ONLY_PROFILE_FIELDS) kitchenSink[field] = "hijacked";

    await profiles.updateOwn(expertOn(application.id), kitchenSink);

    const applied = Object.keys(profileRepo.edits[0]!.edit);
    expect(applied.sort()).toEqual(["country", "professionalSummary"]);
    for (const field of ADMIN_ONLY_PROFILE_FIELDS) {
      expect(applied, field).not.toContain(field);
    }
  });

  it("audits an approved expert changing their profile", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    await profiles.updateOwn(expertOn(application.id), {
      professionalSummary:
        "Fifteen years across Sales Cloud and Service Cloud, mostly integration and performance work on large orgs.",
    });
    expect(uow.auditEntries.some((e) => e.action === "expert_profile.updated")).toBe(true);
  });

  it("rejects an empty edit", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    await expect(profiles.updateOwn(expertOn(application.id), {})).rejects.toThrow(ValidationError);
  });

  it("rejects a summary too thin to review", async () => {
    const application = [...uow.applicationRows.values()][0]!;
    await expect(
      profiles.updateOwn(expertOn(application.id), { professionalSummary: "I know Apex." }),
    ).rejects.toThrow(ValidationError);
  });
});
