FROM postgres:15-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ops
COPY infrastructure/deployment/requirements-operations.lock /tmp/requirements.lock
RUN /opt/ops/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock
COPY infrastructure/deployment/operations.py /opt/operations.py
USER postgres
CMD ["/opt/ops/bin/python", "/opt/operations.py"]
