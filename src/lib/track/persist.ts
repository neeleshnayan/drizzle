/**
 * Themes → Versions → Applications → Outcome-events. The tracking spine:
 * a theme is a strategic angle, a version is a frozen résumé snapshot under it,
 * an application records where a version was sent, and events are the funnel.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  profiles,
  experiences,
  education,
  skills,
  projects,
  certifications,
  sources,
  resumeThemes,
  resumeVersions,
  applications,
  applicationEvents,
  opportunities,
  insights,
} from "@/db/schema";
import { getFullProfile } from "@/lib/profile/read";
import { embedBge } from "@/lib/embeddings";

async function profileIdFor(userId: string): Promise<string> {
  const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!p) throw new Error("Profile not found");
  return p.id;
}

// ---- themes ----
export async function createTheme(userId: string, name: string, latentAttributes: Record<string, unknown> = {}) {
  const pid = await profileIdFor(userId);
  const [row] = await db
    .insert(resumeThemes)
    .values({ profileId: pid, name, latentAttributes })
    .returning();
  return row;
}

export async function listThemes(userId: string) {
  const pid = await profileIdFor(userId);
  return db.select().from(resumeThemes).where(eq(resumeThemes.profileId, pid)).orderBy(asc(resumeThemes.createdAt));
}

export const TBD_THEME_NAME = "TBD — after mentor call";

/** On first upload: seed a "Default" theme + a placeholder target-role theme the
 *  mentor call fills in later. Idempotent — does nothing if themes already exist. */
export async function ensureStarterThemes(userId: string) {
  const pid = await profileIdFor(userId);
  const existing = await db.select({ id: resumeThemes.id }).from(resumeThemes).where(eq(resumeThemes.profileId, pid)).limit(1);
  if (existing.length) return;
  await db.insert(resumeThemes).values([
    { profileId: pid, name: "Default", latentAttributes: { kind: "default" } },
    { profileId: pid, name: TBD_THEME_NAME, latentAttributes: { kind: "target_role", pending: true } },
  ]);
}

/** After a mentor call: set the target-role theme to what the call landed on.
 *  Every call retunes the direction, not just the first — so we update the
 *  EXISTING target-role theme (by kind, whatever it's now named), falling back to
 *  the pending TBD seed, and creating one if neither exists. The old version only
 *  matched the TBD *name*, so call 2+ (after the theme was renamed) silently
 *  no-op'd and the ranking direction froze at whatever call 1 decided. */
/**
 * A JD is not a direction. Distill a role LABEL (often a specific posting title —
 * "Senior GTM Engineer, Marketing Operations (Remote, UK&I) — Fixed Term @ Webflow")
 * into a durable career-TRAJECTORY phrase ("Senior GTM Engineer, Marketing
 * Operations"): drop the company, office/location, and employment-type noise;
 * keep role family + domain + altitude. Deterministic (no LLM) so it's free +
 * instant. Domain parens like "(Web3/FinTech)" are kept — that's trajectory, not
 * noise. This is the "keywords that resonate as a trajectory" seam.
 */
const LOC_OR_TYPE = /\b(remote|hybrid|onsite|on-site|contract|fixed[-\s]?term|full[-\s]?time|part[-\s]?time|intern(ship)?|temp(orary)?|uk&?i|emea|apac|amer|us|usa|uk|india|london|nyc|new york|san francisco|sf|bangalore|bengaluru|remote-first|w-?2|c2c)\b/i;
export function distillDirection(raw: string): string {
  let s = (raw || "").trim();
  s = s.split(/\s+@\s+/)[0]; // drop "@ Company"
  // drop parens ONLY when they're location/employment noise (keep domain parens)
  s = s.replace(/\s*\(([^)]*)\)/g, (m, inner) => (LOC_OR_TYPE.test(inner) ? "" : m));
  // drop a trailing "— Fixed Term / - Remote / – 6 months" style tail
  s = s.replace(/\s*[-–—]\s*[^-–—]*$/g, (m) => (LOC_OR_TYPE.test(m) || /\d+\s*months?/i.test(m) ? "" : m));
  s = s.replace(/,?\s*\b(remote|hybrid|onsite)\b/gi, ""); // stray work-mode words
  s = s.replace(/\s{2,}/g, " ").replace(/[\s,–—-]+$/g, "").trim();
  return s || raw.trim();
}

