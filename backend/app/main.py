import logging
import re
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import (
    add_message,
    delete_session_messages,
    get_all_sessions,
    get_connection,
    get_session_messages,
    init_db,
    session_exists,
)
from app.gateway import (
    AllProvidersUnavailable,
    cache_enabled,
    execute_chat,
)
from app.schemas import (
    ChatRequest,
    ChatResponse,
    HealthResponse,
    SessionHistoryResponse,
)

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB on startup
    init_db()
    yield


app = FastAPI(
    title="Lyftr LLM Chatbot Gateway",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# Exception handler to guarantee JSON error response format
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": jsonable_encoder(exc.errors())},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled error: {exc}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An internal server error occurred"},
    )


@app.get("/")
def root():
    """
    Root endpoint so visiting the base URL in a browser shows status instead of 404.
    """
    return {
        "status": "ok",
        "message": "Lyftr LLM Chatbot Gateway API is running",
        "endpoints": {
            "health": "/health",
            "chat": "POST /chat",
            "messages": "GET /sessions/{session_id}/messages",
            "docs": "/docs"
        }
    }


@app.get("/debug/groq-models")
async def debug_groq_models():
    """
    Query Groq models API with key_1 to find supported model IDs.
    """
    import httpx
    keys = settings.api_key_list
    if not keys:
        return {"error": "no keys"}
    key = keys[0]
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(
                "https://api.groq.com/openai/v1/models",
                headers={"Authorization": f"Bearer {key}"}
            )
            return r.json()
        except Exception as e:
            return {"error": str(e)}


@app.get("/debug/last-error")
def debug_last_error():
    """
    Returns the exact error from the last failed provider call.
    """
    import app.gateway as gw
    return {
        "last_error": gw.last_provider_error
    }


@app.get("/debug/keys")
def debug_keys():
    """
    Safe debug endpoint returning masked keys to diagnose provider connection.
    """
    keys = settings.api_key_list
    masked = []
    for idx, k in enumerate(keys):
        if len(k) > 8:
            masked.append(f"key_{idx+1}: {k[:4]}...{k[-4:]} (len: {len(k)})")
        else:
            masked.append(f"key_{idx+1}: {k} (len: {len(k)})")
    return {
        "keys_count": len(keys),
        "keys_configured": masked,
        "model": settings.LLM_MODEL
    }


@app.get("/health", response_model=HealthResponse)
def health():
    """
    Returns 200 once the app is running, the database is reachable and the key pool is loaded.
    """
    try:
        with get_connection() as conn:
            conn.execute("SELECT 1")
    except Exception as e:
        logger.error(f"Database health check failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is unreachable",
        )

    keys_count = len(settings.api_key_list)
    return HealthResponse(
        status="ok",
        keys_configured=keys_count,
        cache_enabled=cache_enabled,
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    x_simulate_failure: Optional[str] = Header(None, alias="X-Simulate-Failure"),
):
    """
    Chat endpoint with multi-turn context, key fallback, and caching.
    """
    # 1. Fetch existing session history from SQLite (oldest first)
    existing_messages = get_session_messages(payload.session_id)

    # 2. Build full message list for LLM context
    # System prompt + history + new user message
    system_prompt = payload.system_prompt or settings.DEFAULT_SYSTEM_PROMPT
    llm_messages = [{"role": "system", "content": system_prompt}]

    for msg in existing_messages:
        llm_messages.append({"role": msg["role"], "content": msg["content"]})

    # Prepare user message content (supporting text, document uploads, and images)
    user_db_content = payload.message
    if payload.file:
        if payload.file.type.startswith("image/"):
            user_db_content = f"📷 [{payload.file.name}]\n{payload.message}"
            if payload.file.data and payload.file.data.startswith("data:image"):
                llm_messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"[Uploaded Image: {payload.file.name}]\n{payload.message}"},
                        {"type": "image_url", "image_url": {"url": payload.file.data}}
                    ]
                })
            else:
                llm_messages.append({"role": "user", "content": f"[Uploaded Image: {payload.file.name}]\n{payload.message}"})
        else:
            # Clean printable text and limit to 3,500 characters to stay within Groq's 8,000 TPM limit
            raw_text = payload.file.data or ""
            clean_chars = [c for c in raw_text if c.isprintable() or c in "\n\t "]
            clean_text = "".join(clean_chars).strip()
            clean_text = re.sub(r"[ \t]+", " ", clean_text)
            snippet = clean_text[:3500]
            user_db_content = f"📄 [{payload.file.name}]\n{payload.message}"
            llm_messages.append({
                "role": "user",
                "content": f"[Attached Document: {payload.file.name}]\n```\n{snippet}\n```\n\n{payload.message}"
            })
    else:
        llm_messages.append({"role": "user", "content": payload.message})

    # 3. Execute LLM call with LiteLLM gateway, fallback, and cache
    try:
        result = await execute_chat(
            messages=llm_messages,
            simulate_failure_header=x_simulate_failure,
        )
    except AllProvidersUnavailable:
        from app.gateway import last_provider_error
        if x_simulate_failure:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="all providers unavailable",
            )
        if last_provider_error and ("tokens per minute" in last_provider_error.lower() or "too large" in last_provider_error.lower()):
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Document too large for Groq free-tier rate limits (8,000 TPM). Please upload a smaller excerpt or text file.",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="all providers unavailable",
        )
    except Exception as e:
        logger.error(f"Execution error in chat: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="all providers unavailable",
        )

    reply = result["reply"]
    metadata = result["metadata"]

    # 4. Only persist to SQLite upon successful completion
    # Store user message
    add_message(
        session_id=payload.session_id,
        role="user",
        content=user_db_content,
    )

    # Store assistant message with metadata
    assistant_meta = {
        "resolution_source": metadata["resolution_source"],
        "input_tokens": metadata["input_tokens"],
        "output_tokens": metadata["output_tokens"],
    }
    add_message(
        session_id=payload.session_id,
        role="assistant",
        content=reply,
        metadata=assistant_meta,
    )

    return ChatResponse(
        session_id=payload.session_id,
        reply=reply,
        metadata=metadata,
    )


@app.get("/sessions/{session_id}/messages", response_model=SessionHistoryResponse, response_model_exclude_none=True)
def get_session_history(session_id: str):
    """
    Returns the stored history of one session from SQLite, oldest first, without the system prompt.
    """
    if not session_exists(session_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="session not found",
        )

    messages = get_session_messages(session_id)
    return SessionHistoryResponse(
        session_id=session_id,
        messages=messages,
    )


@app.get("/sessions")
def list_sessions():
    """
    Returns a list of recent conversation sessions stored in SQLite.
    """
    return {"sessions": get_all_sessions()}


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    """
    Deletes all messages for a specific session from SQLite.
    """
    deleted = delete_session_messages(session_id)
    return {"status": "ok", "deleted": deleted, "session_id": session_id}
