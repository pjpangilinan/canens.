from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://canens:canens_dev_pass@localhost:5432/canens"

    # Bedrock credentials are not read here. They come from the execution role
    # that Lambda provides, so there is no API key to configure or leak.
    aws_region: str = "us-east-1"
    bedrock_model_id: str = "amazon.nova-lite-v1:0"

    # Per-token billing makes an unbounded generation a real cost, so every
    # call is capped explicitly.
    bedrock_max_tokens: int = 1024
    bedrock_timeout_seconds: float = 20.0

    # Hard ceiling on model calls per user per day. Set to 0 to disable.
    ai_daily_cap: int = 200

    # Comma-separated list of exact origins permitted to call the API.
    allowed_origins: str = "http://localhost:3000"

    # Shared secret required in the X-Canens-Token header on AI and backup
    # routes. This is not real authentication: the value is inlined into the
    # client bundle, so anyone who can load the page has it. It exists to stop
    # casual abuse of a public endpoint, not to resist an attacker. Pair it
    # with the daily call cap and an account-level spend limit.
    #
    # It is required when APP_ENV is "production" and optional otherwise, so a
    # deployment that forgets to set it fails at startup rather than quietly
    # serving an unauthenticated, billable endpoint to the internet.
    api_token: str | None = None
    app_env: str = "development"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore unknown keys so a stale .env left over from a previous
        # provider cannot stop the application from starting.
        extra="ignore",
    )

    @model_validator(mode="after")
    def _token_required_in_production(self) -> "Settings":
        if self.app_env.lower() == "production" and not self.api_token:
            raise ValueError(
                "API_TOKEN must be set when APP_ENV=production. Without it the AI "
                "and backup routes are unauthenticated and billable."
            )
        return self

    @property
    def origin_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


settings = Settings()

# Single-user MVP. Real accounts are out of scope; the id stays threaded
# through every model and query so they remain possible later.
MVP_USER_ID = "00000000-0000-0000-0000-000000000000"
