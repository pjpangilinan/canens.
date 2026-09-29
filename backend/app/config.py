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

    # Sign-up is open, so every account gets its own allowance and the allowance
    # starts small. This is the whole reason a stranger cannot cost real money
    # on their first afternoon: a new account may make the first number of
    # calls, and the last is the steady state for as long as the account lives.
    # Index is the account's age in days, so this is days 0, 1, 2, 3 and 4+.
    ai_daily_cap_ramp: tuple[int, ...] = (10, 25, 50, 100, 200)

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

    def daily_cap_for(self, age_days: int) -> int:
        """The allowance for an account of a given age, in days."""
        ramp = self.ai_daily_cap_ramp
        if not ramp:
            return 0
        return ramp[min(max(age_days, 0), len(ramp) - 1)]


settings = Settings()
