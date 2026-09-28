import React from 'react';

interface GoalCardProps {
  title: string;
  status: string;
}

export default function GoalCard({ title, status }: GoalCardProps) {
  return (
    <div className="bg-midnight-blue border border-indigo-glow/20 shadow-glow rounded-xl p-6 hover:border-indigo-glow/50 transition-colors duration-300 group">
      <div className="flex justify-between items-start">
        <h3 className="text-xl font-semibold text-lunar-silver group-hover:text-white transition-colors duration-300">
          {title}
        </h3>
        <span className="bg-indigo-glow/20 text-indigo-glow px-3 py-1 rounded-full text-sm font-medium">
          {status}
        </span>
      </div>
    </div>
  );
}
