"use client";

import { useState } from "react";
import { Goal, GoalStatus, Task, TaskStatus } from "../lib/db";
import { streamNextSteps } from "../lib/api";
import * as store from "../lib/store";
import { flushBackupNow } from "../lib/backup";

interface GoalCardProps {
  goal: Goal;
  tasks: Task[];
  /** Ids of tasks matching the current search, for highlighting. */
  matchingTaskIds: Set<string>;
  /** Expand on mount because a task inside matched the search. */
  startExpanded: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}

export default function GoalCard({
  goal,
  tasks,
  matchingTaskIds,
  startExpanded,
  onChanged,
  onError,
}: GoalCardProps) {
  // null means "the user has not said", so a card follows whatever the search
  // asks for until they touch it. Reading startExpanded only in useState meant
  // it applied on mount, so a card already on screen when the user typed never
  // expanded and the goal matched for no visible reason.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? startExpanded;
  const [renamingGoal, setRenamingGoal] = useState(false);
  const [goalTitle, setGoalTitle] = useState(goal.title);
  const [addingTask, setAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTaskTitle, setEditTaskTitle] = useState("");
  const [generating, setGenerating] = useState(false);
  const [streamSnippet, setStreamSnippet] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const isCompleted = goal.status === GoalStatus.COMPLETED;
  const outstanding = tasks.filter((t) => t.status !== TaskStatus.COMPLETED);
  const done = tasks.filter((t) => t.status === TaskStatus.COMPLETED);

  const toggleExpanded = () => setUserExpanded(!expanded);

  const announce = () => onChanged();

  async function run(action: () => Promise<unknown>, context: string) {
    try {
      await action();
      announce();
    } catch (error) {
      onError(`${context}: ${(error as Error).message}`);
    }
  }

  /** Steps the model proposed, appended. Never replaces: the user curates. */
  async function applyProposal(titles: string[]) {
    let added = 0;
    for (const title of titles) {
      try {
        await store.createTask(goal.id, title);
        added += 1;
      } catch (error) {
        // The goal may have been completed or deleted while the model was
        // thinking. Say so rather than dropping the rest silently.
        onError(`Could not add a step: ${(error as Error).message}`);
        break;
      }
    }
    if (added > 0) {
      setUserExpanded(true);
      announce();
    }
  }

  async function saveGoalTitle() {
    const title = goalTitle.trim();
    setRenamingGoal(false);
    if (!title || title === goal.title) {
      setGoalTitle(goal.title);
      return;
    }

    try {
      await store.renameGoal(goal.id, title);
      announce();
    } catch (error) {
      setGoalTitle(goal.title);
      onError(`Could not rename the goal: ${(error as Error).message}`);
      return;
    }

    // The breakdown was written against the old wording, so offer fresh steps
    // for the new one. This appends; existing steps are left alone.
    setConfirmRegenerate(true);
  }

  async function generate() {
    setGenerating(true);
    setStreamSnippet(null);
    try {
      const result = await streamNextSteps(
        goal.title,
        tasks.map((t) => ({ title: t.title, status: t.status })),
        (token) => {
          setStreamSnippet((prev) => {
            const next = ((prev ?? "") + token).replace(/[\s\r\n]+/g, " ");
            return next.length > 30 ? "..." + next.slice(-27) : next;
          });
        },
      );

      if (result.status === "done") {
        // Archiving removes the goal from the active list, so the model
        // proposes it and the user decides.
        setConfirmArchive("The model thinks this goal is done.");
        return;
      }

      await applyProposal(result.tasks);
    } catch (error) {
      onError(`Could not generate next steps: ${(error as Error).message}`);
    } finally {
      setGenerating(false);
      setStreamSnippet(null);
    }
  }

  async function toggleTask(task: Task) {
    const next =
      task.status === TaskStatus.COMPLETED ? TaskStatus.PENDING : TaskStatus.COMPLETED;
    await run(() => store.setTaskStatus(task.id, next), "Could not update the task");
  }

  return (
    <div className="bg-surface border border-primary/20 shadow-glass rounded-xl overflow-hidden transition-all duration-300">
      <div className="p-6 flex justify-between items-start gap-4">
        {/*
          The input is a sibling of the toggle, not a child of it. A button
          may only contain phrasing content, and nesting a text field inside
          one makes the toggle's accessible name change as you type, so a
          screen reader announces a field inside a button.
        */}
        {renamingGoal ? (
          <input
            autoFocus
            value={goalTitle}
            onChange={(e) => setGoalTitle(e.target.value)}
            onBlur={saveGoalTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveGoalTitle();
              if (e.key === "Escape") {
                setGoalTitle(goal.title);
                setRenamingGoal(false);
              }
            }}
            className="flex-1 min-w-0 bg-black/50 border border-primary/50 rounded px-2 py-1 text-xl text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Rename "${goal.title}"`}
          />
        ) : (
          <h3 className="flex-1 min-w-0 text-xl font-semibold text-foreground">
            <button
              onClick={toggleExpanded}
              aria-expanded={expanded}
              // Names the action, not just the goal. A button whose name is
              // only the goal's title says nothing about what pressing it does.
              aria-label={`${expanded ? "Collapse" : "Expand"} ${goal.title}`}
              className="flex items-center space-x-3 text-left w-full group"
            >
              <svg
                className={`w-5 h-5 shrink-0 text-muted transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              <span className="truncate group-hover:text-white transition-colors">{goal.title}</span>
            </button>
          </h3>
        )}

        <div className="flex items-center space-x-3 shrink-0">
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap ${
              isCompleted ? "bg-green-500/20 text-green-400" : "bg-primary/20 text-primary-light"
            }`}
          >
            {goal.status}
          </span>

          {!isCompleted && (
            <>
              <button
                onClick={() => {
                  setGoalTitle(goal.title);
                  setRenamingGoal(true);
                }}
                disabled={generating}
                className="text-muted hover:text-primary transition-colors disabled:opacity-40"
                title="Rename goal"
                aria-label={`Rename "${goal.title}"`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                </svg>
              </button>

              <button
                onClick={() =>
                  void run(() => store.archiveGoal(goal.id), "Could not complete the goal")
                }
                // Generating writes steps, and a step on an archived goal is
                // invisible. The model call is asynchronous, so the race is
                // real rather than theoretical.
                disabled={generating}
                className="text-green-500/70 hover:text-green-500 transition-colors disabled:opacity-40"
                title="Complete goal"
                aria-label="Complete goal"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </>
          )}

          <button
            onClick={() => {
              // Destructive, so do not leave the server holding a snapshot
              // that still contains what was just removed.
              flushBackupNow();
              void run(() => store.deleteGoal(goal.id), "Could not delete the goal");
            }}
            disabled={generating}
            className="text-red-500/70 hover:text-red-500 transition-colors disabled:opacity-40"
            title="Delete goal"
            aria-label={`Delete "${goal.title}"`}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {confirmRegenerate && (
        <div className="px-6 py-4 border-t border-white/5 bg-primary/10 flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground flex-1 min-w-[12rem]">
            The steps were written for the old title. Generate more for &ldquo;{goal.title}&rdquo;?
          </p>
          <button
            onClick={() => {
              setConfirmRegenerate(false);
              void generate();
            }}
            className="text-sm bg-primary text-white px-3 py-1.5 rounded hover:bg-primary-light"
          >
            Generate steps
          </button>
          <button
            onClick={() => setConfirmRegenerate(false)}
            className="text-sm text-muted hover:text-white px-3 py-1.5 rounded"
          >
            Not now
          </button>
        </div>
      )}

      {confirmArchive && (
        <div className="px-6 py-4 border-t border-white/5 bg-primary/10 flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground flex-1 min-w-[12rem]">
            {confirmArchive} Complete it and move it to your Activity Log?
          </p>
          <button
            onClick={() => {
              setConfirmArchive(null);
              void run(() => store.archiveGoal(goal.id), "Could not complete the goal");
            }}
            className="text-sm bg-primary text-white px-3 py-1.5 rounded hover:bg-primary-light"
          >
            Complete goal
          </button>
          <button
            onClick={() => setConfirmArchive(null)}
            className="text-sm text-muted hover:text-white px-3 py-1.5 rounded"
          >
            Not yet
          </button>
        </div>
      )}

      {expanded && (
        <div className="px-6 pb-6 pt-4 border-t border-white/5 bg-black/20">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-sm font-medium text-muted uppercase tracking-wider">Next steps</h4>
            {!isCompleted && (
              <div className="flex space-x-4">
                <button
                  onClick={() => void generate()}
                  disabled={generating}
                  className="text-xs flex items-center space-x-1 text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-50"
                >
                  <svg
                    className={`w-4 h-4 ${generating ? "animate-spin" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span>{generating ? (streamSnippet ? `Drafting: ${streamSnippet}` : "Thinking...") : "Generate steps"}</span>
                </button>
                <button
                  onClick={() => setAddingTask(true)}
                  className="text-xs flex items-center space-x-1 text-primary-light hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Add step</span>
                </button>
              </div>
            )}
          </div>

          <ul className="space-y-2">
            {outstanding.length === 0 && !addingTask && (
              <li className="text-sm text-muted italic text-center py-6 bg-white/5 rounded-lg border border-dashed border-white/10">
                {tasks.length === 0
                  ? "No steps yet. Generate some, or add one yourself."
                  : "Every step is done."}
              </li>
            )}

            {outstanding.map((task) => {
              const isMatch = matchingTaskIds.has(task.id);
              return (
                <li
                  key={task.id}
                  className={`group/task flex justify-between items-center p-3 rounded-lg border transition-colors ${
                    isMatch
                      ? "bg-primary/20 border-primary/50 ring-1 ring-primary/30"
                      : "bg-white/5 border-white/5 hover:border-primary/30"
                  }`}
                >
                  {editingTaskId === task.id ? (
                    <div className="flex items-center space-x-2 w-full">
                      <input
                        autoFocus
                        value={editTaskTitle}
                        onChange={(e) => setEditTaskTitle(e.target.value)}
                        onBlur={() => {
                          const title = editTaskTitle.trim();
                          setEditingTaskId(null);
                          if (title && title !== task.title) {
                            void run(() => store.renameTask(task.id, title), "Could not rename the step");
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editTaskTitle.trim()) {
                            const id = task.id;
                            const title = editTaskTitle.trim();
                            setEditingTaskId(null);
                            if (title !== task.title) {
                              void run(() => store.renameTask(id, title), "Could not rename the step");
                            }
                          }
                          if (e.key === "Escape") setEditingTaskId(null);
                        }}
                        maxLength={200}
                        className="flex-1 bg-black/50 border border-primary/50 rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-primary"
                        aria-label="Step title"
                      />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center space-x-3 flex-1 overflow-hidden">
                        {/*
                          role="checkbox" rather than a real input: completing
                          the step moves it out of this list, so the control
                          cannot hold a checked state. It is still exposed as a
                          checkbox, and it keeps a visible focus ring, which the
                          previous focus:outline-none removed.
                        */}
                        <button
                          role="checkbox"
                          aria-checked="false"
                          onClick={() => void toggleTask(task)}
                          className="w-5 h-5 rounded-md border-2 border-muted/50 hover:border-green-500 hover:bg-green-500/10 flex items-center justify-center text-green-500 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary shrink-0"
                          title="Mark as done"
                          aria-label={`Mark "${task.title}" as done`}
                        />
                        <span className="text-sm text-foreground truncate" title={task.title}>
                          {task.title}
                        </span>
                      </div>
                      <div className="flex space-x-1 opacity-100 sm:opacity-0 sm:group-hover/task:opacity-100 focus-within:opacity-100 transition-opacity shrink-0 ml-4">
                        <button
                          onClick={() => {
                            setEditingTaskId(task.id);
                            setEditTaskTitle(task.title);
                          }}
                          className="text-muted hover:text-primary p-1"
                          title="Edit step"
                          aria-label={`Edit "${task.title}"`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={() => void run(() => store.deleteTask(task.id), "Could not delete the step")}
                          className="text-muted hover:text-red-500 p-1"
                          title="Delete step"
                          aria-label={`Delete "${task.title}"`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}

            {done.length > 0 && (
              <li className="pt-2">
                <details className="group/done">
                  <summary className="text-xs text-muted cursor-pointer hover:text-foreground select-none">
                    {done.length} completed
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {done.map((task) => (
                      <li key={task.id} className="flex items-center gap-3 px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => void toggleTask(task)}
                          className="w-4 h-4 accent-primary"
                          aria-label={`Undo completion of "${task.title}"`}
                        />
                        <span className="text-sm text-muted line-through truncate">{task.title}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}

            {addingTask && (
              <li className="p-3 bg-white/5 rounded-lg border border-primary/50">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newTaskTitle.trim()) return;
                    const title = newTaskTitle;
                    setNewTaskTitle("");
                    setAddingTask(false);
                    void run(() => store.createTask(goal.id, title), "Could not add the step");
                  }}
                  className="flex items-center space-x-2"
                >
                  <input
                    autoFocus
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setAddingTask(false);
                    }}
                    placeholder="Describe the next step..."
                    aria-label={`Add a step to "${goal.title}"`}
                    maxLength={200}
                    className="flex-1 bg-black/50 border border-white/10 rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    disabled={!newTaskTitle.trim()}
                    className="text-sm bg-primary text-white px-3 py-1.5 rounded hover:bg-primary-light disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingTask(false)}
                    className="text-muted hover:text-white p-1.5"
                    aria-label="Cancel"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </form>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
