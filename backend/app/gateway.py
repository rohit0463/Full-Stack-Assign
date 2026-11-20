import time
import json
import hashlib
import logging
from typing import List, Dict, Any, Optional, Tuple
import litellm
from litellm.caching import Cache

from app.config import settings

logger = logging.getLogger("gateway")
logger.setLevel(logging.INFO)

# Initialize LiteLLM cache (in-memory)
try:
    litellm.cache = Cache(type="local")
    cache_enabled = True
except Exception as e:
    logger.warning(f"Failed to initialize LiteLLM cache: {e}")
    cache_enabled = False


# Diagnostic tracker for live debugging
last_provider_error: Optional[str] = None


class AllProvidersUnavailable(Exception):
    """Raised when every key in the pool has failed."""
    pass


def parse_simulation_header(header_val: Optional[str]) -> Dict[str, int]:
    """
    Parse X-Simulate-Failure header.
    Format: comma-separated <key_id>=<status> pairs; * means every key.
    Statuses: 429, 500, 502, 503.
    """
    if not header_val or not settings.ENABLE_FAILURE_SIMULATION:
        return {}

    failures: Dict[str, int] = {}
    parts = [p.strip() for p in header_val.split(",") if p.strip()]
    for part in parts:
        if "=" in part:
            k, v = part.split("=", 1)
            k = k.strip()
            try:
                status = int(v.strip())
                if status in (429, 500, 502, 503):
                    failures[k] = status
            except ValueError:
                continue
    return failures


