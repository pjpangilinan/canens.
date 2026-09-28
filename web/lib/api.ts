const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export interface Goal {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

export async function fetchGoals(): Promise<Goal[]> {
  const res = await fetch(`${API_BASE}/api/goals`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch goals');
  return res.json();
}
