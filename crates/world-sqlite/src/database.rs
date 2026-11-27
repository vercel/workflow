use std::{
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use rusqlite::{Connection, ErrorCode};

use crate::Result;

/// The data directory's database file, as in the TS local World.
pub(crate) const DATABASE_FILE_NAME: &str = "world.db";

/// How long a statement waits for another process's lock.
const BUSY_TIMEOUT: Duration = Duration::from_secs(30);

/// A handle to one data directory's database. Cheap; holds no connection.
///
/// Every operation opens and closes its own connection, as the TS local World
/// does in its `none` connection mode. Operations are synchronous: the calling
/// thread blocks while SQLite waits for another process's lock.
pub(crate) struct Database {
    file: PathBuf,
}

impl Database {
    pub fn new(data_dir: &Path) -> Result<Self> {
        Ok(Self {
            file: std::path::absolute(data_dir)?.join(DATABASE_FILE_NAME),
        })
    }

    /// Runs `operation` on a connection opened for it and closed after it.
    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        operation(&open(&self.file)?)
    }
}

/// Opens a connection and applies the TS local World's connection settings.
/// No World schema is installed yet.
fn open(file: &Path) -> Result<Connection> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(file)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    // Reassigning even the current mode takes a write lock, so skip it on
    // configured files to let readers open while another process writes.
    let vacuum: i64 = connection.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
    if vacuum != 2 {
        connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    }
    connection.pragma_update(None, "journal_size_limit", 67_108_864)?;
    // Switching to WAL needs a lock SQLite does not wait for, and is a no-op
    // once the file is in WAL mode: attempt it only when needed, and retry
    // while another connection holds the file.
    retry_while_busy(|| {
        let mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            connection.pragma_update(None, "journal_mode", "WAL")?;
        }
        Ok(())
    })?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "secure_delete", "ON")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}

/// Runs `operation`, pausing briefly and retrying while SQLite reports the
/// database busy without waiting. Bounded by the busy timeout overall.
fn retry_while_busy<T>(mut operation: impl FnMut() -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    let deadline = Instant::now() + BUSY_TIMEOUT;
    let mut attempt = 0;
    loop {
        match operation() {
            Err(error) if is_busy(&error) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50.min(1 << attempt)));
                attempt = (attempt + 1).min(6);
            }
            result => return result,
        }
    }
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

#[cfg(test)]
mod tests {
    use std::{
        thread,
        time::{Duration, Instant},
    };

    use super::{DATABASE_FILE_NAME, Database};
    use crate::Result;

    // @lat: [[world-sqlite#Rust crate#Database connections]]
    #[test]
    fn connections_use_local_world_settings() -> Result<()> {
        let directory = tempfile::tempdir()?;
        Database::new(directory.path())?.with_connection(|connection| {
            // Includes per-connection settings, which other connections cannot observe.
            for (pragma, expected) in [
                ("auto_vacuum", 2),
                ("journal_size_limit", 67_108_864),
                ("synchronous", 1),
                ("secure_delete", 1),
                ("foreign_keys", 1),
                ("busy_timeout", 30_000),
                ("user_version", 0),
            ] {
                let value: i64 = connection.pragma_query_value(None, pragma, |row| row.get(0))?;
                assert_eq!(value, expected, "{pragma}");
            }
            let mode: String =
                connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
            assert_eq!(mode, "wal");
            Ok(())
        })
    }

    #[test]
    fn connections_are_not_retained() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let database = Database::new(directory.path())?;
        database.with_connection(|connection| {
            Ok(connection.execute_batch("CREATE TEMP TABLE temporary(value)")?)
        })?;
        database.with_connection(|connection| {
            // TEMP tables disappear on close: no connection was retained.
            let tables: i64 =
                connection.query_row("SELECT count(*) FROM sqlite_temp_schema", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(tables, 0);
            Ok(())
        })?;
        // No retained handle prevents removing the file or writes to an unlinked one.
        let file = directory.path().join(DATABASE_FILE_NAME);
        std::fs::remove_file(&file)?;
        database.with_connection(|_| Ok(()))?;
        assert!(file.is_file());
        Ok(())
    }

    // @lat: [[world-sqlite#Rust crate#Database connections#Lock waits]]
    #[test]
    fn opening_waits_for_another_connection_to_release_the_file() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let database = Database::new(directory.path())?;
        let holder = rusqlite::Connection::open(directory.path().join(DATABASE_FILE_NAME))?;
        // A rollback-journal exclusive lock blocks every setup statement.
        holder.execute_batch("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE")?;
        let started = Instant::now();
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            holder.execute_batch("ROLLBACK")
        });
        database.with_connection(|_| Ok(()))?;
        assert!(started.elapsed() >= Duration::from_millis(100));
        release.join().unwrap()?;
        Ok(())
    }
}
