//! Shared application state, and the two ways the commands touch the store.
//!
//! Every command is either a [`AppState::read`] or a [`AppState::write`]. That is
//! not decoration: `write` opens a transaction, so a state change and the audit
//! event that explains it commit together or not at all. There is no third way
//! to reach the database from a command, which is what makes "every action is in
//! the trail" a property of the code rather than a promise in a README.

use std::sync::Arc;

use rusqlite::{Connection, Transaction};

use crate::db::Store;
use crate::domain::Merchant;
use crate::error::EngineResult;
use crate::recovery::engine::EngineHandle;

/// Who the audit trail names for actions taken in the UI.
pub const OPERATOR_ENV: &str = "REVIVEAI_OPERATOR";

const DEFAULT_OPERATOR: &str = "Ops Desk";

pub struct AppState {
    store: Arc<Store>,
    engine: Arc<EngineHandle>,
    merchant: Merchant,
    /// Phase 1 has no sign-in. The trail still has to name somebody, and naming
    /// the configured desk is more honest than logging every action as "user".
    operator: String,
}

impl AppState {
    pub fn new(store: Arc<Store>, engine: Arc<EngineHandle>, merchant: Merchant) -> Self {
        AppState {
            store,
            engine,
            merchant,
            operator: std::env::var(OPERATOR_ENV)
                .ok()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| DEFAULT_OPERATOR.to_string()),
        }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn engine(&self) -> &EngineHandle {
        &self.engine
    }

    pub fn merchant(&self) -> Merchant {
        self.merchant.clone()
    }

    pub fn operator(&self) -> &str {
        &self.operator
    }

    /// Runs a query. No transaction: SQLite gives a single statement a consistent
    /// snapshot already, and wrapping reads would only lengthen the time the
    /// write lock is contended.
    pub fn read<T>(&self, query: impl FnOnce(&Connection) -> EngineResult<T>) -> EngineResult<T> {
        let connection = self.store.lock()?;
        query(&connection)
    }

    /// Runs a mutation in a transaction, committing only on success.
    ///
    /// On an error the `Transaction` is dropped without committing, which rolls
    /// back — so a refused transition cannot leave a half-written job or an audit
    /// event describing something that did not happen.
    pub fn write<T>(
        &self,
        mutation: impl FnOnce(&Transaction<'_>) -> EngineResult<T>,
    ) -> EngineResult<T> {
        let mut connection = self.store.lock()?;
        let transaction = connection.transaction()?;
        let outcome = mutation(&transaction)?;
        transaction.commit()?;
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::jobs;
    use crate::domain::MerchantMode;
    use crate::error::EngineError;

    fn state() -> AppState {
        AppState::new(
            Arc::new(Store::in_memory().unwrap()),
            Arc::new(EngineHandle::new()),
            Merchant {
                id: "acc_TEST".into(),
                name: "Kettle & Co.".into(),
                mode: MerchantMode::Test,
            },
        )
    }

    #[test]
    fn a_read_sees_the_store() {
        let state = state();
        let count = state
            .read(|connection| jobs::count_by_status(connection, &[]))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn a_failed_write_leaves_nothing_behind() {
        let state = state();

        let failed: EngineResult<()> = state.write(|transaction| {
            transaction.execute(
                "INSERT INTO customers (id, name, email, phone_masked)
                 VALUES ('cust_x', 'Test', 'test@example.in', '+91 9•••• ••00')",
                [],
            )?;
            // Something goes wrong after the insert.
            Err(EngineError::Rejected("no".into()))
        });

        assert!(failed.is_err());

        let customers = state
            .read(|connection| {
                Ok(connection.query_row("SELECT COUNT(*) FROM customers", [], |row| {
                    row.get::<_, i64>(0)
                })?)
            })
            .unwrap();
        assert_eq!(customers, 0, "a rolled-back write was persisted");
    }

    #[test]
    fn the_operator_name_is_never_empty() {
        assert!(!state().operator().is_empty());
    }
}
