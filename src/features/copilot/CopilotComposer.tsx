import {
  Check,
  Edit2,
  KeyRound,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Send,
  Sparkles,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  clearChatSession,
  createChatSession,
  deleteChatSession,
  getCopilotStatus,
  listChatSessions,
  loadChatMessages,
  renameChatSession,
  saveChatMessage,
  streamCopilotAnswer,
  type ChatSession,
  type CopilotStatus,
} from '@/data/copilot';
import { cn } from '@/lib/cn';
import { Badge, Button, Callout, Panel, PanelBody, PanelHeader } from '@/components/ui';

interface CopilotComposerProps {
  scopedJobIds: string[];
  className?: string;
}

interface DisplayMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

const INITIAL_STATUS: CopilotStatus = { configured: false, model: 'Gemini 3.6 Flash' };
const LAST_SESSION_KEY = 'reviveai_active_chat_session_id';

const STARTER_PROMPTS = [
  'Which failure reason lost us the most money this week?',
  'Recommend playbook rules for high-value UPI failures',
  'What percentage of recovered payments came from auto-retry?',
];

/** Persistent, streamed, advisory conversation powered by Gemini and SQLite with ChatGPT-style sessions. */
export function CopilotComposer({ scopedJobIds, className }: CopilotComposerProps) {
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Focus rename input when entering edit mode
  useEffect(() => {
    if (editingSessionId !== null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingSessionId]);

  // Load status and chat sessions on mount
  useEffect(() => {
    let active = true;
    void getCopilotStatus()
      .then((next) => active && setStatus(next))
      .catch(() => {
        if (active) {
          setStatus(INITIAL_STATUS);
          setStatusError('Could not check the Gemini configuration. Restart ReviveAI and try again.');
        }
      });

    void listChatSessions()
      .then(async (loadedSessions) => {
        if (!active) return;
        if (loadedSessions.length > 0) {
          setSessions(loadedSessions);

          // Restore last opened conversation if available
          const savedId = localStorage.getItem(LAST_SESSION_KEY);
          const numericId = savedId ? parseInt(savedId, 10) : null;
          const targetSession =
            (numericId ? loadedSessions.find((s) => s.id === numericId) : undefined) ??
            loadedSessions[0];

          if (targetSession) {
            setActiveSessionId(targetSession.id);
            localStorage.setItem(LAST_SESSION_KEY, String(targetSession.id));
          }
        } else {
          // Create initial default session
          try {
            const initialSession = await createChatSession('New Chat');
            if (active) {
              setSessions([initialSession]);
              setActiveSessionId(initialSession.id);
              localStorage.setItem(LAST_SESSION_KEY, String(initialSession.id));
            }
          } catch (err) {
            console.error('Failed to create initial chat session:', err);
          }
        }
      })
      .catch((err) => {
        console.error('Failed to load chat sessions:', err);
      });

    return () => {
      active = false;
    };
  }, []);

  // Load messages when activeSessionId changes
  useEffect(() => {
    if (activeSessionId === null) {
      setMessages([]);
      return;
    }

    let active = true;
    setLoadingMessages(true);
    setError(null);

    void loadChatMessages(activeSessionId)
      .then((loaded) => {
        if (active) {
          setMessages(
            loaded.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              streaming: false,
            })),
          );
        }
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to load session messages:', err);
          setError('Could not load messages for this conversation.');
        }
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });

    return () => {
      active = false;
    };
  }, [activeSessionId]);

  // Scroll to bottom when messages update
  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const ready = status?.configured === true;

  const handleSelectSession = useCallback((sessionId: number) => {
    setActiveSessionId(sessionId);
    localStorage.setItem(LAST_SESSION_KEY, String(sessionId));
    setEditingSessionId(null);
    setError(null);
  }, []);

  const handleNewChat = async () => {
    try {
      const newSession = await createChatSession('New Chat');
      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(newSession.id);
      localStorage.setItem(LAST_SESSION_KEY, String(newSession.id));
      setMessages([]);
      setError(null);
      setEditingSessionId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create new chat.');
    }
  };

  const handleStartRename = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
  };

  const handleSaveRename = async (sessionId: number, e?: React.MouseEvent | React.FormEvent) => {
    if (e) e.stopPropagation();
    const clean = editingTitle.trim();
    if (!clean) {
      setEditingSessionId(null);
      return;
    }

    try {
      const updated = await renameChatSession(sessionId, clean);
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? updated : s)));
      setEditingSessionId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename chat session.');
    }
  };

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(null);
  };

  const handleDeleteSession = async (sessionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = window.confirm('Delete this conversation? This cannot be undone.');
    if (!confirmed) return;

    try {
      await deleteChatSession(sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);

      if (activeSessionId === sessionId) {
        if (remaining.length > 0 && remaining[0]) {
          const nextActive = remaining[0];
          setActiveSessionId(nextActive.id);
          localStorage.setItem(LAST_SESSION_KEY, String(nextActive.id));
        } else {
          // If no sessions left, create a fresh one
          const fresh = await createChatSession('New Chat');
          setSessions([fresh]);
          setActiveSessionId(fresh.id);
          localStorage.setItem(LAST_SESSION_KEY, String(fresh.id));
          setMessages([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete conversation.');
    }
  };

  const handleClearCurrentSession = async () => {
    if (!activeSessionId || messages.length === 0) return;
    const confirmed = window.confirm('Clear all messages in this conversation?');
    if (!confirmed) return;

    try {
      await clearChatSession(activeSessionId);
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear conversation.');
    }
  };

  async function submitPrompt(customPrompt?: string) {
    const question = (customPrompt ?? prompt).trim();
    if (!question || !ready || asking) return;

    let targetSessionId = activeSessionId;

    // If no active session, create one first
    if (!targetSessionId) {
      try {
        const fresh = await createChatSession('New Chat');
        setSessions((prev) => [fresh, ...prev]);
        targetSessionId = fresh.id;
        setActiveSessionId(fresh.id);
        localStorage.setItem(LAST_SESSION_KEY, String(fresh.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not initialize chat session.');
        return;
      }
    }

    setAsking(true);
    setError(null);
    if (!customPrompt) setPrompt('');

    // Auto-rename session if it's currently named "New Chat" and this is the first message
    const currentSession = sessions.find((s) => s.id === targetSessionId);
    if (currentSession && (currentSession.title === 'New Chat' || messages.length === 0)) {
      const autoTitle =
        question.length > 30 ? `${question.slice(0, 30).trim()}…` : question;
      void renameChatSession(targetSessionId, autoTitle)
        .then((renamed) => {
          setSessions((prev) => prev.map((s) => (s.id === targetSessionId ? renamed : s)));
        })
        .catch(() => {
          // non-fatal auto-rename
        });
    }

    const userMsg: DisplayMessage = { role: 'user', content: question, streaming: false };
    const placeholderAssistant: DisplayMessage = { role: 'assistant', content: '', streaming: true };

    setMessages((prev) => [...prev, userMsg, placeholderAssistant]);

    // Save user message immediately to database
    void saveChatMessage(targetSessionId, 'user', question).catch((err) => {
      console.error('Failed to persist user message:', err);
    });

    let accumulatedText = '';
    try {
      await streamCopilotAnswer({ prompt: question, jobIds: scopedJobIds }, (event) => {
        if (event.kind !== 'delta' || !event.text) return;
        accumulatedText += event.text;
        setMessages((prev) => {
          const lastIdx = prev.length - 1;
          if (lastIdx < 0 || prev[lastIdx]?.role !== 'assistant') return prev;
          return prev.map((msg, i) => (i === lastIdx ? { ...msg, content: accumulatedText } : msg));
        });
      });

      const finalText = accumulatedText || 'Gemini returned no response text. Please try again.';

      setMessages((prev) => {
        const lastIdx = prev.length - 1;
        if (lastIdx < 0 || prev[lastIdx]?.role !== 'assistant') return prev;
        return prev.map((msg, i) => (i === lastIdx ? { ...msg, content: finalText, streaming: false } : msg));
      });

      // Save complete assistant message ONLY after streaming finishes
      void saveChatMessage(targetSessionId, 'assistant', finalText).then(() => {
        // Update session's updatedAt locally so it moves to top of list if desired
        setSessions((prev) =>
          prev.map((s) => (s.id === targetSessionId ? { ...s, updatedAt: Date.now() } : s)),
        );
      }).catch((err) => {
        console.error('Failed to persist assistant message:', err);
      });
    } catch (cause: unknown) {
      // Remove incomplete placeholder on stream failure
      setMessages((prev) => prev.slice(0, -1));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  }

  return (
    <Panel className={cn('flex flex-col', className)}>
      <PanelHeader
        eyebrow="Gemini · advisory only"
        title="Ask about your recovery data"
        description="PII-redacted job summaries are analysed; recommendations always need your approval"
        actions={
          <div className="flex items-center gap-2">
            {ready ? (
              <Badge tone="mint" dot>
                {status?.model}
              </Badge>
            ) : (
              <Badge tone="amber" dot>
                Not connected
              </Badge>
            )}
          </div>
        }
      />
      <PanelBody className="flex flex-1 flex-col gap-3 p-0 sm:p-0">
        {status === null ? (
          <div className="px-5 pt-4">
            <p className="font-mono text-micro text-content-faint">Checking Gemini connection…</p>
          </div>
        ) : null}

        {!ready && status !== null ? (
          <div className="px-5 pt-4">
            <Callout tone="amber" title="Gemini is not configured">
              Add <code className="font-mono text-micro text-content">COPILOT_API_KEY</code> to the local{' '}
              <code className="font-mono text-micro text-content">.env</code> file, then restart ReviveAI. The
              rules-based recommendations and playbooks remain available without it.
            </Callout>
          </div>
        ) : null}

        {statusError ? (
          <div className="px-5 pt-4">
            <Callout tone="coral" title="Connection check failed">{statusError}</Callout>
          </div>
        ) : null}

        {/* ChatGPT-Style 2-Column Container */}
        <div className="flex flex-1 flex-col overflow-hidden border-t border-hairline md:flex-row min-h-[520px]">
          {/* Left Session Sidebar */}
          <div className="flex w-full shrink-0 flex-col border-b border-hairline bg-canvas/60 md:w-60 md:border-r md:border-b-0">
            {/* Sidebar Header: New Chat Button */}
            <div className="p-3 border-b border-hairline/60">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleNewChat()}
                icon={<Plus className="h-3.5 w-3.5 text-azure" />}
                className="w-full justify-start text-xs font-medium border-dashed hover:border-azure/60 hover:bg-azure-dim/30"
              >
                New Chat
              </Button>
            </div>

            {/* Sidebar Sessions List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1 max-h-[160px] md:max-h-[440px]">
              {sessions.length === 0 ? (
                <div className="p-4 text-center">
                  <p className="text-micro text-content-faint">No conversations yet.</p>
                </div>
              ) : (
                sessions.map((session) => {
                  const isActive = session.id === activeSessionId;
                  const isEditing = editingSessionId === session.id;

                  if (isEditing) {
                    return (
                      <div
                        key={session.id}
                        className="flex items-center gap-1.5 rounded-md border border-azure/40 bg-surface px-2 py-1.5 text-xs shadow-xs"
                      >
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveRename(session.id);
                            if (e.key === 'Escape') handleCancelRename(e as unknown as React.MouseEvent);
                          }}
                          className="w-full bg-transparent text-xs text-content outline-none"
                        />
                        <button
                          type="button"
                          onClick={(e) => void handleSaveRename(session.id, e)}
                          className="text-mint hover:text-mint/80 p-0.5"
                          title="Save title"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelRename}
                          className="text-content-faint hover:text-content p-0.5"
                          title="Cancel"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={session.id}
                      onClick={() => handleSelectSession(session.id)}
                      className={cn(
                        'group relative flex items-center justify-between rounded-md px-2.5 py-2 text-xs transition-colors cursor-pointer',
                        isActive
                          ? 'border border-azure/30 bg-azure-dim/60 font-medium text-azure-soft'
                          : 'border border-transparent text-content-muted hover:bg-surface hover:text-content',
                      )}
                    >
                      <div className="flex items-center gap-2 truncate pr-2">
                        <MessageSquare
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            isActive ? 'text-azure' : 'text-content-faint group-hover:text-content-muted',
                          )}
                        />
                        <span className="truncate text-left">{session.title}</span>
                      </div>

                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          onClick={(e) => handleStartRename(session, e)}
                          className="p-1 text-content-faint hover:text-content rounded hover:bg-raised"
                          title="Rename conversation"
                        >
                          <Edit2 className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => void handleDeleteSession(session.id, e)}
                          className="p-1 text-content-faint hover:text-coral rounded hover:bg-coral-dim/30"
                          title="Delete conversation"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Sidebar Footer */}
            <div className="border-t border-hairline/60 p-2.5 text-center">
              <span className="font-mono text-[0.625rem] text-content-faint">
                {sessions.length} {sessions.length === 1 ? 'conversation' : 'conversations'}
              </span>
            </div>
          </div>

          {/* Right Main Chat Pane */}
          <div className="flex flex-1 flex-col bg-surface overflow-hidden">
            {/* Conversation Sub-Header */}
            <div className="flex items-center justify-between border-b border-hairline/60 px-4 py-2 bg-surface/50">
              <div className="flex items-center gap-2 truncate">
                <span className="font-mono text-micro font-semibold uppercase tracking-wider text-content-faint">
                  Active Thread:
                </span>
                <span className="truncate text-xs font-medium text-content">
                  {activeSession?.title ?? 'Conversation'}
                </span>
              </div>
              {messages.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={asking}
                  onClick={() => void handleClearCurrentSession()}
                  icon={<Trash2 className="h-3 w-3 text-content-faint hover:text-coral" />}
                  className="text-micro h-7 px-2"
                >
                  Clear thread
                </Button>
              )}
            </div>

            {/* Messages Stream Container */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-h-[380px]" aria-live="polite">
              {loadingMessages ? (
                <div className="flex h-32 items-center justify-center">
                  <p className="font-mono text-xs text-content-faint animate-pulse">Loading conversation…</p>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-azure-dim/40 text-azure mb-3 border border-azure/20">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <h3 className="text-xs font-semibold text-content">Start a new Copilot discussion</h3>
                  <p className="mt-1 max-w-sm text-micro text-content-faint">
                    Ask questions about failed payments, retry strategies, and revenue recovery playbooks.
                  </p>

                  <div className="mt-4 flex flex-col gap-2 w-full max-w-md">
                    {STARTER_PROMPTS.map((promptText, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => void submitPrompt(promptText)}
                        disabled={!ready || asking}
                        className="rounded-panel border border-hairline bg-raised/50 p-2.5 text-left text-xs text-content-muted hover:border-azure/40 hover:bg-azure-dim/20 hover:text-content transition-all flex items-center justify-between group disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="truncate">{promptText}</span>
                        <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-content-faint group-hover:text-azure" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((message, index) => {
                  if (message.role === 'user') {
                    return (
                      <div key={message.id ?? `user-${index}`} className="flex justify-end">
                        <div className="max-w-[85%] rounded-panel border border-azure/30 bg-azure-dim/60 p-3 text-xs text-content shadow-xs">
                          <div className="mb-1 border-b border-azure/20 pb-1 font-mono text-[0.625rem] font-semibold text-azure-soft uppercase tracking-wider">
                            You
                          </div>
                          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={message.id ?? `assistant-${index}`} className="flex justify-start">
                      <div className="w-full rounded-panel border border-hairline bg-raised p-3.5 text-xs text-content-muted shadow-xs">
                        <div className="mb-2 flex items-center justify-between border-b border-hairline pb-1.5 font-mono text-[0.625rem] font-semibold text-violet-soft uppercase tracking-wider">
                          <span>Copilot · Advisory</span>
                          {message.streaming && (
                            <span className="flex items-center gap-1 font-mono text-micro text-azure-soft">
                              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-azure" />
                              streaming…
                            </span>
                          )}
                        </div>
                        {message.content ? (
                          <div className="space-y-2 leading-relaxed break-words">
                            <Markdown
                              components={{
                                h1: ({ children }) => (
                                  <h1 className="mt-3 mb-1.5 text-sm font-semibold text-content first:mt-0">{children}</h1>
                                ),
                                h2: ({ children }) => (
                                  <h2 className="mt-3 mb-1.5 text-xs font-semibold text-content first:mt-0">{children}</h2>
                                ),
                                h3: ({ children }) => (
                                  <h3 className="mt-2 mb-1 text-xs font-semibold text-content first:mt-0">{children}</h3>
                                ),
                                h4: ({ children }) => (
                                  <h4 className="mt-2 mb-1 text-xs font-semibold text-content first:mt-0">{children}</h4>
                                ),
                                p: ({ children }) => (
                                  <p className="mb-2 last:mb-0 leading-relaxed text-content-muted">{children}</p>
                                ),
                                ul: ({ children }) => (
                                  <ul className="mb-2 list-disc pl-4 space-y-1 last:mb-0 leading-relaxed text-content-muted">
                                    {children}
                                  </ul>
                                ),
                                ol: ({ children }) => (
                                  <ol className="mb-2 list-decimal pl-4 space-y-1 last:mb-0 leading-relaxed text-content-muted">
                                    {children}
                                  </ol>
                                ),
                                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                                strong: ({ children }) => (
                                  <strong className="font-semibold text-content">{children}</strong>
                                ),
                                em: ({ children }) => <em className="italic text-content">{children}</em>,
                                code: ({ children, className }) => (
                                  <code
                                    className={cn(
                                      'rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[0.6875rem] text-azure-soft',
                                      className,
                                    )}
                                  >
                                    {children}
                                  </code>
                                ),
                                pre: ({ children }) => (
                                  <pre className="my-2 overflow-x-auto rounded border border-hairline bg-surface p-2.5 font-mono text-[0.6875rem] text-content">
                                    {children}
                                  </pre>
                                ),
                                blockquote: ({ children }) => (
                                  <blockquote className="my-2 border-l-2 border-azure/40 pl-3 italic text-content-muted">
                                    {children}
                                  </blockquote>
                                ),
                              }}
                            >
                              {message.content}
                            </Markdown>
                          </div>
                        ) : (
                          <p className="italic text-content-faint">Thinking…</p>
                        )}
                        <p className="mt-2.5 border-t border-hairline/60 pt-2 font-mono text-micro text-content-faint">
                          {message.streaming
                            ? 'streaming…'
                            : 'Advisory only — recommendations require human approval'}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {error ? (
              <div className="px-4 pb-2">
                <Callout tone="coral" title="Could not complete request">{error}</Callout>
              </div>
            ) : null}

            {/* Input Composer */}
            <div className="border-t border-hairline bg-surface/80 p-3">
              <textarea
                id="copilot-prompt"
                rows={2}
                value={prompt}
                disabled={!ready || asking}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    void submitPrompt();
                  }
                }}
                placeholder={
                  ready
                    ? 'Ask about failure reasons, recovery rates, or strategies…'
                    : 'Available once Gemini is configured'
                }
                data-selectable
                className={cn(
                  'w-full resize-none rounded-panel border border-hairline bg-surface p-2.5',
                  'text-xs leading-relaxed text-content placeholder:text-content-faint',
                  'transition-colors duration-150 focus:border-azure/60 focus:outline-none',
                  'disabled:cursor-not-allowed disabled:bg-canvas disabled:text-content-faint',
                )}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="flex items-center gap-1.5 font-mono text-micro text-content-faint">
                  {ready ? (
                    <>PII redacted · scoped to {scopedJobIds.length} open jobs · ⌘↵ to send</>
                  ) : (
                    <>
                      <KeyRound aria-hidden className="h-3 w-3" /> credentials required
                    </>
                  )}
                </p>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!ready || prompt.trim().length === 0}
                  busy={asking}
                  onClick={() => void submitPrompt()}
                  icon={ready ? <Send className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
                >
                  Ask
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}
