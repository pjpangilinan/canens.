import { describe, expect, it } from "vitest";
import { GoalStatus, GoalWithTasks, TaskStatus } from "../lib/db";
import { searchGoals } from "../lib/search";

function goal(id: string, title: string, status = GoalStatus.ACTIVE): GoalWithTasks {
  return {
    id,
    user_id: "u",
    title,
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    tasks: [],
  };
}

function task(
  id: string,
  goalId: string,
  title: string,
  status: TaskStatus = TaskStatus.PENDING,
) {
  return {
    id,
    user_id: "u",
    goal_id: goalId,
    title,
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("searchGoals", () => {
  it("returns everything for an empty query", () => {
    const goals = [goal("g1", "Write a book"), goal("g2", "Run a marathon")];
    const result = searchGoals(goals, "   ");

    expect(result.goals).toHaveLength(2);
    expect(result.matchingTaskIds.size).toBe(0);
    expect(result.expandGoalIds.size).toBe(0);
  });

  it("matches a goal title", () => {
    const goals = [goal("g1", "Write a book"), goal("g2", "Run a marathon")];
    const result = searchGoals(goals, "book");

    expect(result.goals.map((g) => g.id)).toEqual(["g1"]);
    // A title match does not force the task list open.
    expect(result.expandGoalIds.has("g1")).toBe(false);
  });

  it("matches case insensitively", () => {
    const goals = [goal("g1", "Write a BOOK")];
    expect(searchGoals(goals, "book").goals).toHaveLength(1);
  });

  it("keeps a goal whose task matches and marks the task", () => {
    const g = goal("g1", "Write a book");
    g.tasks = [task("t1", "g1", "Draft the first chapter"), task("t2", "g1", "Find a publisher")];

    const result = searchGoals([g], "chapter");

    expect(result.goals.map((x) => x.id)).toEqual(["g1"]);
    expect([...result.matchingTaskIds]).toEqual(["t1"]);
    expect(result.expandGoalIds.has("g1")).toBe(true);
  });

  it("matches completed steps too", () => {
    // The user is searching for something they wrote. "Nothing matches" for
    // text they can see on screen is the wrong answer, even if the step is
    // finished - and the Activity Log can find the same text.
    const g = goal("g1", "Write a book");
    g.tasks = [task("t1", "g1", "Already done", TaskStatus.COMPLETED)];

    const result = searchGoals([g], "already");

    expect(result.goals.map((x) => x.id)).toEqual(["g1"]);
    expect([...result.matchingTaskIds]).toEqual(["t1"]);
    expect(result.expandGoalIds.has("g1")).toBe(true);
  });

  it("returns nothing when there is no match", () => {
    const g = goal("g1", "Write a book");
    g.tasks = [task("t1", "g1", "Draft the first chapter")];

    expect(searchGoals([g], "helicopter").goals).toHaveLength(0);
  });
});
