# Production infrastructure

A single self-contained CloudFormation stack, `canens-prod`, built with SAM. It
exists for two reasons: Bedrock credentials cannot live in a browser bundle, and
a copy of the user's data is worth having somewhere other than their browser
profile.

| Resource | Purpose |
| --- | --- |
| VPC, 2 public subnets, IGW | Network isolation. |
| RDS PostgreSQL `db.t3.micro` | Holds the whole-store backup snapshot. |
| Lambda (container image) | The FastAPI app, built from `backend/Dockerfile`. |
| API Gateway HTTP API | The routes, with CORS limited to the frontend origin. |
| IAM role | `bedrock:InvokeModel`, logs, VPC access. Nothing else. |
| Budget + alarms | Monthly ceiling, Lambda errors, RDS free storage. |

## Why the subnets are public and there is no NAT Gateway

A Lambda in a private subnet needs a NAT Gateway to reach Bedrock, and a NAT
Gateway is about $32/month before any traffic moves. A Lambda in a public subnet
is given a public IP and reaches the internet through the internet gateway
directly. The database shares those subnets, but its security group accepts
connections only from the Lambda's security group, so it is not reachable from
the internet in any useful way.

The tradeoff is a database with a public IP that is nonetheless unreachable
without also being inside the VPC. For a personal goal tracker holding no
sensitive data that is a good trade against a NAT Gateway that would cost more
than the entire rest of the stack.

## What this costs

Roughly **$15-20/month**, almost all of it the `db.t3.micro` instance. Lambda,
API Gateway and CloudWatch are negligible at single-user volume, and the AWS
free tier covers 750 hours of micro RDS per month for the first year. The budget
alarm fires at 80% of $25.

If the bill ever matters more than the database being Postgres, the snapshot
could move to S3 and the instance could go away entirely. That is not done here
because the user chose Postgres and changing it is not a deployment concern.

## Deploying

`sam` is required. Everything else is in the template.

```bash
# One-off: the parameters are secrets, so they are passed at deploy time
# rather than being written into samconfig.toml.
DB_PASSWORD=$(python -c "import secrets; print(secrets.token_urlsafe(32))")
API_TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(32))")

sam build --template-file infrastructure/template.yaml

sam deploy \
  --config-file infrastructure/samconfig.toml \
  --parameter-overrides \
      DatabasePassword="$DB_PASSWORD" \
      ApiToken="$API_TOKEN" \
      AlertEmail=you@example.com
```

RDS provisioning takes 20-30 minutes. The stack is not usable until it finishes.

Then point the frontend at the `ApiEndpoint` stack output:

```
NEXT_PUBLIC_API_URL=https://<id>.execute-api.<region>.amazonaws.com/prod
```

**Migrations are not automatic.** A fresh database has no tables and the first
request fails, so run this once against the deployed function as a one-off
invocation:

```bash
aws lambda invoke --function-name canens-prod-canens \
  --payload '{}' /dev/stdout
```

## What is deliberately absent

- **Custom domain and certificate.** The API Gateway default domain is enough;
  GitHub Pages supplies TLS for the frontend.
- **WAF.** A token that ships in the public bundle is not a real authorisation
  boundary. The daily call cap, the reserved concurrency of 1, the API Gateway
  throttle and the budget alarm are the actual cost controls.
- **CI deployment of the backend.** The GitHub Actions workflow builds and
  publishes the frontend. The backend is deployed by hand.
