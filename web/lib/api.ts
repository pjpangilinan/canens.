/**
 * The only module that talks to the network.
 *
 * Both calls are AI requests. The store is local; backup lives in
 * `backup.ts`. Keeping the split explicit means a reader can tell at a glance
 * which operations need the backend.
 */
import { API_BASE, apiHeaders } from "./config";

export interface NextStepsResult {
  status: "more" | "done";
  tasks: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * How long to wait for a model call before giving up.
 *
 * Without this, a request that never settles leaves the button reading
 * "Thinking..." indefinitely, with no way out but reloading.
 */
const REQUEST_TIMEOUT_MS = 30_000;

async function post<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // A network failure reaches fetch as a TypeError, which would otherwise
    // surface as an unhelpful "Failed to fetch".
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The request timed out. Try again.", 0);
    }
    throw new ApiError("Could not reach the server. Check your connection.", 0);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = `Request failed: ${response.status}`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string") detail = payload.detail;
    } catch {
      // Body was not JSON; keep the status-based message.
    }
    throw new ApiError(detail, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A 200 with a non-JSON body: a CDN interstitial, a misrouted proxy, or an
    // API Gateway default response. Surfacing the raw parser error would be
    // both confusing and useless.
    throw new ApiError("The server returned an unexpected response.", response.status);
  }
}

export function fetchNextSteps(
  goalTitle: string,
  existingTasks: { title: string; status: string }[],
): Promise<NextStepsResult> {
  return post<NextStepsResult>("/api/goals/next-steps", {
    goal_title: goalTitle,
    existing_tasks: existingTasks,
  });
}

export function fetchStarterGoals(answers: string, count = 4): Promise<{ goals: string[] }> {
  return post<{ goals: string[] }>("/api/onboarding/starter-goals", {
    answers,
    count,
  });
}
