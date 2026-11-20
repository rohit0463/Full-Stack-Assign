# Lyftr AI - Full-Stack LLM Chatbot with Key Failover and Response Caching

A resilient, production-ready full-stack AI application featuring LiteLLM multi-key failover, in-memory/disk response caching, multi-turn session persistence with SQLite, and an interactive React chat interface.

---

## 1. Live URLs

- **Live Frontend**: [https://lyftr-llm-chatbot.vercel.app](https://lyftr-llm-chatbot.vercel.app) *(or your deployed Vercel / Cloudflare Pages URL)*
- **Live Backend API**: [https://lyftr-llm-chatbot-backend.onrender.com](https://lyftr-llm-chatbot-backend.onrender.com) *(or your deployed Render / Railway URL)*
- **Interactive API Documentation (Swagger)**: `https://lyftr-llm-chatbot-backend.onrender.com/docs`
- **Health Check**: `https://lyftr-llm-chatbot-backend.onrender.com/health`
- **GitHub Repository**: [https://github.com/rohit0463/lyftr-llm-chatbot](https://github.com/rohit0463/lyftr-llm-chatbot)

---

## 2. Run locally: with Docker and without

### Option A: With Docker (Recommended)

Prerequisites: Docker & Docker Compose installed.

1. **Clone the repository**:
   ```bash
   git clone https://github.com/rohit0463/lyftr-llm-chatbot.git
   cd lyftr-llm-chatbot
   ```

2. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   # Open .env and add your valid LLM_API_KEYS (e.g. Gemini, Groq, or OpenAI keys)
   ```

3. **Start the complete stack**:
   ```bash
   make up
   ```
   - **Backend API**: `http://localhost:8000` (Docs at `http://localhost:8000/docs`)
   - **Frontend UI**: `http://localhost:3000`
   - SQLite data is persisted safely in Docker named volume `sqlite_data` mounted at `/data/app.db`.

4. **Stop the stack**:
   ```bash
   make down
   ```

---

### Option B: Without Docker

#### 1. Backend Setup (FastAPI + LiteLLM)
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Set local environment variables
export DATABASE_URL="sqlite:///./app.db"
export LLM_API_KEYS="your-first-key,your-second-key"
export ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
export ENABLE_FAILURE_SIMULATION="true"
export LLM_MODEL="gemini/gemini-2.0-flash"

# Run tests
pytest -v

# Start development server
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

#### 2. Frontend Setup (React + Vite)
```bash
cd frontend
npm install
export VITE_API_URL="http://localhost:8000"
npm run dev
```
Open `http://localhost:3000` in your browser.

---

## 3. Design decisions: key fallback, caching, SQLite session storage

### Key Pool & Automated Failover
- **Ordered Key Pool**: Configured via `LLM_API_KEYS` (comma-separated, keyed as `key_1`, `key_2`, ...).
- **Graceful Fallback**: If a key encounters rate limits (`HTTP 429`), quota exhaustion, or server errors (`5xx`), the gateway logs the failure, increments `fallback_attempts`, and seamlessly forwards the request to the next available key in the pool.
- **Failover Simulation Hook**: Supports the required `X-Simulate-Failure` header (e.g. `key_1=429`, `key_1=429,key_2=500`, `*=429`) whenever `ENABLE_FAILURE_SIMULATION=true`.
- **Fault Isolation**: If every key in the pool is exhausted or simulated to fail, the backend returns a clean `503 Service Unavailable` with `{"detail": "all providers unavailable"}`. No internal stack traces or HTML errors leak to the client, and failed requests are never saved to history.

### Response Caching
- **Deterministic Cache Key**: A SHA-256 hash of the JSON-encoded `{"model": model, "messages": messages}` tuple (encompassing the system prompt, historical dialogue, and current user input).
- **Dual Cache Layer**: Combines LiteLLM's local cache with a fast in-memory key-value cache.
- **Contract Adherence**:
  - `LIVE_INFERENCE`: Identifies newly executed completions, tracking which key answered (`key_id: "key_1"`, etc.).
  - `LLM_CACHE`: Identifies cache hits, returning identical text and token counts, with `key_id: null`, `fallback_attempts: 0`, and ultra-low response latency (< 10 ms).
  - Cache hits occur across sessions if the prompt sequence matches, while differing prompts always trigger live inference.

### SQLite Session Storage
- **Isolated Storage**: Uses SQLite with zero external dependencies (no Redis, no Postgres required).
- **Safe Persistence**: Stored at `/data/app.db` via `DATABASE_URL` under a Docker volume so all conversation history survives container restarts.
- **Schema & Indexes**: Automatically initialized on startup (`CREATE TABLE IF NOT EXISTS messages (...)`) with an index on `session_id` for $O(1)$ session history retrieval.
- **Non-Destructive Failures**: Messages are committed to SQLite only after successful completion, ensuring error turns (422, 503) do not pollute history.

---

## 4. Verification: how to see failover, cache hits and per-message token usage

### 1. Verify Cache Hits (`LLM_CACHE`)
1. Open the UI at `http://localhost:3000` (or the live URL).
2. Ask: *"What is the capital of France?"*.
   - You will see metadata pill: `LIVE_INFERENCE`, `key: key_1`, `latency: ~800 ms`.
3. Click **"↻ New Chat"** (which generates a new session id).
4. Send the exact same question: *"What is the capital of France?"*.
   - You will see metadata pill immediately change to: `LLM_CACHE`, `key: null`, `latency: ~2 ms` (substantially faster than live call).
5. Send a new question: *"What is the capital of Germany?"*.
   - You will see metadata pill: `LIVE_INFERENCE`.

### 2. Verify Key Failover (`X-Simulate-Failure`)
In the UI header bar, select the **Failover Hook** dropdown (or use `curl`):
- **Select `key_1=429`**:
  - Request sends header `X-Simulate-Failure: key_1=429`.
  - Response metadata displays: `key: key_2`, `1 fallback(s)`, status `200 OK`.
- **Select `*=429` (All Keys Fail)**:
  - Request sends header `X-Simulate-Failure: *=429`.
  - UI displays readable error banner: `Error (503): all providers unavailable`.
  - No broken screen or unhandled exception occurs.

### 3. Verify Per-Message Token Usage
- Under every assistant message, inspect `in: <count>` and `out: <count>`.
- Two equal-length first messages in two separate sessions report the same `input_tokens` (reflecting system prompt + message, not cumulative session growth).

### 4. Automated Backend Test Suite
Run the automated test suite with pytest:
```bash
make test
```
Validates:
- `GET /health` contract
- Multi-turn conversation retrieval via `GET /sessions/{session_id}/messages`
- Key failover with `X-Simulate-Failure: key_1=429` and `key_1=500`
- Provider exhaustion returning 503
- Fast cache retrieval and cache isolation
- Validation error handling (422)

---

## 5. Setup Used: your editor and AI tools

- **Editor**: Visual Studio Code / Antigravity IDE
- **AI Tools**: Antigravity AI Assistant (Google DeepMind), LiteLLM Gateway
- **Runtime & Frameworks**: Python 3.11, FastAPI, Uvicorn, SQLite3, React 18, Vite, Docker & Docker Compose

---

## 6. Bonus features (if any): what you added beyond the requirements and why

1. **Interactive Failover Simulator in UI**:
   - Integrated an interactive simulator dropdown and custom header input directly inside the frontend header.
   - *Why*: Allows evaluators and reviewers to test all failover scenarios (`key_1=429`, `key_1=500`, `*=429`) in real time from the browser without needing curl or Postman.

2. **Custom System Prompt Session Configurator**:
   - Built a live system prompt input tagged with `data-testid="system-prompt-input"`.
   - *Why*: Enables users to customize assistant persona per session (e.g. "Answer as a pirate") while respecting cache isolation.

3. **Session Switcher & Reset**:
   - Added a "New Chat" button and clear session badge in the header to effortlessly test multi-turn isolation and cross-session cache behavior.

4. **Multi-Stage Lean Docker Containers**:
   - Multi-stage builds for both backend (Python 3.11 slim) and frontend (Node 20 build -> Nginx Alpine runtime) resulting in minimal image footprint and fast cold starts.
