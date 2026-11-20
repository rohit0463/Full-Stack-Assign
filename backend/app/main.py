import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import (
    add_message,
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
        content={"detail": exc.errors()},
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

    llm_messages.append({"role": "user", "content": payload.message})

    # 3. Execute LLM call with LiteLLM gateway, fallback, and cache
    try:
        result = await execute_chat(
            messages=llm_messages,
            simulate_failure_header=x_simulate_failure,
        )
    except AllProvidersUnavailable:
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
        content=payload.message,
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


@app.get("/sessions/{session_id}/messages", response_model=SessionHistoryResponse)
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
