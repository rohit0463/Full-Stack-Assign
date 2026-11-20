import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

# Set test environment before imports
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["LLM_API_KEYS"] = "mock_key_1,mock_key_2,mock_key_3"
os.environ["ENABLE_FAILURE_SIMULATION"] = "true"
os.environ["LLM_MODEL"] = "gemini/gemini-2.0-flash"

from app.main import app
from app.database import init_db
import app.gateway as gateway


@pytest.fixture(autouse=True)
def setup_test_db():
    init_db()
    # Clear gateway cache between tests
    gateway._response_cache.clear()
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def mock_litellm_response(reply="Mock AI Response", prompt_tokens=25, completion_tokens=10):
    mock_resp = MagicMock()
    mock_choice = MagicMock()
    mock_choice.message.content = reply
    mock_resp.choices = [mock_choice]
    mock_usage = MagicMock()
    mock_usage.prompt_tokens = prompt_tokens
    mock_usage.completion_tokens = completion_tokens
    mock_resp.usage = mock_usage
    return mock_resp


def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["keys_configured"] == 3
    assert "cache_enabled" in data


@patch("litellm.acompletion", new_callable=AsyncMock)
def test_chat_live_inference_success(mock_acompletion, client):
    mock_acompletion.return_value = mock_litellm_response("The capital of France is Paris.", 42, 9)

    payload = {
        "session_id": "s-test-1",
        "message": "What is the capital of France?"
    }
    response = client.post("/chat", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["session_id"] == "s-test-1"
    assert data["reply"] == "The capital of France is Paris."
    meta = data["metadata"]
    assert meta["resolution_source"] == "LIVE_INFERENCE"
    assert meta["model"] == "gemini/gemini-2.0-flash"
    assert meta["input_tokens"] == 42
    assert meta["output_tokens"] == 9
    assert meta["key_id"] == "key_1"
    assert meta["fallback_attempts"] == 0
    assert isinstance(meta["latency_ms"], int)


@patch("litellm.acompletion", new_callable=AsyncMock)
def test_response_caching(mock_acompletion, client):
    mock_acompletion.return_value = mock_litellm_response("The capital of France is Paris.", 42, 9)

    # 1. First call in session A -> LIVE_INFERENCE
    res1 = client.post("/chat", json={"session_id": "s-cache-1", "message": "What is the capital of France?"})
    assert res1.status_code == 200
    assert res1.json()["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert res1.json()["metadata"]["key_id"] == "key_1"

    # 2. Second call in session B with same initial message -> LLM_CACHE
    res2 = client.post("/chat", json={"session_id": "s-cache-2", "message": "What is the capital of France?"})
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["metadata"]["resolution_source"] == "LLM_CACHE"
    assert data2["metadata"]["key_id"] is None
    assert data2["metadata"]["fallback_attempts"] == 0
    assert data2["reply"] == "The capital of France is Paris."
    assert data2["metadata"]["input_tokens"] == 42
    assert data2["metadata"]["output_tokens"] == 9

    # 3. Different message in session C -> LIVE_INFERENCE
    mock_acompletion.return_value = mock_litellm_response("Berlin is the capital of Germany.", 30, 8)
    res3 = client.post("/chat", json={"session_id": "s-cache-3", "message": "What is the capital of Germany?"})
    assert res3.status_code == 200
    assert res3.json()["metadata"]["resolution_source"] == "LIVE_INFERENCE"


@patch("litellm.acompletion", new_callable=AsyncMock)
def test_failover_simulation_key_1_429(mock_acompletion, client):
    mock_acompletion.return_value = mock_litellm_response("Answer from key 2", 35, 12)

    headers = {"X-Simulate-Failure": "key_1=429"}
    payload = {"session_id": "s-failover-1", "message": "Test failover"}
    response = client.post("/chat", json=payload, headers=headers)

    assert response.status_code == 200
    data = response.json()
    assert data["metadata"]["key_id"] == "key_2"
    assert data["metadata"]["fallback_attempts"] == 1
    assert data["metadata"]["resolution_source"] == "LIVE_INFERENCE"


@patch("litellm.acompletion", new_callable=AsyncMock)
def test_failover_simulation_key_1_500(mock_acompletion, client):
    mock_acompletion.return_value = mock_litellm_response("Answer from key 2", 35, 12)

    headers = {"X-Simulate-Failure": "key_1=500"}
    payload = {"session_id": "s-failover-2", "message": "Test failover 500"}
    response = client.post("/chat", json=payload, headers=headers)

    assert response.status_code == 200
    data = response.json()
    assert data["metadata"]["key_id"] == "key_2"
    assert data["metadata"]["fallback_attempts"] == 1


def test_failover_all_providers_unavailable(client):
    headers = {"X-Simulate-Failure": "*=429"}
    payload = {"session_id": "s-fail-all", "message": "Should fail all keys"}
    response = client.post("/chat", json=payload, headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "all providers unavailable"}

    # Ensure nothing was added to history
    hist_response = client.get("/sessions/s-fail-all/messages")
    assert hist_response.status_code == 404
    assert hist_response.json() == {"detail": "session not found"}


@patch("litellm.acompletion", new_callable=AsyncMock)
def test_multi_turn_history(mock_acompletion, client):
    mock_acompletion.return_value = mock_litellm_response("Paris", 20, 5)

    session_id = "s-multi-turn"
    # Turn 1
    res1 = client.post("/chat", json={"session_id": session_id, "message": "Hello"})
    assert res1.status_code == 200

    # Turn 2
    mock_acompletion.return_value = mock_litellm_response("The weather is nice", 35, 8)
    res2 = client.post("/chat", json={"session_id": session_id, "message": "How is the weather?"})
    assert res2.status_code == 200

    # Check history endpoint
    hist = client.get(f"/sessions/{session_id}/messages")
    assert hist.status_code == 200
    data = hist.json()
    assert data["session_id"] == session_id
    msgs = data["messages"]
    assert len(msgs) == 4
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "Hello"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"] == "Paris"
    assert msgs[1]["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert msgs[2]["role"] == "user"
    assert msgs[2]["content"] == "How is the weather?"
    assert msgs[3]["role"] == "assistant"
    assert msgs[3]["content"] == "The weather is nice"


def test_session_not_found(client):
    response = client.get("/sessions/unknown-session-12345/messages")
    assert response.status_code == 404
    assert response.json() == {"detail": "session not found"}


def test_validation_errors(client):
    # Empty message
    res1 = client.post("/chat", json={"session_id": "s-val", "message": "   "})
    assert res1.status_code == 422
    assert "detail" in res1.json()

    # Missing session_id
    res2 = client.post("/chat", json={"message": "Valid message"})
    assert res2.status_code == 422
    assert "detail" in res2.json()

    # Message over 4000 chars
    long_msg = "x" * 4001
    res3 = client.post("/chat", json={"session_id": "s-val", "message": long_msg})
    assert res3.status_code == 422
    assert "detail" in res3.json()
