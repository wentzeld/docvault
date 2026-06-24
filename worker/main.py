"""
DocVault embedding worker — main entry point.
Runs the pg-boss job consumer and the snippet HTTP server concurrently.
Handles graceful shutdown on SIGTERM/SIGINT.
"""
import asyncio
import logging
import signal
import sys

from config import get_config
from embedder import Embedder
from job_handler import JobHandler
from snippet_server import SnippetServer


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )


async def main() -> None:
    cfg = get_config()
    setup_logging(cfg["log_level"])

    log = logging.getLogger("docvault.worker")
    log.info(
        "DocVault worker starting. model=%s device=%s",
        cfg["model_name"],
        cfg["device"],
    )

    # Load model (this may take 10-30s on first run; longer on CPU)
    embedder = Embedder(
        model_path=cfg["model_path"],
        device=cfg["device"],
        batch_size=cfg["batch_size"],
    )

    handler = JobHandler(db_url=cfg["db_url"], embedder=embedder)
    server = SnippetServer(
        embedder=embedder,
        host=cfg["worker_host"],
        port=cfg["worker_port"],
        token=cfg["worker_token"],
        max_request_mb=cfg["max_request_mb"],
    )

    loop = asyncio.get_running_loop()

    # Graceful shutdown handler
    shutdown_event = asyncio.Event()

    def handle_signal(sig: signal.Signals) -> None:
        log.info("Received %s — shutting down...", sig.name)
        handler.stop()
        shutdown_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, handle_signal, sig)

    # Run both coroutines concurrently
    tasks = [
        asyncio.create_task(handler.run_poll_loop(), name="job-poll"),
        asyncio.create_task(server.run_http_server(), name="http-server"),
        asyncio.create_task(shutdown_event.wait(), name="shutdown-watch"),
    ]

    try:
        done, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    except asyncio.CancelledError:
        pass
    finally:
        await server.stop()
        log.info("Worker stopped.")


if __name__ == "__main__":
    asyncio.run(main())
