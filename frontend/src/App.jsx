import React, { useState, useEffect, useRef, useMemo } from 'react';
import './index.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'https://lyftr-backend-rohit.onrender.com';

function generateSessionId() {
  return 'sess-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now().toString(36);
}

function escapeHtml(string) {
  return String(string || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Markdown and Diagram Renderer with Mermaid and Image Support
function MarkdownContent({ content }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !window.mermaid) return;

    const mermaidEls = containerRef.current.querySelectorAll('.mermaid-target:not([data-rendered="true"])');
    mermaidEls.forEach(async (el, idx) => {
      el.setAttribute('data-rendered', 'true');
      const rawEncoded = el.getAttribute('data-code');
      let rawCode = rawEncoded ? decodeURIComponent(rawEncoded) : el.textContent;

      // 1. Unescape any HTML entities if present
      let cleanCode = rawCode
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();

      // 2. Ensure diagram header exists
      if (!/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph)/i.test(cleanCode)) {
        cleanCode = 'flowchart TD\n' + cleanCode;
      }

      // 3. Auto-fix unquoted labels containing parentheses or colons inside brackets:
      // e.g. A[User (Client)] -> A["User (Client)"]
      cleanCode = cleanCode.replace(/\[([^"\]\n]*[\(:\/][^"\]\n]*)\]/g, '["$1"]');

      const id = 'mermaid-svg-' + Math.random().toString(36).substring(2, 9) + '-' + idx;

      try {
        const { svg } = await window.mermaid.render(id, cleanCode);
        el.innerHTML = svg;
      } catch (err) {
        console.warn('Mermaid rendering notice:', err);
        // Suppress and clean up any error elements injected into DOM by Mermaid
        const stray = document.getElementById('d' + id) || document.querySelector('#' + id);
        if (stray) stray.remove();

        // Render clean, readable fallback diagram
        el.innerHTML = `
          <div class="mermaid-fallback-card">
            <pre class="mermaid-clean-code"><code>${escapeHtml(cleanCode)}</code></pre>
          </div>
        `;
      }
    });
  }, [content]);

  const html = useMemo(() => {
    if (typeof window !== 'undefined' && window.marked) {
      const renderer = new window.marked.Renderer();

      // Custom code block renderer (supports Mermaid diagrams & copy button)
      renderer.code = function (code, lang, escaped) {
        let codeText = '';
        let language = '';

        if (typeof code === 'object' && code !== null) {
          codeText = code.text || '';
          language = (code.lang || '').toLowerCase().trim();
        } else {
          codeText = typeof code === 'string' ? code : '';
          language = (typeof lang === 'string' ? lang : '').toLowerCase().trim();
        }

        if (language === 'mermaid') {
          const encoded = encodeURIComponent(codeText);
          return `
            <div class="mermaid-block">
              <div class="diagram-tag">📊 Visual Flowchart</div>
              <div class="mermaid-target" data-code="${encoded}">
                <pre class="mermaid-clean-code"><code>${escapeHtml(codeText)}</code></pre>
              </div>
            </div>
          `;
        }

        const encoded = encodeURIComponent(codeText);
        return `
          <div class="code-block-wrapper">
            <div class="code-block-header">
              <span class="code-lang">${language || 'code'}</span>
              <button class="copy-code-btn" onclick="navigator.clipboard.writeText(decodeURIComponent('${encoded}')); this.innerText='✓ Copied'; setTimeout(() => this.innerText='Copy code', 2000);">
                Copy code
              </button>
            </div>
            <pre><code class="language-${language}">${escapeHtml(codeText)}</code></pre>
          </div>
        `;
      };

      // Custom image renderer with modern card wrapper
      renderer.image = function (href, title, text) {
        let imageHref = '';
        let altText = '';

        if (typeof href === 'object' && href !== null) {
          imageHref = href.href || '';
          altText = href.text || href.title || 'Visual depiction';
        } else {
          imageHref = typeof href === 'string' ? href : '';
          altText = typeof text === 'string' ? text : (typeof title === 'string' ? title : 'Visual depiction');
        }

        return `
          <figure class="chatgpt-image-card">
            <img src="${imageHref}" alt="${escapeHtml(altText)}" loading="lazy" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=800&q=80';" />
            <figcaption>${escapeHtml(altText)}</figcaption>
          </figure>
        `;
      };

      try {
        return window.marked.parse(content, { renderer, gfm: true, breaks: true });
      } catch (e) {
        console.error('Marked parse error:', e);
        return `<p>${escapeHtml(content)}</p>`;
      }
    }
    return `<p>${escapeHtml(content)}</p>`;
  }, [content]);

  return (
    <div
      ref={containerRef}
      className="assistant-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function App() {
  const [sessionId, setSessionId] = useState(generateSessionId);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [simulationHeader, setSimulationHeader] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [healthInfo, setHealthInfo] = useState(null);
  const [copiedSession, setCopiedSession] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showDevModal, setShowDevModal] = useState(false);
  const [showGlobalMetrics, setShowGlobalMetrics] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState({});
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [attachedFile, setAttachedFile] = useState(null);

  // Saved sessions list for the sidebar
  const [sessions, setSessions] = useState(() => {
    try {
      const saved = localStorage.getItem('aurora_sessions');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const textareaRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const liveTranscriptRef = useRef('');

  const startVoiceRecording = async () => {
    // 1. Request microphone stream
    let stream = null;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (permErr) {
      console.warn('Microphone permission notice:', permErr);
      alert('Microphone access was denied. Please allow microphone permissions in your browser address bar.');
      return;
    }

    setIsRecording(true);
    liveTranscriptRef.current = inputMessage ? inputMessage.trim() + ' ' : '';
    audioChunksRef.current = [];

    // Setup MediaRecorder for fail-safe audio transcription
    if (stream && typeof MediaRecorder !== 'undefined') {
      try {
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };
        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start(250);
      } catch (recErr) {
        console.warn('MediaRecorder init notice:', recErr);
      }
    }

    // 2. Setup live client SpeechRecognition for real-time visual typing in textarea
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';

        recognition.onresult = (event) => {
          let currentSessionText = '';
          for (let i = 0; i < event.results.length; i++) {
            currentSessionText += event.results[i][0].transcript + ' ';
          }
          const text = (liveTranscriptRef.current + currentSessionText).replace(/\s+/g, ' ').trim();
          if (text) {
            setInputMessage(text);
            if (textareaRef.current) {
              textareaRef.current.value = text;
            }
          }
        };

        recognition.onerror = (e) => {
          console.warn('Live speech recognition notice:', e.error);
        };

        recognition.onend = () => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            try { recognition.start(); } catch (err) {}
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (speechErr) {
        console.warn('WebSpeech init warning:', speechErr);
      }
    }
  };

  const stopVoiceRecording = async (autoSubmit = false) => {
    setIsRecording(false);

    // Stop SpeechRecognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }

    // Stop MediaRecorder and audio stream
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current.stream?.getTracks().forEach((track) => track.stop());
      } catch (e) {}
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    let finalQuery = (inputMessage || '').trim();

    // If client SpeechRecognition did not transcribe any text, send audio to Groq Whisper fallback
    if (!finalQuery && audioChunksRef.current.length > 0) {
      try {
        setIsTranscribing(true);
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioBlob, 'voice_query.webm');

        const res = await fetch(`${API_BASE}/transcribe`, {
          method: 'POST',
          body: formData,
        });

        if (res.ok) {
          const data = await res.json();
          if (data.text && data.text.trim()) {
            finalQuery = data.text.trim();
            setInputMessage(finalQuery);
            if (textareaRef.current) {
              textareaRef.current.value = finalQuery;
            }
          }
        }
      } catch (transcribeErr) {
        console.warn('Whisper fallback error:', transcribeErr);
      } finally {
        setIsTranscribing(false);
      }
    }

    if (autoSubmit && finalQuery) {
      setTimeout(() => {
        handleSend(null, finalQuery);
      }, 100);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopVoiceRecording(false);
    } else {
      startVoiceRecording();
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedFile({
          name: file.name,
          type: file.type,
          size: file.size,
          data: reader.result,
          previewUrl: reader.result,
          isImage: true,
        });
      };
      reader.readAsDataURL(file);
    } else if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
      try {
        const arrayBuffer = await file.arrayBuffer();
        let extractedText = '';

        // Extract text page by page using PDF.js if available
        if (window.pdfjsLib) {
          try {
            const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
            const pdfDoc = await loadingTask.promise;
            const maxPages = Math.min(pdfDoc.numPages, 12);
            const pageTexts = [];

            for (let i = 1; i <= maxPages; i++) {
              const page = await pdfDoc.getPage(i);
              const textContent = await page.getTextContent();
              const pageStr = textContent.items
                .map((item) => item.str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
              if (pageStr) {
                pageTexts.push(`[Page ${i}]\n${pageStr}`);
              }
            }
            if (pageTexts.length > 0) {
              extractedText = pageTexts.join('\n\n');
            }
          } catch (pdfErr) {
            console.warn('PDF.js client extraction error, falling back to base64:', pdfErr);
          }
        }

        // Base64 fallback for backend pypdf if client extraction was empty
        let base64Data = '';
        if (!extractedText) {
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          base64Data = 'data:application/pdf;base64,' + window.btoa(binary);
        }

        const textSnippet = extractedText
          ? extractedText.slice(0, 3500)
          : base64Data;

        setAttachedFile({
          name: file.name,
          type: 'application/pdf',
          size: file.size,
          data: textSnippet,
          isImage: false,
          isPdf: true,
        });
      } catch (err) {
        console.error('PDF file read error:', err);
      }
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        const text = (reader.result || '').slice(0, 4000);
        setAttachedFile({
          name: file.name,
          type: file.type || 'text/plain',
          size: file.size,
          data: text,
          isImage: false,
          isPdf: false,
        });
      };
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  // Fetch backend health and past sessions on mount
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((res) => res.json())
      .then((data) => setHealthInfo(data))
      .catch((err) => console.error('Health check error:', err));

    // Fetch existing conversation sessions from SQLite backend
    fetch(`${API_BASE}/sessions`)
      .then((res) => res.json())
      .then((data) => {
        if (data.sessions && data.sessions.length > 0) {
          const dbSessions = data.sessions.map((s) => ({
            id: s.session_id,
            title: s.title || 'Conversation',
            timestamp: new Date(s.created_at).getTime(),
          }));
          setSessions((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const newOnes = dbSessions.filter((d) => !existingIds.has(d.id));
            return [...prev, ...newOnes];
          });
        }
      })
      .catch((err) => console.log('Local sessions active:', err));
  }, []);

  // Save sessions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('aurora_sessions', JSON.stringify(sessions));
    } catch (e) {
      console.error(e);
    }
  }, [sessions]);

  // Automatically persist messages per session in localStorage for instant restoration
  useEffect(() => {
    if (sessionId && messages.length > 0) {
      try {
        localStorage.setItem(`chat_history_${sessionId}`, JSON.stringify(messages));
      } catch (e) {
        console.warn('LocalStorage save warning:', e);
      }
    }
  }, [sessionId, messages]);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputMessage]);

  const handleNewSession = () => {
    const newId = generateSessionId();
    setSessionId(newId);
    setMessages([]);
    setInputMessage('');
    setAttachedFile(null);
  };

  const handleSwitchSession = async (targetId) => {
    if (targetId === sessionId && messages.length > 0) return;

    // 1. Restore instantly from localStorage (0ms latency, opens immediately)
    let restored = false;
    try {
      const cached = localStorage.getItem(`chat_history_${targetId}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
          restored = true;
        }
      }
    } catch (e) {}

    setSessionId(targetId);
    if (!restored) {
      setMessages([]);
      setIsLoading(true);
    }

    // 2. Sync with SQLite backend
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetId}/messages`);
      if (res.ok) {
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          const mapped = data.messages.map((m) => ({
            role: m.role,
            content: m.content,
            metadata: m.metadata || null,
          }));
          setMessages(mapped);
          try {
            localStorage.setItem(`chat_history_${targetId}`, JSON.stringify(mapped));
          } catch (e) {}
        }
      }
    } catch (e) {
      console.error('Failed to sync session history:', e);
    } finally {
      setIsLoading(false);
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  };

  const handleDeleteSession = async (e, targetId) => {
    e.stopPropagation();
    try {
      localStorage.removeItem(`chat_history_${targetId}`);
    } catch (err) {}

    // Remove from frontend state immediately
    setSessions((prev) => prev.filter((s) => s.id !== targetId));

    // If the deleted session was currently open, reset to new chat
    if (targetId === sessionId) {
      handleNewSession();
    }

    // Delete from SQLite database
    try {
      await fetch(`${API_BASE}/sessions/${targetId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete session on server:', err);
    }
  };

  const handleClearAllSessions = async () => {
    if (!window.confirm('Delete all past chat history?')) return;
    const allIds = sessions.map((s) => s.id);
    for (const id of allIds) {
      try {
        localStorage.removeItem(`chat_history_${id}`);
      } catch (e) {}
    }
    setSessions([]);
    handleNewSession();

    for (const id of allIds) {
      fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  };

  const handleSend = async (e, directText = null, overrideSim = null) => {
    if (e) e.preventDefault();
    const textToSend = directText !== null ? directText : inputMessage;
    if ((!textToSend.trim() && !attachedFile) || isLoading) return;

    const currentFile = attachedFile;
    const finalMessageText = textToSend.trim() || (currentFile ? `Please analyze this attached file: ${currentFile.name}` : '');

    const userMessage = { role: 'user', content: finalMessageText, file: currentFile };
    setMessages((prev) => [...prev, userMessage]);
    if (directText === null) {
      setInputMessage('');
      setAttachedFile(null);
    }
    setIsLoading(true);

    // Keep active session at the top of the sidebar list
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      const title = finalMessageText.slice(0, 32);
      return [
        { id: sessionId, title: title + (finalMessageText.length > 32 ? '...' : ''), timestamp: Date.now() },
        ...remaining.slice(0, 30),
      ];
    });

    const headers = { 'Content-Type': 'application/json' };
    const simToUse = overrideSim !== null ? overrideSim : simulationHeader;
    if (simToUse && simToUse.trim()) {
      headers['X-Simulate-Failure'] = simToUse.trim();
    }

    const payload = {
      session_id: sessionId,
      message: finalMessageText,
      system_prompt: systemPrompt.trim() ? systemPrompt : undefined,
      file: currentFile
        ? {
            name: currentFile.name,
            type: currentFile.type,
            data: currentFile.data,
            size: currentFile.size,
          }
        : undefined,
    };

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errDetail = `Error ${res.status}: ${res.statusText}`;
        try {
          const errData = await res.json();
          if (errData.detail) {
            errDetail = typeof errData.detail === 'string' ? errData.detail : JSON.stringify(errData.detail);
          }
        } catch {
          // fallback to statusText
        }
        setMessages((prev) => [
          ...prev,
          {
            role: 'error',
            content: errDetail,
            statusCode: res.status,
          },
        ]);
        return;
      }

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.reply,
          metadata: data.metadata,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'error',
          content: `Network connection failed: ${err.message}`,
          statusCode: 500,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const toggleDetails = (idx) => {
    setExpandedDetails((prev) => ({
      ...prev,
      [idx]: !prev[idx],
    }));
  };

  return (
    <div className="chatgpt-layout">
      {/* Collapsible Left Sidebar */}
      <aside className={`chatgpt-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-top">
          <button
            className="new-chat-btn"
            onClick={handleNewSession}
            title="Start a new chat"
          >
            <span className="icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </span>
            <span>New chat</span>
          </button>

          <button
            className="sidebar-toggle-btn"
            onClick={() => setSidebarOpen(false)}
            title="Close sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>

        {/* Sessions / Chat History List */}
        <div className="sidebar-history">
          <div className="history-header">
            <span className="history-label">Recent Chats</span>
            {sessions.length > 0 && (
              <button
                type="button"
                className="clear-all-link"
                onClick={handleClearAllSessions}
                title="Clear all past chats"
              >
                Clear all
              </button>
            )}
          </div>

          {sessions.length === 0 ? (
            <div className="empty-history-note">No saved chats yet</div>
          ) : (
            sessions.map((sess) => (
              <div
                key={sess.id}
                className={`history-item ${sess.id === sessionId ? 'active' : ''}`}
                onClick={() => handleSwitchSession(sess.id)}
                title={`Open chat: ${sess.title}`}
              >
                <span className="chat-bubble-icon">💬</span>
                <span className="chat-title">{sess.title}</span>
                <button
                  type="button"
                  className="delete-session-btn"
                  onClick={(e) => handleDeleteSession(e, sess.id)}
                  title="Delete this chat"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <div
            className="sidebar-user-pill"
            onClick={() => setShowDevModal(true)}
            title="Configure Failover Simulator and System Prompt"
          >
            <div className="user-avatar">⚙️</div>
            <div className="user-info">
              <span className="user-name">Developer Settings</span>
              <span className="user-sub">Failover Hook & Keys</span>
            </div>
          </div>

          {healthInfo && (
            <div className="health-pill" title="Live backend status">
              <span className="health-dot" />
              <span>{healthInfo.keys_configured} Keys Active</span>
            </div>
          )}
        </div>
      </aside>

      {/* Main Chat Canvas */}
      <div className="chatgpt-main">
        {/* Top Navigation Bar */}
        <header className="chatgpt-header">
          <div className="header-left">
            {!sidebarOpen && (
              <button
                className="header-btn"
                onClick={() => setSidebarOpen(true)}
                title="Open sidebar"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
            )}

            <div
              className="model-selector"
              onClick={() => setShowDevModal(true)}
              title="Click to view Gateway & Failover status"
            >
              <span className="model-name">Aurora AI</span>
              <span className="model-badge">Groq LPU</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          <div className="header-right">
            <button
              className={`header-pill-btn ${showGlobalMetrics ? 'active' : ''}`}
              onClick={() => setShowGlobalMetrics(!showGlobalMetrics)}
              title="Show resolution source (LIVE/CACHE), latency, and tokens"
            >
              {showGlobalMetrics ? '📊 Hide Metrics' : '📊 Show Metrics'}
            </button>

            <button
              className="header-pill-btn"
              onClick={() => setShowDevModal(true)}
              title="Open Failover & System Config"
            >
              🛠️ Failover Hook
            </button>

            <button
              className="header-btn"
              onClick={handleNewSession}
              title="New Chat"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Message Feed Area */}
        <div className="chat-feed-scroll">
          <div className="chat-feed-container">
            {messages.length === 0 ? (
              <div className="chatgpt-hero">
                <div className="hero-spark">
                  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="1.5">
                    <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" />
                  </svg>
                </div>
                <h2>What can I help with today?</h2>

                <div className="prompt-grid">
                  <div
                    className="prompt-card"
                    onClick={() => handleSend(null, 'Draw a clear Mermaid flowchart diagram showing how an LLM Gateway with automated key failover and response caching works.')}
                  >
                    <span className="prompt-title">📊 Visual Diagram: LLM Gateway</span>
                    <span className="prompt-sub">Render interactive Mermaid flowchart</span>
                  </div>

                  <div
                    className="prompt-card"
                    onClick={() => handleSend(null, 'Show a breathtaking image of the Aurora Borealis glowing in the northern sky and explain the science behind it.')}
                  >
                    <span className="prompt-title">🎨 Image: Aurora Borealis</span>
                    <span className="prompt-sub">Generate visual depiction + article</span>
                  </div>

                  <div
                    className="prompt-card"
                    onClick={() => handleSend(null, 'What is machine learning in one sentence?')}
                  >
                    <span className="prompt-title">⚡ Test 1ms Cache Hit</span>
                    <span className="prompt-sub">Instant response with 0 token cost</span>
                  </div>

                  <div
                    className="prompt-card"
                    onClick={() => {
                      setSimulationHeader('key_1=429');
                      handleSend(null, 'Explain binary search with a clean Java code implementation.', 'key_1=429');
                    }}
                  >
                    <span className="prompt-title">🛡️ Key Failover (429) + Java Code</span>
                    <span className="prompt-sub">Fallback smoothly to key_2</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="messages-list">
                {messages.map((msg, idx) => {
                  if (msg.role === 'user') {
                    return (
                      <div key={idx} className="msg-row user">
                        <div className="user-bubble">
                          {msg.file && (
                            <div className="user-attachment-preview">
                              {msg.file.isImage ? (
                                <img src={msg.file.data} alt={msg.file.name} className="user-bubble-image" />
                              ) : (
                                <div className="user-bubble-file">
                                  <span className="file-badge-icon">📄</span>
                                  <span className="file-badge-name">{msg.file.name}</span>
                                </div>
                              )}
                            </div>
                          )}
                          <div className="user-bubble-text">{msg.content}</div>
                        </div>
                      </div>
                    );
                  }

                  if (msg.role === 'error') {
                    return (
                      <div key={idx} className="msg-row error">
                        <div className="error-bubble">
                          <span className="error-icon">⚠️</span>
                          <span className="error-text">{msg.content}</span>
                        </div>
                      </div>
                    );
                  }

                  // Assistant message
                  const isDetailsOpen = showGlobalMetrics || expandedDetails[idx];

                  return (
                    <div key={idx} className="msg-row assistant">
                      <div className="assistant-avatar">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <circle cx="12" cy="12" r="4" />
                          <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
                          <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
                          <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
                          <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
                        </svg>
                      </div>

                      <div className="assistant-content" data-testid="assistant-message">
                        {/* Rich Markdown with Mermaid & Image Support */}
                        <MarkdownContent content={msg.content} />

                        {/* Subtle ChatGPT Action Bar */}
                        <div className="msg-actions">
                          <button
                            className="action-btn"
                            onClick={() => copyToClipboard(msg.content, idx)}
                            title="Copy response"
                          >
                            {copiedIndex === idx ? '✓ Copied' : (
                              <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                                <span>Copy</span>
                              </>
                            )}
                          </button>

                          {msg.metadata && (
                            <button
                              className={`action-btn ${isDetailsOpen ? 'active' : ''}`}
                              onClick={() => toggleDetails(idx)}
                              title="Toggle metadata details"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="16" x2="12" y2="12" />
                                <line x1="12" y1="8" x2="12.01" y2="8" />
                              </svg>
                              <span>{isDetailsOpen ? 'Hide Info' : 'Info'}</span>
                            </button>
                          )}
                        </div>

                        {/* Telemetry Ribbon (Evaluator testids strictly preserved) */}
                        {msg.metadata && (
                          <div className={`telemetry-ribbon ${!isDetailsOpen ? 'telemetry-hidden' : ''}`}>
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
                            <span className="telemetry-pill">
                              🤖 <span data-testid="meta-model">{msg.metadata.model}</span>
                            </span>

                            {/* Latency */}
                            <span className="telemetry-pill">
                              ⏱️ <span data-testid="meta-latency">{msg.metadata.latency_ms} ms</span>
                            </span>

                            {/* Input Tokens */}
                            <span className="telemetry-pill">
                              in: <strong data-testid="meta-input-tokens">{msg.metadata.input_tokens}</strong>
                            </span>

                            {/* Output Tokens */}
                            <span className="telemetry-pill">
                              out: <strong data-testid="meta-output-tokens">{msg.metadata.output_tokens}</strong>
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
                    <div className="assistant-avatar">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <circle cx="12" cy="12" r="4" />
                      </svg>
                    </div>
                    <div className="assistant-content">
                      <div className="typing-indicator">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* ChatGPT Bottom Dock */}
        <div className="chatgpt-input-wrapper">
          {(isRecording || isTranscribing) && (
            <div className="voice-recording-pill">
              <span className="recording-dot" />
              <span className="recording-status">
                {isTranscribing ? (
                  'Transcribing audio with Whisper...'
                ) : inputMessage ? (
                  <>Transcribed: <strong>"{inputMessage}"</strong></>
                ) : (
                  'Listening to your voice... Speak now'
                )}
              </span>
              {!isTranscribing && (
                <>
                  <button
                    type="button"
                    onClick={() => stopVoiceRecording(true)}
                    className="search-mic-btn"
                    title="Stop and search immediately"
                  >
                    🔍 Search
                  </button>
                  <button
                    type="button"
                    onClick={() => stopVoiceRecording(false)}
                    className="stop-mic-btn"
                    title="Stop recording and review"
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          )}

          {attachedFile && (
            <div className="attachment-chip">
              {attachedFile.isImage ? (
                <img src={attachedFile.data} alt={attachedFile.name} className="chip-thumbnail" />
              ) : (
                <span className="chip-icon">📄</span>
              )}
              <div className="chip-info">
                <span className="chip-name">{attachedFile.name}</span>
                <span className="chip-size">({(attachedFile.size / 1024).toFixed(1)} KB)</span>
              </div>
              <button
                type="button"
                className="chip-remove-btn"
                onClick={() => setAttachedFile(null)}
                title="Remove attachment"
              >
                ✕
              </button>
            </div>
          )}

          <form className={`chatgpt-input-box ${isRecording ? 'recording' : ''}`} onSubmit={handleSend}>
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach photos, images, or files to search/analyze"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="image/*,.pdf,.txt,.py,.js,.java,.cpp,.csv,.json,.md,.html,.css"
              onChange={handleFileChange}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? "🎙️ Recording... Speak freely (click Stop or Search when done)" : "Message Aurora AI... (Type, attach files, or speak)"}
              data-testid="chat-input"
              disabled={isLoading}
            />

            {/* Voice Microphone Recording Button */}
            <button
              type="button"
              className={`mic-btn ${isRecording ? 'recording' : ''}`}
              onClick={toggleRecording}
              title={isRecording ? 'Stop voice recording' : 'Record voice to search (Microphone)'}
            >
              {isRecording ? (
                <span className="mic-stop-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </span>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>

            <button
              type="submit"
              className={`send-circle-btn ${(inputMessage.trim() || attachedFile) && !isLoading ? 'ready' : ''}`}
              data-testid="send-button"
              disabled={(!inputMessage.trim() && !attachedFile) || isLoading}
              title="Send message"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </form>

          <div className="input-disclaimer">
            Aurora AI can make mistakes. Verify important information.
          </div>
        </div>
      </div>

      {/* Developer & Failover Simulator Modal */}
      {showDevModal && (
        <div className="modal-backdrop" onClick={() => setShowDevModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🛠️ Developer Playground & Failover</h3>
              <button className="modal-close-btn" onClick={() => setShowDevModal(false)}>
                ✕
              </button>
            </div>

            <div className="modal-body">
              {/* System Prompt (Contract: data-testid="system-prompt-input") */}
              <div className="modal-section">
                <label className="section-label">System Persona Prompt</label>
                <input
                  type="text"
                  className="modal-input"
                  data-testid="system-prompt-input"
                  placeholder="e.g. You are a helpful AI assistant. Answer concisely."
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                />
                <div className="modal-pills">
                  <button
                    type="button"
                    className="modal-pill"
                    onClick={() => setSystemPrompt('You are an expert AI software architect. Be precise and concise.')}
                  >
                    Expert Architect
                  </button>
                  <button
                    type="button"
                    className="modal-pill"
                    onClick={() => setSystemPrompt('Answer every question like a witty 17th century pirate.')}
                  >
                    Pirate Mode
                  </button>
                  <button
                    type="button"
                    className="modal-pill"
                    onClick={() => setSystemPrompt('')}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Failover Hook (X-Simulate-Failure) */}
              <div className="modal-section">
                <label className="section-label">Failover Hook Header (X-Simulate-Failure)</label>
                <div className="modal-pills">
                  <button
                    type="button"
                    className={`modal-pill ${simulationHeader === '' ? 'active' : ''}`}
                    onClick={() => setSimulationHeader('')}
                  >
                    ● Normal Execution
                  </button>
                  <button
                    type="button"
                    className={`modal-pill ${simulationHeader === 'key_1=429' ? 'active' : ''}`}
                    onClick={() => setSimulationHeader('key_1=429')}
                  >
                    ⚡ Key 1 Rate Limit (429)
                  </button>
                  <button
                    type="button"
                    className={`modal-pill ${simulationHeader === 'key_1=500' ? 'active' : ''}`}
                    onClick={() => setSimulationHeader('key_1=500')}
                  >
                    ⚠️ Key 1 Server Error (500)
                  </button>
                  <button
                    type="button"
                    className={`modal-pill ${simulationHeader === '*=429' ? 'active' : ''}`}
                    onClick={() => setSimulationHeader('*=429')}
                  >
                    🛑 All Keys Down (*=429)
                  </button>
                </div>

                <input
                  type="text"
                  className="modal-input"
                  placeholder="Custom X-Simulate-Failure (e.g. key_1=429,key_2=500)"
                  value={simulationHeader}
                  onChange={(e) => setSimulationHeader(e.target.value)}
                  style={{ marginTop: '0.5rem' }}
                />
              </div>

              {/* Telemetry Toggle */}
              <div className="modal-section">
                <label className="section-label">Telemetry Badges</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <button
                    type="button"
                    className={`modal-pill ${showGlobalMetrics ? 'active' : ''}`}
                    onClick={() => setShowGlobalMetrics(!showGlobalMetrics)}
                  >
                    {showGlobalMetrics ? '✓ Enabled on all messages' : '✕ Hidden by default'}
                  </button>
                  <span style={{ fontSize: '0.78rem', color: '#8e8e8e' }}>
                    Turn ON during video recording to show LIVE_INFERENCE, LLM_CACHE, and key_2 fallback.
                  </span>
                </div>
              </div>

              {/* Session ID */}
              <div className="modal-section">
                <label className="section-label">Active Session ID</label>
                <div className="session-display">
                  <code>{sessionId}</code>
                  <button
                    type="button"
                    className="modal-pill"
                    onClick={() => {
                      navigator.clipboard.writeText(sessionId);
                      setCopiedSession(true);
                      setTimeout(() => setCopiedSession(false), 2000);
                    }}
                  >
                    {copiedSession ? '✓ Copied' : 'Copy ID'}
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="modal-done-btn" onClick={() => setShowDevModal(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
