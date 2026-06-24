"""
DocVault pg-boss job handler.
Polls pgboss.job table directly via psycopg3 (no Node.js client needed).
"""
import asyncio
import json
import logging
from typing import Any

import psycopg
from psycopg.rows import dict_row

from embedder import Embedder

log = logging.getLogger(__name__)

POLL_INTERVAL_S = 2
JOB_NAME = "embed-document"
BATCH_SIZE = 16
JOB_TIMEOUT_S = 120


class JobHandler:
    def __init__(self, db_url: str, embedder: Embedder):
        self.db_url = db_url
        self.embedder = embedder
        self._running = True

    def stop(self) -> None:
        self._running = False

    async def run_poll_loop(self) -> None:
        log.info("Job poll loop started. Polling every %ss.", POLL_INTERVAL_S)
        while self._running:
            try:
                await self._poll_and_process()
            except Exception as e:
                log.error("Poll loop error: %s", e, exc_info=True)
            await asyncio.sleep(POLL_INTERVAL_S)
        log.info("Job poll loop stopped.")

    async def _poll_and_process(self) -> None:
        async with await psycopg.AsyncConnection.connect(
            self.db_url, row_factory=dict_row
        ) as conn:
            rows = await self._claim_jobs(conn, BATCH_SIZE)
            if not rows:
                return

            doc_ids = []
            job_ids = []
            for r in rows:
                data = r.get("data") or {}
                if isinstance(data, str):
                    data = json.loads(data)
                doc_ids.append(data.get("docId"))
                job_ids.append(r["id"])

            # Filter out None doc IDs
            valid = [(jid, did) for jid, did in zip(job_ids, doc_ids) if did]
            if not valid:
                await self._fail_jobs(conn, job_ids, "Missing docId in job payload")
                return

            job_ids_valid = [v[0] for v in valid]
            doc_ids_valid = [v[1] for v in valid]

            log.info(
                "Processing %d embed job(s): %s", len(doc_ids_valid), doc_ids_valid
            )

            docs = await self._fetch_docs(conn, doc_ids_valid)

            if not docs:
                await self._fail_jobs(conn, job_ids_valid, "Documents not found in DB")
                return

            texts = [f"{d['title']}\n\n{d['content']}" for d in docs]

            try:
                vectors = self.embedder.embed_documents(texts)
            except Exception as e:
                log.error("Embedding inference failed: %s", e, exc_info=True)
                await self._fail_jobs(conn, job_ids_valid, str(e))
                await self._update_embed_status(conn, doc_ids_valid, "failed")
                return

            # Write embeddings back to DB
            for doc, vec in zip(docs, vectors):
                word_count = self.embedder.word_count(doc["content"])
                vec_list = vec.tolist()
                await conn.execute(
                    """
                    UPDATE documents SET
                        embedding = %s::vector,
                        embed_status = 'ready',
                        embed_model = %s,
                        words = %s,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (
                        str(vec_list),
                        self.embedder.model_version,
                        word_count,
                        doc["id"],
                    ),
                )

            await conn.commit()
            await self._ack_jobs(conn, job_ids_valid)
            log.info("Embedded %d document(s) successfully.", len(docs))

    async def _claim_jobs(self, conn: Any, batch_size: int) -> list[dict]:
        """
        Atomically claim up to batch_size pg-boss jobs.
        Uses SELECT ... FOR UPDATE SKIP LOCKED on pgboss.job.
        """
        result = await conn.execute(
            """
            WITH batch AS (
                SELECT id FROM pgboss.job
                WHERE name = %s
                  AND state = 'created'
                  AND (start_after IS NULL OR start_after <= now())
                ORDER BY priority DESC, created_on ASC
                LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            UPDATE pgboss.job j SET
                state = 'active',
                started_on = now(),
                expire_in = %s::interval
            FROM batch
            WHERE j.id = batch.id
            RETURNING j.id, j.data
            """,
            (JOB_NAME, batch_size, f"{JOB_TIMEOUT_S} seconds"),
        )
        return await result.fetchall()

    async def _ack_jobs(self, conn: Any, job_ids: list) -> None:
        await conn.execute(
            "UPDATE pgboss.job SET state='completed', completed_on=now() "
            "WHERE id = ANY(%s::uuid[])",
            (job_ids,),
        )
        await conn.commit()

    async def _fail_jobs(self, conn: Any, job_ids: list, reason: str) -> None:
        await conn.execute(
            "UPDATE pgboss.job SET state='failed', output=%s::jsonb "
            "WHERE id = ANY(%s::uuid[])",
            (json.dumps({"error": reason}), job_ids),
        )
        await conn.commit()

    async def _update_embed_status(
        self, conn: Any, doc_ids: list, status: str
    ) -> None:
        await conn.execute(
            "UPDATE documents SET embed_status = %s::embed_status WHERE id = ANY(%s::uuid[])",
            (status, doc_ids),
        )
        await conn.commit()

    async def _fetch_docs(self, conn: Any, doc_ids: list) -> list[dict]:
        result = await conn.execute(
            "SELECT id, title, content FROM documents WHERE id = ANY(%s::uuid[])",
            (doc_ids,),
        )
        return await result.fetchall()
