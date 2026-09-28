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

    # Comma-separated list of exact origins permitted to call the API.
    allowed_origins: str = "http://localhost:3000"

    # Shared secret required in the X-Canens-Token header on AI and backup
    # routes. This is not real authentication: the value is inlined into the
    # client bundle, so anyone who can load the page has it. It exists to stop
    # casual abuse of a public endpoint, not to resist an attacker. Pair it
    # with API Gateway throttling and an account-level spend limit.
    api_token: str | None = None

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

# Single-user MVP. Real accounts are out of scope; the id stays threaded
# through every model and query so they remain possible later.
MVP_USER_ID = "00000000-0000-0000-0000-000000000000"
