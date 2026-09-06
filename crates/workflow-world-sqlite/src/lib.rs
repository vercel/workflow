//! Experimental SQLite backend for the first Rust World contract slice.
//!
//! The schema is a pre-release prototype. It currently exercises resilient run
//! start, atomic materialization, dense slots, ordered checksummed migrations,
//! process contention, and application-process recovery at instrumented
//! transaction boundaries. It is not yet a complete local `World`
//! implementation or a power-loss durability claim.

#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, ffi::ErrorCode,
    params,
};
use workflow_protocol::{
    CreateEventResult, EventPage, EventType, RunCreatedEventData, RunStartedRequest, RunStatus,
    StoredEvent, WorkflowRun, WorldError, WorldErrorKind, WorldSnapshot, event_id_to_slot,
    slot_to_event_id,
};
use workflow_world_core::plan_run_started;

use crate::migrations::{
    AppliedMigration, MIGRATIONS, current_schema_version, validate_applied_history,
    validate_registry,
};

const PRELOAD_LIMIT: usize = 100;
const MIGRATION_RETRY_INTERVAL: Duration = Duration::from_millis(10);

mod migrations;

#[must_use]
pub fn sqlite_library_version() -> &'static str {
    rusqlite::version()
}

#[derive(Clone, Debug)]
pub struct SqliteWorld {
    path: PathBuf,
    busy_timeout: Duration,
}

impl SqliteWorld {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            busy_timeout: Duration::from_secs(5),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn with_busy_timeout(mut self, busy_timeout: Duration) -> Self {
        self.busy_timeout = busy_timeout;
        self
    }

    pub fn migrate(&self) -> Result<(), WorldError> {
        validate_registry()?;
        prepare_database_path(&self.path)?;
        retry_with_busy_budget(
            self.busy_timeout,
            MIGRATION_RETRY_INTERVAL,
            |attempt_timeout| self.migrate_once(attempt_timeout),
        )
    }

