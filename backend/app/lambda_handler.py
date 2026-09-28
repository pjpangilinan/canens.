"""AWS Lambda entrypoint.

Wraps the FastAPI application for the ``fastapi-mangum`` runtime so the same
code runs locally under uvicorn and in Lambda behind API Gateway.
"""
from mangum import Mangum

from app.main import app

handler = Mangum(app, lifespan="off")
