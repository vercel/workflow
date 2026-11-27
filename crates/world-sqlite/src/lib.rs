//! The SQLite World, ported from the TS local World (`@workflow/world-local`).
//!
//! Operations are synchronous and need no async runtime; host adapters decide
//! which thread calls them. No World schema or storage operation exists yet.

mod config;
mod database;
mod error;

use database::Database;

pub use config::Config;
pub use error::{Error, Result};

/// A SQLite World over one data directory.
pub struct World {
    database: Database,
}

impl World {
    /// Creates a World without opening its database or creating its data directory.
    pub fn new(config: Config) -> Result<Self> {
        Ok(Self {
            database: Database::new(&config.data_dir)?,
        })
    }

    /// The spec version this World declares. 0 until its operations are
    /// complete, so SDK protocol validation rejects it.
    pub fn spec_version(&self) -> u32 {
        0
    }

    /// Temporary host probe, not part of the World contract: returns `bytes`
    /// after binding them as a SQLite BLOB and reading them back. Remove once
    /// storage operations carry binary payloads.
    pub fn echo(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        self.database.with_connection(|connection| {
            Ok(connection.query_row("SELECT ?1", [bytes], |row| row.get(0))?)
        })
    }
}
