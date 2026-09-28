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
| `docs/adr/` | Architecture decisions, one sequence, with status. |
| `.scratch/` | Specs and tickets. See `docs/agents/issue-tracker.md`. |
| `CONTEXT.md` | Domain vocabulary. Read this first. |

## Running it

```bash
docker compose up -d          # Postgres
cd backend
python -m app.migrate         # schema
python -m app.seed            # the single user
uvicorn app.main:app --reload # http://localhost:8000
```

Then, in another terminal:

```bash
cd web
cp .env.example .env.local    # optional; defaults to localhost:8000
npm install
npm run dev                   # http://localhost:3000
```

## Checks

```bash
cd backend && python -m pytest      # needs DATABASE_URL pointing at Postgres
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

The backend suite runs against real Postgres, not SQLite. This is deliberate:
`now()` does not exist in SQLite, which is how an unevaluated SQL expression
went unnoticed for as long as it did. A test also asserts that the Alembic head
matches the model metadata, because four files used to declare a schema and all
four disagreed.

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

`backend/` is a Docker image for Lambda behind API Gateway, with Postgres on
RDS. It expects `bedrock:InvokeModel` on its execution role; there is no
credential to configure.

**Run migrations before deploying.** Nothing applies them automatically, so a
fresh database has no tables and the first request fails:

```bash
# in the function's environment, as a one-off invocation
python -m app.migrate
```

Set `APP_ENV=production` in the deployed environment. It makes `API_TOKEN`
mandatory, so a deployment that forgets the token fails at startup instead of
quietly serving an unauthenticated, billable endpoint to the internet.

## Things worth knowing before changing this

- `API_TOKEN` is not authentication. It ships in the public bundle, so anyone
  who can load the page has it. It exists to slow down casual abuse, and
  belongs alongside the daily call cap, API Gateway throttling and a budget
  alarm.
- There is one user and one client by design. `user_id` is threaded through
  every record and query so accounts can be added later, but they are not.
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
call, and `AI_DAILY_CAP` calls per day. The cap is stored in the database
rather than in memory, because Lambda discards execution environments and an
in-process counter would reset behind your back.
