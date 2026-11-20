import React, { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

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

  const handleSend = async (e) => {
    if (e) e.preventDefault();
    const trimmed = inputMessage.trim();
    if (!trimmed || isLoading) return;

    // Immediately clear input as per requirement: "Empty after sending"
    setInputMessage('');

    // Append user message to UI
    const userMsg = {
      role: 'user',
      content: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (simulationHeader.trim()) {
        headers['X-Simulate-Failure'] = simulationHeader.trim();
      }

      const body = {
        session_id: sessionId,
        message: trimmed,
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
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <span className="brand-badge">Lyftr AI</span>
          <span className="brand-title">Resilient LLM Gateway</span>
        </div>
        <div className="header-meta">
          <span>
            Session: <code className="session-badge">{sessionId}</code>
          </span>
          {healthInfo && (
            <span style={{ fontSize: '0.8rem', color: '#4ade80' }}>
              ● {healthInfo.keys_configured} Keys Active
            </span>
          )}
          <button
            className="btn-secondary"
            onClick={handleNewSession}
            title="Start fresh session"
          >
            ↻ New Chat
          </button>
        </div>
      </header>

      {/* Control Bar: System prompt & Failover Simulator */}
      <section className="controls-bar">
        <div className="control-row">
          <label className="control-label">System Prompt</label>
          <input
            type="text"
            className="system-prompt-input"
            data-testid="system-prompt-input"
            placeholder="e.g. You are a Shakespearean assistant. (Optional)"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </div>

        <div className="control-row">
          <label className="control-label">Failover Hook</label>
          <select
            className="simulator-select"
            value={simulationHeader}
            onChange={(e) => setSimulationHeader(e.target.value)}
          >
            <option value="">None (Normal execution)</option>
            <option value="key_1=429">Simulate Key 1 Rate Limit (key_1=429)</option>
            <option value="key_1=500">Simulate Key 1 Server Error (key_1=500)</option>
            <option value="key_1=429,key_2=500">Failover Chain (key_1=429,key_2=500)</option>
            <option value="*=429">All Keys Fail (*=429)</option>
          </select>
          <input
            type="text"
            className="system-prompt-input"
            placeholder="Custom X-Simulate-Failure header (e.g. key_1=429)"
            value={simulationHeader}
            onChange={(e) => setSimulationHeader(e.target.value)}
            style={{ maxWidth: '300px' }}
          />
        </div>
      </section>

      {/* Chat Messages */}
      <main className="chat-container">
        <div className="messages-list">
          {messages.length === 0 && (
            <div className="empty-state">
              <h3>Start a Conversation</h3>
              <p>
                Send a message to test multi-turn memory, response caching (
                <code>LLM_CACHE</code>), and automated key failover.
              </p>
            </div>
          )}

          {messages.map((msg, index) => {
            if (msg.role === 'user') {
              return (
                <div key={index} className="message-row user">
                  <div className="message-bubble">{msg.content}</div>
                </div>
              );
            }

            if (msg.role === 'error') {
              return (
                <div key={index} className="error-bubble">
                  <span>⚠️</span>
                  <span>{msg.content}</span>
                </div>
              );
            }

            // Assistant message
            return (
              <div key={index} className="message-row assistant">
                <div className="message-bubble" data-testid="assistant-message">
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>

                  {msg.metadata && (
                    <div className="metadata-container">
                      {/* Resolution Source: Exactly LIVE_INFERENCE or LLM_CACHE */}
                      <span
                        className={`meta-pill ${
                          msg.metadata.resolution_source === 'LLM_CACHE'
                            ? 'source-cache'
                            : 'source-live'
                        }`}
                        data-testid="meta-source"
                      >
                        {msg.metadata.resolution_source}
                      </span>

                      {/* Model */}
                      <span className="meta-pill" data-testid="meta-model">
                        {msg.metadata.model}
                      </span>

                      {/* Latency */}
                      <span className="meta-pill" data-testid="meta-latency">
                        {msg.metadata.latency_ms} ms
                      </span>

                      {/* Input Tokens */}
                      <span className="meta-pill">
                        in: <strong data-testid="meta-input-tokens">{msg.metadata.input_tokens}</strong>
                      </span>

                      {/* Output Tokens */}
                      <span className="meta-pill">
                        out: <strong data-testid="meta-output-tokens">{msg.metadata.output_tokens}</strong>
                      </span>

                      {/* Key ID if available */}
                      {msg.metadata.key_id && (
                        <span className="meta-pill key-info">
                          key: {msg.metadata.key_id}
                        </span>
                      )}

                      {/* Fallback attempts if > 0 */}
                      {msg.metadata.fallback_attempts > 0 && (
                        <span className="meta-pill fallback-info">
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
            <div className="message-row assistant">
              <div className="message-bubble" style={{ color: 'var(--text-muted)' }}>
                Thinking...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input Form */}
        <form className="input-form" onSubmit={handleSend}>
          <input
            type="text"
            className="chat-input"
            data-testid="chat-input"
            placeholder="Type your message... (Press Enter to send)"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            autoFocus
          />
          <button
            type="submit"
            className="send-button"
            data-testid="send-button"
            disabled={isLoading || !inputMessage.trim()}
          >
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
