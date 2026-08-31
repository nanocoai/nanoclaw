"""
Minimal OpenAI-compatible embedding proxy for BGE-M3.
Loads the model once, serves /v1/embeddings on port 8091.
BGE-M3 is already cached on disk from AEGIS.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI(title="BGE-M3 Embedding Proxy")

# Load model at startup (cached on disk, ~2GB RAM on CPU)
model: SentenceTransformer | None = None


@app.on_event("startup")
async def load_model() -> None:
    global model
    print("Loading BAAI/bge-m3 ...")
    model = SentenceTransformer("BAAI/bge-m3", device="cpu")
    print(f"BGE-M3 loaded: dim={model.get_sentence_embedding_dimension()}")


class EmbedRequest(BaseModel):
    input: str | list[str]
    model: str = "bge-m3"


@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest) -> dict[str, Any]:
    texts = [req.input] if isinstance(req.input, str) else req.input
    start = time.time()
    vectors = model.encode(texts, normalize_embeddings=True).tolist()  # type: ignore[union-attr]
    elapsed = time.time() - start
    return {
        "object": "list",
        "data": [
            {"object": "embedding", "index": i, "embedding": v}
            for i, v in enumerate(vectors)
        ],
        "model": req.model,
        "usage": {
            "prompt_tokens": sum(len(t.split()) for t in texts),
            "total_tokens": sum(len(t.split()) for t in texts),
        },
        "_elapsed_ms": round(elapsed * 1000, 1),
    }


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": "bge-m3", "object": "model", "owned_by": "BAAI"}],
    }
