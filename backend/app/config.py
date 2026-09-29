from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Where the whole-store snapshot lives. One object per user, overwritten on
    # every upload, so it is a key/value store rather than a database.
    snapshot_bucket: str = "canens-snapshots"
    usage_table: str = "canens-ai-usage"

    # Cognito. The API Gateway JWT authorizer validates the token at the edge, so
    # the function does no cryptography: it reads the verified subject out of the
    # event. These are the identifiers the authorizer and the pool are wired to,
    # and they only matter when running the function directly.
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""
    aws_region: str = "us-east-1"
    bedrock_model_id: str = "amazon.nova-lite-v1:0"

    # Per-token billing makes an unbounded generation a real cost, so every
    # call is capped explicitly.
    bedrock_max_tokens: int = 1024
    bedrock_timeout_seconds: float = 20.0

    # Hard ceiling on model calls per user per day. Set to 0 to disable.
    #
    # Flat, not ramped. A ramp existed to soften open sign-up, but at 25 it made
    # almost no difference, and the account record it needed - to date the ramp -
    # was a second item per user and two extra DynamoDB calls on every model
    # request, existing only to decide between 10 and 25. One number is the
    # whole policy.
    #
    # The count lives in DynamoDB, not in memory, because Lambda discards
    # execution environments and an in-process counter would reset behind your
    # back.
    ai_daily_cap: int = 25

    # Comma-separated list of exact origins permitted to call the API. The
    # Cognito hosted UI is a redirect, not a fetch, so only the frontend is
    # listed here.
    allowed_origins: str = "http://localhost:3000"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore unknown keys so a stale .env left over from a previous
        # provider cannot stop the application from starting.
        extra="ignore",
    )

    @property
    def origin_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


settings = Settings()
