import { useCallback, useEffect, useRef, useState } from 'react';
import './chat.css';

const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.pdf,.txt,.md,.markdown,.rtf,.csv,.json,.doc,.docx,.ppt,.pptx,.xls,.xlsx';
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

const readEvents = async (body, onEvent) => {
  if (!body) throw new Error('The chat response did not include a stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  const consume = (block) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (value) onEvent(JSON.parse(value));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const blocks = buffered.split(/\r?\n\r?\n/);
    buffered = blocks.pop() || '';
    for (const block of blocks) consume(block);
  }
  buffered += decoder.decode();
  if (buffered.trim()) consume(buffered);
};

const ChatGlyph = ({ name, size = 18 }) => {
  const paths = {
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4zM22 2 11 13" /></>,
    stop: <><rect x="6" y="6" width="12" height="12" rx="2" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    x: <><path d="M6 6l12 12M18 6 6 18" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    bot: <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></>,
    chevron: <><path d="m8 10 4 4 4-4" /></>,
    file: <><path d="M6 2h8l4 4v16H6zM14 2v5h5" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const MessageContent = ({ content }) => {
  const parts = content.split(/```/);
  return <div className="chat-message-content">{parts.map((part, index) => index % 2
    ? <pre key={index}><code>{part.replace(/^[^\n]*\n/, '')}</code></pre>
    : <p key={index}>{part}</p>)}</div>;
};

const formatSessionTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatBytes = (value) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export default function ChatSession() {
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(() => {
    try { return window.localStorage.getItem('moa-chat-agent') || ''; } catch { return ''; }
  });
  const [message, setMessage] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState('');
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const streamControllerRef = useRef(null);
  const conversationRef = useRef(null);
  const attachmentInputRef = useRef(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/chat', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unable to load chat sessions.');
    setSessions(payload.sessions || []);
    setAgents(payload.agents || []);
    setAvailable(Boolean(payload.available));
    setError(payload.error || '');
    setSelectedAgent((current) => {
      const next = (payload.agents || []).some(({ id }) => id === current) ? current : payload.agents?.[0]?.id || '';
      try {
        if (next) window.localStorage.setItem('moa-chat-agent', next);
      } catch { /* Agent preference persistence is optional. */ }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load chat sessions.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      streamControllerRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const element = conversationRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: streamingText ? 'auto' : 'smooth' });
  }, [session?.messages?.length, streamingText]);

  const selectSession = async (id) => {
    if (sending) return;
    setError('');
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || 'Unable to open the chat session.'); return; }
    setSession(payload);
    setSelectedAgent(payload.agent || selectedAgent);
    setStreamingText('');
    setSessionMenuOpen(false);
  };

  const newChat = () => {
    if (sending) return;
    setSession(null);
    setMessage('');
    setStreamingText('');
    setError('');
    setSessionMenuOpen(false);
    setAgentMenuOpen(false);
  };

  const deleteSession = async (item) => {
    if (sending && session?.id === item.id) return;
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || 'Unable to delete the chat session.'); return; }
    if (session?.id === item.id) setSession(null);
    await refresh();
  };

  const send = async () => {
    const content = message.trim();
    if ((!content && !attachments.length) || !selectedAgent || sending || uploadingAttachments) return;
    setError('');
    setStreamingText('');
    setSending(true);
    const controller = new AbortController();
    streamControllerRef.current = controller;
    let currentSessionId = session?.id || '';

    try {
      const response = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: session?.id,
          agent: selectedAgent,
          content,
          attachmentIds: attachments.map(({ id }) => id),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'Unable to send the chat message.');
      }
      let streamed = '';
      await readEvents(response.body, (event) => {
        if (event.type === 'session') {
          currentSessionId = event.session.id;
          setSession(event.session);
        }
        if (event.type === 'delta') {
          streamed += event.text;
          setStreamingText(streamed);
        }
        if (event.type === 'done' || event.type === 'stopped') {
          setSession(event.session);
          setStreamingText('');
        }
        if (event.type === 'error') throw new Error(event.error);
      });
      setMessage('');
      setAttachments([]);
      await refresh();
    } catch (sendError) {
      if (sendError?.name !== 'AbortError') {
        setError(sendError instanceof Error ? sendError.message : 'Unable to complete the chat response.');
      }
      if (currentSessionId) {
        fetch(`/api/chat/sessions/${encodeURIComponent(currentSessionId)}`, { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : null)
          .then((value) => { if (value) setSession(value); })
          .catch(() => {});
      }
    } finally {
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
      setSending(false);
      setStreamingText('');
    }
  };

  const stop = async () => {
    if (session?.id) {
      await fetch(`/api/chat/sessions/${encodeURIComponent(session.id)}/stop`, { method: 'POST' }).catch(() => {});
    }
    streamControllerRef.current?.abort();
  };

  const changeAgent = (value) => {
    setSelectedAgent(value);
    setAgentMenuOpen(false);
    try { window.localStorage.setItem('moa-chat-agent', value); } catch { /* Agent preference persistence is optional. */ }
  };

  const addAttachments = async (event) => {
    const selectedFiles = [...(event.target.files || [])];
    event.target.value = '';
    if (!selectedFiles.length) return;
    const remainingSlots = MAX_ATTACHMENT_COUNT - attachments.length;
    if (selectedFiles.length > remainingSlots) { setError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files per message.`); return; }
    const supported = /\.(png|jpe?g|gif|webp|heic|heif|pdf|txt|md|markdown|rtf|csv|json|docx?|pptx?|xlsx?)$/i;
    if (selectedFiles.some((file) => !supported.test(file.name))) { setError('Choose supported documents or images only.'); return; }
    if (selectedFiles.some((file) => file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES)) { setError('Each attachment must be between 1 byte and 20 MiB.'); return; }
    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
      + selectedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) { setError('Attachments cannot exceed 50 MiB in total.'); return; }
    setUploadingAttachments(true);
    setError('');
    const uploaded = [];
    try {
      for (const file of selectedFiles) {
        const response = await fetch('/api/attachments', {
          method: 'POST',
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-moa-file-name': encodeURIComponent(file.name),
          },
          body: file,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `Unable to attach ${file.name}.`);
        uploaded.push(payload.attachment);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to upload the selected attachment.');
    } finally {
      if (uploaded.length) setAttachments((current) => [...current, ...uploaded]);
      setUploadingAttachments(false);
    }
  };

  const removeAttachment = async (attachment) => {
    const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      setError((await response.json()).error || 'Unable to remove the attachment.');
      return;
    }
    setAttachments((current) => current.filter(({ id }) => id !== attachment.id));
  };

  const activeAgentLabel = agents.find(({ id }) => id === (session?.agent || selectedAgent))?.label
    || session?.agentLabel
    || 'MoA agent';

  return (
    <section className="chat-page" aria-label="Chat">
      <div className="chat-workspace">
        <main className={`chat-conversation ${session ? '' : 'empty'}`} ref={conversationRef} aria-live="polite">
          {!session ? (
            <div className="chat-empty-state"><ChatGlyph name="bot" size={30} /><h2>Start a local conversation</h2><p>Choose one of your existing MoA agents, then send a message. Chat history stays private on this Mac.</p></div>
          ) : (
            <div className="chat-message-list">
              {session.messages.map((item) => (
                <article className={`chat-message ${item.role}`} key={item.id}>
                  <div className="chat-message-identity"><span><ChatGlyph name={item.role === 'user' ? 'user' : 'bot'} size={15} /></span>{item.role === 'user' ? 'You' : activeAgentLabel}</div>
                  <MessageContent content={item.content} />
                  {item.attachments?.length ? <div className="chat-message-attachments">{item.attachments.map((attachment) => <span key={`${item.id}-${attachment.name}`}><ChatGlyph name="file" size={12} />{attachment.name}</span>)}</div> : null}
                </article>
              ))}
              {streamingText ? <article className="chat-message assistant streaming"><div className="chat-message-identity"><span><ChatGlyph name="bot" size={15} /></span>{activeAgentLabel}</div><MessageContent content={streamingText} /><i aria-hidden="true" /></article> : null}
              {sending && !streamingText ? <div className="chat-thinking"><i />{activeAgentLabel} is thinking</div> : null}
            </div>
          )}
        </main>

        <div className="chat-composer-area">
          {sessionMenuOpen ? (
            <aside className="chat-session-popover" id="chat-session-menu" aria-label="Chat sessions">
              <div className="chat-session-popover-header">
                <strong>Sessions</strong>
                <button type="button" onClick={() => setSessionMenuOpen(false)} aria-label="Close chat sessions"><ChatGlyph name="x" size={14} /></button>
              </div>
              <button className="chat-new-button" type="button" onClick={newChat} disabled={sending}><ChatGlyph name="plus" />New chat</button>
              <div className="chat-session-list">
                {sessions.length ? sessions.map((item) => (
                  <div className={`chat-session-row ${session?.id === item.id ? 'selected' : ''}`} key={item.id}>
                    <button className="chat-session-select" type="button" onClick={() => selectSession(item.id)} disabled={sending}>
                      <strong>{item.title}</strong>
                      <small>{formatSessionTime(item.updatedAt)}</small>
                    </button>
                    <button className="chat-session-delete" type="button" onClick={() => deleteSession(item)} disabled={sending && session?.id === item.id} aria-label={`Delete chat: ${item.title}`} title="Delete chat"><ChatGlyph name="trash" size={14} /></button>
                  </div>
                )) : <p className="chat-session-empty">{loading ? 'Loading sessions…' : 'Your chats will appear here.'}</p>}
              </div>
            </aside>
          ) : null}
          {agentMenuOpen ? (
            <aside className="chat-agent-popover" id="chat-agent-menu" aria-label="Choose agent">
              <strong>Agent</strong>
              {agents.length ? agents.map((agent) => (
                <button type="button" key={agent.id} onClick={() => changeAgent(agent.id)} className={agent.id === selectedAgent ? 'selected' : ''}>
                  <span>{agent.mark || agent.label.slice(0, 1)}</span>
                  {agent.label}
                  {agent.id === selectedAgent ? <ChatGlyph name="check" size={14} /> : null}
                </button>
              )) : <p>No agents available</p>}
            </aside>
          ) : null}
          <div
            className={`chat-composer ${composerFocused ? 'focused' : ''}`}
            onFocus={() => setComposerFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                setComposerFocused(false);
                setAgentMenuOpen(false);
              }
            }}
          >
            {error ? <div className="chat-error" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(''); void refresh(); }}><ChatGlyph name="refresh" size={14} />Retry</button></div> : null}
            <div className="chat-input-area">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                maxLength={12_000}
                placeholder={session ? 'Continue this conversation…' : 'Message an MoA agent…'}
                aria-label="Chat message"
                disabled={!available || sending}
              />
              <input ref={attachmentInputRef} className="chat-attachment-input" type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={addAttachments} tabIndex={-1} aria-hidden="true" />
            </div>
            {attachments.length || uploadingAttachments ? <div className="chat-attachment-list" aria-live="polite">{attachments.map((attachment) => <span className="chat-attachment-chip" key={attachment.id}><ChatGlyph name="file" size={13} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span><button type="button" onClick={() => removeAttachment(attachment)} disabled={sending} aria-label={`Remove ${attachment.name}`}><ChatGlyph name="x" size={12} /></button></span>)}{uploadingAttachments ? <span className="chat-attachment-chip uploading"><span className="chat-attachment-spinner" /><span><strong>Uploading…</strong><small>Securing attachment</small></span></span> : null}</div> : null}
            <div className="chat-composer-toolbar">
              <button className="chat-add-attachment" type="button" onClick={() => attachmentInputRef.current?.click()} disabled={!available || sending || uploadingAttachments || attachments.length >= MAX_ATTACHMENT_COUNT} aria-label="Add documents and images" title="Add documents and images"><ChatGlyph name="plus" size={18} /></button>
              <button className="chat-agent-button" type="button" onClick={() => setAgentMenuOpen((open) => !open)} disabled={!available || sending || !agents.length} aria-label={`Agent: ${activeAgentLabel}`} aria-expanded={agentMenuOpen} aria-controls="chat-agent-menu">Agent<ChatGlyph name="chevron" size={14} /></button>
              <button className="chat-sessions-button" type="button" onClick={() => setSessionMenuOpen((open) => !open)} aria-label="Chat sessions" aria-expanded={sessionMenuOpen} aria-controls="chat-session-menu"><ChatGlyph name="history" size={16} /></button>
              {sending ? <button className="chat-stop" type="button" onClick={stop}><ChatGlyph name="stop" size={15} />Stop</button> : <button className="chat-send" type="button" onClick={send} disabled={!available || !selectedAgent || uploadingAttachments || (!message.trim() && !attachments.length)} aria-label="Send message"><ChatGlyph name="send" size={17} /></button>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
