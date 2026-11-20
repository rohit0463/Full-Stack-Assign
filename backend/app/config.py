from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    LLM_API_KEYS: str = "demo-key-1,demo-key-2"
    DATABASE_URL: str = "sqlite:////data/app.db"
    ALLOWED_ORIGINS: str = "*"
    ENABLE_FAILURE_SIMULATION: bool = True
    LLM_MODEL: str = "gemini/gemini-2.0-flash"
    DEFAULT_SYSTEM_PROMPT: str = (
        "You are Aurora AI, a helpful, intelligent, and articulate assistant designed with the style and quality of ChatGPT.\n\n"
        "Guidelines:\n"
        "1. Direct & Natural Answers: Provide clear, well-structured text by default using standard GitHub Markdown (clean paragraphs, bullet points, and bold terms). Do NOT force diagrams or images unless asked.\n"
        "2. Code: When asked for code or technical solutions, provide clean, complete, working code inside fenced code blocks with language tags (e.g. ```python, ```java).\n"
        "3. Diagrams ONLY When Requested: Only include a Mermaid diagram (```mermaid ... ```) if the user explicitly asks for a diagram, flowchart, sequence, or architecture visual.\n"
        "4. Images ONLY When Explicitly Asked: Only include an image (e.g. ![Description](https://image.pollinations.ai/prompt/<encoded_prompt>?width=800&height=450&nologo=true)) when the user explicitly requests an image, photo, or drawing.\n"
        "5. Be concise, precise, and helpful."
    )

    @property
    def api_key_list(self) -> List[str]:
        keys = [
            k.strip().strip("'").strip('"')
            for k in self.LLM_API_KEYS.split(",")
            if k.strip().strip("'").strip('"')
        ]
        return keys

    @property
    def allowed_origins_list(self) -> List[str]:
        if self.ALLOWED_ORIGINS.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",") if origin.strip()]

    @property
    def effective_model(self) -> str:
        keys = self.api_key_list
        if keys and keys[0].startswith("gsk_"):
            return "groq/openai/gpt-oss-20b"
        elif keys and keys[0].startswith("sk-") and not keys[0].startswith("sk-ant"):
            return "openai/gpt-4o-mini"
        if "llama" in self.LLM_MODEL or "70b" in self.LLM_MODEL or "groq" in self.LLM_MODEL:
            return "groq/openai/gpt-oss-20b"
        return self.LLM_MODEL


settings = Settings()
