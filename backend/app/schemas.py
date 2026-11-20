from typing import Optional, List, Any, Dict
from pydantic import BaseModel, Field, field_validator


class HealthResponse(BaseModel):
    status: str = "ok"
    keys_configured: int
    cache_enabled: bool


class FileAttachment(BaseModel):
    name: str
    type: str
    data: Optional[str] = None
    size: Optional[int] = None


class ChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    message: str = Field(...)
    system_prompt: Optional[str] = None
    file: Optional[FileAttachment] = None

    @field_validator("message")
    @classmethod
    def validate_message(cls, v: str) -> str:
        trimmed = v.strip()
        if not (1 <= len(trimmed) <= 4000):
            raise ValueError("message must be 1-4000 characters after trimming whitespace")
        return trimmed

    @field_validator("session_id")
    @classmethod
    def validate_session_id(cls, v: str) -> str:
        trimmed = v.strip()
        if not (1 <= len(trimmed) <= 128):
            raise ValueError("session_id must be 1-128 characters")
        return trimmed


class ChatMetadata(BaseModel):
    resolution_source: str
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    key_id: Optional[str] = None
    fallback_attempts: int


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    metadata: ChatMetadata


class HistoryMessage(BaseModel):
    role: str
    content: str
    metadata: Optional[Dict[str, Any]] = None


class SessionHistoryResponse(BaseModel):
    session_id: str
    messages: List[HistoryMessage]
