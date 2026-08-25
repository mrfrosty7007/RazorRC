//! Copilot persistent chat sessions and messages.

use rusqlite::{params, Connection, Row, Transaction};

use crate::domain::{ChatMessage, ChatSession};
use crate::error::{EngineError, EngineResult};

const SELECT_SESSIONS: &str =
    "SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC, id DESC";

const SELECT_SESSION_BY_ID: &str =
    "SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ?1";

const SELECT_MESSAGES: &str =
    "SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC, id ASC";

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn list_sessions(connection: &Connection) -> EngineResult<Vec<ChatSession>> {
    let mut statement = connection.prepare(SELECT_SESSIONS)?;
    let mut rows = statement.query([])?;

    let mut sessions = Vec::new();
    while let Some(row) = rows.next()? {
        sessions.push(read_session(row)?);
    }
    Ok(sessions)
}

pub fn get_session(connection: &Connection, session_id: i64) -> EngineResult<Option<ChatSession>> {
    let mut statement = connection.prepare(SELECT_SESSION_BY_ID)?;
    let mut rows = statement.query([session_id])?;

    if let Some(row) = rows.next()? {
        Ok(Some(read_session(row)?))
    } else {
        Ok(None)
    }
}

pub fn create_session(transaction: &Transaction<'_>, title: &str) -> EngineResult<ChatSession> {
    let now = now_millis();
    let session_title = if title.trim().is_empty() {
        "New Chat"
    } else {
        title.trim()
    };

    transaction.execute(
        "INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?1, ?2, ?3)",
        params![session_title, now, now],
    )?;

    let id = transaction.last_insert_rowid();

    Ok(ChatSession {
        id,
        title: session_title.to_string(),
        created_at: now,
        updated_at: now,
    })
}

pub fn rename_session(
    transaction: &Transaction<'_>,
    session_id: i64,
    title: &str,
) -> EngineResult<ChatSession> {
    let now = now_millis();
    let clean_title = title.trim();
    if clean_title.is_empty() {
        return Err(EngineError::Rejected("session title cannot be empty".into()));
    }

    let affected = transaction.execute(
        "UPDATE chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![clean_title, now, session_id],
    )?;

    if affected == 0 {
        return Err(EngineError::Store(format!(
            "chat session {session_id} does not exist"
        )));
    }

    let mut statement = transaction.prepare(SELECT_SESSION_BY_ID)?;
    let session = statement.query_row([session_id], read_session)?;
    Ok(session)
}

pub fn delete_session(transaction: &Transaction<'_>, session_id: i64) -> EngineResult<()> {
    transaction.execute(
        "DELETE FROM chat_messages WHERE session_id = ?1",
        params![session_id],
    )?;
    let affected = transaction.execute(
        "DELETE FROM chat_sessions WHERE id = ?1",
        params![session_id],
    )?;
    if affected == 0 {
        return Err(EngineError::Store(format!(
            "chat session {session_id} does not exist"
        )));
    }
    Ok(())
}

pub fn load_messages(
    connection: &Connection,
    session_id: i64,
) -> EngineResult<Vec<ChatMessage>> {
    let mut statement = connection.prepare(SELECT_MESSAGES)?;
    let mut rows = statement.query([session_id])?;

    let mut messages = Vec::new();
    while let Some(row) = rows.next()? {
        messages.push(read_message(row)?);
    }
    Ok(messages)
}

pub fn save_message(
    transaction: &Transaction<'_>,
    session_id: i64,
    role: &str,
    content: &str,
) -> EngineResult<ChatMessage> {
    let now = now_millis();

    let affected = transaction.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    if affected == 0 {
        return Err(EngineError::Store(format!(
            "cannot add message: chat session {session_id} does not exist"
        )));
    }

    transaction.execute(
        "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![session_id, role, content, now],
    )?;

    let id = transaction.last_insert_rowid();

    Ok(ChatMessage {
        id,
        session_id,
        role: role.to_string(),
        content: content.to_string(),
        created_at: now,
    })
}

pub fn clear_session_messages(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> EngineResult<()> {
    let now = now_millis();
    transaction.execute(
        "DELETE FROM chat_messages WHERE session_id = ?1",
        params![session_id],
    )?;
    transaction.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )?;
    Ok(())
}

fn read_session(row: &Row<'_>) -> rusqlite::Result<ChatSession> {
    Ok(ChatSession {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn read_message(row: &Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Store;

    #[test]
    fn chat_sessions_and_messages_crud_cycle() {
        let store = Store::in_memory().unwrap();

        // 1. Initial store has no sessions
        {
            let connection = store.lock().unwrap();
            let initial = list_sessions(&connection).unwrap();
            assert!(initial.is_empty());
        }

        // 2. Create a session
        let session = {
            let mut conn = store.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let created = create_session(&tx, "Recovery Discussion").unwrap();
            assert_eq!(created.title, "Recovery Discussion");
            assert!(created.id > 0);
            tx.commit().unwrap();
            created
        };

        // 3. Save messages in the session
        {
            let mut conn = store.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let saved_user =
                save_message(&tx, session.id, "user", "What is the total revenue at risk?").unwrap();
            assert_eq!(saved_user.role, "user");
            assert_eq!(saved_user.content, "What is the total revenue at risk?");
            assert_eq!(saved_user.session_id, session.id);

            let saved_ai =
                save_message(&tx, session.id, "assistant", "Based on open recovery jobs...").unwrap();
            assert_eq!(saved_ai.role, "assistant");
            assert_eq!(saved_ai.session_id, session.id);
            assert!(saved_ai.id > saved_user.id);
            tx.commit().unwrap();
        }

        // 4. Load messages
        {
            let connection = store.lock().unwrap();
            let messages = load_messages(&connection, session.id).unwrap();
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0].role, "user");
            assert_eq!(messages[1].role, "assistant");

            let sessions = list_sessions(&connection).unwrap();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].id, session.id);
        }

        // 5. Rename session
        {
            let mut conn = store.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let renamed = rename_session(&tx, session.id, "Renamed Topic").unwrap();
            assert_eq!(renamed.title, "Renamed Topic");
            tx.commit().unwrap();
        }

        // 6. Clear session messages
        {
            let mut conn = store.lock().unwrap();
            let tx = conn.transaction().unwrap();
            clear_session_messages(&tx, session.id).unwrap();
            tx.commit().unwrap();
        }

        {
            let connection = store.lock().unwrap();
            let empty_msgs = load_messages(&connection, session.id).unwrap();
            assert!(empty_msgs.is_empty());
        }

        // 7. Delete session
        {
            let mut conn = store.lock().unwrap();
            let tx = conn.transaction().unwrap();
            delete_session(&tx, session.id).unwrap();
            tx.commit().unwrap();
        }

        {
            let connection = store.lock().unwrap();
            let sessions = list_sessions(&connection).unwrap();
            assert!(sessions.is_empty());
        }
    }
}

