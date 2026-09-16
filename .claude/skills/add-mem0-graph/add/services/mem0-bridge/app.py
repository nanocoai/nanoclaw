"""
mem0 Memory Bridge for NanoClaw.

Lightweight FastAPI wrapper around mem0ai providing HTTP endpoints
for memory storage and retrieval with graph support (Qdrant + Neo4j).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

# Disable mem0 telemetry before any mem0 import
os.environ["MEM0_TELEMETRY"] = "false"

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("mem0-bridge")

# ---------------------------------------------------------------------------
# Environment configuration
# ---------------------------------------------------------------------------

USER_ID = os.environ.get("MEM0_USER_ID", "default")
QDRANT_URL = os.environ.get("MEM0_QDRANT_URL", "http://localhost:6333")
QDRANT_COLLECTION = os.environ.get("MEM0_QDRANT_COLLECTION", "suki_memories")
NEO4J_URL = os.environ.get("MEM0_NEO4J_URL", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("MEM0_NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("MEM0_NEO4J_PASSWORD", "")
EMBED_PROVIDER = os.environ.get("MEM0_EMBED_PROVIDER", "openai")
EMBED_MODEL = os.environ.get("MEM0_EMBED_MODEL", "bge-m3")
EMBED_URL = os.environ.get("MEM0_EMBED_URL", "http://127.0.0.1:8091/v1")
EMBED_DIMS = int(os.environ.get("MEM0_EMBED_DIMS", "1024"))
LLM_PROVIDER = os.environ.get("MEM0_LLM_PROVIDER", "openai")
LLM_MODEL = os.environ.get("MEM0_LLM_MODEL", "qwen35-35b")
LLM_URL = os.environ.get("MEM0_LLM_URL", "http://localhost:18088/v1")
ENABLE_GRAPH = os.environ.get("MEM0_ENABLE_GRAPH", "true").lower() == "true"
SESSION_MODE = os.environ.get("MEM0_SESSION_MODE", "live")

# ---------------------------------------------------------------------------
# mem0 config builder
# ---------------------------------------------------------------------------


def _build_config() -> dict[str, Any]:
    """Build mem0 configuration dict from environment variables."""
    config: dict[str, Any] = {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "url": QDRANT_URL,
                "collection_name": QDRANT_COLLECTION,
                "embedding_model_dims": EMBED_DIMS,
            },
        },
        "embedder": {
            "provider": EMBED_PROVIDER,
            "config": {
                "model": EMBED_MODEL,
                "embedding_dims": EMBED_DIMS,
            },
        },
        "llm": {
            "provider": LLM_PROVIDER,
            "config": {
                "model": LLM_MODEL,
            },
        },
        "version": "v1.1",
    }

    # Embedder URL — provider-specific configuration
    if EMBED_PROVIDER == "openai":
        config["embedder"]["config"]["openai_base_url"] = EMBED_URL
        if not os.environ.get("OPENAI_API_KEY"):
            config["embedder"]["config"]["api_key"] = "not-needed"
    elif EMBED_PROVIDER == "ollama":
        config["embedder"]["config"]["ollama_base_url"] = EMBED_URL
    elif EMBED_PROVIDER == "huggingface":
        # HuggingFace provider loads model locally — no external URL needed.
        # Model is specified by EMBED_MODEL (e.g. "BAAI/bge-m3").
        config["embedder"]["config"]["model"] = EMBED_MODEL
        config["embedder"]["config"]["model_kwargs"] = {"device": "cpu"}

    # LLM URL — openai provider works with any OpenAI-compatible API (vLLM, etc.)
    if LLM_PROVIDER == "ollama":
        config["llm"]["config"]["ollama_base_url"] = LLM_URL
    elif LLM_PROVIDER == "openai":
        config["llm"]["config"]["openai_base_url"] = LLM_URL
        if not os.environ.get("OPENAI_API_KEY"):
            config["llm"]["config"]["api_key"] = "not-needed"

    # Graph store (Neo4j)
    if ENABLE_GRAPH:
        config["graph_store"] = {
            "provider": "neo4j",
            "config": {
                "url": NEO4J_URL,
                "username": NEO4J_USER,
                "password": NEO4J_PASSWORD,
            },
        }

    return config


# ---------------------------------------------------------------------------
# Lazy Memory singleton
# ---------------------------------------------------------------------------

_memory_instance: Any = None


def _patch_openai_client_for_thinking(mem: Any) -> None:
    """Monkey-patch mem0's OpenAI LLM client to handle Qwen3.5 thinking mode.

    Qwen3.5 on vLLM with --reasoning-parser puts the actual response in the
    'reasoning' field (model_extra) instead of 'content', regardless of whether
    thinking mode is on or off. mem0 only reads 'content', so we post-process
    every response to move reasoning → content when content is null/empty.
    """
    try:
        client = mem.llm.client  # openai.OpenAI instance
        original_create = client.chat.completions.create

        def patched_create(*args: Any, **kwargs: Any) -> Any:
            # Disable thinking to avoid wasting tokens on reasoning
            extra = kwargs.get("extra_body", {}) or {}
            ctk = extra.get("chat_template_kwargs", {})
            ctk["enable_thinking"] = False
            extra["chat_template_kwargs"] = ctk
            kwargs["extra_body"] = extra

            resp = original_create(*args, **kwargs)

            # Post-process: if content is null, copy from reasoning field
            for choice in resp.choices:
                msg = choice.message
                if not msg.content and hasattr(msg, "model_extra") and msg.model_extra:
                    reasoning = msg.model_extra.get("reasoning")
                    if reasoning and isinstance(reasoning, str):
                        msg.content = reasoning.strip()

            return resp

        client.chat.completions.create = patched_create
        logger.info("Patched OpenAI client for Qwen3.5 reasoning→content mapping")
    except Exception as exc:
        logger.warning("Could not patch OpenAI client for thinking mode: %s", exc)


def _get_memory() -> Any:
    """Lazy-initialize and return the mem0 Memory instance."""
    global _memory_instance
    if _memory_instance is None:
        from mem0 import Memory

        config = _build_config()
        logger.info("Initializing mem0 Memory with config: %s", {
            k: v if k != "graph_store" else {**v, "config": {**v["config"], "password": "***"}}
            for k, v in config.items()
        })
        _memory_instance = Memory.from_config(config)
        _patch_openai_client_for_thinking(_memory_instance)
        logger.info("Graph store: enabled=%s, type=%s",
                     getattr(_memory_instance, 'enable_graph', False),
                     type(getattr(_memory_instance, 'graph', None)).__name__)
    return _memory_instance


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class SearchRequest(BaseModel):
    query: str
    user_id: str | None = None
    limit: int = Field(default=10, ge=1, le=100)
    filters: dict[str, Any] | None = None


class AddRequest(BaseModel):
    messages: list[dict[str, str]]
    user_id: str | None = None
    run_id: str | None = None
    metadata: dict[str, Any] | None = None


class UpdateRequest(BaseModel):
    memory_id: str
    content: str


class DeleteRequest(BaseModel):
    memory_id: str


class ForgetSessionRequest(BaseModel):
    run_id: str


class ForgetTimerangeRequest(BaseModel):
    user_id: str | None = None
    before: str | None = None  # ISO 8601 datetime
    after: str | None = None   # ISO 8601 datetime


class GraphSearchRequest(BaseModel):
    query: str
    user_id: str | None = None


class HistoryRequest(BaseModel):
    memory_id: str


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="mem0 Memory Bridge", version="1.0.0")


@app.get("/health")
async def health() -> dict[str, Any]:
    """Check connectivity to Qdrant, Neo4j, and embedding service."""
    import httpx

    status: dict[str, Any] = {"status": "ok", "checks": {}}

    # Qdrant
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{QDRANT_URL}/healthz")
            status["checks"]["qdrant"] = "ok" if resp.status_code == 200 else f"status {resp.status_code}"
    except Exception as exc:
        status["checks"]["qdrant"] = f"error: {exc}"
        status["status"] = "degraded"

    # Neo4j — simple TCP connect check
    if ENABLE_GRAPH:
        try:
            from urllib.parse import urlparse

            parsed = urlparse(NEO4J_URL)
            host = parsed.hostname or "localhost"
            port = parsed.port or 7687

            import asyncio

            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=5.0
            )
            writer.close()
            await writer.wait_closed()
            status["checks"]["neo4j"] = "ok"
        except Exception as exc:
            status["checks"]["neo4j"] = f"error: {exc}"
            status["status"] = "degraded"
    else:
        status["checks"]["neo4j"] = "disabled"

    # Embedding service
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Check the models endpoint for OpenAI-compatible APIs
            base = EMBED_URL.rstrip("/")
            resp = await client.get(f"{base}/models")
            status["checks"]["embeddings"] = "ok" if resp.status_code == 200 else f"status {resp.status_code}"
    except Exception as exc:
        status["checks"]["embeddings"] = f"error: {exc}"
        status["status"] = "degraded"

    return status


@app.post("/search")
async def search(req: SearchRequest) -> dict[str, Any]:
    """Search memories by semantic similarity."""
    try:
        mem = _get_memory()
        uid = req.user_id or USER_ID

        kwargs: dict[str, Any] = {"query": req.query, "user_id": uid, "limit": req.limit}
        if req.filters:
            kwargs["filters"] = req.filters

        results = mem.search(**kwargs)
        return {"results": results}
    except Exception as exc:
        logger.exception("search failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/add")
async def add(req: AddRequest) -> dict[str, Any]:
    """Add memories from a conversation."""
    try:
        # Skip test and setup sessions
        if req.run_id and (req.run_id.endswith(":test") or req.run_id.endswith(":setup")):
            return {"status": "skipped", "reason": f"run_id '{req.run_id}' is test/setup"}

        mem = _get_memory()
        uid = req.user_id or USER_ID

        kwargs: dict[str, Any] = {"messages": req.messages, "user_id": uid}
        if req.run_id:
            kwargs["run_id"] = req.run_id
        if req.metadata:
            kwargs["metadata"] = req.metadata

        result = mem.add(**kwargs)
        return {"result": result}
    except Exception as exc:
        logger.exception("add failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/update")
async def update(req: UpdateRequest) -> dict[str, Any]:
    """Update an existing memory's content."""
    try:
        mem = _get_memory()
        result = mem.update(memory_id=req.memory_id, data=req.content)
        return {"result": result}
    except Exception as exc:
        logger.exception("update failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/delete")
