# Production infrastructure

A single self-contained CloudFormation stack, `canens-prod`, built with SAM.

| Resource | Purpose | Monthly |
| --- | --- | --- |
| Cognito user pool + client | Sign-in, via the hosted UI | free |
| Lambda (container image) | The FastAPI app, built from `backend/Dockerfile` | pennies |
| API Gateway HTTP API | The routes, with a JWT authorizer | pennies |
| S3 bucket | The whole-store snapshot, one object per user | ~$0 |
| DynamoDB table | The call counter, one item per user per day | ~$0 |
| IAM role | `bedrock:InvokeModel`, one S3 prefix, one table, logs | free |
| Budget + alarm | Ceiling and a notification at 80% of it | free |

**Total: about $0.02/month**, against a $5 budget alarm.

## Identity

A Cognito user pool issues the token, and API Gateway's JWT authorizer validates
it before the function is invoked, so an unauthenticated request never reaches
the application. The function reads the verified subject out of the event and
passes it as a request header, overwriting whatever the caller sent.

Everything is keyed by that subject: `snapshots/<sub>.json` and `<sub>#<date>`.
One bucket and one table serve every account, with no query and no way to
enumerate across users.

`GET /api/health` is the one unauthenticated route, so an uptime check needs no
token and cannot be turned into a way to spend money.

### Two Cognito settings that fail silently

**`AllowedOAuthFlowsUserPoolClient` defaults to `false`.** With it false the
callback URLs, logout URLs, scopes and OAuth flows are all ignored and only SDK
sign-in is permitted. The hosted UI is unreachable and nothing reports an error.
It must be `true`.

**Token validity has no shared default unit.** An access token is measured in
hours and a refresh token in days, so `TokenValidityUnits` is set explicitly;
Cognito rejects the pair as an invalid range otherwise.

## Keeping the cost bounded

Sign-up is open, so the endpoint is public to strangers. The allowance is per
account and flat: **25 calls a day**. The rest is the per-call token bound, API
Gateway throttling at 5/second, and the budget alarm.

A ramp used to soften new accounts, and it was removed rather than retuned. At
this number it chose between 10 and 25, and paid for that with a second item per
account and two extra DynamoDB round-trips on every model request.

## Why there is no database and no VPC

The browser is the source of truth. The server only needs to do two things it
cannot do in the browser: call a model, and keep a copy.

A snapshot is one JSON document that is replaced wholesale, so there are no
queries, no joins and nothing to reconcile. An object store is the whole
requirement. The one piece of state that is not a document is the count of
model calls made today, which has to be atomic, so that is a single DynamoDB
item incremented under a condition.

Neither of those needs to be inside a VPC, and the function therefore has no
`VpcConfig` at all. That is where most of the cost went. The first version of
this stack had Postgres on RDS, which forced the Lambda into a VPC, and a Lambda
in a VPC cannot reach the internet at all — its elastic network interfaces are
never given a public IP, whatever the subnet says. So the only ways out were:

| | Monthly | What the function could then reach |
| --- | --- | --- |
| NAT Gateway | ~$33 | Every host on the internet |
| A private interface endpoint | ~$7 | Only the one service |
| **Neither** | **$0** | **Nothing, because it needs nothing** |

Dropping the database removed the reason for the VPC, and with it the NAT
gateway question, the endpoint question, four security groups and an internet
gateway.

## Deploying

`sam` is required. The only parameters are the site's origin and the alert
address.

```bash
sam build --template-file infrastructure/template.yaml

sam deploy \
  --config-file infrastructure/samconfig.toml \
  --resolve-image-repos --resolve-s3 \
  --parameter-overrides \
      FrontendOrigin=https://example.github.io \
      AlertEmail=you@example.com
```

There is no migration step, because there is no schema.

Then point the frontend at the `ApiEndpoint` output. There is no stage segment:
the stage is `$default`, because a named stage is prepended to the path the
function receives and every request then 404s in FastAPI.

`AllowedOrigins` must include `FrontendOrigin`, because that is where Cognito
redirects back to and what the browser sends as its `Origin`. Add
`http://localhost:3000` to it to run the site against the deployed API locally.

## Four things that will bite you

**The JWT authorizer kills the automatic CORS preflight.** A preflight is an
`OPTIONS`, it matches the greedy route, and the authorizer runs first — so the
browser asks permission to send a bearer token, gets a 401, and the request it
was asking about never leaves. The backend is up and healthy the whole time. The
`OPTIONS` routes are unauthenticated and `CORSMiddleware` answers, which also
means one owner for the CORS policy and it is testable without deploying.

**The container entrypoint.** `CMD ["app.lambda_handler.handler"]` in exec form
looks right and is not — Lambda runs `CMD` as a program, looks for that name on
disk, and every invocation fails with `Runtime.InvalidEntrypoint`. The image runs
the Runtime Interface Client instead:
`CMD ["python", "-m", "awslambdaric", "app.lambda_handler.handler"]`.
`test_container_entrypoint.py` asserts this, because nothing else can see it
until the image is running in Lambda.

**`s3:ListBucket`.** Without it, S3 answers a `GetObject` for a key that does not
exist with `403 AccessDenied` rather than `404 NoSuchKey`, so the application
cannot tell "never backed up" from "no permission" — and the client auto-restores
on the strength of that answer. The grant is scoped to the one prefix.

**`AllowedOAuthFlowsUserPoolClient`.** It defaults to false, and with it false
Cognito ignores the callback URLs, the logout URLs, the scopes and the OAuth
flows. Only SDK sign-in works, the hosted UI is unreachable, and nothing says so.

## What is deliberately absent

- **Custom domain and certificate.** The API Gateway default domain is enough;
  GitHub Pages supplies TLS for the frontend.
- **WAF.** The cost of a public, sign-up-open endpoint is met with per-account
  the per-account cap, throttling and a budget alarm rather than with rules that would
  have to understand the traffic to be useful.
- **MFA.** Not enabled, because the pool is for a personal tracker and Cognito's
  hosted UI is where it would be configured. `MfaConfiguration: "OFF"` is
  explicit in the template so the decision is visible rather than default.
- **CI deployment.** The workflow builds and publishes the frontend. The backend
  is deployed by hand.
- **Bucket deletion on stack delete.** The bucket has `DeletionPolicy: Retain`.
  It is the only copy of the data outside the browser, so `sam delete` must not
  take it with it. Remove it by hand if you really mean to.