def compute_cache_key(model: str, messages: List[Dict[str, str]]) -> str:
    """
    Cache key: model + the full message list sent to the LLM (system prompt + history + new message).
    """
    serialized = json.dumps({"model": model, "messages": messages}, sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


# Internal cache store backing LiteLLM cache logic to guarantee contract compliance
# Stores: key -> {"reply": str, "input_tokens": int, "output_tokens": int, "model": str}
_response_cache: Dict[str, Dict[str, Any]] = {}


def get_cached_response(cache_key: str) -> Optional[Dict[str, Any]]:
    # First check our internal store
    if cache_key in _response_cache:
        return _response_cache[cache_key]

    # Also check litellm.cache if available
    if cache_enabled and litellm.cache:
        try:
            cached = litellm.cache.get_cache(cache_key)
            if cached and isinstance(cached, dict) and "reply" in cached:
                return cached
        except Exception:
            pass
    return None


def set_cached_response(cache_key: str, data: Dict[str, Any]) -> None:
    _response_cache[cache_key] = data
    if cache_enabled and litellm.cache:
        try:
            litellm.cache.set_cache(cache_key, data)
        except Exception:
            pass


async def execute_chat(
    messages: List[Dict[str, str]],
    simulate_failure_header: Optional[str] = None
) -> Dict[str, Any]:
    """
    Executes completion with key fallback, response caching, and failure simulation.
    Returns:
    {
        "reply": str,
        "metadata": {
            "resolution_source": "LIVE_INFERENCE" | "LLM_CACHE",
            "model": str,
            "latency_ms": int,
            "input_tokens": int,
            "output_tokens": int,
            "key_id": str | None,
            "fallback_attempts": int
        }
    }
    """
    model = settings.effective_model
    cache_key = compute_cache_key(model, messages)

    start_time = time.perf_counter()

    # 1. Check Cache
    cached = get_cached_response(cache_key)
    if cached is not None:
        latency_ms = int((time.perf_counter() - start_time) * 1000)
        # Ensure latency is at least 1ms or realistic small integer
        if latency_ms < 1:
            latency_ms = 1

        return {
            "reply": cached["reply"],
            "metadata": {
                "resolution_source": "LLM_CACHE",
                "model": cached.get("model", model),
                "latency_ms": latency_ms,
                "input_tokens": cached["input_tokens"],
                "output_tokens": cached["output_tokens"],
                "key_id": None,
                "fallback_attempts": 0
            }
        }

    # 2. Live Inference with Key Fallback
    api_keys = settings.api_key_list
    if not api_keys:
        raise AllProvidersUnavailable("No API keys configured.")

    simulated_failures = parse_simulation_header(simulate_failure_header)
    fallback_attempts = 0
    reply_text: Optional[str] = None
    input_tokens = 0
    output_tokens = 0
    success_key_id: Optional[str] = None

    for idx, api_key in enumerate(api_keys):
        key_id = f"key_{idx + 1}"

        # Check simulation
        if "*" in simulated_failures or key_id in simulated_failures:
            sim_status = simulated_failures.get("*", simulated_failures.get(key_id))
            logger.info(f"Simulating failure for {key_id} with status {sim_status}")
            fallback_attempts += 1
            continue

        # Smart provider detection from key prefix
        current_model = model
        if api_key.startswith("gsk_") and not current_model.startswith("groq/"):
            current_model = "groq/llama-3.3-70b-versatile"
        elif api_key.startswith("sk-") and not api_key.startswith("sk-ant") and not current_model.startswith("openai/"):
            current_model = "openai/gpt-4o-mini"

        masked_key = f"{api_key[:6]}...{api_key[-4:]}" if len(api_key) > 10 else "***"
        print(f"[GATEWAY] Attempting completion using {key_id} ({masked_key}) with model {current_model}", flush=True)

        if current_model.startswith("groq/") or api_key.startswith("gsk_"):
            os.environ["GROQ_API_KEY"] = api_key
        elif current_model.startswith("gemini/") or api_key.startswith("AIzaSy"):
            os.environ["GEMINI_API_KEY"] = api_key

        try:
            # LiteLLM completion
            response = await litellm.acompletion(
                model=current_model,
                messages=messages,
                api_key=api_key,
                temperature=0.7,
                max_tokens=1000
            )

            # Extract reply text
            reply_text = response.choices[0].message.content or ""

            # Extract tokens
            usage = getattr(response, "usage", None)
            if usage:
                input_tokens = getattr(usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(usage, "completion_tokens", 0) or 0
            else:
                # Estimate if not provided
                input_tokens = sum(len(m.get("content", "").split()) for m in messages) * 2
                output_tokens = len(reply_text.split()) * 2

            success_key_id = key_id
            model = current_model
            break

        except Exception as e:
            global last_provider_error
            last_provider_error = f"{key_id} ({current_model}): {type(e).__name__}: {str(e)}"
            print(f"[GATEWAY] Provider {key_id} failed: {type(e).__name__}: {e}", flush=True)

            # If gemini-2.0 failed with 404 or not found, auto-try gemini-1.5-flash
            if "2.0" in current_model and ("not found" in str(e).lower() or "404" in str(e)):
                try:
                    fallback_model = "gemini/gemini-1.5-flash"
                    print(f"[GATEWAY] Retrying {key_id} with fallback model {fallback_model}", flush=True)
                    response = await litellm.acompletion(
                        model=fallback_model,
                        messages=messages,
                        api_key=api_key,
                        temperature=0.7,
                        max_tokens=1000
                    )
                    reply_text = response.choices[0].message.content or ""
                    usage = getattr(response, "usage", None)
                    if usage:
                        input_tokens = getattr(usage, "prompt_tokens", 0) or 0
                        output_tokens = getattr(usage, "completion_tokens", 0) or 0
                    else:
                        input_tokens = sum(len(m.get("content", "").split()) for m in messages) * 2
                        output_tokens = len(reply_text.split()) * 2
                    success_key_id = key_id
                    model = fallback_model
                    break
                except Exception as e2:
                    print(f"[GATEWAY] Fallback model also failed: {type(e2).__name__}: {e2}", flush=True)

            fallback_attempts += 1
            continue

    if success_key_id is None or reply_text is None:
        raise AllProvidersUnavailable("all providers unavailable")

    latency_ms = int((time.perf_counter() - start_time) * 1000)
    if latency_ms < 1:
        latency_ms = 1

    # Store in cache
    cache_data = {
        "reply": reply_text,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "model": model
    }
    set_cached_response(cache_key, cache_data)

    return {
        "reply": reply_text,
        "metadata": {
            "resolution_source": "LIVE_INFERENCE",
            "model": model,
            "latency_ms": latency_ms,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "key_id": success_key_id,
            "fallback_attempts": fallback_attempts
        }
    }
