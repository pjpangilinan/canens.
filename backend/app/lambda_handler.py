"""AWS Lambda entrypoint.

Wraps the FastAPI application for the ``fastapi-mangum`` runtime so the same
code runs locally under uvicorn and in Lambda behind API Gateway.

Also the only place the caller's identity enters the application. API Gateway's
JWT authorizer has already validated the token by the time an event arrives
here, and the verified subject is in the event. It is passed to the application
as a request header, which is stripped and re-set on every single invocation:
a browser that sends the header itself must not be able to choose whose data it
reads.
"""
import uuid

from mangum import Mangum

from app.main import app

#: Header carrying the authenticated subject from the verified JWT to the app.
USER_HEADER = "x-canens-user"

# Mangum builds an ASGI scope per event and holds nothing between them, so one
# adapter is reused rather than constructed per request.
_adapter = Mangum(app, lifespan="off")


def _verified_subject(event: dict) -> str | None:
    """The subject API Gateway verified, or None if there was no valid token.

    HTTP API puts Cognito claims under authorizer.jwt.claims; the older REST
    shape uses authorizer.claims, and both are accepted so the function is not
    quietly broken by an authorizer type change.
    """
    request_context = event.get("requestContext") or {}
    authorizer = request_context.get("authorizer") or {}
    claims = (authorizer.get("jwt") or {}).get("claims") or authorizer.get("claims") or {}
    subject = claims.get("sub")

    if not isinstance(subject, str):
        return None
    try:
        # The subject becomes part of an S3 key and a DynamoDB key, so a value
        # that is not a UUID is refused rather than used.
        return str(uuid.UUID(subject))
    except (ValueError, AttributeError, TypeError):
        return None


def handler(event: dict, context: object) -> dict:
    # Drop whatever arrived under this name before setting it from the claims.
    # Case-insensitive because HTTP headers may arrive with arbitrary casing.
    headers = {
        k: v
        for k, v in (event.get("headers") or {}).items()
        if k.lower() != USER_HEADER.lower()
    }
    subject = _verified_subject(event)
    if subject is not None:
        headers[USER_HEADER] = subject

    return _adapter({**event, "headers": headers}, context)
