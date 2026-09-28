from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import goals, sync

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(goals.router)
app.include_router(sync.router)
