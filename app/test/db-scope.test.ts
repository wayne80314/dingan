import { beforeEach, describe, expect, it } from "vitest";
import { withOrg } from "../src/core/db";
import { newId } from "../src/core/ids";
import { resetDb, testEnv } from "./helpers";

async function seedOrgWithProjects(name: string, projectNames: string[]): Promise<string> {
  const now = Date.now();
  const orgId = newId("org");
  await testEnv.DB.prepare(
    `INSERT INTO organization (id, name, line_provider_id, line_channel_id, created_at)
     VALUES (?, ?, 'p', 'c', ?)`,
  ).bind(orgId, name, now).run();

  for (const p of projectNames) {
    await testEnv.DB.prepare(
      `INSERT INTO project (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(newId("prj"), orgId, p, now).run();
  }
  return orgId;
}

beforeEach(resetDb);

describe("withOrg scoping", () => {
  it("requires the marker, so a query cannot omit the tenant filter by accident", async () => {
    const db = withOrg(testEnv, "org_x");
    await expect(db.all(`SELECT * FROM project`)).rejects.toThrow(/\{\{ORG\}\}/);
  });

  it("returns only the requesting organization's rows", async () => {
    const a = await seedOrgWithProjects("A", ["A1", "A2"]);
    await seedOrgWithProjects("B", ["B1"]);

    const rows = await withOrg(testEnv, a).all<{ name: string }>(
      `SELECT name FROM project WHERE {{ORG}} ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(["A1", "A2"]);
  });

  // Regression guard. Binds are positional, and the marker frequently sits
  // after a placeholder the caller supplied. Prepending the org id instead of
  // splicing it in at the right position transposes the arguments, which
  // matches nothing -- an empty result that reads as "no data" rather than as
  // a bug.
  it("aligns binds when the marker comes after the caller's placeholder", async () => {
    const a = await seedOrgWithProjects("A", ["A1", "A2"]);

    const rows = await withOrg(testEnv, a).all<{ name: string }>(
      `SELECT name FROM project WHERE name = ? AND {{ORG}}`,
      "A2",
    );
    expect(rows.map((r) => r.name)).toEqual(["A2"]);
  });

  it("aligns binds when the marker comes before the caller's placeholder", async () => {
    const a = await seedOrgWithProjects("A", ["A1", "A2"]);

    const rows = await withOrg(testEnv, a).all<{ name: string }>(
      `SELECT name FROM project WHERE {{ORG}} AND name = ?`,
      "A1",
    );
    expect(rows.map((r) => r.name)).toEqual(["A1"]);
  });

  it("aligns binds with placeholders on both sides of the marker", async () => {
    const a = await seedOrgWithProjects("A", ["A1", "A2", "A3"]);

    const rows = await withOrg(testEnv, a).all<{ name: string }>(
      `SELECT name FROM project WHERE name > ? AND {{ORG}} AND name < ? ORDER BY name`,
      "A1",
      "A3",
    );
    expect(rows.map((r) => r.name)).toEqual(["A2"]);
  });

  it("handles several markers in one query", async () => {
    const a = await seedOrgWithProjects("A", ["A1"]);
    const b = await seedOrgWithProjects("B", ["B1"]);

    const rows = await withOrg(testEnv, a).all<{ name: string }>(
      `SELECT p.name FROM project p
        WHERE p.{{ORG}}
          AND EXISTS (SELECT 1 FROM project q WHERE q.id = p.id AND q.{{ORG}})`,
    );
    expect(rows.map((r) => r.name)).toEqual(["A1"]);
    expect(b).toBeTruthy();
  });

  it("scopes first() the same way", async () => {
    const a = await seedOrgWithProjects("A", ["A1"]);
    const b = await seedOrgWithProjects("B", ["B1"]);

    const mine = await withOrg(testEnv, a).first<{ name: string }>(
      `SELECT name FROM project WHERE name = ? AND {{ORG}}`,
      "A1",
    );
    expect(mine?.name).toBe("A1");

    const theirs = await withOrg(testEnv, b).first<{ name: string }>(
      `SELECT name FROM project WHERE name = ? AND {{ORG}}`,
      "A1",
    );
    expect(theirs).toBeNull();
  });

  it("scopes writes, so one organization cannot update another's row", async () => {
    const a = await seedOrgWithProjects("A", ["A1"]);
    const b = await seedOrgWithProjects("B", ["B1"]);

    const result = await withOrg(testEnv, b).run(
      `UPDATE project SET name = 'hijacked' WHERE name = ? AND {{ORG}}`,
      "A1",
    );
    expect(result.meta.changes ?? 0).toBe(0);

    const untouched = await withOrg(testEnv, a).first<{ name: string }>(
      `SELECT name FROM project WHERE {{ORG}}`,
    );
    expect(untouched?.name).toBe("A1");
  });

  it("refuses to build a scope without an organization id", () => {
    expect(() => withOrg(testEnv, "")).toThrow(/organization id/);
  });
});
