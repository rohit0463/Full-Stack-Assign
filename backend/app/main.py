import logging
import re
import httpx
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request, status, UploadFile, File
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
            # Handle PDF documents and text files
            raw_data = payload.file.data or ""
            extracted_text = ""

            # Check if this is a base64 encoded PDF payload
            is_pdf = payload.file.name.lower().endswith(".pdf") or payload.file.type == "application/pdf"
            if is_pdf and ("base64," in raw_data or raw_data.startswith("JVBER")):
                try:
                    import base64
                    import io
                    b64_content = raw_data.split("base64,")[-1] if "base64," in raw_data else raw_data
                    pdf_bytes = base64.b64decode(b64_content)
                    try:
                        import pypdf
                        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
                        pages_list = []
                        for page_idx, page in enumerate(reader.pages[:10]):
                            t = page.extract_text()
                            if t and t.strip():
                                pages_list.append(f"[Page {page_idx + 1}]\n{t.strip()}")
                        if pages_list:
                            extracted_text = "\n\n".join(pages_list)
                    except Exception as pe:
                        logger.warning(f"Server-side pypdf extraction warning: {pe}")
                except Exception as b64e:
                    logger.warning(f"Server-side base64 decode warning: {b64e}")

            if not extracted_text:
                extracted_text = raw_data

            # Sanitize printable characters and normalize whitespace
            clean_chars = [c for c in extracted_text if c.isprintable() or c in "\n\t "]
            clean_text = "".join(clean_chars).strip()
            clean_text = re.sub(r"[ \t]+", " ", clean_text)
            # Cap at 3,500 characters to strictly respect Groq's 8,000 TPM limit
            snippet = clean_text[:3500]

            user_db_content = f"📄 [{payload.file.name}]\n{payload.message}"
            llm_messages.append({
                "role": "user",
                "content": (
                    f"The user attached a document named '{payload.file.name}'.\n\n"
                    f"--- BEGIN DOCUMENT CONTENT ---\n"
                    f"{snippet}\n"
                    f"--- END DOCUMENT CONTENT ---\n\n"
                    f"User Request / Question about this document:\n{payload.message}"
                ),
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

    # Enhance with photorealistic images if requested and not already present
    user_query_lower = payload.message.lower()
    if any(trig in user_query_lower for trig in ["photo", "picture", "portrait", "image of", "show me"]) and "![" not in reply:
        import urllib.parse
        clean_subj = payload.message
        for p in [
            "show me a photo of", "show me an image of", "show me a picture of",
            "show me photo of", "show me image of", "picture of", "photo of",
            "image of", "portrait of", "generate an image of", "show me"
        ]:
            if p in clean_subj.lower():
                pos = clean_subj.lower().find(p)
                clean_subj = clean_subj[pos + len(p):].strip(" .?!,")
                break

        clean_subj = clean_subj.split("?")[0].split("\n")[0].split(" and ")[0].strip()
        if len(clean_subj) >= 2:
            enc = urllib.parse.quote(f"{clean_subj} portrait photorealistic realistic detailed 8k")
            img_card = f"![{clean_subj.title()}](https://image.pollinations.ai/prompt/{enc}?width=800&height=500&nologo=true)\n\n"
            # Strip standard LLM refusal lines if present (handling unicode apostrophes and spaces)
            cleaned_lines = []
            for l in reply.split("\n"):
                norm = re.sub(r"[’‘]", "'", l.lower()).replace("\u202f", " ").replace("\xa0", " ")
                if any(ap in norm for ap in [
                    "can't provide a photo", "cannot provide a photo",
                    "can't provide an image", "cannot provide an image",
                    "can't show a photo", "cannot show a photo",
                    "can't provide photos", "cannot provide photos",
                    "unable to provide photos", "unable to display images",
                    "i'm sorry, but i can't", "i am sorry, but i cannot"
                ]):
                    if "however" in norm:
                        idx_how = norm.find("however")
                        cleaned_lines.append(l[idx_how:].capitalize())
                    continue
                cleaned_lines.append(l)
            reply = img_card + "\n".join(cleaned_lines).strip()

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


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribes audio using Groq Whisper API (whisper-large-v3).
    Provides instant, zero-latency speech-to-text fallback for all browsers.
    """
    try:
        audio_bytes = await file.read()
        if not audio_bytes or len(audio_bytes) < 100:
            return {"text": ""}

        filename = file.filename or "audio.webm"
        content_type = file.content_type or "audio/webm"

        for key in settings.api_key_list:
            if key.startswith("gsk_"):
                try:
                    async with httpx.AsyncClient(timeout=20.0) as client:
                        files = {"file": (filename, audio_bytes, content_type)}
                        data = {"model": "whisper-large-v3"}
                        resp = await client.post(
                            "https://api.groq.com/openai/v1/audio/transcriptions",
                            headers={"Authorization": f"Bearer {key}"},
                            files=files,
                            data=data,
                        )
                        if resp.status_code == 200:
                            result = resp.json()
                            return {"text": result.get("text", "").strip()}
                        else:
                            logger.warning(f"Groq whisper status {resp.status_code}: {resp.text}")
                except Exception as e:
                    logger.warning(f"Groq whisper attempt error: {e}")

        return {"text": ""}
    except Exception as e:
        logger.error(f"Transcribe endpoint error: {e}")
        return {"text": ""}
