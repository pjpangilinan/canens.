export const API_BASE = process.env.NEXT_PUBLIC_API_URL || (typeof window !== 'undefined' ? `http://${window.location.hostname}:8000` : 'http://localhost:8000');

import { db, FAKE_USER_ID, Task, Goal, GoalStatus, TaskStatus } from './db';
import { syncService } from './sync';

export type { Task, Goal };

export async function fetchGoals(): Promise<Goal[]> {
  return await db.goals.filter(g => !g.deleted_at).toArray();
}

export async function createGoal(title: string, user_id: string): Promise<Goal> {
  const goal: Goal = {
    id: crypto.randomUUID(),
    user_id,
    title,
    status: GoalStatus.ACTIVE,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    dirty: 1
  };
  await db.goals.add(goal);
  syncService.pushChanges();
  return goal;
}

export async function updateGoal(goal_id: string, updates: Partial<Goal>): Promise<Goal> {
  const now = new Date().toISOString();
  await db.goals.update(goal_id, { ...updates, updated_at: now, dirty: 1 });
  syncService.pushChanges();
  const g = await db.goals.get(goal_id);
  return g as Goal;
}

export async function deleteGoal(goal_id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.goals.update(goal_id, { deleted_at: now, updated_at: now, dirty: 1 });
  syncService.pushChanges();
}



export async function updateTask(task_id: string, updates: Partial<Task>): Promise<Task> {
  const now = new Date().toISOString();
  await db.tasks.update(task_id, { ...updates, updated_at: now, dirty: 1 });
  syncService.pushChanges();
  const t = await db.tasks.get(task_id);
  return t as Task;
}

export async function deleteTask(task_id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.tasks.update(task_id, { deleted_at: now, updated_at: now, dirty: 1 });
  syncService.pushChanges();
}

export async function createTask(goal_id: string, title: string, estimated_minutes: number): Promise<Task> {
  const task: Task = {
    id: crypto.randomUUID(),
    user_id: FAKE_USER_ID,
    goal_id,
    title,
    estimated_minutes,
    status: TaskStatus.PENDING,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    dirty: 1
  };
  await db.tasks.add(task);
  syncService.pushChanges();
  return task;
}



export interface TaskDraft {
  title: string;
  estimated_minutes: number;
}

export interface GoalBreakdown {
  is_completed: boolean;
  tasks: TaskDraft[];
}

export async function fetchCompletedTasks(user_id?: string): Promise<Task[]> {
  return await db.tasks.filter(t => t.status === TaskStatus.COMPLETED && !t.deleted_at).toArray();
}

export async function generateNextSteps(goal_id: string, current_tasks: { title: string, status: string }[]): Promise<GoalBreakdown> {
  const res = await fetch(`${API_BASE}/api/goals/${goal_id}/generate-next-steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_tasks })
  });
  if (!res.ok) throw new Error('Failed to generate tasks');
  return await res.json();
}
