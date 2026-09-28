"use client";

import React, { useEffect, useState } from 'react';
import { fetchCompletedTasks, Task } from '../../lib/api';

interface GroupedTasks {
  [dateString: string]: Task[];
}

export default function ActivityLog() {
  const [groupedTasks, setGroupedTasks] = useState<GroupedTasks>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadTasks = async () => {
      try {
        const tasks = await fetchCompletedTasks();
        
        // Group by date
        const grouped: GroupedTasks = {};
        tasks.forEach(task => {
          // If updated_at isn't returned for some reason, fallback to created_at or now
          const dateVal = task.updated_at || task.created_at || new Date().toISOString();
          const dateObj = new Date(dateVal);
          
          // Format as "July 24, 2026"
          const dateString = dateObj.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          
          if (!grouped[dateString]) {
            grouped[dateString] = [];
          }
          grouped[dateString].push(task);
        });
        
        setGroupedTasks(grouped);
      } catch (err: any) {
        setError(err.message || 'Failed to load activity log');
      } finally {
        setLoading(false);
      }
    };
    
    loadTasks();
  }, []);

  return (
    <main className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto space-y-12">
        <header className="space-y-2">
          <h1 className="text-3xl font-extrabold text-foreground tracking-tight font-headline">
            Activity Log
          </h1>
          <p className="text-muted">A history of what you've accomplished.</p>
        </header>

        {loading ? (
          <div className="space-y-8 animate-pulse">
            {[1, 2].map(i => (
              <div key={i} className="space-y-4">
                <div className="h-6 w-32 bg-white/5 rounded-md"></div>
                <div className="h-20 bg-surface rounded-xl border border-white/5"></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-6 bg-red-900/10 border border-red-500/20 rounded-xl text-red-400">
            {error}
          </div>
        ) : Object.keys(groupedTasks).length === 0 ? (
          <div className="text-center py-16 bg-surface/30 rounded-xl border border-dashed border-white/10">
            <p className="text-muted italic">No completed tasks yet. Time to get to work!</p>
          </div>
        ) : (
          <div className="space-y-10">
            {Object.entries(groupedTasks).map(([date, tasks]) => (
              <section key={date} className="space-y-4">
                <div className="flex items-center space-x-4">
                  <h2 className="text-lg font-semibold text-white">{date}</h2>
                  <div className="flex-1 h-px bg-white/10"></div>
                  <span className="text-sm font-medium text-muted bg-white/5 px-2.5 py-0.5 rounded-full">
                    {tasks.length} task{tasks.length !== 1 ? 's' : ''}
                  </span>
                </div>
                
                <div className="space-y-3 pl-4 border-l-2 border-white/5">
                  {tasks.map(task => (
                    <div key={task.id} className="p-4 bg-surface rounded-xl border border-white/5 hover:border-primary/20 transition-colors flex items-center justify-between group">
                      <div className="flex items-center space-x-3">
                        <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-primary-light" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        </div>
                        <span className="text-foreground group-hover:text-white transition-colors">
                          {task.title}
                        </span>
                      </div>
                      
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-muted/60">{task.estimated_minutes}m</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