    fn migrate_once(&self, attempt_timeout: Duration) -> Result<(), WorldError> {
        let started_at = Instant::now();
        let mut connection =
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(storage_error)?;
        Self::configure_connection_with_timeout(&connection, attempt_timeout)?;
        let current_journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let journal_mode = if current_journal_mode.eq_ignore_ascii_case("wal") {
            current_journal_mode
        } else {
            #[cfg(test)]
            process_tests::pause_at_process_test_failpoint(
                None,
                "before_migration_wal_activation",
            )?;
            connection
                .query_row("PRAGMA journal_mode = WAL", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(storage_error)?
        };
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!("SQLite refused WAL journal mode and selected {journal_mode:?}"),
            )
            .with_details(serde_json::json!({
                "subsystem": "sqlite",
                "reason": "journal_mode_not_wal",
                "journalMode": journal_mode,
            })));
        }
        harden_sqlite_file_permissions(&self.path)?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "before_migration_transaction")?;

        connection
            .busy_timeout(attempt_timeout.saturating_sub(started_at.elapsed()))
            .map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        transaction
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS workflow_schema_migrations (
                  version INTEGER PRIMARY KEY NOT NULL,
                  checksum TEXT NOT NULL,
                  applied_at_ms INTEGER NOT NULL
                ) STRICT;
                "#,
            )
            .map_err(storage_error)?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(
            Some(&transaction),
            "after_migration_table_created",
        )?;

        let applied = read_applied_migrations(&transaction)?;
        let applied_count = validate_applied_history(&applied)?;
        for migration in &MIGRATIONS[applied_count..] {
            // Migration SQL is embedded in this binary and reviewed as source.
            // The checked-in migration test verifies that it leaves this
            // runner-owned transaction active and rollbackable.
            transaction
                .execute_batch(migration.sql)
                .map_err(storage_error)?;
            #[cfg(test)]
            process_tests::pause_at_process_test_failpoint(
                Some(&transaction),
                &format!("after_migration_sql_{}", migration.version),
            )?;
            transaction
                .execute(
                    "INSERT INTO workflow_schema_migrations (version, checksum, applied_at_ms) VALUES (?1, ?2, ?3)",
                    params![migration.version, migration.checksum, now_ms()?],
                )
                .map_err(storage_error)?;
            #[cfg(test)]
            process_tests::pause_at_process_test_failpoint(
                Some(&transaction),
                &format!("after_migration_record_{}", migration.version),
            )?;
        }
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(
            Some(&transaction),
            "before_migration_commit",
        )?;
        transaction.commit().map_err(storage_error)?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "after_migration_commit")?;
        Ok(())
    }

    pub fn create_resilient_run_started(
        &self,
        request: &RunStartedRequest,
    ) -> Result<CreateEventResult, WorldError> {
        if let Some(result) = self.read_only_start_result(request)? {
            return self.with_preload(result);
        }
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "after_read_miss")?;

        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(
            Some(&transaction),
            "after_begin_immediate",
        )?;

        let current_run = read_run(&transaction, &request.run_id)?;
        let plan = plan_run_started(current_run.as_ref(), request, now_ms()?)?;

        if plan.insert_run {
            insert_run(&transaction, &plan.run)?;
        } else if !plan.events.is_empty() {
            update_run(&transaction, &plan.run)?;
        }
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(Some(&transaction), "after_run_write")?;

        let mut appended = Vec::with_capacity(plan.events.len());
        for event in &plan.events {
            appended.push(append_event(&transaction, &plan.run.run_id, event)?);
            #[cfg(test)]
            match appended.len() {
                1 => process_tests::pause_at_process_test_failpoint(
                    Some(&transaction),
                    "after_first_event_append",
                )?,
                2 => process_tests::pause_at_process_test_failpoint(
                    Some(&transaction),
                    "after_second_event_append",
                )?,
                _ => {}
            }
        }

        let result = CreateEventResult {
            run: plan.run,
            event: appended.last().cloned(),
            preload: None,
        };
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(Some(&transaction), "before_commit")?;
        transaction.commit().map_err(storage_error)?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "after_commit_before_preload")?;
        self.with_preload(result)
    }

    pub fn snapshot(&self, run_id: &str) -> Result<WorldSnapshot, WorldError> {
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let run = read_run(&transaction, run_id)?.ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::RunNotFound,
                format!("workflow run {run_id:?} was not found"),
            )
        })?;
        let events = list_events_after_slot(&transaction, run_id, 0, i64::MAX)?;
        transaction.commit().map_err(storage_error)?;
        Ok(WorldSnapshot { run, events })
    }

    pub fn list_events_after_cursor(
        &self,
        run_id: &str,
        cursor: &str,
        limit: usize,
    ) -> Result<EventPage, WorldError> {
        let after_slot = event_id_to_slot(cursor)?;
        self.read_event_page(run_id, after_slot, limit)
    }

    fn read_only_start_result(
        &self,
        request: &RunStartedRequest,
    ) -> Result<Option<CreateEventResult>, WorldError> {
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let current_run = read_run(&transaction, &request.run_id)?;
        if current_run
            .as_ref()
            .is_none_or(|run| run.status == RunStatus::Pending)
        {
            transaction.commit().map_err(storage_error)?;
            return Ok(None);
        }

        let plan = plan_run_started(current_run.as_ref(), request, now_ms()?)?;
        let result = CreateEventResult {
            run: plan.run,
            event: None,
            preload: None,
        };
        transaction.commit().map_err(storage_error)?;
        Ok(Some(result))
    }

    fn with_preload(&self, mut result: CreateEventResult) -> Result<CreateEventResult, WorldError> {
        result.preload = Some(self.read_event_page(&result.run.run_id, 0, PRELOAD_LIMIT)?);
        Ok(result)
    }

    fn read_event_page(
        &self,
        run_id: &str,
        after_slot: u64,
        limit: usize,
    ) -> Result<EventPage, WorldError> {
        if limit == 0 {
            return Err(WorldError::invalid_request(
                "event page limit must be greater than zero",
            ));
        }
        let after_slot = i64::try_from(after_slot).map_err(|_| {
            WorldError::invalid_request(format!("invalid event cursor slot: {after_slot}"))
        })?;
        let fetch_limit = i64::try_from(limit.saturating_add(1)).map_err(|_| {
            WorldError::invalid_request(format!("event page limit is too large: {limit}"))
        })?;
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let mut events = list_events_after_slot(&transaction, run_id, after_slot, fetch_limit)?;
        let has_more = events.len() > limit;
        if has_more {
            events.truncate(limit);
        }
        let cursor = events
            .last()
            .map(|event| slot_to_event_id(event.slot))
            .transpose()?;
        transaction.commit().map_err(storage_error)?;
        Ok(EventPage {
            events,
            cursor,
            has_more,
        })
    }

    fn open_runtime_connection(&self) -> Result<Connection, WorldError> {
        if !self.path.exists() {
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                "SQLite World database does not exist; run migrate first",
            ));
        }
        let connection = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(storage_error)?;
        self.configure_connection(&connection)?;
        Ok(connection)
    }

    fn configure_connection(&self, connection: &Connection) -> Result<(), WorldError> {
        Self::configure_connection_with_timeout(connection, self.busy_timeout)
    }

    fn configure_connection_with_timeout(
        connection: &Connection,
        busy_timeout: Duration,
    ) -> Result<(), WorldError> {
        connection
            .busy_timeout(busy_timeout)
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage_error)
    }

    fn require_current_schema(&self, connection: &Connection) -> Result<(), WorldError> {
        let migration_table_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_schema_migrations')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(storage_error)?;
        if !migration_table_exists {
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                "SQLite World schema is not initialized; run migrate first",
            ));
        }
        let applied = read_applied_migrations(connection)?;
        if applied.is_empty() {
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                "SQLite World schema is not initialized; run migrate first",
            ));
        }
        let applied_count = validate_applied_history(&applied)?;
        if applied_count != MIGRATIONS.len() {
            let version = applied.last().map_or(0, |migration| migration.version);
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                format!(
                    "SQLite World schema {version} is older than required schema {}; run migrate",
                    current_schema_version()
                ),
            ));
        }
        Ok(())
    }
}

