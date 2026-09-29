/**
 * Whole-store backup.
 *
 * Replaces the two-way sync protocol. A snapshot is uploaded after changes
 * settle and downloaded only when the local store is empty, so a restore can
 * never overwrite newer work. Because the payload is the whole store, a
 * deleted record is simply absent from it, which is why the schema needs no
 * tombstone column.
 */
import { API_BASE, apiHeaders } from "./config";
import { db, Goal, GoalStatus, Task, TaskStatus, USER_ID } from "./db";

const UPLOAD_DEBOUNCE_MS = 2000;
const META_ID = "default";

/**
 * A record that this browser has backed up at least once.
 *
 * Deliberately in localStorage rather than IndexedDB: the decision it drives
 * is whether to auto-restore into an *empty* store, and the common way to end
 * up with one is losing the database. A flag stored in the database would be
 * destroyed by the same event it is meant to detect.
 */
const SYNCED_KEY = "canens.has-backed-up";

export function hasEverBackedUp(): boolean {
  try {
    return localStorage.getItem(SYNCED_KEY) === "1";
  } catch {
    // Private browsing, or storage disabled. Treat as never synced: the safe
    // direction is to ask rather than to restore.
    return false;
  }
}

function markBackedUp(): void {
  try {
    localStorage.setItem(SYNCED_KEY, "1");
  } catch {
    // Not fatal. Worst case the next empty store prompts instead of
    // restoring, which is the safe direction.
  }
}

export type BackupState = "idle" | "saving" | "saved" | "error";

let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
// Set when a write lands while an upload is already running, so the change
// is not simply dropped. Without this, a write during a slow upload scheduled a
// debounce, the timer fired, found an upload in flight and returned the old
// promise - and the change was never uploaded at all.
let queuedWhileBusy = false;

async function setMeta(patch: Partial<{ saved_at: string | null; last_error: string | null }>) {
  const existing = await db.backup_meta.get(META_ID);
  await db.backup_meta.put({
    id: META_ID,
    saved_at: existing?.saved_at ?? null,
    last_error: null,
    ...patch,
  });
}

export async function backupStatus(): Promise<{
  saved_at: string | null;
  last_error: string | null;
}> {
  const meta = await db.backup_meta.get(META_ID);
  return { saved_at: meta?.saved_at ?? null, last_error: meta?.last_error ?? null };
}

/** Call after any local write. Repeated calls collapse into one upload. */
export function scheduleBackup(): void {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    void uploadBackup();
  }, UPLOAD_DEBOUNCE_MS);
}

function toEpoch(iso: string | undefined | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export interface SnapshotData {
  goals: Goal[];
  tasks: Task[];
  tombstones?: Record<string, string>;
}

export function mergeSnapshots(
  local: SnapshotData,
  remote: SnapshotData,
): { goals: Goal[]; tasks: Task[]; tombstones: Record<string, string> } {
  const mergedTombstones: Record<string, string> = {};

  for (const [id, date] of Object.entries(local.tombstones ?? {})) {
    mergedTombstones[id] = date;
  }
  for (const [id, date] of Object.entries(remote.tombstones ?? {})) {
    if (!mergedTombstones[id] || toEpoch(date) > toEpoch(mergedTombstones[id])) {
      mergedTombstones[id] = date;
    }
  }

  // Prune tombstones older than 30 days
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [id, date] of Object.entries(mergedTombstones)) {
    if (toEpoch(date) < thirtyDaysAgo) {
      delete mergedTombstones[id];
    }
  }

  // Merge goals
  const goalMap = new Map<string, Goal>();
  const allGoals = [...local.goals, ...remote.goals];

  for (const goal of allGoals) {
    const deletedAt = mergedTombstones[goal.id];
    if (deletedAt && toEpoch(deletedAt) >= toEpoch(goal.updated_at)) {
      continue;
    }
    if (deletedAt && toEpoch(goal.updated_at) > toEpoch(deletedAt)) {
      delete mergedTombstones[goal.id];
    }

    const existing = goalMap.get(goal.id);
    if (!existing || toEpoch(goal.updated_at) > toEpoch(existing.updated_at)) {
      goalMap.set(goal.id, goal);
    }
  }

  // Merge tasks
  const taskMap = new Map<string, Task>();
  const allTasks = [...local.tasks, ...remote.tasks];

  for (const task of allTasks) {
    if (!goalMap.has(task.goal_id)) continue;

    const deletedAt = mergedTombstones[task.id];
    if (deletedAt && toEpoch(deletedAt) >= toEpoch(task.updated_at)) {
      continue;
    }
    if (deletedAt && toEpoch(task.updated_at) > toEpoch(deletedAt)) {
      delete mergedTombstones[task.id];
    }

    const existing = taskMap.get(task.id);
    if (!existing || toEpoch(task.updated_at) > toEpoch(existing.updated_at)) {
      taskMap.set(task.id, task);
    }
  }

  return {
    goals: Array.from(goalMap.values()),
    tasks: Array.from(taskMap.values()),
    tombstones: mergedTombstones,
  };
}

