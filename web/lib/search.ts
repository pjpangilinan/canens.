/**
 * Pure local text search over the store.
 *
 * Extracted from the page component so it can be tested directly against a
 * seeded database without going through the API, which is what the previous
 * spec asked for and never got.
 */
import { GoalWithTasks } from "./db";

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

export interface SearchOutcome {
  /** Goals to render, after filtering. */
  goals: GoalWithTasks[];
  /** Ids of tasks that matched, so the card can highlight them. */
  matchingTaskIds: Set<string>;
  /** Goals that contain a match and should auto-expand. */
  expandGoalIds: Set<string>;
}

export function searchGoals(goals: GoalWithTasks[], query: string): SearchOutcome {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return { goals, matchingTaskIds: new Set(), expandGoalIds: new Set() };
  }

  const matchingTaskIds = new Set<string>();
  const expandGoalIds = new Set<string>();
  const kept: GoalWithTasks[] = [];

  for (const goal of goals) {
    const goalMatches = matches(goal.title, needle);
    // Completed steps match too. The user is searching for something they
    // wrote, and "Nothing matches" for text they can see on screen - or read
    // in the Activity Log - is the wrong answer.
    const taskMatches = goal.tasks.filter((t) => matches(t.title, needle));

    if (!goalMatches && taskMatches.length === 0) continue;

    for (const task of taskMatches) matchingTaskIds.add(task.id);
    // A goal whose own title matched is already visible; only auto-expand for
    // a step match, so a title match does not collapse a long step list open.
    if (!goalMatches) expandGoalIds.add(goal.id);

    kept.push(goal);
  }

  return { goals: kept, matchingTaskIds, expandGoalIds };
}