async def delete(req: DeleteRequest) -> dict[str, Any]:
    """Delete a memory by ID."""
    try:
        mem = _get_memory()
        mem.delete(memory_id=req.memory_id)
        return {"status": "deleted", "memory_id": req.memory_id}
    except Exception as exc:
        logger.exception("delete failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/forget_session")
async def forget_session(req: ForgetSessionRequest) -> dict[str, Any]:
    """Delete all memories associated with a session (run_id)."""
    try:
        mem = _get_memory()

        # Get all memories, then filter by run_id
        all_memories = mem.get_all(user_id=USER_ID)
        deleted = 0

        memories_list = all_memories if isinstance(all_memories, list) else all_memories.get("results", [])

        for memory in memories_list:
            mem_metadata = memory.get("metadata", {}) or {}
            if mem_metadata.get("run_id") == req.run_id:
                mem.delete(memory_id=memory["id"])
                deleted += 1

        return {"status": "ok", "deleted": deleted, "run_id": req.run_id}
    except Exception as exc:
        logger.exception("forget_session failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/forget_timerange")
async def forget_timerange(req: ForgetTimerangeRequest) -> dict[str, Any]:
    """Delete memories within a time range based on created_at."""
    try:
        mem = _get_memory()
        uid = req.user_id or USER_ID

        before_dt = datetime.fromisoformat(req.before) if req.before else None
        after_dt = datetime.fromisoformat(req.after) if req.after else None

        # Ensure timezone-aware comparison
        if before_dt and before_dt.tzinfo is None:
            before_dt = before_dt.replace(tzinfo=timezone.utc)
        if after_dt and after_dt.tzinfo is None:
            after_dt = after_dt.replace(tzinfo=timezone.utc)

        all_memories = mem.get_all(user_id=uid)
        deleted = 0

        memories_list = all_memories if isinstance(all_memories, list) else all_memories.get("results", [])

        for memory in memories_list:
            created_str = memory.get("created_at")
            if not created_str:
                continue

            created_at = datetime.fromisoformat(created_str)
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)

            in_range = True
            if after_dt and created_at < after_dt:
                in_range = False
            if before_dt and created_at > before_dt:
                in_range = False

            if in_range:
                mem.delete(memory_id=memory["id"])
                deleted += 1

        return {"status": "ok", "deleted": deleted, "user_id": uid}
    except Exception as exc:
        logger.exception("forget_timerange failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/graph_search")
