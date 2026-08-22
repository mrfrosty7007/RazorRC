import type { DataSource } from './repositories';
import { seedAdapter } from './adapters/seedAdapter';
import { tauriAdapter } from './adapters/tauriAdapter';

export type { DataSource, AuditQuery, PageRequest } from './repositories';

/**
 * True when running inside the Tauri webview rather than a browser tab.
 * Tauri v2 injects `__TAURI_INTERNALS__` before any app code runs.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The single place the adapter is chosen. Swapping the Rust engine in is this
 * decision and nothing else -- no screen imports an adapter directly.
 *
 * Set `VITE_FORCE_SEED=1` to keep the seed data while running the desktop
 * shell, which is useful for UI work before the engine is ready.
 */
function resolveDataSource(): DataSource {
  if (import.meta.env['VITE_FORCE_SEED'] === '1') return seedAdapter;
  return isTauri() ? tauriAdapter : seedAdapter;
}

export const data: DataSource = resolveDataSource();
