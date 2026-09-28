import { expect, test, vi } from "vitest";

const NAME = "CanensLocalDB";

function openRaw(
  version: number,
  seed: (database: IDBDatabase) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, version);
    request.onupgradeneeded = () => seed(request.result);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * The regression that broke the home page.
 *
 * A database written by the previous version holds rows whose timestamps are
 * millisecond integers, because the backend's sync payload serialised them that
 * way. Bumping the schema version without an upgrade callback left those rows
 * in place, and the first sort over them threw
 * "localeCompare is not a function".
 *
 * fake-indexeddb always starts at the current version, so the old shape is
 * written in by hand at version 3 and the real module is then loaded against
 * it, which is what the app does on a returning browser.
 */
test("the v4 upgrade repairs rows left by the previous version", async () => {
  await deleteDatabase();

  await openRaw(3, (database) => {
    database
      .createObjectStore("goals", { keyPath: "id" })
      .add({
        id: "g1",
        user_id: "u",
        title: "A goal",
        status: "Active",
        created_at: 1756684800000,
        updated_at: 1756684800000,
        deleted_at: null,
        dirty: 0,
      });
    database
      .createObjectStore("tasks", { keyPath: "id" })
      .add({
        id: "t1",
        user_id: "u",
        goal_id: "g1",
        title: "A step",
        status: "Pending",
        created_at: 1756684800000,
        updated_at: 1756684800000,
        deleted_at: null,
        dirty: 0,
        estimated_minutes: 30,
      });
  });

  // Re-evaluate the module so it opens the database that now exists, at the
  // current version, and runs the upgrade.
  vi.resetModules();
  const { db } = await import("../lib/db");
  const { tasksForGoals } = await import("../lib/store");

  const goal = await db.goals.get("g1");
  const task = await db.tasks.get("t1");

  // Timestamps are strings again, and the fields the schema dropped are gone.
  expect(typeof goal?.created_at).toBe("string");
  expect(typeof task?.created_at).toBe("string");
  expect(goal).not.toHaveProperty("deleted_at");
  expect(goal).not.toHaveProperty("dirty");
  expect(task).not.toHaveProperty("deleted_at");
  expect(task).not.toHaveProperty("dirty");
  expect(task).not.toHaveProperty("estimated_minutes");

  // And the thing that used to throw.
  const grouped = await tasksForGoals(["g1"]);
  expect(grouped.get("g1")?.map((t) => t.title)).toEqual(["A step"]);

  await db.delete();
});
