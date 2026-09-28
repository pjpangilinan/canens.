from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import ai, backup

app = FastAPI(title="Canens API")

# Credentials are not used, so they are not allowed. The previous
# configuration combined a wildcard origin with allow_credentials, which
# browsers reject as invalid; it only appeared to work because no request
# ever sent credentials.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Content-Type", "X-Canens-Token"],
)

app.include_router(ai.router)
app.include_router(backup.router)


@app.get("/api/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
