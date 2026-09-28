"use client";

import React, { useEffect, useState } from 'react';
import GoalCard from '../components/GoalCard';
import GoalInput from '../components/GoalInput';
import { createGoal, deleteGoal, updateTask, updateGoal } from '../lib/api';
import SearchBar from '../components/SearchBar';
import SuggestedGoals from '../components/SuggestedGoals';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, FAKE_USER_ID, Goal, Task, GoalStatus, TaskStatus } from '../lib/db';
import { syncService } from '../lib/sync';

export default function Home() {
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    syncService.init().catch((err) => {
      console.error("Sync init failed", err);
      // We don't necessarily want to block the UI if backend is down, local works!
    });
  }, []);

  const goals = useLiveQuery(async () => {
    const gs = await db.goals.filter(g => !g.deleted_at).toArray();
    const sorted = gs.sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
    // Fetch ALL active tasks once
    const allTasks = await db.tasks.filter(t => !t.deleted_at).toArray();
    
    // Attach tasks to goals for GoalCard
    for (const g of sorted) {
      g.tasks = allTasks.filter(t => t.goal_id === g.id);
    }
    return sorted as (Goal & { tasks: Task[] })[];
  });


  const loading = goals === undefined;

  const handleCreateGoal = async (title: string) => {
    try {
      await createGoal(title, FAKE_USER_ID);
    } catch (err: any) {
      console.error('Error creating goal:', err);
    }
  };

  const handleDeleteGoal = async (id: string) => {
    try {
      await deleteGoal(id);
    } catch (err) {
      console.error('Error deleting goal:', err);
    }
  };

  const handleTaskComplete = async (taskId: string) => {
    try {
      await updateTask(taskId, { status: TaskStatus.COMPLETED });
    } catch (err) {
      console.error('Error completing task:', err);
    }
  };

  const handleCompleteGoal = async (id: string) => {
    try {
      await updateGoal(id, { status: GoalStatus.COMPLETED });
    } catch (err) {
      console.error('Error completing goal:', err);
    }
  };

  return (
    <main className="min-h-screen bg-background py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="text-center space-y-4">
          <h1 className="text-4xl md:text-5xl font-extrabold text-foreground tracking-tight font-headline">
            Canens<span className="text-primary">.</span>
          </h1>
          <p className="text-lg text-muted max-w-xl mx-auto">
            Minimalist Goal Tracker. Keep track of what matters.
          </p>
        </header>

        <section className="mb-4">
          <GoalInput onSubmit={handleCreateGoal} />
        </section>

        <section className="mb-6">
          <SearchBar value={searchQuery} onChange={setSearchQuery} />
        </section>

        <section className="space-y-4">
          {loading ? (
            <div className="text-center py-12 space-y-4">
              <div className="animate-pulse space-y-4 max-w-sm mx-auto">
                <div className="h-24 bg-surface rounded-xl border border-primary/10"></div>
                <div className="h-24 bg-surface rounded-xl border border-primary/10"></div>
              </div>
            </div>
          ) : error ? (
            <div className="text-center py-12 px-6 bg-red-900/10 border border-red-500/20 rounded-xl">
              <p className="text-red-400 font-medium">{error}</p>
              <p className="text-muted text-sm mt-2">Make sure the backend is running.</p>
            </div>
          ) : goals.length === 0 ? (
            <SuggestedGoals onSelectGoal={handleCreateGoal} />
          ) : (
            <div className="space-y-4">
              {goals
                .filter((goal) => {
                  if (!searchQuery.trim()) return true;
                  const query = searchQuery.toLowerCase();
                  return (
                    goal.title.toLowerCase().includes(query) ||
                    goal.tasks.some(t => t.title.toLowerCase().includes(query))
                  );
                })
                .map((goal) => (
                  <GoalCard 
                    key={goal.id} 
                    id={goal.id} 
                    title={goal.title} 
                    status={goal.status} 
                    tasks={goal.tasks} 
                    searchQuery={searchQuery}
                    onDelete={handleDeleteGoal}
                    onComplete={handleCompleteGoal}
                    onTaskComplete={handleTaskComplete}
                  />
                ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
