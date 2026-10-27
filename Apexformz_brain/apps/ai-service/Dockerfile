FROM python:3.12-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APEXFORMZ_ENV=production SPORT_PACKS_DIR=/app/sport-packs APEXFORMZ_SCHEMAS_DIR=/app/packages/contracts/schemas
COPY packages/contracts/python /app/packages/contracts/python
COPY packages/contracts/schemas /app/packages/contracts/schemas
COPY packages/perception-py /app/packages/perception-py
COPY apps/ai-service/requirements.txt /app/requirements.txt
COPY apps/ai-service/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.lock && pip install --no-cache-dir --no-deps /app/packages/contracts/python /app/packages/perception-py
RUN apt-get update && apt-get install -y --no-install-recommends libegl1 libgles2 && rm -rf /var/lib/apt/lists/*
COPY apps/ai-service/app /app/app
COPY apps/ai-service/main.py /app/main.py
COPY sport-packs /app/sport-packs
COPY apps/frontend/public/models/pose_landmarker_full.task /app/models/pose_landmarker_full.task
ENV APEXFORMZ_MODEL_CACHE=/app/models
RUN python -c "from apexformz_perception.pose import create_backend; backend=create_backend('mediapipe', variant='full', prefer_gpu=False); backend.close(); print('Pinned CPU pose model initialized')"
RUN useradd --system --uid 10001 --create-home appuser
USER appuser
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
