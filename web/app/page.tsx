"use client";

import React, { useEffect, useState } from 'react';
import GoalCard from '../components/GoalCard';
import { fetchGoals, Goal } from '../lib/api';

export default function Home() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadGoals() {
      try {
        const data = await fetchGoals();
        setGoals(data);
      } catch (err: any) {
        setError(err.message || 'Failed to load goals');
      } finally {
        setLoading(false);
      }
    }
    loadGoals();
  }, []);

  return (
    <main className="min-h-screen bg-midnight-slate py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="text-center space-y-4">
          <h1 className="text-4xl md:text-5xl font-extrabold text-lunar-silver tracking-tight">
            Canens<span className="text-indigo-glow">.</span>
          </h1>
          <p className="text-lg text-lunar-dim max-w-xl mx-auto">
            Energy-Aware Productivity. Keep track of what matters.
          </p>
        </header>

        <section className="space-y-4">
          {loading ? (
            <div className="text-center py-12 space-y-4">
              <div className="animate-pulse space-y-4 max-w-sm mx-auto">
                <div className="h-24 bg-midnight-blue rounded-xl border border-indigo-glow/10"></div>
                <div className="h-24 bg-midnight-blue rounded-xl border border-indigo-glow/10"></div>
              </div>
            </div>
          ) : error ? (
            <div className="text-center py-12 px-6 bg-red-900/10 border border-red-500/20 rounded-xl">
              <p className="text-red-400 font-medium">{error}</p>
              <p className="text-lunar-dim text-sm mt-2">Make sure the backend is running.</p>
            </div>
          ) : goals.length === 0 ? (
            <div className="text-center py-12 px-6 bg-midnight-blue/30 border border-midnight-blue rounded-xl">
              <p className="text-lunar-dim">No goals found. Start by creating one!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {goals.map((goal) => (
                <GoalCard key={goal.id} title={goal.title} status={goal.status} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
