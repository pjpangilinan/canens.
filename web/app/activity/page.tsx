"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, GoalStatus, TaskStatus } from "../../lib/db";
import SearchBar from "../../components/SearchBar";
import SignIn from "../../components/SignIn";
import { useAuth } from "../../lib/auth";
import { isApiConfigured } from "../../lib/config";
import { scheduleBackup } from "../../lib/backup";
import { reopenGoal, timestampOf } from "../../lib/store";

interface DayGroup {
  /** Sortable key, e.g. 2026-10-01. Never rendered. */
  iso: string;
  /** Human label, e.g. "October 1, 2026". */
  date: string;
  goals: { id: string; title: string; tasks: string[] }[];
}

/**
 * The home for completed work.
 *
 * An archived goal is filtered out of the active list, so without this page
 * finishing your work would make it unreachable. Goals are named alongside
 * their completed steps for that reason.
 */
export default function ActivityLog() {
  const { status, session, signOut, recheck } = useAuth();
  const [query, setQuery] = useState("");

  const data = useLiveQuery(async () => {
    const goals = await db.goals.where("status").equals(GoalStatus.COMPLETED).toArray();
    const goalIds = new Set(goals.map((g) => g.id));

    const completed = (
      await db.tasks
        .where("status")
        .equals(TaskStatus.COMPLETED)
        .filter((t) => goalIds.has(t.goal_id))
        .toArray()
    ).sort((a, b) => timestampOf(a.updated_at) - timestampOf(b.updated_at));

    return { goals, completed };
  });

  // Derived rather than stored: an effect that setState from the query
  // result would cause a second render pass for no benefit.
  const loading = data === undefined;

  const groups = useMemo<DayGroup[]>(() => {
    if (!data) return [];

    const needle = query.trim().toLowerCase();

    // Grouped by goal, not by task. Deriving the groups from completed tasks
    // made a goal that was archived before it had any steps invisible, which
    // is the exact data loss this page exists to prevent.
    const byDay = new Map<string, DayGroup>();
    for (const goal of data.goals) {
      const steps = data.completed.filter((t) => t.goal_id === goal.id);
      if (needle) {
        const goalMatches = goal.title.toLowerCase().includes(needle);
        const stepMatches = steps.some((t) => t.title.toLowerCase().includes(needle));
        if (!goalMatches && !stepMatches) continue;
      }

      // Grouped and sorted on an ISO key. Sorting the rendered label is
      // alphabetical by month name, which put "October 1" above
      // "September 28" and left the log in the wrong order across months.
      const when = new Date(goal.updated_at);
      const iso = when.toISOString().slice(0, 10);
      const group = byDay.get(iso) ?? {
        iso,
        date: when.toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        goals: [],
      };
      group.goals.push({
        id: goal.id,
        title: goal.title,
        tasks: steps.map((t) => t.title),
      });
      byDay.set(iso, group);
    }

    return [...byDay.values()].sort((a, b) => b.iso.localeCompare(a.iso));
  }, [data, query]);

  const totalGoals = groups.reduce((sum, group) => sum + group.goals.length, 0);
  const totalSteps = groups.reduce(
    (sum, group) => sum + group.goals.reduce((n, goal) => n + goal.tasks.length, 0),
    0,
  );

  if (status === "loading") {
    return (
      <main className="flex-1 flex items-center justify-center">
        <p className="text-muted text-sm">Checking your session...</p>
      </main>
    );
  }

  if (status === "unconfigured" && isApiConfigured) {
    return (
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-2xl font-bold text-foreground">Sign-in is not configured</h1>
          <p className="text-sm text-muted">
            NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID are unset.
          </p>
        </div>
      </main>
    );
  }

  if (status === "signed-out") {
    return <SignIn onSignedIn={recheck} />;
  }

  return (
    <main className="py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-extrabold text-foreground tracking-tight">
              Activity Log
            </h1>
            {session?.email && (
              <div className="flex items-center gap-3 text-xs text-muted/70">
                <span className="truncate max-w-[14rem]">{session.email}</span>
                <button onClick={signOut} className="underline hover:text-foreground shrink-0">
                  Sign out
                </button>
              </div>
            )}
          </div>
          <p className="text-muted">Everything you have finished, and what it was for.</p>
        </header>

        <SearchBar
          value={query}
          onChange={setQuery}
          label="Search finished goals and steps"
          hint="Search what you have finished..."
        />

        {loading ? (
          <div className="space-y-4 animate-pulse">
            <div className="h-6 w-32 bg-white/5 rounded-md" />
            <div className="h-20 bg-surface rounded-xl" />
          </div>
        ) : groups.length === 0 ? (
          <p className="text-center text-muted italic py-16 bg-surface/30 rounded-xl border border-dashed border-white/10">
            {query.trim() ? `Nothing matches "${query.trim()}".` : "Nothing completed yet."}
          </p>
        ) : (
          <div className="space-y-10">
            {groups.map((group) => (
              <section key={group.date} className="space-y-4">
                <div className="flex items-center gap-4">
                  <h2 className="text-lg font-semibold text-foreground">{group.date}</h2>
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-sm font-medium text-muted bg-white/5 px-2.5 py-0.5 rounded-full">
                    {group.goals.length} {group.goals.length === 1 ? "goal" : "goals"}
                  </span>
                </div>

                <ul className="space-y-4">
                  {group.goals.map((goal) => (
                    <li key={goal.id} className="bg-surface rounded-xl border border-white/5 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-foreground font-medium">{goal.title}</h3>
                        {/* Archiving is not a one-way door. Completing the last
                            step removes the goal card entirely, so this is the
                            only way back. */}
                        <button
                          onClick={() => {
                            void reopenGoal(goal.id);
                            scheduleBackup();
                          }}
                          className="text-xs text-muted hover:text-primary transition-colors shrink-0"
                        >
                          Reopen
                        </button>
                      </div>
                      {goal.tasks.length > 0 ? (
                        <ul className="mt-3 space-y-2 pl-4 border-l-2 border-white/5">
                          {goal.tasks.map((step) => (
                            <li key={step} className="flex items-center gap-3">
                              <span className="w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center shrink-0 text-primary-light">
                                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                                  <path
                                    fillRule="evenodd"
                                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </span>
                              <span className="text-sm text-muted">{step}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-muted/70 italic">No steps recorded.</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="text-center text-xs text-muted/70">
              {totalGoals} {totalGoals === 1 ? "goal" : "goals"} archived, {totalSteps}{" "}
              {totalSteps === 1 ? "step" : "steps"} completed.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
