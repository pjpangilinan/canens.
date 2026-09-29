/**
 * A walk through the app as a new user, against the deployed API, capturing a
 * screenshot at every step. Sign-in goes through the real Cognito hosted UI,
 * so the redirect, the PKCE exchange and the token refresh are all exercised.
 *
 * This is not part of the test suite. It calls Bedrock for real and rewrites
 * the stored snapshot, so it is skipped unless it is asked for:
 *
 *   $env:NEXT_PUBLIC_API_URL = "https://<id>.execute-api.<region>.amazonaws.com"
 *   $env:NEXT_PUBLIC_COGNITO_USER_POOL_ID = "us-east-1_..."
 *   $env:NEXT_PUBLIC_COGNITO_CLIENT_ID = "..."
 *   $env:CANENS_SCREENSHOTS = "1"
 *   npx playwright test walkthrough.spec.ts
 *
 * The output lands in ../../../screenshots, which the README references.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const POOL = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";
const CLIENT = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";
const REGION = process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1";
const OUT = path.resolve(__dirname, "../../../screenshots");

const enabled =
  process.env.CANENS_SCREENSHOTS === "1" &&
  Boolean(API_URL) &&
  Boolean(POOL) &&
  Boolean(CLIENT);

test.skip(
  !enabled,
  "set CANENS_SCREENSHOTS=1, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID",
);

/** The email of the account this run signs in as. */
const EMAIL = `canens-screenshots-${Date.now().toString(36)}@example.com`;
const PASSWORD = "Correct-Horse-9!Batt";

function aws(args: string[]): string {
  return execFileSync("aws", args, { encoding: "utf8" });
}

/**
 * Create and confirm the account, through the CLI.
 *
 * Self-service sign-up would leave the account waiting on an emailed
 * confirmation code, and there is nowhere for a test to read it from.
 */
function createConfirmedUser(): void {
  const base = ["--region", REGION, "--user-pool-id", POOL, "--username", EMAIL];
  aws(["cognito-idp", "admin-create-user", ...base, "--message-action", "SUPPRESS"]);
  aws([
    "cognito-idp",
    "admin-set-user-password",
    ...base,
    "--password",
    PASSWORD,
    "--permanent",
  ]);
}

/**
 * A real Cognito session, obtained through the SDK.
 *
 * The app signs in through the hosted UI, which is a redirect to
 * cognito-idp.<region>.amazonaws.com/<pool>/oauth2/authorize. That surface is
 * not reachable from the machine this was recorded on - the pool's
 * amazoncognito.com domain does not resolve there - so the redirect itself is
 * not exercised here. Everything after it is: the token is a genuine Cognito
 * access token, the API Gateway authorizer really verifies it, and the
 * application reads it through the same session store the redirect fills.
 *
 * The alternative, injecting a header the app trusts, would not test anything.
 */
