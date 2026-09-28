# Canens

Break a vague goal into the next three to five concrete actions.

The browser is the source of truth. The backend exists for two reasons only:
Amazon Bedrock credentials cannot live in a browser bundle, and a copy of your
data is worth having somewhere other than your browser profile.

## Layout

| Path | What it is |
| --- | --- |
| `web/` | Next.js static export. Dexie over IndexedDB is the store. |
| `backend/` | FastAPI. Four routes, an AI proxy and a backup sink. |
| `infrastructure/` | The SAM template for the production stack. See its README. |
| `verify.ps1` | One command that runs every check, including the billable ones. |

## Running it

There is no database to start. The snapshot is an object in S3 and the daily
model-call counter is an item in DynamoDB, both reached with the credentials in
your AWS profile, exactly as Bedrock is.

```bash
cd backend
cp .env.example .env         # point SNAPSHOT_BUCKET and USAGE_TABLE at buckets you own
uvicorn app.main:app --reload # http://localhost:8000
```

Then, in another terminal:

```bash
cd web
cp .env.example .env.local    # optional; defaults to localhost:8000
npm install
npm run dev                   # http://localhost:3000
```

`docker compose up -d` still works and is a convenient way to run the API, but
there is no database service behind it any more.

## Checks

```bash
cd backend && python -m pytest      # no database, no AWS account needed
cd web && npm run lint
cd web && npm run typecheck
cd web && npm test                  # unit
cd web && npm run test:e2e          # builds, then Playwright
```

There is also `verify.ps1`, which runs all of the above plus a live-backend and
a live-model pass, and prints a pass/fail summary:

```bash
powershell -File verify.ps1            # everything
powershell -File verify.ps1 -SkipAI    # without calling Bedrock
```

The backend suite needs nothing running. The two AWS clients are faked at the
boto3 client boundary, and the fakes validate the request parameters rather
than accepting whatever they are given — a fake that accepted a bare integer
where DynamoDB wants a string is how a suite passed while the deployed function
could not count anything. Set `CANENS_TEST=1` to run against real AWS instead.


The end-to-end suite splits by what it needs:

| Flag | Enables |
| --- | --- |
| *(none)* | The flows that need no backend |
| `CANENS_E2E_API=1` | The backup round trip, against a running API |
| `CANENS_E2E_AI=1` | The tests that call Bedrock, which costs money |

## Deploying

`web/` exports to a static site for GitHub Pages. `NEXT_PUBLIC_BASE_PATH` must
be the repository name, `NEXT_PUBLIC_API_URL` the https URL of the deployed
API, and the workflow fails if the latter is missing rather than shipping a
page that points at `localhost:8000`. All three are inlined at build time.

`backend/` is a Docker image for Lambda behind API Gateway, with the snapshot in
S3 and the call counter in DynamoDB. The stack that builds all of that is in
`infrastructure/`; read `infrastructure/README.md` before changing it, because
the absence of a database — and therefore of a VPC, a NAT gateway and a private
endpoint — is what keeps the whole thing at about $0.02 a month, and that chain
of reasoning is not obvious from the template. The function needs
`bedrock:InvokeModel` on its execution role; there is no credential to configure.

There is no migration step, because there is no schema. Set `APP_ENV=production`
in the deployed environment: it makes `API_TOKEN` mandatory, so a deployment
that forgets the token fails at startup instead of quietly serving an
unauthenticated, billable endpoint to the internet.

## Things worth knowing before changing this

- `API_TOKEN` is not authentication. It ships in the public bundle, so anyone
  who can load the page has it. It exists to slow down casual abuse, and
  belongs alongside the daily call cap, API Gateway throttling and a budget
  alarm.
- There is one user and one client by design. The user id is part of every
  storage key so accounts can be added later, but they are not.
- Generation never writes a goal or a step. The only thing the AI routes
  persist is the call counted against the daily cap.
- Completing the last Step archives the Goal. That is intended, and the
  Activity Log is where the Goal stays reachable and can be reopened.
- Undoing a Step does **not** un-archive a Goal. Reopening is explicit.
- The model answers by calling a tool, so its output is shape-checked by
  Bedrock. If you switch to a model without `converse` support, such as Claude
  3 Haiku, `invoke_model` is a different code path.
- Bedrock's stop reasons are snake_case (`max_tokens`). The camelCase
  spelling is the request field, and comparing against it means a guard
  silently never fires. There is a test that reads the real enum from botocore
  for exactly this reason.

## Calling Bedrock for real

Locally, credentials come from your AWS profile:

```bash
aws sts get-caller-identity
cd backend && python -c "from app.services.bedrock import bedrock; print(bedrock.next_steps('Write a book', []))"
```

If that fails with `AccessDeniedException`, the model is not enabled for your
account. In the Bedrock console, enable model access and re-run. If on-demand
access is restricted, set `BEDROCK_MODEL_ID` to an inference profile id such as
`us.amazon.nova-lite-v1:0` instead of the bare one.

Every call is capped three ways: user-initiated only, `BEDROCK_MAX_TOKENS` per
call, and `AI_DAILY_CAP` calls per day. The cap is a DynamoDB item rather than a
process variable, because Lambda discards execution environments and an
in-process counter would reset behind your back. The increment and the check are
one conditional update, so the ceiling holds when two requests arrive together.
