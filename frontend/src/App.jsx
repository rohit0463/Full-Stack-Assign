import React, { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'https://lyftr-backend-rohit.onrender.com';

function generateSessionId() {
  return 's-' + Math.random().toString(36).substring(2, 9);
}

export default function App() {
  // New session on page load
  const [sessionId, setSessionId] = useState(generateSessionId);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [simulationHeader, setSimulationHeader] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [healthInfo, setHealthInfo] = useState(null);
  const [copiedSession, setCopiedSession] = useState(false);
  const [showDeveloperPanel, setShowDeveloperPanel] = useState(true);
  const messagesEndRef = useRef(null);

  // Check health and backend connectivity on mount
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((res) => res.json())
      .then((data) => setHealthInfo(data))
      .catch((err) => console.error('Health check error:', err));
  }, []);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleNewSession = () => {
    const newId = generateSessionId();
    setSessionId(newId);
    setMessages([]);
  };

  const copySessionId = () => {
    navigator.clipboard.writeText(sessionId);
    setCopiedSession(true);
    setTimeout(() => setCopiedSession(false), 2000);
  };

  const handleSend = async (e, customText = null, customSim = null) => {
    if (e) e.preventDefault();
    const textToSend = (customText !== null ? customText : inputMessage).trim();
    if (!textToSend || isLoading) return;

    const simToSend = customSim !== null ? customSim : simulationHeader;

    // Immediately clear input as per requirement: "Empty after sending"
    setInputMessage('');

    // Append user message to UI
    const userMsg = {
      role: 'user',
      content: textToSend,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (simToSend && simToSend.trim()) {
        headers['X-Simulate-Failure'] = simToSend.trim();
      }

      const body = {
        session_id: sessionId,
        message: textToSend,
      };
      if (systemPrompt.trim()) {
        body.system_prompt = systemPrompt.trim();
      }

      const response = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        // Handle 422, 503 or other errors cleanly in chat
        const errorDetail =
          typeof data.detail === 'string'
            ? data.detail
            : JSON.stringify(data.detail) || 'Failed to process request';
        setMessages((prev) => [
          ...prev,
          {
            role: 'error',
            content: `Error (${response.status}): ${errorDetail}`,
          },
        ]);
      } else {
        // Success
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.reply,
            metadata: data.metadata,
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'error',
          content: `Network error: ${err.message || 'Unable to contact backend.'}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="aurora-container">
      {/* Header */}
      <header className="aurora-header">
        <div className="brand-section">
          <div className="brand-logo">🌌</div>
          <div className="brand-text">
            <h1>Aurora AI</h1>
            <p>Resilient LLM Gateway with Cache Telemetry</p>
          </div>
        </div>

        <div className="header-actions">
          {healthInfo && (
            <div className="status-badge" title="Backend health verified">
              <span className="status-pulse" />
              <span>{healthInfo.keys_configured} Keys Ready</span>
            </div>
          )}

          <div
            className="session-pill"
            onClick={copySessionId}
            title="Click to copy Session ID"
          >
            <span>Session:</span>
            <code>{sessionId}</code>
            <span>{copiedSession ? '✓' : '📋'}</span>
          </div>

          <button
            className="btn-icon-text"
            onClick={handleNewSession}
            title="Reset conversation state and generate new session"
          >
            ↻ New Chat
          </button>
        </div>
      </header>

      {/* Developer Playground & Failover Simulator */}
      <section className="aurora-panel">
        <div
          className="panel-header"
          onClick={() => setShowDeveloperPanel(!showDeveloperPanel)}
        >
          <span className="panel-title">
            🛠️ Developer Playground & Failover Simulator
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {showDeveloperPanel ? '▲ Minimize' : '▼ Expand'}
          </span>
        </div>

        {showDeveloperPanel && (
          <div className="panel-content">
            {/* System Prompt Group */}
            <div className="control-group">
              <span className="control-title">System Persona</span>
              <input
                type="text"
                className="input-styled"
                data-testid="system-prompt-input"
                placeholder="Optional persona prompt (e.g. You are a Senior Software Architect...)"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
              <div className="preset-pills">
                <button
                  type="button"
                  className="preset-pill"
                  onClick={() =>
                    setSystemPrompt(
                      'You are an expert AI software architect. Be precise and technical.'
                    )
                  }
                >
                  Tech Architect
                </button>
                <button
                  type="button"
                  className="preset-pill"
                  onClick={() =>
                    setSystemPrompt(
                      'You are a direct, concise assistant. Answer in 1-2 punchy sentences.'
                    )
                  }
                >
                  Ultra Concise
                </button>
                <button
                  type="button"
                  className="preset-pill"
                  onClick={() => setSystemPrompt('')}
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Failover Simulator Group */}
            <div className="control-group">
              <span className="control-title">Failover Hook</span>
              <div className="preset-pills">
                <button
                  type="button"
                  className={`preset-pill ${simulationHeader === '' ? 'active' : ''}`}
                  onClick={() => setSimulationHeader('')}
                >
                  ● Normal Execution
                </button>
                <button
                  type="button"
                  className={`preset-pill ${
                    simulationHeader === 'key_1=429' ? 'active' : ''
                  }`}
                  onClick={() => setSimulationHeader('key_1=429')}
                >
                  ⚡ Simulate Key 1 Rate Limit (429)
                </button>
                <button
                  type="button"
                  className={`preset-pill ${
                    simulationHeader === 'key_1=500' ? 'active' : ''
                  }`}
                  onClick={() => setSimulationHeader('key_1=500')}
                >
                  ⚠️ Simulate Key 1 Server Error (500)
                </button>
                <button
                  type="button"
                  className={`preset-pill ${
                    simulationHeader === '*=429' ? 'active' : ''
                  }`}
                  onClick={() => setSimulationHeader('*=429')}
                >
                  🛑 Simulate All Keys Down (*=429)
                </button>
              </div>
              <input
                type="text"
                className="input-styled"
                placeholder="Custom X-Simulate-Failure (e.g. key_1=429,key_2=500)"
                value={simulationHeader}
                onChange={(e) => setSimulationHeader(e.target.value)}
                style={{ maxWidth: '280px' }}
              />
            </div>
          </div>
        )}
      </section>

      {/* Main Chat Canvas */}
      <main className="chat-canvas">
        <div className="feed-container">
          {messages.length === 0 && (
            <div className="hero-state">
              <div className="hero-glow-badge">🌌</div>
              <h2>Welcome to Aurora AI</h2>
              <p>
                A high-reliability AI conversation gateway with built-in response
                caching, instant multi-key failover, and per-turn telemetry.
              </p>

              <div className="starter-cards">
                <div
                  className="starter-card"
                  onClick={() =>
                    handleSend(null, 'What is the capital of France?')
                  }
                >
                  <strong>⚡ Test Cache Hits</strong>
                  <span>
                    Ask once for LIVE_INFERENCE, then ask in a new chat for
                    LLM_CACHE.
                  </span>
                </div>

                <div
                  className="starter-card"
                  onClick={() => {
                    setSimulationHeader('key_1=429');
                    handleSend(
                      null,
                      'Tell me a fascinating space fact.',
                      'key_1=429'
                    );
                  }}
                >
                  <strong>🛡️ Test Key Failover</strong>
                  <span>
                    Simulate key_1 failing with HTTP 429 and verify instant
                    fallback to key_2.
                  </span>
                </div>

                <div
                  className="starter-card"
                  onClick={() =>
                    handleSend(
                      null,
                      'Explain Quantum Computing in two clear sentences.'
                    )
                  }
                >
                  <strong>💡 Technical QA</strong>
                  <span>
                    Test token tracking and low-latency inference on Groq /
                    Gemini.
                  </span>
                </div>
              </div>
            </div>
          )}

          {messages.map((msg, index) => {
            if (msg.role === 'user') {
              return (
                <div key={index} className="msg-row user">
                  <div className="user-bubble">{msg.content}</div>
                </div>
              );
            }

            if (msg.role === 'error') {
              return (
                <div key={index} className="error-card">
                  <span style={{ fontSize: '1.2rem' }}>⚠️</span>
                  <span>{msg.content}</span>
                </div>
              );
            }

            // Assistant message
            return (
              <div key={index} className="msg-row assistant">
                <div className="assistant-card" data-testid="assistant-message">
                  <div className="assistant-body">{msg.content}</div>

                  {msg.metadata && (
                    <div className="telemetry-ribbon">
                      {/* Resolution Source: Exactly LIVE_INFERENCE or LLM_CACHE */}
                      <span
                        className={`telemetry-pill ${
                          msg.metadata.resolution_source === 'LLM_CACHE'
                            ? 'cache-src'
                            : 'live-src'
                        }`}
                      >
                        {msg.metadata.resolution_source === 'LLM_CACHE' ? '💾 ' : '⚡ '}
                        <span data-testid="meta-source">{msg.metadata.resolution_source}</span>
                      </span>

                      {/* Model */}
                      <span className="telemetry-pill model-tag">
                        🤖 <span data-testid="meta-model">{msg.metadata.model}</span>
                      </span>

                      {/* Latency */}
                      <span className="telemetry-pill">
                        ⏱️ <span data-testid="meta-latency">{msg.metadata.latency_ms} ms</span>
                      </span>

                      {/* Input Tokens */}
                      <span className="telemetry-pill">
                        in:{' '}
                        <strong data-testid="meta-input-tokens">
                          {msg.metadata.input_tokens}
                        </strong>
                      </span>

                      {/* Output Tokens */}
                      <span className="telemetry-pill">
                        out:{' '}
                        <strong data-testid="meta-output-tokens">
                          {msg.metadata.output_tokens}
                        </strong>
                      </span>

                      {/* Key ID */}
                      {msg.metadata.key_id && (
                        <span className="telemetry-pill key-tag">
                          🔑 {msg.metadata.key_id}
                        </span>
                      )}

                      {/* Fallback Attempts */}
                      {msg.metadata.fallback_attempts > 0 && (
                        <span className="telemetry-pill fallback-warn">
                          ⚠️ {msg.metadata.fallback_attempts} fallback(s)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {isLoading && (
            <div className="msg-row assistant">
              <div
                className="assistant-card"
                style={{
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                }}
              >
                <div className="status-pulse" />
                <span>Aurora is generating response...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Form Dock */}
        <form className="input-dock" onSubmit={handleSend}>
          <input
            type="text"
            className="dock-input"
            data-testid="chat-input"
            placeholder="Ask Aurora anything... (Press Enter to send)"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            autoFocus
          />
          <button
            type="submit"
            className="dock-send"
            data-testid="send-button"
            disabled={isLoading || !inputMessage.trim()}
          >
            <span>Send</span>
            <span>↑</span>
          </button>
        </form>
      </main>
    </div>
  );
}
