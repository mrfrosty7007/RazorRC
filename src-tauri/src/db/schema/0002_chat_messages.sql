-- RazorRC recovery store, migration 0002.
--
-- Persistent conversation history for the AI Copilot.

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at ASC, id ASC);