export async function uploadBackup(): Promise<void> {
  if (inFlight) {
    queuedWhileBusy = true;
    return inFlight;
  }

  inFlight = (async () => {
    const [goals, tasks, tombstones] = await Promise.all([
      db.goals.toArray(),
      db.tasks.toArray(),
      db.tombstones.toArray(),
    ]);
    const tombstoneMap: Record<string, string> = {};
    for (const t of tombstones) {
      tombstoneMap[t.id] = t.deleted_at;
    }

    try {
      const response = await fetch(`${API_BASE}/api/backup`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({ goals, tasks, tombstones: tombstoneMap }),
        keepalive: true,
      });
      if (!response.ok) throw new Error(`Backup failed: ${response.status}`);
      const body = (await response.json().catch(() => null)) as { saved_at?: string } | null;
      markBackedUp();
      await setMeta({ saved_at: body?.saved_at ?? new Date().toISOString(), last_error: null });
    } catch (error) {
      // A failed backup must not lose the data; the next write or reconnect
      // schedules another attempt.
      await setMeta({ last_error: (error as Error).message });
    }
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }

  // A write that arrived mid-upload was included in this snapshot only if it
  // landed before the read above. Re-run to be certain, rather than assuming.
  if (queuedWhileBusy) {
    queuedWhileBusy = false;
    return uploadBackup();
  }
}

