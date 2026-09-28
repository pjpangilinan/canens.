import Dexie, { type EntityTable } from "dexie";

export const GoalStatus = {
  ACTIVE: "Active",
  COMPLETED: "Completed",
} as const;
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const TaskStatus = {
  PENDING: "Pending",
  COMPLETED: "Completed",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Persisted shape. This is exactly what is stored, and nothing more. */
export interface Goal {
  id: string;
  user_id: string;
  title: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  user_id: string;
  goal_id: string;
  title: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

/** What a goal looks like once its tasks are attached for rendering. */
export interface GoalWithTasks extends Goal {
  tasks: Task[];
}

export interface BackupMeta {
  id: string;
  saved_at: string | null;
  last_error: string | null;
}

export const db = new Dexie("CanensLocalDB") as Dexie & {
  goals: EntityTable<Goal, "id">;
  tasks: EntityTable<Task, "id">;
  backup_meta: EntityTable<BackupMeta, "id">;
};

/**
 * Version 4 drops the `dirty` index and the `sync_meta` table, and removes
 * `deleted_at` and `estimated_minutes` from the records.
 *
 * `deleted_at` existed so deletions could be propagated to other clients.
 * There are no other clients: a backup is a whole-store snapshot, so a deleted
 * record is simply absent from it.
 *
 * The upgrade callback is the point. Rows written by the previous version came
 * from the backend's sync payload, which serialised timestamps as millisecond
 * integers rather than ISO strings. Without this callback those rows survive
 * the version bump unchanged and the first sort over them throws
 * "localeCompare is not a function" - taking the home page down with them.
 */
db.version(4)
  .stores({
    goals: "id, user_id, status, created_at",
    tasks: "id, user_id, goal_id, status",
    backup_meta: "id",
  })
  .upgrade(async (tx) => {
    const normalise = (row: Record<string, unknown>) => {
      if (!row || typeof row !== "object") return;

      for (const key of ["created_at", "updated_at"]) {
        const value = row[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          row[key] = new Date(value).toISOString();
        } else if (typeof value !== "string" || !value) {
          row[key] = new Date(0).toISOString();
        }
      }

      for (const removed of ["deleted_at", "dirty", "estimated_minutes"]) {
        delete row[removed];
      }
    };

    await tx.table("goals").toCollection().modify(normalise);
    await tx.table("tasks").toCollection().modify(normalise);
  });

/**
 * Single-user MVP. Real accounts are out of scope, but the id is stored on
 * every record and used in every query so adding them later is a matter of
 * changing where this value comes from.
 */
export const USER_ID = "00000000-0000-0000-0000-000000000000";