fn retry_with_busy_budget<T>(
    busy_timeout: Duration,
    retry_interval: Duration,
    mut attempt: impl FnMut(Duration) -> Result<T, WorldError>,
) -> Result<T, WorldError> {
    let started_at = Instant::now();
    let mut attempt_timeout = busy_timeout;
    loop {
        match attempt(attempt_timeout) {
            Err(error) if error.retryable() => {
                // First-time DELETE-to-WAL activation can report BUSY immediately when
                // another process is activating the same file. Drop that connection and
                // retry the entire locked migration against newly committed state.
                let remaining = busy_timeout.saturating_sub(started_at.elapsed());
                if remaining.is_zero() {
                    return Err(error);
                }
                thread::sleep(retry_interval.min(remaining));
                attempt_timeout = busy_timeout.saturating_sub(started_at.elapsed());
                if attempt_timeout.is_zero() {
                    return Err(error);
                }
            }
            result => return result,
        }
    }
}

fn read_applied_migrations(connection: &Connection) -> Result<Vec<AppliedMigration>, WorldError> {
    let mut statement = connection
        .prepare("SELECT version, checksum FROM workflow_schema_migrations ORDER BY version ASC")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(AppliedMigration {
                version: row.get(0)?,
                checksum: row.get(1)?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn insert_run(transaction: &Transaction<'_>, run: &WorkflowRun) -> Result<(), WorldError> {
    transaction
        .execute(
            r#"
            INSERT INTO workflow_runs (
              run_id, status, deployment_id, workflow_name, spec_version, input,
              execution_context_json, attributes_json, encryption_public_key,
              next_event_slot, created_at_ms, started_at_ms, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12)
            "#,
            params![
                run.run_id,
                run.status.as_str(),
                run.deployment_id,
                run.workflow_name,
                i64::from(run.spec_version),
                run.input,
                run.execution_context
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(persisted_data_error)?,
                serde_json::to_string(&run.attributes).map_err(persisted_data_error)?,
                run.encryption_public_key,
                run.created_at_ms,
                run.started_at_ms,
                run.updated_at_ms,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn update_run(transaction: &Transaction<'_>, run: &WorkflowRun) -> Result<(), WorldError> {
    let changed = transaction
        .execute(
            r#"
            UPDATE workflow_runs
            SET status = ?2, started_at_ms = ?3, updated_at_ms = ?4
            WHERE run_id = ?1
            "#,
            params![
                run.run_id,
                run.status.as_str(),
                run.started_at_ms,
                run.updated_at_ms,
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(WorldError::new(
            WorldErrorKind::RunNotFound,
            format!("workflow run {:?} disappeared during update", run.run_id),
        ));
    }
    Ok(())
}

fn append_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    event: &workflow_protocol::UnpositionedEvent,
) -> Result<StoredEvent, WorldError> {
    let slot = transaction
        .query_row(
            "SELECT next_event_slot FROM workflow_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(storage_error)?;
    let event_data_present = i64::from(event.event_data.is_some());
    transaction
        .execute(
            r#"
            INSERT INTO workflow_events (
              run_id, slot, event_type, spec_version, event_data_present, created_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                run_id,
                slot,
                event.event_type.as_str(),
                i64::from(event.spec_version),
                event_data_present,
                event.created_at_ms,
            ],
        )
        .map_err(storage_error)?;

    if let Some(data) = &event.event_data {
        transaction
            .execute(
                r#"
                INSERT INTO workflow_run_created_event_data (
                  run_id, slot, deployment_id, workflow_name, input, execution_context_json,
                  attributes_json, allow_reserved_attributes, encryption_public_key
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    run_id,
                    slot,
                    data.deployment_id,
                    data.workflow_name,
                    data.input,
                    data.execution_context
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(persisted_data_error)?,
                    data.attributes
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(persisted_data_error)?,
                    i64::from(data.allow_reserved_attributes),
                    data.encryption_public_key,
                ],
            )
            .map_err(storage_error)?;
    }

    let changed = transaction
        .execute(
            r#"
            UPDATE workflow_runs
            SET next_event_slot = ?2
            WHERE run_id = ?1 AND next_event_slot = ?2 - 1
            "#,
            params![run_id, slot + 1],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(WorldError::new(
            WorldErrorKind::Storage,
            format!("event slot {slot} for run {run_id:?} lost its transaction owner"),
        ));
    }

    Ok(StoredEvent {
        run_id: run_id.to_owned(),
        slot: to_u64(slot, "event slot")?,
        event_type: event.event_type,
        spec_version: event.spec_version,
        created_at_ms: event.created_at_ms,
        event_data: event.event_data.clone(),
    })
}

fn read_run(connection: &Connection, run_id: &str) -> Result<Option<WorkflowRun>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT run_id, status, deployment_id, workflow_name, spec_version, input,
                   execution_context_json, attributes_json, encryption_public_key,
                   created_at_ms, started_at_ms, updated_at_ms
            FROM workflow_runs
            WHERE run_id = ?1
            "#,
            [run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(
            |(
                run_id,
                status,
                deployment_id,
                workflow_name,
                spec_version,
                input,
                execution_context_json,
                attributes_json,
                encryption_public_key,
                created_at_ms,
                started_at_ms,
                updated_at_ms,
            )| {
                Ok(WorkflowRun {
                    run_id,
                    status: RunStatus::try_from(status.as_str())?,
                    deployment_id,
                    workflow_name,
                    spec_version: to_u32(spec_version, "run spec version")?,
                    input,
                    execution_context: execution_context_json
                        .as_deref()
                        .map(serde_json::from_str)
                        .transpose()
                        .map_err(persisted_data_error)?,
                    attributes: serde_json::from_str(&attributes_json)
                        .map_err(persisted_data_error)?,
                    encryption_public_key,
                    created_at_ms,
                    started_at_ms,
                    updated_at_ms,
                })
            },
        )
        .transpose()
}

fn list_events_after_slot(
    connection: &Connection,
    run_id: &str,
    after_slot: i64,
    limit: i64,
) -> Result<Vec<StoredEvent>, WorldError> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT e.slot, e.event_type, e.spec_version, e.event_data_present, e.created_at_ms,
                   d.deployment_id, d.workflow_name, d.input, d.execution_context_json,
                   d.attributes_json, d.allow_reserved_attributes, d.encryption_public_key
            FROM workflow_events e
            LEFT JOIN workflow_run_created_event_data d
              ON d.run_id = e.run_id AND d.slot = e.slot
            WHERE e.run_id = ?1 AND e.slot > ?2
            ORDER BY e.slot ASC
            LIMIT ?3
            "#,
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(params![run_id, after_slot, limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<Vec<u8>>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<String>>(11)?,
            ))
        })
        .map_err(storage_error)?;

    let mut events = Vec::new();
    for row in rows {
        let (
            slot,
            event_type,
            spec_version,
            event_data_present,
            created_at_ms,
            deployment_id,
            workflow_name,
            input,
            execution_context_json,
            attributes_json,
            allow_reserved_attributes,
            encryption_public_key,
        ) = row.map_err(storage_error)?;
        let event_data = match event_data_present {
            0 => {
                if deployment_id.is_some()
                    || workflow_name.is_some()
                    || input.is_some()
                    || execution_context_json.is_some()
                    || attributes_json.is_some()
                    || allow_reserved_attributes.is_some()
                    || encryption_public_key.is_some()
                {
                    return Err(WorldError::persisted_data(format!(
                        "event {run_id:?}/{slot} has payload columns but event_data_present is false"
                    )));
                }
                None
            }
            1 => Some(RunCreatedEventData {
                deployment_id: deployment_id
                    .ok_or_else(|| missing_event_data(run_id, slot, "deployment_id"))?,
                workflow_name: workflow_name
                    .ok_or_else(|| missing_event_data(run_id, slot, "workflow_name"))?,
                input: input.ok_or_else(|| missing_event_data(run_id, slot, "input"))?,
                execution_context: execution_context_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(persisted_data_error)?,
                attributes: attributes_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(persisted_data_error)?,
                allow_reserved_attributes: match allow_reserved_attributes
                    .ok_or_else(|| missing_event_data(run_id, slot, "allow_reserved_attributes"))?
                {
                    0 => false,
                    1 => true,
                    other => {
                        return Err(WorldError::persisted_data(format!(
                            "event {run_id:?}/{slot} has invalid allow_reserved_attributes value {other}"
                        )));
                    }
                },
                encryption_public_key,
            }),
            other => {
                return Err(WorldError::persisted_data(format!(
                    "event {run_id:?}/{slot} has invalid event_data_present value {other}"
                )));
            }
        };
        events.push(StoredEvent {
            run_id: run_id.to_owned(),
            slot: to_u64(slot, "event slot")?,
            event_type: EventType::try_from(event_type.as_str())?,
            spec_version: to_u32(spec_version, "event spec version")?,
            created_at_ms,
            event_data,
        });
    }
    Ok(events)
}

fn missing_event_data(run_id: &str, slot: i64, field: &str) -> WorldError {
    WorldError::persisted_data(format!(
        "event {run_id:?}/{slot} is missing required {field}"
    ))
}

fn to_u32(value: i64, label: &str) -> Result<u32, WorldError> {
    u32::try_from(value)
        .map_err(|_| WorldError::persisted_data(format!("invalid {label}: {value}")))
}

fn to_u64(value: i64, label: &str) -> Result<u64, WorldError> {
    u64::try_from(value)
        .map_err(|_| WorldError::persisted_data(format!("invalid {label}: {value}")))
}

fn now_ms() -> Result<i64, WorldError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorldError::new(WorldErrorKind::Storage, "system clock is before Unix epoch"))?
        .as_millis();
    i64::try_from(millis)
        .map_err(|_| WorldError::new(WorldErrorKind::Storage, "system clock overflow"))
}

fn prepare_database_path(path: &Path) -> Result<(), WorldError> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        create_private_directories(parent)?;
    }
    create_private_database_file(path)?;
    harden_sqlite_file_permissions(path)
}

