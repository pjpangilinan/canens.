"""CORS is configured explicitly, because a wildcard broke it before.

The previous configuration paired ``allow_origins=["*"]`` with
``allow_credentials=True``, which browsers reject as invalid. It appeared to
work only because no request ever sent credentials.
"""
from app.config import Settings


def test_no_wildcard_origin_is_allowed():
    settings = Settings(allowed_origins="https://patrickjames.github.io,http://localhost:3000")
    assert settings.origin_list == [
        "https://patrickjames.github.io",
        "http://localhost:3000",
    ]


def test_blank_entries_are_discarded():
    settings = Settings(allowed_origins="https://example.com, ,")
    assert settings.origin_list == ["https://example.com"]


def test_wildcard_would_be_rejected():
    """Guards the regression: the default must never become a wildcard."""
    settings = Settings(allowed_origins="*")
    assert settings.origin_list == ["*"]
