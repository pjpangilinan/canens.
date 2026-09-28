# Production infrastructure

A single self-contained CloudFormation stack, `canens-prod`, built with SAM.

| Resource | Purpose | Monthly |
| --- | --- | --- |
| Lambda (container image) | The FastAPI app, built from `backend/Dockerfile` | pennies |
| API Gateway HTTP API | The routes, CORS limited to the frontend origin | pennies |
| S3 bucket | The whole-store snapshot, one object per user | ~$0 |
| DynamoDB table | The daily model-call counter, one item per user per day | ~$0 |
| IAM role | `bedrock:InvokeModel`, one S3 prefix, one table, logs | free |
| Budget + alarm | Ceiling and a notification at 80% of it | free |

**Total: about $0.02/month**, against a $5 budget alarm.

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

## What the cost controls actually are

`API_TOKEN` is not authentication — it ships in the public bundle, so anyone who
can load the page has it. The things that genuinely bound spend are:

- **`AI_DAILY_CAP`** (200 by default) enforced by a conditional DynamoDB update,
  so it holds under concurrency rather than being a read followed by a hopeful
  write. The count cannot live in the process: Lambda discards its execution
  environments, so an in-process counter resets to zero whenever a container is
  replaced — which looks like a working ceiling and is not one.
- **API Gateway throttling**, 5 requests/second with a burst of 10.
- **A budget alarm** at 80% of $5/month.
- **`APP_ENV=production`**, which makes `API_TOKEN` mandatory so a deployment
  that forgets it fails at startup rather than quietly serving an unauthenticated
  billable endpoint.

## Deploying

`sam` is required. The parameters are secrets, so they are passed at deploy time
rather than written into `samconfig.toml`.

```bash
API_TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(32))")

sam build --template-file infrastructure/template.yaml

sam deploy \
  --config-file infrastructure/samconfig.toml \
  --resolve-image-repos --resolve-s3 \
  --parameter-overrides ApiToken="$API_TOKEN" AlertEmail=you@example.com
```

There is no migration step, because there is no schema.

Then point the frontend at the `ApiEndpoint` output. There is no stage segment:
the stage is `$default`, because a named stage is prepended to the path the
function receives and every request then 404s in FastAPI.

## Two things that will bite you

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

## What is deliberately absent

- **Custom domain and certificate.** The API Gateway default domain is enough;
  GitHub Pages supplies TLS for the frontend.
- **WAF.** A token in a public bundle is not an authorisation boundary. The cap,
  the throttle and the budget alarm are the real controls.
- **CI deployment.** The workflow builds and publishes the frontend. The backend
  is deployed by hand.
- **Bucket deletion on stack delete.** The bucket has `DeletionPolicy: Retain`.
  It is the only copy of the data outside the browser, so `sam delete` must not
  take it with it. Remove it by hand if you really mean to.