/** Recompute + store the user's bge direction vector (profiles.direction_bge) so
 *  the Cloudflare Edge ranker gets live semantic trajectory without a manual
 *  sweep. Mirrors tools/direction-vec-sweep for one user. direction_bge lives in
 *  the DB but not the Drizzle schema, so the write is raw SQL. Best-effort — the
 *  sweep tool remains the backstop. */
async function refreshDirectionBge(pid: string, role: string) {
  try {
    const asp = await db
      .select({ content: insights.content })
      .from(insights)
      .where(and(eq(insights.profileId, pid), sql`${insights.dimension} in ('aspiration','value')`))
      .orderBy(desc(insights.createdAt))
      .limit(3);
    const aspSents = asp.map((r) => r.content ?? "").filter(Boolean);
    // bge is symmetric — plain text, no "search_query:" prefix
    const text = [role && `Target role: ${role}.`, ...aspSents].filter(Boolean).join(" ").trim();
    if (!text) return;
    const [vec] = await embedBge([text]);
    if (!vec?.length) return;
    await db.execute(sql`UPDATE profiles SET direction_bge = ${`[${vec.join(",")}]`}::vector WHERE id = ${pid}`);
  } catch {
    /* best-effort — direction-vec-sweep is the backstop */
  }
}

export async function fillTargetTheme(userId: string, rawRole: string, rationale: string) {
  const role = distillDirection(rawRole); // JD → trajectory
  const pid = await profileIdFor(userId);
  const themes = await db
    .select({ id: resumeThemes.id, name: resumeThemes.name, latentAttributes: resumeThemes.latentAttributes })
    .from(resumeThemes)
    .where(eq(resumeThemes.profileId, pid));
  // prefer the pending TBD seed (first call); else the already-filled target-role
  // theme (later calls); else nothing to update.
  const target =
    themes.find((t) => t.name === TBD_THEME_NAME) ??
    themes.find((t) => (t.latentAttributes as { kind?: string } | null)?.kind === "target_role");
  const latentAttributes = { kind: "target_role" as const, role, rationale };
  if (target) {
    await db
      .update(resumeThemes)
      .set({ name: `Target: ${role}`, latentAttributes })
      .where(eq(resumeThemes.id, target.id));
  } else {
    // safety: a user whose starter themes never seeded still gets a target theme
    await db.insert(resumeThemes).values({ profileId: pid, name: `Target: ${role}`, latentAttributes });
  }
  // keep the CF Edge ranker's direction vector fresh (bge) for this new direction
  await refreshDirectionBge(pid, role);
  return { ok: true as const };
}

// ---- versions ----
/** Snapshot the user's current résumé (content + style) as a version. */
export async function createVersion(
  userId: string,
  opts: { themeId?: string; hypothesis?: string; label?: string },
) {
  const pid = await profileIdFor(userId);
  const full = await getFullProfile(userId);
  if (!full) throw new Error("Profile not found");
  const [row] = await db
    .insert(resumeVersions)
    .values({
      profileId: pid,
      themeId: opts.themeId ?? null,
      hypothesis: opts.hypothesis ?? null,
      label: opts.label ?? null,
      content: full as unknown as Record<string, unknown>,
    })
    .returning({ id: resumeVersions.id, createdAt: resumeVersions.createdAt });
  return row;
}

export async function listVersions(userId: string) {
  const pid = await profileIdFor(userId);
  return db
    .select({
      id: resumeVersions.id,
      themeId: resumeVersions.themeId,
      label: resumeVersions.label,
      hypothesis: resumeVersions.hypothesis,
      createdAt: resumeVersions.createdAt,
    })
    .from(resumeVersions)
    .where(eq(resumeVersions.profileId, pid))
    .orderBy(desc(resumeVersions.createdAt));
}

