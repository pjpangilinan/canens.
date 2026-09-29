"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import GoalCard from "./GoalCard";
import GoalInput from "./GoalInput";
import SearchBar from "./SearchBar";
import Onboarding from "./Onboarding";
import BackupStatus from "./BackupStatus";
import { GoalWithTasks } from "../lib/db";
import { searchGoals } from "../lib/search";
import * as store from "../lib/store";
import {
  restoreIfEmpty,
  installUnloadFlush,
  scheduleBackup,
  exportLocalDataJson,
  deleteRemoteBackup,
  syncWithRemote,
} from "../lib/backup";
import { deleteAccount, readSession } from "../lib/auth";

export default function Home({
  onSignOut,
  signedInAs,
}: {
  onSignOut: () => void;
  signedInAs: string | null;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [canRestore, setCanRestore] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    // Inline rather than via a callback: the restore result arrives later, and
    // routing it through a function that sets state trips the effect lint.
    let cancelled = false;
    restoreIfEmpty({ force: false })
      .then((outcome) => {
        if (cancelled) return;
        if (outcome === "restored") setRestored(true);
        if (outcome === "declined-because-previously-synced") setCanRestore(true);
        if (outcome === "nothing-to-restore") {
          // If store is not empty, run LWW sync with remote
          void syncWithRemote();
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setRestoreError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The explicit request, from the "Restore?" button. Only offered when this
  // browser has backed up before, so an empty store means the user emptied it
  // rather than that they are new.
  const forceRestore = useCallback(async () => {
    setCanRestore(false);
    try {
      if ((await restoreIfEmpty({ force: true })) === "restored") setRestored(true);
    } catch (err) {
      setRestoreError((err as Error).message);
    }
  }, []);

  const handleExport = useCallback(async () => {
    try {
      const json = await exportLocalDataJson();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `canens-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Export failed: ${(err as Error).message}`);
    }
  }, []);

  const handleDeleteAccount = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteRemoteBackup().catch(() => {});
      const session = readSession();
      if (session?.accessToken) {
        await deleteAccount(session.accessToken);
      }
      await store.clearAllData();
      localStorage.clear();
      onSignOut();
    } catch (err) {
      setError(`Account deletion failed: ${(err as Error).message}`);
      setIsDeleting(false);
      setShowDeleteModal(false);
    }
  }, [onSignOut]);

  // A 2s debounce means the last edit before closing the tab was otherwise
  // never uploaded, and a failed upload was never retried without another
  // write. Flush on the way out and retry on reconnect.
  useEffect(() => installUnloadFlush(), []);

  const goals = useLiveQuery(async () => {
    const active = await store.activeGoals();
    const grouped = await store.tasksForGoals(active.map((g) => g.id));
    return active.map<GoalWithTasks>((goal) => ({
      ...goal,
      tasks: grouped.get(goal.id) ?? [],
    }));
  });

  const handleError = useCallback((message: string) => setError(message), []);

  const onChanged = useCallback(() => {
    setError(null);
    scheduleBackup();
  }, []);

  const search = useMemo(
    () => searchGoals(goals ?? [], query),
    [goals, query],
  );

  return (
    <main className="py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="text-center space-y-3">
          <h1 className="text-4xl md:text-5xl font-extrabold text-foreground tracking-tight">
            Canens<span className="text-primary">.</span>
          </h1>
          <p className="text-lg text-muted max-w-xl mx-auto">
            Break a goal into the next few actions.
          </p>
          {signedInAs && (
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2 text-xs text-muted/70">
              <span className="truncate max-w-[16rem]">{signedInAs}</span>
              <span>•</span>
              <button
                onClick={() => void handleExport()}
                className="underline hover:text-foreground shrink-0"
              >
                Export data (JSON)
              </button>
              <span>•</span>
              <button
                onClick={onSignOut}
                className="underline hover:text-foreground shrink-0"
              >
                Sign out
              </button>
              <span>•</span>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="underline text-red-400/80 hover:text-red-300 shrink-0"
              >
                Delete account
              </button>
            </div>
          )}
        </header>

        {showDeleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="bg-surface border border-red-500/30 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-glass">
              <h3 className="text-lg font-bold text-foreground">Delete Account and Data?</h3>
              <p className="text-sm text-muted">
                This will permanently delete your Cognito account, wipe all cloud backups, and clear your local goals and steps. This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-foreground/80 hover:text-foreground border border-surface-border hover:bg-surface-elevated"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => void handleDeleteAccount()}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
                >
                  {isDeleting ? "Deleting..." : "Permanently Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        <GoalInput
          onSubmit={async (title) => {
            await store.createGoal(title);
            onChanged();
          }}
          onError={handleError}
        />

        <SearchBar
          value={query}
          onChange={setQuery}
          label="Search goals and steps"
          hint="Search goals and steps..."
        />

        {restored && (
          <p className="text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-2">
            Restored your goals from backup.
          </p>
        )}
        {canRestore && (
          <div className="flex flex-wrap items-center gap-3 text-sm bg-primary/10 border border-primary/30 rounded-lg px-4 py-3">
            <p className="flex-1 min-w-[12rem] text-foreground">
              Your goals are empty, but a backup exists. Restore it?
            </p>
            <button
              onClick={() => void forceRestore()}
              className="bg-primary text-white px-3 py-1.5 rounded hover:bg-primary-light"
            >
              Restore
            </button>
          </div>
        )}
        {restoreError && (
          <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2">
            Could not check for a backup: {restoreError}
          </p>
        )}

        {error && (
          <div className="flex items-start gap-3 bg-red-900/10 border border-red-500/20 rounded-xl px-4 py-3">
            <p className="text-red-400 text-sm flex-1">{error}</p>
            <button onClick={() => setError(null)} className="text-red-400/70 hover:text-red-400" aria-label="Dismiss">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <section className="space-y-4">
          {goals === undefined ? (
            <div className="animate-pulse space-y-4 max-w-sm mx-auto">
              <div className="h-24 bg-surface rounded-xl border border-primary/10" />
              <div className="h-24 bg-surface rounded-xl border border-primary/10" />
            </div>
          ) : goals.length === 0 && !query.trim() ? (
            <Onboarding onCreateGoal={async (title) => {
              await store.createGoal(title);
              onChanged();
            }} onError={handleError} />
          ) : search.goals.length === 0 ? (
            <p className="text-center text-muted py-12">
              {query.trim() ? `Nothing matches "${query.trim()}".` : "No active goals."}
            </p>
          ) : (
            <div className="space-y-4">
              {search.goals.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  tasks={goal.tasks}
                  matchingTaskIds={search.matchingTaskIds}
                  startExpanded={search.expandGoalIds.has(goal.id)}
                  onChanged={onChanged}
                  onError={handleError}
                />
              ))}
            </div>
          )}
        </section>

        <BackupStatus />
      </div>
    </main>
  );
}
