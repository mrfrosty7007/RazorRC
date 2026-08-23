import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/data';

export interface CopilotStatus { configured: boolean; model: string; }
export interface CopilotQuestion { prompt: string; jobIds: string[]; }
export interface CopilotStreamEvent { requestId: string; kind: 'delta' | 'complete'; text: string | null; message: string | null; }

/** The credential stays behind Tauri IPC; this module never reads `.env`. */
export async function getCopilotStatus(): Promise<CopilotStatus> {
  if (!isTauri()) return { configured: false, model: 'Gemini 2.5 Flash' };
  return invoke<CopilotStatus>('get_copilot_status');
}

/** Subscribe before invoking so early Gemini tokens cannot be lost. */
export async function streamCopilotAnswer(question: CopilotQuestion, onEvent: (event: CopilotStreamEvent) => void): Promise<void> {
  const requestId = crypto.randomUUID();
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<CopilotStreamEvent>('copilot:stream', (event) => {
      if (event.payload.requestId === requestId) onEvent(event.payload);
    });
    await invoke<void>('stream_copilot_answer', { requestId, prompt: question.prompt, jobIds: question.jobIds });
  } finally { unlisten?.(); }
}
