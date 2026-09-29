# Canens

Local-first goal tracker that breaks goals into next actions using Amazon Bedrock Nova Lite.

<p align="center">
  <img src="screenshots/07-steps-generated.png" alt="Canens Preview" width="480" />
</p>

## Highlights

- **Local-first**: Instant UI updates backed by browser IndexedDB (Dexie).
- **Cloud Backup**: Automated snapshot backups to AWS S3.
- **AI Next Steps**: Proposes actionable next steps via Bedrock Amazon Nova Lite.
- **Cognito Auth**: Direct-to-Cognito authentication with in-app password reset.
- **Rate-limited**: Atomic DynamoDB counter bounds model usage (25 calls/day).

## Screenshots

| Sign In | Goals & Generated Steps |
| :---: | :---: |
| <img src="screenshots/01-signed-out.png" width="320" alt="Sign In" /> | <img src="screenshots/05-suggested-goals.png" width="320" alt="Suggested Goals" /> |
| **Activity Log** | **Mobile** |
| <img src="screenshots/17-activity-log.png" width="320" alt="Activity Log" /> | <img src="screenshots/18-mobile-home.png" width="220" alt="Mobile View" /> |

## Architecture

```
Browser                     API Gateway             Lambda
─────────                   ────────────            ──────
Next.js static export   →   HTTP API          →    FastAPI (Mangum)
  Cognito action API         JWT authorizer          x-canens-user
IndexedDB (Dexie)                                   │
  └── background backup ───────────────────────────→│
                                                       ├─→ S3 (snapshots/{sub}.json)
      AI response       ←───────────────────────────┤
                                                       └─→ DynamoDB (rate limits)
                                                            → Bedrock (Nova Lite)
```

- **Frontend**: Next.js static export hosted on GitHub Pages.
- **Backend**: Python FastAPI deployed as a container Lambda.
- **Auth**: AWS Cognito user pool with API Gateway JWT authorizer.
- **Data**: IndexedDB client-side, encrypted S3 snapshots for backup, DynamoDB for rate limiting.

## Quick Start

### Backend

```bash
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Runs at `http://localhost:8000`.

### Frontend

```bash
cd web
npm install
npm run dev
```

Runs at `http://localhost:3000`.

## Testing

```bash
# Backend unit & integration tests
cd backend && pytest

# Frontend unit & e2e tests
cd web && npm test && npm run test:e2e

# Full automated verification suite
powershell -File verify.ps1 -SkipAI
```

## Deployment

- **Frontend**: Automatically built and deployed to GitHub Pages via GitHub Actions.
- **Backend**: Managed with AWS SAM:

```bash
sam build --template-file infrastructure/template.yaml
sam deploy --config-file infrastructure/samconfig.toml --resolve-image-repos --resolve-s3
```
