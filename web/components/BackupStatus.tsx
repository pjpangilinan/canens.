"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { uploadBackup } from "../lib/backup";

/**
 * Surfaces backup state, so a durability feature is not invisible. The
 * previous app had no user-visible error reporting at all outside the
 * Activity Log.
 *
 * Reads through a live query rather than a one-shot effect: reading once on
 * mount means the status still says nothing after the upload it is reporting
 * on has happened.
 */
export default function BackupStatus() {
  const meta = useLiveQuery(async () => {
    const row = await db.backup_meta.get("default");
    return { saved_at: row?.saved_at ?? null, last_error: row?.last_error ?? null };
  });

  if (meta === undefined) return null;

  if (meta.last_error) {
    return (
      <div className="flex items-center justify-between gap-3 text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-2">
        <span>Backup failed: {meta.last_error}</span>
        <button
          onClick={() => void uploadBackup()}
          className="underline shrink-0"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!meta.saved_at) return null;

  return (
    <p className="text-center text-xs text-muted/70">
      Backed up {new Date(meta.saved_at).toLocaleTimeString()}
    </p>
  );
}
