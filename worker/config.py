"""
DocVault worker configuration.
Reads from .env file (parent directory) and environment variables.
All keys overridable by DOCVAULT_* env vars.
"""
import logging
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from parent directory (repo root)
_repo_root = Path(__file__).parent.parent
load_dotenv(_repo_root / ".env")

log = logging.getLogger(__name__)


def _resolve_device() -> str:
    """
    Resolve the embedding device to use.

    - If DOCVAULT_EMBEDDING_DEVICE is explicitly set to "cpu", honour it.
    - If set to "cuda" (or left as default), verify CUDA is actually available.
      Fall back to "cpu" with a warning if not.
    - "auto" (or unset) picks CUDA when available, CPU otherwise.
    """
    import torch

    requested = os.environ.get("DOCVAULT_EMBEDDING_DEVICE", "auto").lower()

    if requested == "cpu":
        return "cpu"

    cuda_available = torch.cuda.is_available()

    if requested == "cuda":
        if cuda_available:
            return "cuda"
        log.warning(
            "DOCVAULT_EMBEDDING_DEVICE=cuda requested but CUDA is not available. "
            "Falling back to CPU. Semantic search will work but will be slower."
        )
        return "cpu"

    # "auto" or anything else: pick the best available
    return "cuda" if cuda_available else "cpu"


def _default_batch_size(device: str) -> int:
    """
    Sensible batch size defaults by device.
    GPU (6 GB RTX 3050): 4 to avoid CUDA OOM.
    CPU: 32 (no VRAM limit; throughput-oriented).
    """
    return 4 if device == "cuda" else 32


def get_config() -> dict:
    device = _resolve_device()
    default_batch = _default_batch_size(device)
    return {
        "db_url": os.environ.get(
            "DOCVAULT_DATABASE_URL",
            "postgresql://docvault:changeme@localhost:5432/docvault",
        ),
        "model_path": os.environ.get(
            "DOCVAULT_EMBEDDING_MODEL_PATH",
            str(Path.home() / ".cache" / "docvault" / "models"),
        ),
        "model_name": os.environ.get(
            "DOCVAULT_EMBEDDING_MODEL",
            "nomic-ai/nomic-embed-text-v1.5",
        ),
        "device": device,
        "batch_size": int(os.environ.get("DOCVAULT_EMBEDDING_BATCH_SIZE", str(default_batch))),
        "worker_port": int(os.environ.get("DOCVAULT_EMBEDDING_WORKER_PORT", "8001")),
        "worker_host": os.environ.get("DOCVAULT_WORKER_HOST", "127.0.0.1"),
        # Optional shared bearer token. When set, /embed and /snippet require
        # `Authorization: Bearer <token>`. Set the same value on the API side
        # (DOCVAULT_WORKER_TOKEN). Strongly recommended if the worker port is
        # reachable by anything other than the local API process.
        "worker_token": os.environ.get("DOCVAULT_WORKER_TOKEN", ""),
        "max_request_mb": int(os.environ.get("DOCVAULT_WORKER_MAX_REQUEST_MB", "16")),
        "poll_interval_s": float(os.environ.get("DOCVAULT_WORKER_POLL_INTERVAL_S", "2")),
        "log_level": os.environ.get("DOCVAULT_SERVER_LOG_LEVEL", "INFO").upper(),
    }
