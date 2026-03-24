from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import analysis
import os

app = FastAPI(
    title="SmartCoach AI Service",
    description="Real-time pose estimation and sports analysis engine",
    version="1.0.0"
)

# Allow requests from Backend Express Server
origins = [
    "http://localhost:4000",
    "http://localhost:3000", # Sometimes direct from frontend if needed
    os.getenv("CORS_ORIGIN", "http://localhost:4000")
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analysis.router, tags=["Analysis"])

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "SmartCoach AI"}
