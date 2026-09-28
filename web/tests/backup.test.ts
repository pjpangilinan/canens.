import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, GoalStatus, TaskStatus } from "../lib/db";
import { restoreIfEmpty, uploadBackup } from "../lib/backup";

/**
 * The backup exists to survive losing the browser, so the property that
 * matters is that a stale snapshot can never overwrite newer work.
 */

const SNAPSHOT = {
  exists: true,
  saved_at: "2026-02-01T10:00:00.000Z",
  goals: [
    {
      id: "g1",
      user_id: "u",
      title: "Restored goal",
      status: "Active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  tasks: [
    {
      id: "t1",
      user_id: "u",
      goal_id: "g1",
      title: "Restored step",
      status: "Pending",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(async () => {
  await db.goals.clear();
  await db.tasks.clear();
  await db.backup_meta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreIfEmpty", () => {
  it("restores into an empty store", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SNAPSHOT)));

    expect(await restoreIfEmpty()).toBe("restored");

    expect((await db.goals.toArray()).map((g) => g.title)).toEqual(["Restored goal"]);
    expect((await db.tasks.toArray()).map((t) => t.title)).toEqual(["Restored step"]);
    expect((await db.backup_meta.get("default"))?.saved_at).toBe("2026-02-01T10:00:00.000Z");
  });

  it("refuses to touch a store that already has goals", async () => {
    await db.goals.add({
      id: "local",
      user_id: "u",
      title: "Newer local work",
      status: GoalStatus.ACTIVE,
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);

    expect(await restoreIfEmpty()).toBe("nothing-to-restore");
    // The check happens before any request, so a stale snapshot cannot even
    // be fetched when there is nothing to restore into.
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await db.goals.toArray()).map((g) => g.title)).toEqual(["Newer local work"]);
  });

  it("does not do nothing when there is no stored snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ exists: false })));

    expect(await restoreIfEmpty()).toBe("nothing-to-restore");
    expect(await db.goals.count()).toBe(0);
  });

  it("drops tasks whose goal is missing rather than importing orphans", async () => {
    const withOrphan = {
      ...SNAPSHOT,
      tasks: [
        ...SNAPSHOT.tasks,
        { ...SNAPSHOT.tasks[0], id: "orphan", goal_id: "does-not-exist" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(withOrphan)));

    expect(await restoreIfEmpty()).toBe("restored");
    expect((await db.tasks.toArray()).map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("restore after the user has deleted everything", () => {
  /**
   * An empty store has two causes: a new device, or the user deleting
   * everything. The emptiness check cannot tell them apart, so once this
   * browser has backed up, an empty store is treated as deliberate and the
   * restore is offered rather than performed.
   */
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores automatically on a browser that has never backed up", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SNAPSHOT)));

    expect(await restoreIfEmpty()).toBe("restored");
    expect(await db.goals.count()).toBe(1);
  });

  it("declines and offers instead, once a backup has been made", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SNAPSHOT)));

    await uploadBackup();
    await db.goals.clear();

    expect(await restoreIfEmpty()).toBe("declined-because-previously-synced");
    // The user deleted everything; it must not quietly come back.
    expect(await db.goals.count()).toBe(0);
  });

  it("restores anyway when the user explicitly asks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SNAPSHOT)));

    await uploadBackup();
    await db.goals.clear();

    expect(await restoreIfEmpty({ force: true })).toBe("restored");
    expect((await db.goals.toArray()).map((g) => g.title)).toEqual(["Restored goal"]);
  });
});

describe("uploadBackup", () => {
  it("sends the whole store and records when it saved", async () => {
    await db.goals.add({
      id: "g1",
      user_id: "u",
      title: "A goal",
      status: GoalStatus.ACTIVE,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await db.tasks.add({
      id: "t1",
      user_id: "u",
      goal_id: "g1",
      title: "A step",
      status: TaskStatus.PENDING,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadBackup();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/backup$/);
    expect(init.method).toBe("PUT");

    const body = JSON.parse(String(init.body));
    expect(body.goals).toHaveLength(1);
    expect(body.tasks).toHaveLength(1);
    // The persisted rows carry no local-only fields, so nothing needs
    // stripping before upload.
    expect(body.goals[0]).not.toHaveProperty("dirty");

    expect((await db.backup_meta.get("default"))?.last_error).toBeNull();
    expect((await db.backup_meta.get("default"))?.saved_at).toBeTruthy();
  });

  it("records the failure and keeps the data", async () => {
    await db.goals.add({
      id: "g1",
      user_id: "u",
      title: "Still here",
      status: GoalStatus.ACTIVE,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));

    await uploadBackup();

    const meta = await db.backup_meta.get("default");
    expect(meta?.last_error).toContain("503");
    // A failed backup must never cost data; the next write retries.
    expect(await db.goals.count()).toBe(1);
  });
});