/** Mark which version of a theme is the one to use for applications. */
export async function setActiveVersion(userId: string, themeId: string, versionId: string) {
  const pid = await profileIdFor(userId);
  await db
    .update(resumeThemes)
    .set({ activeVersionId: versionId })
    .where(and(eq(resumeThemes.id, themeId), eq(resumeThemes.profileId, pid)));
  return { ok: true as const };
}

/**
 * Load a saved version back into the live résumé — a destructive replace of the
 * Layer 2 rows + profile style, inside one transaction. The snapshot is
 * immutable, so this is reversible by restoring another version.
 */
export async function restoreVersion(userId: string, versionId: string) {
  const pid = await profileIdFor(userId);
  const [v] = await db
    .select({ content: resumeVersions.content })
    .from(resumeVersions)
    .where(and(eq(resumeVersions.id, versionId), eq(resumeVersions.profileId, pid)))
    .limit(1);
  if (!v) throw new Error("Version not found");

  // the snapshot is a getFullProfile() shape
  const c = v.content as {
    profile?: Record<string, unknown>;
    experiences?: Record<string, unknown>[];
    education?: Record<string, unknown>[];
    skills?: Record<string, unknown>[];
    projects?: Record<string, unknown>[];
    certifications?: Record<string, unknown>[];
  };

  await db.transaction(async (tx) => {
    if (c.profile) {
      const p = c.profile;
      await tx
        .update(profiles)
        .set({
          fullName: (p.fullName as string) ?? null,
          headline: (p.headline as string) ?? null,
          email: (p.email as string) ?? null,
          phone: (p.phone as string) ?? null,
          location: (p.location as string) ?? null,
          links: (p.links as { label: string; url: string }[]) ?? [],
          styleConfig: (p.styleConfig as Record<string, string | number>) ?? {},
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, pid));
    }

    // replace children wholesale (new ids, positions preserved)
    await tx.delete(experiences).where(eq(experiences.profileId, pid));
    await tx.delete(education).where(eq(education.profileId, pid));
    await tx.delete(skills).where(eq(skills.profileId, pid));
    await tx.delete(projects).where(eq(projects.profileId, pid));
    await tx.delete(certifications).where(eq(certifications.profileId, pid));

    if (c.experiences?.length) {
      await tx.insert(experiences).values(
        c.experiences.map((e, i) => ({
          profileId: pid,
          org: (e.org as string) ?? null,
          title: (e.title as string) ?? null,
          employmentType: (e.employmentType as string) ?? null,
          location: (e.location as string) ?? null,
          startDate: (e.startDate as string) ?? null,
          endDate: (e.endDate as string) ?? null,
          isCurrent: (e.isCurrent as boolean) ?? false,
          position: (e.position as number) ?? i,
          bullets: (e.bullets as { text: string }[]) ?? [],
        })),
      );
    }
    if (c.education?.length) {
      await tx.insert(education).values(
        c.education.map((e, i) => ({
          profileId: pid,
          institution: (e.institution as string) ?? null,
          degree: (e.degree as string) ?? null,
          field: (e.field as string) ?? null,
          startDate: (e.startDate as string) ?? null,
          endDate: (e.endDate as string) ?? null,
          details: (e.details as string) ?? null,
          position: (e.position as number) ?? i,
        })),
      );
    }
    if (c.skills?.length) {
      await tx.insert(skills).values(
        c.skills.map((sk, i) => ({
          profileId: pid,
          name: (sk.name as string) ?? "skill",
          category: (sk.category as string) ?? null,
          position: (sk.position as number) ?? i,
        })),
      );
    }
    if (c.projects?.length) {
      await tx.insert(projects).values(
        c.projects.map((pr, i) => ({
          profileId: pid,
          name: (pr.name as string) ?? null,
          description: (pr.description as string) ?? null,
          position: (pr.position as number) ?? i,
          bullets: (pr.bullets as { text: string }[]) ?? [],
        })),
      );
    }
    if (c.certifications?.length) {
      await tx.insert(certifications).values(
        c.certifications.map((ct, i) => ({
          profileId: pid,
          name: (ct.name as string) ?? null,
          issuer: (ct.issuer as string) ?? null,
          date: (ct.date as string) ?? null,
          position: (ct.position as number) ?? i,
        })),
      );
    }

    await tx.insert(sources).values({
      profileId: pid,
      kind: "user_edit",
      metadata: { action: "restore_version", versionId },
    });
  });

  return { ok: true as const };
}

