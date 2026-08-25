-- ReviveAI recovery store, migration 0003.
--
-- Support multiple chat sessions for Copilot with automatic migration of existing messages.

CREATE TABLE IF NOT EXISTS chat_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- If existing messages exist, create an "Imported Conversation" session
INSERT INTO chat_sessions (id, title, created_at, updated_at)
SELECT 1, 'Imported Conversation',
       COALESCE((SELECT MIN(created_at) FROM chat_messages), CAST(strftime('%s', 'now') AS INTEGER) * 1000),
       COALESCE((SELECT MAX(created_at) FROM chat_messages), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE (SELECT COUNT(*) FROM chat_messages) > 0;

-- Create the v2 table with session_id foreign key
CREATE TABLE IF NOT EXISTS chat_messages_v2 (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

-- Migrate existing messages into session 1
INSERT INTO chat_messages_v2 (id, session_id, role, content, created_at)
SELECT id, 1, role, content, created_at FROM chat_messages;

-- Swap the tables
DROP TABLE chat_messages;
ALTER TABLE chat_messages_v2 RENAME TO chat_messages;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
ON chat_messages(session_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
ON chat_sessions(updated_at DESC, id DESC);
