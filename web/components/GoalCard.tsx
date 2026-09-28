import React, { useState } from 'react';
import { Task, createTask, updateTask, deleteTask as apiDeleteTask, generateNextSteps } from '../lib/api';
import { GoalStatus, TaskStatus } from '../lib/db';

interface GoalCardProps {
  id: string;
  title: string;
  status: string;
  tasks?: Task[];
  searchQuery?: string;
  onDelete?: (id: string) => void;
  onComplete?: (id: string) => void;
  onTaskComplete?: (taskId: string) => void;
}

export default function GoalCard({ id, title, status, tasks = [], searchQuery = '', onDelete, onComplete, onTaskComplete }: GoalCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTaskTitle, setEditTaskTitle] = useState('');
  const [localTasks, setLocalTasks] = useState<Task[]>(tasks);
  const [isGenerating, setIsGenerating] = useState(false);

  // Filter out completed tasks
  const activeTasks = localTasks.filter(t => t.status !== TaskStatus.COMPLETED);
  const isCompleted = status === GoalStatus.COMPLETED;

  // When tasks prop changes (e.g. from websocket or refresh), update local tasks
  React.useEffect(() => {
    setLocalTasks(tasks);
  }, [tasks]);

  React.useEffect(() => {
    if (searchQuery.trim() && localTasks.some(t => t.title.toLowerCase().includes(searchQuery.toLowerCase()))) {
      setIsExpanded(true);
    }
  }, [searchQuery, localTasks]);

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    
    try {
      const newTask = await createTask(id, newTaskTitle, 30);
      setLocalTasks(prev => [...prev, newTask]);
      setNewTaskTitle('');
      setIsAddingTask(false);
    } catch (err) {
      console.error('Failed to create task', err);
    }
  };

  const handleGenerateNextSteps = async () => {
    setIsGenerating(true);
    try {
      const currentTasks = localTasks.map(t => ({ title: t.title, status: t.status }));
      const res = await generateNextSteps(id, currentTasks);
      
      if (res.is_completed && onComplete) {
        onComplete(id);
      } else if (res.tasks && res.tasks.length > 0) {
        const newLocalTasks: Task[] = [];
        for (const t of res.tasks) {
          const newTask = await createTask(id, t.title, t.estimated_minutes);
          newLocalTasks.push(newTask);
        }
        setLocalTasks(prev => [...prev, ...newLocalTasks]);
      }
    } catch (err) {
      console.error('Failed to generate tasks', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveEdit = async (taskId: string) => {
    if (!editTaskTitle.trim()) return;
    try {
      const updated = await updateTask(taskId, { title: editTaskTitle });
      setLocalTasks(prev => prev.map(t => t.id === taskId ? updated : t));
      setEditingTaskId(null);
    } catch (err) {
      console.error('Failed to update task', err);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await apiDeleteTask(taskId);
      setLocalTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('Failed to delete task', err);
    }
  };

  const handleComplete = async (taskId: string) => {
    // Optimistic UI update
    setLocalTasks(prev => prev.filter(t => t.id !== taskId));
    if (onTaskComplete) {
      await onTaskComplete(taskId);
    }
  };

  return (
    <div className="bg-surface border border-primary/20 shadow-glass rounded-xl overflow-hidden transition-all duration-300">
      <div 
        className="p-6 cursor-pointer hover:bg-primary/5 flex justify-between items-start group"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center space-x-3">
          <button className="text-muted group-hover:text-primary transition-colors">
            <svg className={`w-5 h-5 transform transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
          <h3 className="text-xl font-semibold text-foreground group-hover:text-white transition-colors duration-300">
            {title}
          </h3>
        </div>
        <div className="flex items-center space-x-3" onClick={e => e.stopPropagation()}>
          <span className={`px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap ml-4 ${isCompleted ? 'bg-green-500/20 text-green-400' : 'bg-primary/20 text-primary-light'}`}>
            {status}
          </span>
          {!isCompleted && onComplete && (
            <button onClick={() => onComplete(id)} className="text-green-500/70 hover:text-green-500 transition-colors" title="Complete Goal">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {onDelete && (
            <button onClick={() => onDelete(id)} className="text-red-500/70 hover:text-red-500 transition-colors" title="Delete Goal">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {isExpanded && (
        <div className="px-6 pb-6 pt-2 border-t border-white/5 bg-black/20">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-sm font-medium text-muted uppercase tracking-wider">Active Tasks</h4>
            {!isCompleted && (
              <div className="flex space-x-4">
                <button 
                  onClick={handleGenerateNextSteps}
                  disabled={isGenerating}
                  className="text-xs flex items-center space-x-1 text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-50"
                >
                  <svg className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  <span>{isGenerating ? 'Generating...' : 'Generate Steps'}</span>
                </button>
                <button 
                  onClick={() => setIsAddingTask(true)}
                  className="text-xs flex items-center space-x-1 text-primary-light hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                  <span>Add Task</span>
                </button>
              </div>
            )}
          </div>

          <ul className="space-y-2">
            {activeTasks.length > 0 ? (
              activeTasks.map(task => {
                const isMatch = searchQuery.trim() && task.title.toLowerCase().includes(searchQuery.toLowerCase());
                return (
                <li key={task.id} className={`flex justify-between items-center p-3 rounded-lg border group/task transition-colors ${
                  isMatch ? 'bg-primary/20 border-primary/50 ring-1 ring-primary/30 shadow-[0_0_15px_rgba(var(--primary),0.2)]' : 'bg-white/5 border-white/5 hover:border-primary/30'
                }`}>
                  {editingTaskId === task.id ? (
                    <div className="flex items-center space-x-2 w-full">
                      <input 
                        type="text" 
                        value={editTaskTitle}
                        onChange={e => setEditTaskTitle(e.target.value)}
                        className="flex-1 bg-black/50 border border-primary/50 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-primary"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveEdit(task.id);
                          if (e.key === 'Escape') setEditingTaskId(null);
                        }}
                      />
                      <button onClick={() => handleSaveEdit(task.id)} className="text-green-400 hover:text-green-300">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      </button>
                      <button onClick={() => setEditingTaskId(null)} className="text-red-400 hover:text-red-300">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center space-x-3 flex-1 overflow-hidden">
                        <button
                          onClick={() => handleComplete(task.id)}
                          className="w-5 h-5 rounded-md border-2 border-muted/50 hover:border-green-500 hover:bg-green-500/10 flex items-center justify-center text-green-500 transition-all focus:outline-none shrink-0 group/check"
                          title="Mark as complete"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 opacity-0 group-hover/check:opacity-100 transition-opacity" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        </button>
                        <span className="text-sm text-foreground truncate" title={task.title}>
                          {task.title}
                        </span>
                      </div>
                      <div className="flex space-x-2 shrink-0 ml-4 items-center">
                        <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-1 rounded-full">{task.estimated_minutes} min</span>
                        
                        {/* Edit and Delete Actions */}
                        <div className="flex space-x-1 opacity-0 group-hover/task:opacity-100 transition-opacity ml-2">
                          <button 
                            onClick={() => { setEditingTaskId(task.id); setEditTaskTitle(task.title); }}
                            className="text-muted hover:text-primary p-1"
                            title="Edit task"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                          <button 
                            onClick={() => handleDeleteTask(task.id)}
                            className="text-muted hover:text-red-500 p-1"
                            title="Delete task"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </li>
                );
              })
            ) : (
              !isAddingTask && !isCompleted && (
                <li className="text-sm text-muted italic text-center py-6 bg-white/5 rounded-lg border border-dashed border-white/10 flex flex-col items-center justify-center space-y-3">
                  <div className="flex space-x-2">
                    <div className="w-2 h-2 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-2 h-2 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-2 h-2 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                  <span>AI is breaking down this goal...</span>
                </li>
              )
            )}

            {isAddingTask && (
              <li className="p-3 bg-white/5 rounded-lg border border-primary/50">
                <form onSubmit={handleAddTask} className="flex items-center space-x-2">
                  <input 
                    type="text" 
                    value={newTaskTitle}
                    onChange={e => setNewTaskTitle(e.target.value)}
                    placeholder="Describe the task..."
                    className="flex-1 bg-black/50 border border-white/10 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-primary"
                    autoFocus
                  />
                  <button type="submit" className="text-sm bg-primary text-white px-3 py-1.5 rounded hover:bg-primary-light transition-colors">
                    Add
                  </button>
                  <button type="button" onClick={() => setIsAddingTask(false)} className="text-muted hover:text-white p-1.5">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
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
