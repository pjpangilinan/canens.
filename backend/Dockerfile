FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /var/task

# Dependencies first so a code-only change does not reinstall them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

# Lambda provides the AWS_REGION, and credentials arrive through the
# execution role rather than configuration, so there is no secret to bake in.

CMD ["app.lambda_handler.handler"]
