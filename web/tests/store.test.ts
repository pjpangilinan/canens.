import { beforeEach, describe, expect, it } from "vitest";
import { db, GoalStatus, Task, TaskStatus } from "../lib/db";
import { setTaskStatus, tasksForGoals } from "../lib/store";

/**
 * The completion rule, tested against a real IndexedDB rather than a mock.
 *
 * fake-indexeddb provides a genuine implementation, so these are real table
 * queries. A mock would only re-assert the mock.
 */
const GOAL = {
  id: "g1",
  user_id: "u",
  title: "Write a book",
  status: GoalStatus.ACTIVE,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function task(id: string, status: TaskStatus = TaskStatus.PENDING) {
  return {
    id,
    user_id: "u",
    goal_id: GOAL.id,
    title: `Task ${id}`,
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

async function seed(...tasks: ReturnType<typeof task>[]) {
  await db.goals.add(GOAL);
  for (const t of tasks) await db.tasks.add(t);
}

beforeEach(async () => {
  await db.goals.clear();
  await db.tasks.clear();
});

describe("setTaskStatus", () => {
  it("leaves the goal active while other steps remain", async () => {
    await seed(task("t1"), task("t2"));

    await setTaskStatus("t1", TaskStatus.COMPLETED);

    expect((await db.goals.get("g1"))?.status).toBe(GoalStatus.ACTIVE);
    expect((await db.tasks.get("t1"))?.status).toBe(TaskStatus.COMPLETED);
  });

  it("archives the goal when the last step completes", async () => {
    await seed(task("t1"), task("t2"));

    await setTaskStatus("t1", TaskStatus.COMPLETED);
    await setTaskStatus("t2", TaskStatus.COMPLETED);

    expect((await db.goals.get("g1"))?.status).toBe(GoalStatus.COMPLETED);
  });

  it("leaves the goal archived when a step is un-completed", async () => {
    // Un-ticking is usually a correction to a mis-click, not a statement that
    // the work is live again. Once archived, a goal stays archived until it is
    // reopened deliberately from the Activity Log.
    await seed(task("t1"), task("t2"));

    await setTaskStatus("t1", TaskStatus.COMPLETED);
    await setTaskStatus("t2", TaskStatus.COMPLETED);
    expect((await db.goals.get("g1"))?.status).toBe(GoalStatus.COMPLETED);

    await setTaskStatus("t2", TaskStatus.PENDING);
    expect((await db.goals.get("g1"))?.status).toBe(GoalStatus.COMPLETED);
    expect((await db.tasks.get("t2"))?.status).toBe(TaskStatus.PENDING);
  });

  it("throws for an unknown id rather than silently doing nothing", async () => {
    await expect(setTaskStatus("nope", TaskStatus.COMPLETED)).rejects.toThrow(/nope/);
  });
});

describe("tasksForGoals", () => {
  /**
   * Rows inherited from the previous version arrived from the backend's sync
   * payload, which serialised timestamps as millisecond integers. Sorting
   * those with localeCompare threw and took the home page down with them.
   */
  it("sorts rows whose timestamps are numbers, not strings", async () => {
    await db.goals.add({
      id: "g1",
      user_id: "u",
      title: "A goal",
      status: GoalStatus.ACTIVE,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    // Exactly the shape the old sync path wrote. Cast because the type says
    // string; the point of this test is that the runtime value is not.
    const legacy = {
      id: "t1",
      user_id: "u",
      goal_id: "g1",
      title: "Older",
      status: TaskStatus.PENDING,
      created_at: 1756684800000,
      updated_at: 1756684800000,
    } as unknown as Task;

    await db.tasks.bulkAdd([
      legacy,
      {
        id: "t2",
        user_id: "u",
        goal_id: "g1",
        title: "Newer",
        status: TaskStatus.PENDING,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
    ]);

    const grouped = await tasksForGoals(["g1"]);

    expect(grouped.get("g1")?.map((t) => t.title)).toEqual(["Older", "Newer"]);
  });

  it("returns an empty map when there are no goals to look up", async () => {
    expect((await tasksForGoals([])).size).toBe(0);
  });
});

describe("createTask", () => {
  it("refuses a goal that is no longer active", async () => {
    // Generation is asynchronous, so steps can arrive after the goal was
    // completed or deleted. A pending step on an archived goal is invisible,
    // and one pointing at a deleted goal is dropped on the next restore.
    await seed(task("t1"));
    await setTaskStatus("t1", TaskStatus.COMPLETED);

    const { createTask } = await import("../lib/store");
    await expect(createTask("g1", "Late step")).rejects.toThrow(/no longer active/);
    expect(await db.tasks.count()).toBe(1);
  });

  it("refuses a goal that does not exist", async () => {
    const { createTask } = await import("../lib/store");
    await expect(createTask("missing", "Orphan")).rejects.toThrow(/missing/);
  });
});

describe("deleting a goal", () => {
  it("removes its steps too", async () => {
    await seed(task("t1"), task("t2"));
    const { deleteGoal } = await import("../lib/store");

    await deleteGoal("g1");

    expect(await db.goals.count()).toBe(0);
    expect(await db.tasks.count()).toBe(0);
  });
});
