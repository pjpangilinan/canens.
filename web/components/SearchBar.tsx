import React from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** Searching the home list covers live steps; the log covers finished ones. */
  hint?: string;
}

export default function SearchBar({ value, onChange, label, hint }: SearchBarProps) {
  return (
    <div className="w-full relative group">
      <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted group-focus-within:text-white transition-colors">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onChange("");
        }}
        placeholder={hint ?? "Search goals and steps..."}
        aria-label={label}
        className="w-full bg-white/5 border border-white/10 rounded-full py-3 pl-12 pr-10 text-sm text-foreground placeholder-muted focus:outline-none focus:bg-white/10 focus-visible:ring-2 focus-visible:ring-primary transition-all shadow-sm"
      />
      {value.trim() && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute inset-y-0 right-0 pr-4 flex items-center text-muted hover:text-white transition-colors"
          aria-label="Clear search"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
