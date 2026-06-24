"""
DocVault embedding worker — model inference.
Handles document embedding, query embedding, and sentence-level snippet generation.
"""
import re
import logging
from typing import Optional

import torch
import numpy as np
from sentence_transformers import SentenceTransformer

log = logging.getLogger(__name__)

MODEL_NAME = "nomic-ai/nomic-embed-text-v1.5"
# Batch sizes: GPU (6 GB RTX 3050) needs 4 to avoid CUDA OOM; CPU can go higher.
BATCH_SIZE_GPU = 4
BATCH_SIZE_CPU = 32
MAX_SNIPPET_CHARS = 120
TASK_PREFIX_DOC = "search_document: "
TASK_PREFIX_QUERY = "search_query: "


class Embedder:
    def __init__(self, model_path: str, device: str = "cpu", batch_size: Optional[int] = None):
        # Safety net: if caller passes "cuda" but CUDA isn't actually available,
        # fall back to CPU instead of crashing the worker process.
        if device == "cuda" and not torch.cuda.is_available():
            log.warning(
                "Device 'cuda' requested but CUDA is not available — falling back to CPU."
            )
            device = "cpu"

        self.device = device
        self.batch_size = batch_size if batch_size is not None else (
            BATCH_SIZE_GPU if device == "cuda" else BATCH_SIZE_CPU
        )

        log.info("Loading model %s on device=%s batch_size=%d ...", MODEL_NAME, device, self.batch_size)
        self.model = SentenceTransformer(
            model_path if model_path else MODEL_NAME,
            trust_remote_code=True,  # nomic requires this
            device=device,
            cache_folder=model_path if model_path else None,
        )
        self.model_version = "nomic-embed-text-v1.5"
        log.info("Model loaded successfully on %s.", device)

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        """
        Embed a batch of document texts with task prefix per nomic spec.
        Returns shape (N, 768) float32 array.
        """
        prefixed = [TASK_PREFIX_DOC + t for t in texts]
        with torch.inference_mode():
            vecs = self.model.encode(
                prefixed,
                batch_size=self.batch_size,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        return np.array(vecs, dtype=np.float32)

    def embed_query(self, text: str) -> list[float]:
        """
        Embed a single search query with query task prefix.
        Returns 768-dim list of floats.
        """
        prefixed = TASK_PREFIX_QUERY + text
        with torch.inference_mode():
            vec = self.model.encode(
                [prefixed],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        return vec[0].tolist()

    def word_count(self, text: str) -> int:
        return len(re.findall(r"\S+", text))

    def split_sentences(self, text: str) -> list[str]:
        """
        Sentence splitter for markdown prose.
        Splits on '. ', '? ', '! ' followed by uppercase, or double newlines.
        """
        parts = re.split(r"(?<=[.?!])\s+(?=[A-Z])|(?<=\n)\n+", text)
        return [p.strip() for p in parts if p.strip()]

    def top_sentence_snippet(
        self, doc_text: str, query_vec: list[float]
    ) -> str:
        """
        For semantic search snippets: find the sentence in doc_text whose
        embedding has the highest cosine similarity to query_vec.
        Returns up to MAX_SNIPPET_CHARS characters.
        """
        sentences = self.split_sentences(doc_text)
        if not sentences:
            return doc_text[:MAX_SNIPPET_CHARS]

        query_np = np.array(query_vec, dtype=np.float32)

        with torch.inference_mode():
            sent_vecs = self.model.encode(
                [TASK_PREFIX_DOC + s for s in sentences],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        sent_vecs_np = np.array(sent_vecs, dtype=np.float32)

        # Cosine similarity (vectors already normalised, so dot product = cosine)
        sims = sent_vecs_np @ query_np
        best_idx = int(np.argmax(sims))
        best = sentences[best_idx]
        return best[:MAX_SNIPPET_CHARS]

    def keyword_snippet(self, doc_text: str, query_terms: list[str]) -> str:
        """
        For keyword search snippets: first sentence containing any query term.
        Falls back to first sentence. Returns up to MAX_SNIPPET_CHARS characters.
        """
        sentences = self.split_sentences(doc_text)
        lower_terms = [t.lower() for t in query_terms]
        for sentence in sentences:
            if any(t in sentence.lower() for t in lower_terms):
                return sentence[:MAX_SNIPPET_CHARS]
        return (sentences[0] if sentences else doc_text)[:MAX_SNIPPET_CHARS]