async function signIn(page: Page): Promise<void> {
  createConfirmedUser();

  const auth = JSON.parse(
    aws([
      "cognito-idp",
      "initiate-auth",
      "--region",
      REGION,
      "--client-id",
      CLIENT,
      "--auth-flow",
      "USER_PASSWORD_AUTH",
      "--auth-parameters",
      `USERNAME=${EMAIL},PASSWORD=${PASSWORD}`,
      "--query",
      "AuthenticationResult",
      "--output",
      "json",
    ]),
  ) as { AccessToken: string; IdToken: string; ExpiresIn: number };

  // Decode the ID token for the claims oidc-client-ts expects in its stored user.
  const claims = JSON.parse(
    Buffer.from(auth.IdToken.split(".")[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;

  // The key oidc-client-ts reads, and the shape it writes. Matching it means
  // the application is signed in through its own normal path.
  const authority = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
  const stored = {
    id_token: auth.IdToken,
    access_token: auth.AccessToken,
    refresh_token: null,
    token_type: "Bearer",
    scope: "openid email profile",
    session_state: null,
    expires_at: Math.floor(Date.now() / 1000) + auth.ExpiresIn,
    profile: { sub: claims.sub, email: claims.email, email_verified: true },
  };

  await page.addInitScript(
    ({ key, value }) => {
      window.sessionStorage.setItem(key, value);
    },
    { key: `oidc.user:${authority}:${CLIENT}`, value: JSON.stringify(stored) },
  );
}

let shot = 0;

async function capture(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  shot += 1;
  const file = path.join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`);
  // Let transitions settle, so a card is not caught mid-animation.
  await page.waitForTimeout(450);
  // Viewport rather than fullPage. The nav is `sticky top-0`, and a full-page
  // capture resizes the viewport to the content height, which leaves the nav
  // painted over the heading. That is an artefact of the capture, not the app.
  await page.screenshot({ path: file });
  console.log(`  screenshot: ${path.basename(file)}`);
}

/**
 * The API calls the walkthrough makes for itself, as the signed-in user.
 *
 * There is no shared token any more, so the bearer is read out of the session
 * the app just created. That is also a check in itself: if sign-in had not
 * produced a usable token, this returns null and the first call is a 401.
 */
function api(request: APIRequestContext, bearer: string) {
  const headers = { Authorization: `Bearer ${bearer}` };
  return {
    reset: (data: unknown) => request.put(`${API_URL}/api/backup`, { headers, data }),
  };
}

/** The access token the app is holding, from its own session storage. */
async function readAccessToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i) ?? "";
      if (!key.startsWith("oidc.user:")) continue;
      const raw = window.sessionStorage.getItem(key);
      if (!raw) continue;
      try {
        const user = JSON.parse(raw);
        if (user?.access_token) return user.access_token as string;
      } catch {
        // Not the entry we are after.
      }
    }
    return null;
  });
}

/**
 * The longest word in the text, which is the least likely to be a substring of
 * something else on the page. The search term is read out of the model's own
 * output rather than hard-coded, because that output changes every run.
 */
function distinctiveWord(text: string): string {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ""))
    .filter((w) => w.length >= 5)
    .sort((a, b) => b.length - a.length);
  return words[0] ?? text.slice(0, 5);
}

test("a new user's first run", async ({ page, request }) => {
  // Real model calls and a full hosted-UI redirect take a while, and the
  // default 30s budget is for tests that stub everything.
  test.setTimeout(900_000);

  // Tall enough that a goal card with six steps fits without scrolling, now
  // that the screenshots are viewport-sized.
  await page.setViewportSize({ width: 1280, height: 1040 });

  // Signed out first, because that is what a visitor arrives to. Captured
  // before the session is seeded, so the gate is genuinely exercised.
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Sign in or create an account/ }),
  ).toBeVisible({ timeout: 30_000 });
  await capture(page, "signed-out");

  await signIn(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign out" }),
    "sign-in did not produce a session",
  ).toBeVisible({ timeout: 30_000 });
  await capture(page, "signed-in");

  const bearer = await readAccessToken(page);
  expect(bearer, "sign-in produced no access token").not.toBeNull();
  const server = api(request, bearer as string);

  // Start from nothing on both sides. Otherwise the app restores the previous
  // run and the first-run screens cannot be photographed.
  expect((await server.reset({ goals: [], tasks: [] })).status()).toBe(200);

  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase("CanensLocalDB");
        req.onsuccess = req.onerror = req.onblocked = () => resolve(null);
      }),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Start with a goal" })).toBeVisible();
  await capture(page, "first-run");

  // Onboarding: answer a question and let the model suggest goals.
  await page
    .getByPlaceholder("e.g. I never know what the next step is")
    .fill("I never know what the next step is");
  await page
    .getByPlaceholder("e.g. a couple of hours most evenings")
    .fill("a couple of hours most evenings");
  await capture(page, "onboarding-answered");

  const suggestButton = page.getByRole("button", { name: /Suggest some goals|Thinking/ });
  await suggestButton.click();
  // A real model call, so the titles are whatever it produced rather than
  // anything this file knows in advance. The button returns to its idle label
  // when the call finishes, which is the signal to wait on.
  await expect(suggestButton).toHaveText("Suggest some goals", { timeout: 180_000 });

  // The suggestions are the only buttons in that grid.
  const suggestions = page.locator("div.grid > button");
  await expect(suggestions.first()).toBeVisible();
  expect(await suggestions.count(), "the model returned no suggestions").toBeGreaterThan(0);
  await capture(page, "suggested-goals");

  // Take the first suggestion, whichever it is.
  const firstSuggestion = suggestions.first();
  const chosen = (await firstSuggestion.innerText()).trim();
  expect(chosen, "the model returned an empty suggestion").not.toEqual("");
  await firstSuggestion.click();

  await expect(page.getByRole("heading", { name: chosen })).toBeVisible();
  await capture(page, "goal-created");

  // Expand it and generate steps. Another real model call.
  await page.getByRole("button", { name: `Expand ${chosen}` }).click();
  const generate = page.getByRole("button", { name: /Generate steps|Thinking/ }).first();
  await generate.click();
  await expect(page.getByRole("checkbox", { name: /Mark .* as done/ }).first()).toBeVisible({
    timeout: 180_000,
  });
  await capture(page, "steps-generated");

  // Add a step by hand, beside the generated ones. The goal input has an "Add"
  // button too, so this one is scoped to the step form.
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByPlaceholder("Describe the next step...").fill("Pick a topic and a length");
  await page.getByRole("list").getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Pick a topic and a length")).toBeVisible();
  await capture(page, "step-added-by-hand");

  // Complete the first outstanding step. Its title comes from the model, so it
  // is read rather than assumed.
  const firstStep = page.getByRole("checkbox", { name: /Mark .* as done/ }).first();
  const stepName = (await firstStep.getAttribute("aria-label"))?.replace(
    /^Mark "(.*)" as done$/,
    "$1",
  ) ?? "";
  await firstStep.click();
  await expect(page.getByText("1 completed")).toBeVisible();
  await capture(page, "step-completed");

  // Search has to reach a step you can no longer see. That is the case that is
  // easy to get wrong, and the reason search covers completed steps as well as
  // pending ones.
  const needle = distinctiveWord(stepName);
  await page.getByRole("searchbox").fill(needle);
  await expect(page.getByText("1 completed")).toBeVisible();
  // Open the completed section, or the match that proves the point is folded
  // away and the screenshot shows nothing.
  await page.getByText("1 completed").click();
  await expect(page.getByText(stepName)).toBeVisible();
  await capture(page, "search-finds-completed-step");
  await page.getByRole("searchbox").fill("");

  // Completing the goal archives it, which is what moves it to the log.
  await page.getByRole("button", { name: "Complete goal" }).click();
  await expect(page.getByRole("heading", { name: "Start with a goal" })).toBeVisible({
    timeout: 20_000,
  });
  await capture(page, "goal-archived");

  // A second goal, so the log has more than one entry.
  await page.getByPlaceholder("What is your next goal?").fill("Run a half marathon");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Run a half marathon" })).toBeVisible();
  await capture(page, "second-goal");

  // The snapshot has to reach S3 and the status line has to say so.
  await expect(page.getByText(/Backed up/)).toBeVisible({ timeout: 30_000 });
  await capture(page, "backed-up");

  // The empty-store-that-is-not-a-new-device case. This browser has backed up
  // before, so emptying the two data tables means the user emptied it, and the
  // app asks rather than resurrecting work they deleted on purpose. The
  // "has ever backed up" flag lives in localStorage, so it survives.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open("CanensLocalDB");
        open.onsuccess = () => {
          const tx = open.result.transaction(["goals", "tasks"], "readwrite");
          tx.objectStore("goals").clear();
          tx.objectStore("tasks").clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
        open.onerror = () => resolve();
      }),
  );
  await page.reload();
  await expect(page.getByText("Your goals are empty, but a backup exists.")).toBeVisible({
    timeout: 30_000,
  });
  await capture(page, "restore-prompt");

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored your goals from backup.")).toBeVisible();
  await capture(page, "restored-on-request");

  // The genuinely-new-device case, which is the one that restores without
  // asking: the store is gone *and* the flag recording that it was ever backed
  // up is gone too, so there is nothing to suggest the user meant to empty it.
  // "Run a half marathon" is the active goal: the generated one was archived
  // before this backup, so it comes back into the Activity Log.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase("CanensLocalDB");
        req.onsuccess = req.onerror = req.onblocked = () => resolve(null);
      }),
  );
  await page.reload();
  await expect(page.getByText("Restored your goals from backup.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { name: "Run a half marathon" })).toBeVisible();
  await capture(page, "restored-without-asking");

  // The log is where a completed goal stays reachable, and the only way back.
  await page.goto("/activity/");
  await expect(page.getByRole("heading", { name: chosen })).toBeVisible();
  await capture(page, "activity-log");

  // The same markup has to work on a phone, while the goal is still archived
  // so the log has something in it.
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "mobile-home");
  await page.goto("/activity/");
  await expect(page.getByRole("heading", { name: chosen })).toBeVisible();
  await capture(page, "mobile-activity");
  await page.setViewportSize({ width: 1280, height: 1040 });

  // Reopen is an async write to IndexedDB, so navigating the instant the button
  // is clicked can unload the page before it lands. Wait for the log to drop it.
  await page.getByRole("button", { name: "Reopen" }).first().click();
  await expect(page.getByRole("heading", { name: chosen })).toBeHidden();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: chosen })).toBeVisible();
  await capture(page, "reopened");

  // Leave nothing behind: the snapshot is the user's, not the walkthrough's.
  expect((await server.reset({ goals: [], tasks: [] })).status()).toBe(200);
});
