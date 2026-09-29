"use client";

import { useState } from "react";
import { fetchStarterGoals } from "../lib/api";

const QUESTIONS = [
  {
    id: "obstacle",
    label: "What gets in the way of making progress?",
    placeholder: "e.g. I never know what the next step is",
  },
  {
    id: "time",
    label: "How much time do you usually have?",
    placeholder: "e.g. a couple of hours most evenings",
  },
] as const;

interface OnboardingProps {
  onCreateGoal: (title: string) => Promise<void>;
  onError: (message: string) => void;
}

export default function Onboarding({ onCreateGoal, onError }: OnboardingProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [addingTitle, setAddingTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answered = QUESTIONS.filter((q) => (answers[q.id] ?? "").trim()).length;
  const canSuggest = answered >= 1 && !loading;

  async function suggest() {
    setLoading(true);
    setError(null);
    try {
      const summary = QUESTIONS.map((q) => `${q.label} ${answers[q.id]?.trim() ?? ""}`)
        .join("\n")
        .trim();
      const result = await fetchStarterGoals(summary, 4);
      setSuggestions(result.goals);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      onError(`Could not suggest goals: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-headline font-bold text-foreground">Start with a goal</h2>
        <p className="text-muted">
          Type one above to add it. Or answer a question or two and Canens will suggest some.
        </p>
      </div>

      <div className="space-y-4 bg-surface/50 border border-primary/20 rounded-xl p-6">
        {QUESTIONS.map((question) => (
          <label key={question.id} className="block space-y-2">
            <span className="text-sm text-foreground">{question.label}</span>
            <input
              value={answers[question.id] ?? ""}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
              placeholder={question.placeholder}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted focus:outline-none focus:border-primary"
            />
          </label>
        ))}

        <button
          onClick={() => void suggest()}
          disabled={!canSuggest}
          className="text-sm bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-light disabled:opacity-50 transition-colors"
        >
          {loading ? "Thinking..." : "Suggest some goals"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {suggestions.map((title) => (
            <button
              key={title}
              disabled={addingTitle !== null}
              onClick={async () => {
                if (addingTitle !== null) return;
                setAddingTitle(title);
                try {
                  await onCreateGoal(title);
                } finally {
                  setAddingTitle(null);
                }
              }}
              className="text-left bg-surface border border-primary/20 hover:border-primary/60 rounded-xl p-4 transition-colors disabled:opacity-50"
            >
              <span className="text-foreground">{addingTitle === title ? "Adding..." : title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
