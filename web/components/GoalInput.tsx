"use client";

import { useState } from "react";

interface GoalInputProps {
  onSubmit: (title: string) => Promise<void>;
  onError: (message: string) => void;
}

export default function GoalInput({ onSubmit, onError }: GoalInputProps) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(title);
      setTitle("");
    } catch (error) {
      onError(`Could not add the goal: ${(error as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full relative">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setTitle("");
        }}
        placeholder="What is your next goal?"
        aria-label="New goal"
        maxLength={500}
        className="w-full bg-surface/50 border border-primary/20 rounded-xl py-4 pl-6 pr-24 text-foreground placeholder-muted focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all shadow-inner"
        disabled={submitting}
      />
      <button
        type="submit"
        disabled={!title.trim() || submitting}
        className="absolute right-2 top-2 bottom-2 bg-primary text-white px-4 rounded-lg font-medium hover:bg-primary-light disabled:opacity-50 disabled:hover:bg-primary transition-colors"
      >
        {submitting ? "Adding..." : "Add"}
      </button>
    </form>
  );
}
