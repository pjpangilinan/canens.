# Canens

Break a goal into the next few actions.

![A goal expanded into generated steps](screenshots/07-steps-generated.png)

The browser holds the data. The server does the three things a browser cannot:
sign you in, call Amazon Nova Lite, and keep a copy of what you have.

## What it does

You write a goal. The model proposes the next three to five actions. You keep the
ones you want, edit them, add your own, tick them off. Completing a goal archives
it to an Activity Log, and from there you can reopen it.

Every change is written to IndexedDB first and uploaded in the background.
Accounts are Amazon Cognito, and each one only ever sees its own goals.

## Screens

The walkthrough is not mock data. It is
[`web/tests/e2e/walkthrough.spec.ts`](web/tests/e2e/walkthrough.spec.ts) driving
a real browser against the deployed API with real model calls, regenerated with
`CANENS_SCREENSHOTS=1 npx playwright test walkthrough.spec.ts`.

**Sign in.** The form posts straight to Cognito's action API. The password reaches
no other host and nothing is stored here, but there is no hosted sign-up page
and **no password reset** - see [Sharp edges](#sharp-edges). Sign-up is open.

![Signed out](screenshots/01-signed-out.png)

**Your own store.** A new account starts empty.

![Signed in](screenshots/02-signed-in.png)

**First run.** The onboarding offers to suggest goals, or you just type one.

| | |
| --- | --- |
| ![First run](screenshots/03-first-run.png) | ![Onboarding answered](screenshots/04-onboarding-answered.png) |
| An empty store, and the question. | Two answers, about to ask the model. |

**Suggestions.** Real output from Nova Lite.

![Suggested goals](screenshots/05-suggested-goals.png)

**Generated steps.** They are proposals. Nothing is saved until you accept them,
and they are appended rather than replacing what you already have.

![Steps generated](screenshots/07-steps-generated.png)

**Alongside your own.** Type a step in the same list.

![Step added by hand](screenshots/08-step-added-by-hand.png)

**Ticking one off.** It moves into a collapsed "completed" group.

![Step completed](screenshots/09-step-completed.png)

**Search still finds it.** This is the case that is easy to get wrong, so it is
the one worth a screenshot: a step you can no longer see still has to be
findable, so search covers completed steps as well as pending ones.

![Search finds a completed step](screenshots/10-search-finds-completed-step.png)

**Backup.** Every write is uploaded under your own key, and the status line says
so. Failures are reported here rather than swallowed.

![Backed up](screenshots/13-backed-up.png)

**Restore is asked for, not assumed.** If this browser has backed up before and
the store is empty, you emptied it on purpose, so it asks before resurrecting
anything.

![Restore prompt](screenshots/14-restore-prompt.png)

**Restore is automatic on a genuinely new device.** Losing the store *and* the
record that it had ever been backed up means there is nothing to suggest the
emptying was deliberate, so it restores on load.

![Restored without asking](screenshots/16-restored-without-asking.png)

**Activity Log.** Where a completed goal stays reachable. Archiving is not a
one-way door.

![Activity Log](screenshots/17-activity-log.png)

**Reopened.**

![Reopened](screenshots/20-reopened.png)

**On a phone.** Same markup, no separate build.

| | |
| --- | --- |
| ![Home on mobile](screenshots/18-mobile-home.png) | ![Activity Log on mobile](screenshots/19-mobile-activity.png) |

## Architecture

```
Browser                     API Gateway             Lambda
─────────                   ────────────            ──────
Next.js static export   →   HTTP API          →    FastAPI behind Mangum
  action-API sign-in         JWT authorizer          subject from claims
Dexie / IndexedDB                                     │
    └── background upload ─────────────────────────→│
                                                       ├─→ S3        snapshots/<sub>.json
      read model answer  ←───────────────────────────┤
                                                       └─→ DynamoDB  <sub>#<day> counter
                                                            → Bedrock  Nova Lite

Cognito user pool ── signs the token the authorizer checks
```

The frontend is a static export. No server rendering, no API to hydrate, nothing
to run but a CDN.

### Identity

A Cognito user pool issues the token. API Gateway's JWT authorizer validates its
signature, issuer, expiry and audience **before** the function is invoked, so an
unauthenticated request never reaches the application at all. The function does
no cryptography: it reads the verified subject out of the event and puts it in
one request header, which it overwrites on every invocation so a caller cannot
supply its own.

Everything downstream is keyed by that subject. The snapshot is
`snapshots/<sub>.json` and the counter is `<sub>#<date>`, so one bucket and one
table serve every account with no query and no way to enumerate across users.

The app is a public client with no secret, because a browser cannot keep one.
Sign-in posts to Cognito's action API (`SignUp`, `ConfirmSignUp`, `InitiateAuth`).
Public-client requests are unsigned, so there is no key in the bundle and no
SigV4 to do. The access token is the same one the authorizer checks, and it is
verified end to end against the deployed API.

### Why there is no database and no VPC

The server stores a whole-store snapshot, replaced on each upload. There are no
queries, no joins and nothing to reconcile, so an object store is the entire
requirement. The one piece of state that is not a document is a call counter,
which has to be atomic, so it is a conditional DynamoDB update.

Neither needs a VPC, so the function has no `VpcConfig` and reaches AWS directly.
That is worth about $0.02 a month. It was not always true: with Postgres on RDS
the function had to be in a VPC, and a Lambda in a VPC cannot reach the internet
without a NAT gateway (~$33/month) or a private endpoint (~$7/month). The
reasoning is in [`infrastructure/README.md`](infrastructure/README.md) because
none of it is obvious from the template.

### Keeping the bill bounded

Sign-up is open, so the endpoint is public to strangers and each of them can call
a model. One number bounds that: **25 calls per account per day**. A ramp used
to soften new accounts, and it was removed rather than retuned, because at this
number the ramp chose between 10 and 25 and paid for a second database item and
two extra round-trips on every model call to do it.

Alongside that:

- `BEDROCK_MAX_TOKENS` per call, and generation is user-initiated only.
- The increment and the check are one conditional update, so the ceiling holds
  when two requests arrive together. It cannot live in the process: Lambda
  discards its execution environments, so an in-process counter resets to zero
  whenever a container is replaced — which looks like a working ceiling and is
  not one.
- API Gateway throttling at 5 requests/second, burst 10.
- A budget alarm at 80% of $5/month.

## Running it

No database to start. The snapshot is an object in S3 and the counter is an item
in DynamoDB, both reached with the credentials in your AWS profile.

```bash
cd backend
cp .env.example .env         # point SNAPSHOT_BUCKET and USAGE_TABLE at buckets you own
uvicorn app.main:app --reload # http://localhost:8000
```

```bash
cd web
cp .env.example .env.local   # fill in the Cognito details to get a sign-in gate
npm install
npm run dev                  # http://localhost:3000
```

With both `NEXT_PUBLIC_API_URL` and the Cognito values unset, the app runs with
no sign-in at all — which is the local case, against a local API with no
authorizer on it. Set the API URL without the Cognito values and it fails closed
with a message instead, because a deployed build with no way to sign in would
otherwise serve an app that 401s on every call.

## Checks

```bash
cd backend && python -m pytest      # no database, no AWS account needed
cd web && npm test && npm run test:e2e
```

The backend fakes the two AWS clients at the boto3 boundary and validates the
parameters it is handed. A fake that accepted a bare integer where DynamoDB
wants a string is how a suite of 89 tests passed while the deployed function
could not count anything at all. Set `CANENS_TEST=1` to run against real AWS.

`verify.ps1` runs everything including the two passes CI skips — a live backend
and real model calls, which cost money.

```bash
powershell -File verify.ps1 -SkipAI
```

## Deploying

`web/` goes to GitHub Pages. The workflow needs `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_CLIENT_ID` and
`NEXT_PUBLIC_BASE_PATH` as repository variables, all inlined at build time. It
fails rather than shipping a page pointing at `localhost`.

`backend/` is a SAM stack:

```bash
sam build --template-file infrastructure/template.yaml
sam deploy --config-file infrastructure/samconfig.toml --resolve-image-repos --resolve-s3
```

No migration step, because there is no schema. See
[`infrastructure/README.md`](infrastructure/README.md).

## Sharp edges

Six things that cost time, kept here so they do not cost it twice.

- **A JWT authorizer kills the automatic CORS preflight.** A preflight is an
  `OPTIONS`, it matches the greedy route, and the authorizer runs first — so the
  browser asks permission to send a bearer token and gets a 401, and the request
  it was asking about never leaves. The symptom is `Failed to fetch` on a
  backend that is up and healthy. Preflight needs its own unauthenticated route,
  and the application's `CORSMiddleware` has to list `Authorization` in
  `allow_headers`; a leftover `X-Canens-Token` there fails the same way.
- **A container image cannot name a Python attribute in `CMD`.** Lambda runs
  `CMD` as a program, so `CMD ["app.lambda_handler.handler"]` fails every
  invocation with `Runtime.InvalidEntrypoint`. The image runs the Runtime
  Interface Client: `python -m awslambdaric app.lambda_handler.handler`. Nothing
  but a test can catch this, so one reads the Dockerfile.
- **S3 returns `403`, not `404`, for a missing key** when the caller cannot list
  the bucket. Without `s3:ListBucket` the app reports "you have no backup" to a
  user who does — and the client auto-restores on that answer. The grant is
  scoped to the one prefix.
- **A named API Gateway stage breaks routing.** It prepends the stage name to
  the path the function receives, so the greedy route hands Mangum
  `/prod/api/health` and everything 404s in FastAPI. The stage is `$default`.
- **Cognito's OIDC surface does not work for this pool; its action API does.**
  `/oauth2/authorize`, `/authorize`, `/oauth2/token`, `/login` and `/userInfo` all
  answer `400 BadRequest — "The server did not understand the operation that was
  requested"`, and the pool's own discovery document advertises those broken
  endpoints. The domain the hosted UI would live on is not exposed by any API, so
  it cannot be addressed. A redirect-based sign-in therefore cannot be made to
  work here, and it fails silently from the app's point of view: the button is
  there, the unit tests pass, and the only symptom is a 400 in the browser.

  What does work is the action API — `SignUp`, `ConfirmSignUp`, `InitiateAuth`,
  `RefreshToken` — the surface boto3 and the AWS SDKs call. A user pool *client*
  is public, so its requests are unsigned and need no key, and Cognito answers
  with `Access-Control-Allow-Origin: *`, so a browser can call it. That is what
  `web/lib/auth.ts` does now.

  The cost of leaving the hosted UI: **there is no password reset.** Reset is a
  hosted-UI page, and without it someone who forgets their password has to be
  helped another way. Adding a domain to the pool is what would make the hosted
  UI reachable, and with it reset, and it is the fix worth doing before this has
  real users. `web/tests/e2e/signup.spec.ts` performs a real sign-up and sign-in
  against the live pool, because nothing cheaper catches this.
- **`CORSConfiguration` needs a list, not a comma-separated string.** API
  Gateway matches origins by exact string, so one element of `"a,b"` matches
  neither, and the preflight returns with no `Access-Control-Allow-Origin` at
  all.

## Layout

| Path | |
| --- | --- |
| `web/` | Next.js static export. Dexie over IndexedDB is the store. |
| `web/lib/auth.ts` | Cognito action-API client, session, refresh. |
| `backend/` | FastAPI. Health, two model calls, snapshot. |
| `infrastructure/` | SAM template, Cognito, and why the network is shaped as it is. |
| `web/tests/e2e/walkthrough.spec.ts` | Regenerates the screenshots above. |
| `web/tests/e2e/signup.spec.ts` | Real sign-up and sign-in against the live pool. |
| `verify.ps1` | Everything, including the billable passes. |
