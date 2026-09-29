/**
 * Sign-up and sign-in, driven through the real form against the real pool.
 *
 * This exists because the sign-in path was wrong for a long time and nothing
 * caught it. The app redirected to Cognito's hosted UI, every endpoint on that
 * surface answers 400 for this pool, and the unit tests were all passing
 * because none of them made a request. The only way to know a sign-in flow
 * works is to perform one.
 *
 * Both halves are exercised as a person would: the form is filled in and
 * submitted. Account creation stops at the emailed code, because a test has no
 * inbox to read, so the confirmation is done through the CLI and then the form
 * is used to sign in with the same credentials. No Bedrock, so it is cheap,
 * but it does create a real account and needs real AWS credentials for the
 * confirmation step.
 *
 *   $env:NEXT_PUBLIC_COGNITO_USER_POOL_ID = "us-east-1_..."
 *   $env:NEXT_PUBLIC_COGNITO_CLIENT_ID = "..."
 *   $env:CANENS_E2E_AUTH = "1"
 *   npx playwright test signup.spec.ts
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const POOL = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";
const CLIENT = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";
const REGION = process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1";

test.skip(
  process.env.CANENS_E2E_AUTH !== "1" || !POOL || !CLIENT,
  "set CANENS_E2E_AUTH=1, NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID",
);

const EMAIL = `canens-auth-${Date.now().toString(36)}@example.com`;
const PASSWORD = "Correct-Horse-9!Batt";

test("a new person can create an account and sign in with it", async ({ page }) => {
  // --- create ------------------------------------------------------------
  await page.goto("/");

  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account", exact: true }).click();

  // The code went to a mailbox nothing can read, so this is as far as the form
  // gets. It is the part that proves the browser can reach Cognito at all.
  await expect(page.getByText(/We sent a code to/)).toBeVisible();

  // --- confirm, out of band ---------------------------------------------
  // The admin API, because the client one demands the emailed code and a test
  // has no inbox. What is under test is the form, not the code arriving.
  execFileSync(
    "aws",
    [
      "cognito-idp",
      "admin-confirm-sign-up",
      "--region",
      REGION,
      "--user-pool-id",
      POOL,
      "--username",
      EMAIL,
    ],
    { encoding: "utf8" },
  );

  // --- sign in, through the form ----------------------------------------
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // A usable session, not just a screen that changed.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.sessionStorage.getItem("canens.session");
        if (!raw) return null;
        const session = JSON.parse(raw) as { accessToken?: string; sub?: string };
        return session.accessToken ? session.sub : null;
      }),
    )
    .not.toBeNull();

  // The gate gave way to the application.
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
});

test("a wrong password is reported as a wrong password", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("Wrong-Horse-9!Batt");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // Not "NotAuthorizedException", and not a raw Cognito failure the person
  // cannot act on. Scoped to the form because Next keeps its own role="alert"
  // route announcer in the document.
  await expect(page.locator("form").getByRole("alert")).toContainText("do not match");
  expect(await page.evaluate(() => window.sessionStorage.getItem("canens.session"))).toBeNull();
});
