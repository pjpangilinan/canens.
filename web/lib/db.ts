import Dexie, { type EntityTable } from 'dexie';

export const TaskStatus = {
  PENDING: 'Pending',
  COMPLETED: 'Completed'
} as const;
export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

export interface Task {
  id: string;
  user_id: string;
  goal_id: string | null;
  title: string;
  estimated_minutes: number;
  status: TaskStatusType | string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  dirty?: number; // 1 if needs push, 0 otherwise
}

export const GoalStatus = {
  ACTIVE: 'Active',
  COMPLETED: 'Completed'
} as const;
export type GoalStatusType = typeof GoalStatus[keyof typeof GoalStatus];

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  status: GoalStatusType | string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  dirty?: number;
  tasks?: Task[];
}



export interface SyncMeta {
  id: string;
  last_pulled_at: number;
}

export const db = new Dexie('CanensLocalDB') as Dexie & {
  tasks: EntityTable<Task, 'id'>;
  goals: EntityTable<Goal, 'id'>;

  sync_meta: EntityTable<SyncMeta, 'id'>;
};

// Schema versioning
db.version(3).stores({
  tasks: 'id, user_id, goal_id, updated_at, dirty',
  goals: 'id, user_id, updated_at, dirty',

  sync_meta: 'id'
});

export const FAKE_USER_ID = "00000000-0000-0000-0000-000000000000";