/** Themes with their versions nested — the dashboard's main read. */
export async function getThemesWithVersions(userId: string) {
  const [themes, versions] = await Promise.all([listThemes(userId), listVersions(userId)]);
  const byTheme = new Map<string, typeof versions>();
  const untagged: typeof versions = [];
  for (const v of versions) {
    if (v.themeId) {
      const arr = byTheme.get(v.themeId) ?? [];
      arr.push(v);
      byTheme.set(v.themeId, arr);
    } else {
      untagged.push(v);
    }
  }
  return {
    themes: themes.map((t) => ({ ...t, versions: byTheme.get(t.id) ?? [] })),
    untagged,
  };
}

// ---- applications + outcome events ----
export async function createApplication(
  userId: string,
  input: { company?: string; role?: string; resumeVersionId?: string; opportunityId?: string },
) {
  const pid = await profileIdFor(userId);
  const [app] = await db
    .insert(applications)
    .values({
      profileId: pid,
      company: input.company ?? null,
      role: input.role ?? null,
      resumeVersionId: input.resumeVersionId ?? null,
      opportunityId: input.opportunityId ?? null,
      status: "applied",
    })
    .returning({ id: applications.id });
  await db.insert(applicationEvents).values({ applicationId: app.id, stage: "applied", source: "manual" });
  return app;
}

export async function listApplications(userId: string) {
  const pid = await profileIdFor(userId);
  const rows = await db
    .select({
      id: applications.id,
      company: applications.company,
      role: applications.role,
      status: applications.status,
      notes: applications.notes,
      followUpAt: applications.followUpAt,
      appliedAt: applications.appliedAt,
      resumeVersionId: applications.resumeVersionId,
      themeName: resumeThemes.name,
      opportunityId: applications.opportunityId,
      oppFacts: opportunities.facts,
    })
    .from(applications)
    .leftJoin(resumeVersions, eq(applications.resumeVersionId, resumeVersions.id))
    .leftJoin(resumeThemes, eq(resumeVersions.themeId, resumeThemes.id))
    .leftJoin(opportunities, eq(applications.opportunityId, opportunities.id))
    .where(eq(applications.profileId, pid))
    .orderBy(desc(applications.appliedAt));
  // flatten the joined role facts to what the card's collapsible needs
  return rows.map(({ oppFacts, ...r }) => {
    const f = (oppFacts ?? {}) as { summary?: string; must_have_skills?: string[]; nice_to_have_skills?: string[] };
    return {
      ...r,
      summary: f.summary?.trim() || null,
      skills: [...new Set([...(f.must_have_skills ?? []), ...(f.nice_to_have_skills ?? [])].map((s) => String(s).toLowerCase().trim()).filter(Boolean))].slice(0, 10),
    };
  });
}

/** Kanban card edits — notes and the follow-up nudge date. */
export async function updateApplication(
  userId: string,
  applicationId: string,
  patch: { notes?: string | null; followUpAt?: Date | null },
) {
  const pid = await profileIdFor(userId);
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.profileId, pid)))
    .limit(1);
  if (!app) throw new Error("Application not found");
  const set: Record<string, unknown> = {};
  if ("notes" in patch) set.notes = patch.notes;
  if ("followUpAt" in patch) set.followUpAt = patch.followUpAt;
  if (Object.keys(set).length) await db.update(applications).set(set).where(eq(applications.id, applicationId));
  return { ok: true as const };
}

/** Advance an application to a new stage, recording the funnel event. */
export async function setApplicationStatus(
  userId: string,
  applicationId: string,
  stage: string,
  result?: string,
) {
  const pid = await profileIdFor(userId);
  // ownership check
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.profileId, pid)))
    .limit(1);
  if (!app) throw new Error("Application not found");
  await db.update(applications).set({ status: stage }).where(eq(applications.id, applicationId));
  await db.insert(applicationEvents).values({ applicationId, stage, result: result ?? null, source: "manual" });
  return { ok: true as const };
}