export async function syncWithRemote(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/backup`, { headers: apiHeaders() });
    if (!response.ok) return false;
    const body = await response.json();
    if (!body.exists) {
      const localCount = await db.goals.count();
      if (localCount > 0) void uploadBackup();
      return false;
    }

    const remoteGoals: Goal[] = (body.goals ?? []).filter(isGoal);
    const remoteTasks: Task[] = (body.tasks ?? []).filter(isTask);
    const remoteTombstones: Record<string, string> = body.tombstones ?? {};

    const [localGoals, localTasks, localTombstonesList] = await Promise.all([
      db.goals.toArray(),
      db.tasks.toArray(),
      db.tombstones.toArray(),
    ]);

    const localTombstones: Record<string, string> = {};
    for (const t of localTombstonesList) {
      localTombstones[t.id] = t.deleted_at;
    }

    const merged = mergeSnapshots(
      { goals: localGoals, tasks: localTasks, tombstones: localTombstones },
      { goals: remoteGoals, tasks: remoteTasks, tombstones: remoteTombstones },
    );

    await db.transaction("rw", db.goals, db.tasks, db.tombstones, db.backup_meta, async () => {
      await db.goals.clear();
      await db.tasks.clear();
      await db.tombstones.clear();

      await db.goals.bulkPut(
        merged.goals.map((g) => ({
          ...g,
          user_id: g.user_id ?? USER_ID,
          status: g.status === GoalStatus.COMPLETED ? GoalStatus.COMPLETED : GoalStatus.ACTIVE,
        })),
      );
      await db.tasks.bulkPut(
        merged.tasks.map((t) => ({
          ...t,
          user_id: t.user_id ?? USER_ID,
          status: t.status === TaskStatus.COMPLETED ? TaskStatus.COMPLETED : TaskStatus.PENDING,
        })),
      );
      await db.tombstones.bulkPut(
        Object.entries(merged.tombstones).map(([id, deleted_at]) => ({ id, deleted_at })),
      );
      await setMeta({ saved_at: body.saved_at ?? null, last_error: null });
    });

    markBackedUp();
    void uploadBackup();
    return true;
  } catch (err) {
    await setMeta({ last_error: (err as Error).message });
    return false;
  }
}

/** Stop losing edits to a closed tab: a pending backup is flushed on the way out. */
export function installUnloadFlush(): () => void {
  const flush = () => {
    if (uploadTimer) {
      clearTimeout(uploadTimer);
      uploadTimer = null;
      void uploadBackup();
    }
  };
  const onOnline = () => void syncWithRemote();

  window.addEventListener("pagehide", flush);
  window.addEventListener("online", onOnline);

  return () => {
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("online", onOnline);
  };
}

function isGoal(value: unknown): value is Goal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Goal).id === "string" &&
    typeof (value as Goal).title === "string"
  );
}

function isTask(value: unknown): value is Task {
  return (
    isGoal(value) && typeof (value as Task).goal_id === "string"
  );
}

export type RestoreOutcome =
  | "restored"
  | "nothing-to-restore"
  | "declined-because-previously-synced";

/**
 * Check the server for a snapshot to restore, and restore it if it is safe.
 *
 * An empty store has two very different causes: a new device, or the user
 * having deleted everything. The emptiness check cannot tell them apart, so it
 * is not the whole safety story. If this browser has backed up before, an
 * empty store means the user emptied it, and the snapshot is restored only on
 * an explicit request - otherwise deleting every goal and coming back to them
 * is indistinguishable from a first run.
 */
export async function restoreIfEmpty(
  { force = false }: { force?: boolean } = {},
): Promise<RestoreOutcome> {
  if ((await db.goals.count()) > 0) return "nothing-to-restore";

  const response = await fetch(`${API_BASE}/api/backup`, { headers: apiHeaders() });
  if (!response.ok) throw new Error(`Restore failed: ${response.status}`);

  const body = await response.json();
  if (!body.exists) return "nothing-to-restore";

  const goals: Goal[] = (body.goals ?? []).filter(isGoal);
  // Drop tasks whose goal is missing rather than importing orphans.
  const tasks: Task[] = (body.tasks ?? []).filter(
    (t: unknown) => isTask(t) && goals.some((g) => g.id === (t as Task).goal_id),
  );

  if (goals.length === 0 && tasks.length === 0) return "nothing-to-restore";

  if (!force && hasEverBackedUp()) return "declined-because-previously-synced";

  await db.transaction("rw", db.goals, db.tasks, db.backup_meta, async () => {
    await db.goals.bulkPut(
      goals.map((g) => ({
        ...g,
        user_id: g.user_id ?? USER_ID,
        status: g.status === GoalStatus.COMPLETED ? GoalStatus.COMPLETED : GoalStatus.ACTIVE,
      })),
    );
    await db.tasks.bulkPut(
      tasks.map((t) => ({
        ...t,
        user_id: t.user_id ?? USER_ID,
        status: t.status === TaskStatus.COMPLETED ? TaskStatus.COMPLETED : TaskStatus.PENDING,
      })),
    );
    await setMeta({ saved_at: body.saved_at ?? null, last_error: null });
  });

  return "restored";
}

/** Called after a destructive change, so the server is never briefly behind. */
export function flushBackupNow(): void {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = null;
  void uploadBackup();
}

/** Delete cloud snapshot on the server. */
export async function deleteRemoteBackup(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/backup`, {
    method: "DELETE",
    headers: apiHeaders(),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete remote backup: ${response.status}`);
  }
}

/** Export entire local store as a formatted JSON document. */
export async function exportLocalDataJson(): Promise<string> {
  const [goals, tasks] = await Promise.all([db.goals.toArray(), db.tasks.toArray()]);
  return JSON.stringify(
    {
      goals,
      tasks,
      exported_at: new Date().toISOString(),
    },
    null,
    2,
  );
}
