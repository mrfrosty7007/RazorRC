import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/data';

export interface CopilotStatus {
  configured: boolean;
  model: string;
}

export interface CopilotQuestion {
  prompt: string;
  jobIds: string[];
}

export interface CopilotStreamEvent {
  requestId: string;
  kind: 'delta' | 'complete';
  text: string | null;
  message: string | null;
}

export interface ChatSession {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id?: number;
  sessionId?: number;
  session_id?: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
  created_at?: number;
}

/** The credential stays behind Tauri IPC; this module never reads `.env`. */
export async function getCopilotStatus(): Promise<CopilotStatus> {
  if (!isTauri()) return { configured: false, model: 'Gemini 3.6 Flash' };
  return invoke<CopilotStatus>('get_copilot_status');
}

/** Subscribe before invoking so early Gemini tokens cannot be lost. */
export async function streamCopilotAnswer(
  question: CopilotQuestion,
  onEvent: (event: CopilotStreamEvent) => void,
): Promise<void> {
  const requestId = crypto.randomUUID();
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<CopilotStreamEvent>('copilot:stream', (event) => {
      if (event.payload.requestId === requestId) onEvent(event.payload);
    });
    await invoke<void>('stream_copilot_answer', {
      requestId,
      prompt: question.prompt,
      jobIds: question.jobIds,
    });
  } finally {
    unlisten?.();
  }
}

// ---------------------------------------------------------------------------
// LocalStorage Fallbacks for Browser / Dev Mode
// ---------------------------------------------------------------------------

const SESSIONS_KEY = 'reviveai_chat_sessions';
const MESSAGES_KEY = 'reviveai_chat_messages';
const LEGACY_KEY = 'reviveai_chat_history';

function initMockStorage(): { sessions: ChatSession[]; messages: ChatMessage[] } {
  try {
    const rawSessions = localStorage.getItem(SESSIONS_KEY);
    const rawMessages = localStorage.getItem(MESSAGES_KEY);

    if (rawSessions && rawMessages) {
      return {
        sessions: JSON.parse(rawSessions) as ChatSession[],
        messages: JSON.parse(rawMessages) as ChatMessage[],
      };
    }

    // Migrate from legacy history if exists
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacyMsgs = JSON.parse(legacyRaw) as ChatMessage[];
      if (Array.isArray(legacyMsgs) && legacyMsgs.length > 0) {
        const firstTime = legacyMsgs[0]?.createdAt ?? Date.now();
        const lastTime = legacyMsgs[legacyMsgs.length - 1]?.createdAt ?? Date.now();
        const importedSession: ChatSession = {
          id: 1,
          title: 'Imported Conversation',
          createdAt: firstTime,
          updatedAt: lastTime,
        };
        const migratedMsgs: ChatMessage[] = legacyMsgs.map((m, idx) => ({
          id: m.id ?? idx + 1,
          sessionId: 1,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt ?? Date.now(),
        }));

        localStorage.setItem(SESSIONS_KEY, JSON.stringify([importedSession]));
        localStorage.setItem(MESSAGES_KEY, JSON.stringify(migratedMsgs));
        localStorage.removeItem(LEGACY_KEY);
        return { sessions: [importedSession], messages: migratedMsgs };
      }
    }

    return { sessions: [], messages: [] };
  } catch {
    return { sessions: [], messages: [] };
  }
}

function saveMockData(sessions: ChatSession[], messages: ChatMessage[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Chat Session and Message Operations
// ---------------------------------------------------------------------------

export async function listChatSessions(): Promise<ChatSession[]> {
  if (!isTauri()) {
    const { sessions } = initMockStorage();
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  }
  return invoke<ChatSession[]>('list_chat_sessions');
}

export async function createChatSession(title?: string): Promise<ChatSession> {
  if (!isTauri()) {
    const { sessions, messages } = initMockStorage();
    const now = Date.now();
    const newId = sessions.length > 0 ? Math.max(...sessions.map((s) => s.id)) + 1 : 1;
    const session: ChatSession = {
      id: newId,
      title: title?.trim() || 'New Chat',
      createdAt: now,
      updatedAt: now,
    };
    sessions.unshift(session);
    saveMockData(sessions, messages);
    return session;
  }
  return invoke<ChatSession>('create_chat_session', { title: title ?? null });
}

export async function renameChatSession(sessionId: number, title: string): Promise<ChatSession> {
  if (!isTauri()) {
    const { sessions, messages } = initMockStorage();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Chat session ${sessionId} not found`);
    session.title = title.trim();
    session.updatedAt = Date.now();
    saveMockData(sessions, messages);
    return session;
  }
  return invoke<ChatSession>('rename_chat_session', { sessionId, title });
}

export async function deleteChatSession(sessionId: number): Promise<void> {
  if (!isTauri()) {
    const { sessions, messages } = initMockStorage();
    const remainingSessions = sessions.filter((s) => s.id !== sessionId);
    const remainingMessages = messages.filter((m) => (m.sessionId ?? m.session_id) !== sessionId);
    saveMockData(remainingSessions, remainingMessages);
    return;
  }
  return invoke<void>('delete_chat_session', { sessionId });
}

export async function loadChatMessages(sessionId: number): Promise<ChatMessage[]> {
  if (!isTauri()) {
    const { messages } = initMockStorage();
    return messages
      .filter((m) => (m.sessionId ?? m.session_id) === sessionId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  return invoke<ChatMessage[]>('load_chat_messages', { sessionId });
}

export async function saveChatMessage(
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
): Promise<ChatMessage> {
  if (!isTauri()) {
    const { sessions, messages } = initMockStorage();
    const session = sessions.find((s) => s.id === sessionId);
    const now = Date.now();
    if (session) {
      session.updatedAt = now;
    }
    const message: ChatMessage = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      sessionId,
      role,
      content,
      createdAt: now,
    };
    messages.push(message);
    saveMockData(sessions, messages);
    return message;
  }
  return invoke<ChatMessage>('save_chat_message', { sessionId, role, content });
}

export async function clearChatSession(sessionId: number): Promise<void> {
  if (!isTauri()) {
    const { sessions, messages } = initMockStorage();
    const remainingMessages = messages.filter((m) => (m.sessionId ?? m.session_id) !== sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
    }
    saveMockData(sessions, remainingMessages);
    return;
  }
  return invoke<void>('clear_chat_session', { sessionId });
}

