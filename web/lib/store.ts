/**
 * The local store is the only place the UI reads from and writes to.
 *
 * These functions replace the previous `api.ts`, which was named for a
 * network client but implemented almost entirely as Dexie access, so the
 * distinction between local and remote was invisible at the call site. Remote
 * calls now live in `api.ts`; everything here is local.
 */
import { db, Goal, GoalStatus, Task, TaskStatus, USER_ID } from "./db";

function now(): string {
  return new Date().toISOString();
}

export async function createGoal(title: string): Promise<Goal> {
  const timestamp = now();
  const goal: Goal = {
    id: crypto.randomUUID(),
    user_id: USER_ID,
    title: title.trim(),
    status: GoalStatus.ACTIVE,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.goals.add(goal);
  return goal;
}

/**
 * `Dexie.update` resolves to the number of rows changed, and silently does
 * nothing when the id is absent. Ignoring that return value is how an
 * `undefined` used to reach the render tree through a `map` callback.
 */
export async function renameGoal(goalId: string, title: string): Promise<Goal> {
  const changed = await db.goals.update(goalId, {
    title: title.trim(),
    updated_at: now(),
  });
  if (changed === 0) throw new Error(`No goal with id ${goalId}`);
  return (await db.goals.get(goalId)) as Goal;
}

export async function archiveGoal(goalId: string): Promise<void> {
  const changed = await db.goals.update(goalId, {
    status: GoalStatus.COMPLETED,
    updated_at: now(),
  });
  if (changed === 0) throw new Error(`No goal with id ${goalId}`);
}

export async function reopenGoal(goalId: string): Promise<void> {
  const changed = await db.goals.update(goalId, {
    status: GoalStatus.ACTIVE,
    updated_at: now(),
  });
  if (changed === 0) throw new Error(`No goal with id ${goalId}`);
}

/** Deleting a goal removes its tasks too. Archiving is the reversible option. */
export async function deleteGoal(goalId: string): Promise<void> {
  await db.transaction("rw", db.goals, db.tasks, async () => {
    await db.tasks.where("goal_id").equals(goalId).delete();
    await db.goals.delete(goalId);
  });
}
export async function createTask(goalId: string, title: string): Promise<Task> {
  // A step on a goal that has since been completed or deleted is invisible:
  // archived goals are filtered out of the active list, and a task pointing at
  // a deleted goal is dropped on the next restore. Generation is asynchronous,
  // so this is reachable rather than theoretical.
  const goal = await db.goals.get(goalId);
  if (!goal) throw new Error(`No goal with id ${goalId}`);
  if (goal.status !== GoalStatus.ACTIVE) {
    throw new Error("That goal is no longer active");
  }

  const timestamp = now();
  const task: Task = {
    id: crypto.randomUUID(),
    user_id: USER_ID,
    goal_id: goalId,
    title: title.trim(),
    status: TaskStatus.PENDING,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.tasks.add(task);
  return task;
}

export async function renameTask(taskId: string, title: string): Promise<Task> {
  const changed = await db.tasks.update(taskId, {
    title: title.trim(),
    updated_at: now(),
  });
  if (changed === 0) throw new Error(`No task with id ${taskId}`);
  return (await db.tasks.get(taskId)) as Task;
}

export async function deleteTask(taskId: string): Promise<void> {
  await db.tasks.delete(taskId);
}

/**
 * Complete or un-complete a task.
 *
 * Completing the last outstanding task of a goal completes the goal. That is
 * the only thing un-completing can undo, and deliberately so: once a goal has
 * been archived it stays archived until it is reopened deliberately from the
 * Activity Log. Un-ticking a step is not a statement that the work is live
 * again - it is usually a correction to a mis-click, and a goal bouncing back
 * onto the home list because of one would be worse than the mistake.
 */
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  const task = await db.tasks.get(taskId);
  if (!task) throw new Error(`No task with id ${taskId}`);

  const completing = status === TaskStatus.COMPLETED;

  await db.transaction("rw", db.goals, db.tasks, async () => {
    await db.tasks.update(taskId, { status, updated_at: now() });
    if (!completing) return;

    const outstanding = await db.tasks
      .where("goal_id")
      .equals(task.goal_id)
      .filter((t) => t.status !== TaskStatus.COMPLETED)
      .count();

    if (outstanding === 0) {
      const changed = await db.goals.update(task.goal_id, {
        status: GoalStatus.COMPLETED,
        updated_at: now(),
      });
      if (changed === 0) {
        throw new Error(`Task ${taskId} refers to goal ${task.goal_id}, which no longer exists`);
      }
    }
  });
}

export async function activeGoals(): Promise<Goal[]> {
  return db.goals
    .where("status")
    .equals(GoalStatus.ACTIVE)
    .reverse()
    .sortBy("created_at");
}

/**
 * A timestamp as a number, for sorting.
 *
 * The type says `created_at` is a string, and for rows this app writes it is.
 * Rows inherited from the previous version came from the backend's sync
 * payload, which sent millisecond integers instead. Comparing those with
 * localeCompare throws and takes the home page down, so the value is coerced
 * rather than trusted.
 */
export function timestampOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = new Date(value as string).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function tasksForGoals(
  goalIds: string[],
): Promise<Map<string, Task[]>> {
  const grouped = new Map<string, Task[]>();
  if (goalIds.length === 0) return grouped;

  const tasks = await db.tasks.where("goal_id").anyOf(goalIds).toArray();
  for (const task of tasks) {
    const list = grouped.get(task.goal_id) ?? [];
    list.push(task);
    grouped.set(task.goal_id, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => timestampOf(a.created_at) - timestampOf(b.created_at));
  }
  return grouped;
}

export async function isStoreEmpty(): Promise<boolean> {
  return (await db.goals.count()) === 0;
}
