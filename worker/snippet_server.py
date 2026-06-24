"""
DocVault snippet server — aiohttp HTTP server on :8001.
Provides /embed and /snippet endpoints for Fastify to call during search.
"""
import asyncio
import json
import logging

from aiohttp import web

from embedder import Embedder

log = logging.getLogger(__name__)


class SnippetServer:
    def __init__(
        self,
        embedder: Embedder,
        host: str = "127.0.0.1",
        port: int = 8001,
        token: str = "",
        max_request_mb: int = 16,
    ):
        self.embedder = embedder
        self.host = host
        self.port = port
        self.token = token
        self.max_request_bytes = max_request_mb * 1024 * 1024
        self._runner: web.AppRunner | None = None

    def _authorized(self, request: web.Request) -> bool:
        """When a token is configured, require a matching Bearer credential."""
        if not self.token:
            return True
        header = request.headers.get("Authorization", "")
        return header == f"Bearer {self.token}"

    async def handle_embed(self, request: web.Request) -> web.Response:
        """POST /embed — embed a query string, return 768-dim vector."""
        if not self._authorized(request):
            return web.Response(status=401, text="Unauthorized")
        try:
            body = await request.json()
        except Exception:
            return web.Response(status=400, text="Invalid JSON body")

        text = body.get("text", "")
        if not text:
            return web.Response(status=400, text='"text" field required')

        try:
            vec = self.embedder.embed_query(str(text))
        except Exception as e:
            log.error("embed_query failed: %s", e, exc_info=True)
            return web.Response(status=500, text="Embedding failed")

        return web.Response(
            content_type="application/json",
            text=json.dumps({"embedding": vec}),
        )

    async def handle_snippet(self, request: web.Request) -> web.Response:
        """POST /snippet — generate a search snippet."""
        if not self._authorized(request):
            return web.Response(status=401, text="Unauthorized")
        try:
            body = await request.json()
        except Exception:
            return web.Response(status=400, text="Invalid JSON body")

        mode = body.get("mode", "semantic")
        doc_text = body.get("text", "")

        if not doc_text:
            return web.Response(status=400, text='"text" field required')

        try:
            if mode == "semantic":
                query_vec = body.get("query_vec", [])
                if not query_vec:
                    return web.Response(
                        status=400, text='"query_vec" required for semantic mode'
                    )
                snippet = self.embedder.top_sentence_snippet(doc_text, query_vec)
            else:
                terms = body.get("terms", [])
                snippet = self.embedder.keyword_snippet(doc_text, terms)
        except Exception as e:
            log.error("snippet generation failed: %s", e, exc_info=True)
            return web.Response(status=500, text="Snippet generation failed")

        return web.Response(
            content_type="application/json",
            text=json.dumps({"snippet": snippet}),
        )

    async def handle_health(self, _request: web.Request) -> web.Response:
        """GET /health — liveness check."""
        return web.Response(
            content_type="application/json",
            text=json.dumps({"status": "ok", "model": self.embedder.model_version}),
        )

    async def run_http_server(self) -> None:
        app = web.Application(client_max_size=self.max_request_bytes)
        app.router.add_post("/embed", self.handle_embed)
        app.router.add_post("/snippet", self.handle_snippet)
        app.router.add_get("/health", self.handle_health)

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()

        log.info(
            "Snippet server listening on http://%s:%d", self.host, self.port
        )

        # Keep running indefinitely
        while True:
            await asyncio.sleep(3600)

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()
