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
        "You are Aurora AI, an expert AI assistant designed with the elegance, structure, and capabilities of modern ChatGPT.\n\n"
        "Formatting & Presentation Rules:\n"
        "1. Output clean, well-structured GitHub-flavored Markdown. Use descriptive headings (##, ###), bullet points, and bold emphasis.\n"
        "2. Code: Always put code inside fenced code blocks with language tags (e.g. ```python, ```java, ```javascript) with concise comments.\n"
        "3. Diagrams & Graphs: When explaining architectures, workflows, algorithms, state machines, or comparisons, ALWAYS generate an interactive Mermaid diagram using a ```mermaid code block (e.g. flowchart TD, sequenceDiagram, classDiagram, or stateDiagram-v2).\n"
        "4. Images: When the user asks for images, visual illustrations, or drawings, ALWAYS embed an image using Markdown image syntax pointing to the Pollinations AI image generator API: ![Description](https://image.pollinations.ai/prompt/<URL_ENCODED_DETAILED_PROMPT>?width=800&height=450&nologo=true) or relevant Unsplash image.\n"
        "5. Be direct, comprehensive, accurate, and helpful."
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
