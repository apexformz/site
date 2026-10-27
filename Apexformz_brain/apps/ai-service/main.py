from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import analysis
from app.routes import brain_jobs
from app.routes import brain_tracking_jobs
from app.routes import brain_perception_jobs
import os
import secrets
from fastapi.responses import JSONResponse

try:
    from apexformz_contracts import CONTRACT_VERSION
except ImportError:  # pragma: no cover - contracts package not installed
    CONTRACT_VERSION = "unavailable"

app = FastAPI(
    title="ApexFormz AI Service",
    description="Legacy real-time pose analysis (relay path) plus ApexFormz Brain retrospective deep-analysis jobs",
    version="1.1.0"
)

@app.middleware("http")
async def internal_auth(request, call_next):
    brain_jobs.expire_results()
    if request.url.path != "/health" and os.environ.get("APEXFORMZ_ENV") == "production":
        token = os.environ.get("APEXFORMZ_SERVICE_TOKEN", "")
        if len(token) < 32 or not secrets.compare_digest(request.headers.get("x-service-token", ""), token):
            return JSONResponse(status_code=401, content={"error": "Service authentication required"})
    return await call_next(request)

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
app.include_router(brain_jobs.router)
# Research adapters use local paths and optional unlocked models. Production input
# must pass through the private S3 analysis API instead of arbitrary file paths.
if os.environ.get("APEXFORMZ_ENV") != "production":
    app.include_router(brain_tracking_jobs.router)
    app.include_router(brain_perception_jobs.router)

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "ApexFormz AI", "contract_version": CONTRACT_VERSION}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
