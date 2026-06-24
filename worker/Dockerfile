# syntax=docker/dockerfile:1

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Build essentials for any packages that need to compile native extensions.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with a home dir for the model cache.
RUN useradd --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

# Install Python deps. CPU-only torch keeps the image small (no CUDA wheels).
COPY worker/requirements.txt ./requirements.txt
RUN pip install --upgrade pip \
    && pip install torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt

# Worker sources.
COPY worker/ ./

# Model cache lives under the non-root user's home.
RUN mkdir -p /home/appuser/.cache/docvault \
    && chown -R appuser:appuser /app /home/appuser/.cache

USER appuser

EXPOSE 8001

CMD ["python", "main.py"]