async def graph_search(req: GraphSearchRequest) -> dict[str, Any]:
    """Search the Neo4j knowledge graph for related entities."""
    if not ENABLE_GRAPH:
        raise HTTPException(status_code=400, detail="Graph support is disabled")

    try:
        mem = _get_memory()
        uid = req.user_id or USER_ID

        # mem0's graph store search
        if hasattr(mem, "enable_graph") and mem.enable_graph and mem.graph is not None:
            filters = {"user_id": uid}
            results = mem.graph.search(query=req.query, filters=filters)
            return {"results": results}
        else:
            raise HTTPException(
                status_code=501,
                detail="Graph memory not available on this mem0 instance",
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("graph_search failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/history")
async def history(req: HistoryRequest) -> dict[str, Any]:
    """Get the change history for a specific memory."""
    try:
        mem = _get_memory()
        result = mem.history(memory_id=req.memory_id)
        return {"history": result}
    except Exception as exc:
        logger.exception("history failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------


@app.on_event("startup")
async def on_startup() -> None:
    """Log configuration on startup."""
    logger.info(
        "mem0-bridge starting — qdrant=%s collection=%s neo4j=%s graph=%s "
        "embed=%s/%s llm=%s/%s user=%s mode=%s",
        QDRANT_URL, QDRANT_COLLECTION, NEO4J_URL, ENABLE_GRAPH,
        EMBED_PROVIDER, EMBED_MODEL, LLM_PROVIDER, LLM_MODEL,
        USER_ID, SESSION_MODE,
    )

    if not NEO4J_PASSWORD and ENABLE_GRAPH:
        logger.warning("MEM0_NEO4J_PASSWORD is not set — Neo4j graph store will likely fail")