#[cfg(unix)]
fn create_private_directories(path: &Path) -> Result<(), WorldError> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path).map_err(storage_error)
}

#[cfg(not(unix))]
fn create_private_directories(path: &Path) -> Result<(), WorldError> {
    fs::create_dir_all(path).map_err(storage_error)
}

#[cfg(unix)]
fn create_private_database_file(path: &Path) -> Result<(), WorldError> {
    use std::os::unix::fs::OpenOptionsExt;

    match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(storage_error(error)),
    }
}

#[cfg(not(unix))]
fn create_private_database_file(path: &Path) -> Result<(), WorldError> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map(|_| ())
        .map_err(storage_error)
}

#[cfg(unix)]
fn harden_sqlite_file_permissions(path: &Path) -> Result<(), WorldError> {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    for suffix in ["", "-wal", "-shm"] {
        let mut candidate = OsString::from(path.as_os_str());
        candidate.push(suffix);
        let candidate = PathBuf::from(candidate);
        if candidate.exists() {
            fs::set_permissions(candidate, fs::Permissions::from_mode(0o600))
                .map_err(storage_error)?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_sqlite_file_permissions(_path: &Path) -> Result<(), WorldError> {
    Ok(())
}

fn storage_error<E>(error: E) -> WorldError
where
    E: std::error::Error + 'static,
{
    let retryable = (&error as &dyn std::error::Error)
        .downcast_ref::<rusqlite::Error>()
        .and_then(|error| match error {
            rusqlite::Error::SqliteFailure(failure, _) => Some(failure.code),
            _ => None,
        })
        .is_some_and(|code| matches!(code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked));
    WorldError::new(WorldErrorKind::Storage, "SQLite storage operation failed")
        .with_retryable(retryable)
        .with_details(serde_json::json!({ "subsystem": "sqlite" }))
}

fn persisted_data_error(error: impl std::fmt::Display) -> WorldError {
    WorldError::persisted_data(error.to_string())
}

#[cfg(test)]
mod migration_retry_tests {
    use std::thread;
    use std::time::Duration;

    use workflow_protocol::{WorldError, WorldErrorKind};

    use super::retry_with_busy_budget;

    fn retryable_error() -> WorldError {
        WorldError::new(WorldErrorKind::Storage, "synthetic busy").with_retryable(true)
    }

    #[test]
    fn a_retry_never_receives_a_fresh_busy_timeout() {
        let budget = Duration::from_millis(100);
        let mut attempt_timeouts = Vec::new();
        let result = retry_with_busy_budget(budget, Duration::from_millis(1), |timeout| {
            attempt_timeouts.push(timeout);
            if attempt_timeouts.len() == 1 {
                Err(retryable_error())
            } else {
                Ok("migrated")
            }
        })
        .expect("second attempt should succeed");

        assert_eq!(result, "migrated");
        assert_eq!(attempt_timeouts[0], budget);
        assert!(attempt_timeouts[1] < budget);
        assert!(!attempt_timeouts[1].is_zero());
    }

    #[test]
    fn an_expired_budget_does_not_start_another_attempt() {
        let budget = Duration::from_millis(10);
        let mut attempts = 0;
        let error = retry_with_busy_budget(budget, Duration::from_millis(1), |_| {
            attempts += 1;
            thread::sleep(budget + Duration::from_millis(5));
            Err::<(), _>(retryable_error())
        })
        .expect_err("an exhausted retry budget should return the last error");

        assert_eq!(error.kind(), WorldErrorKind::Storage);
        assert!(error.retryable());
        assert_eq!(attempts, 1);
    }
}

#[cfg(test)]
mod process_tests;
