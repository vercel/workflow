//! Experimental SQLite backend for the first Rust World contract slice.
//!
//! The schema is a pre-release prototype. It currently exercises resilient run
//! start, atomic materialization, dense slots, ordered checksummed migrations,
//! leased queue claims and active-run reconciliation, process contention, and
//! application-process recovery at instrumented transaction boundaries. It is
//! not yet a complete local `World` or a power-loss durability claim. The
//! delivery worker is a deliberately narrow loopback-HTTP prototype.

#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, ffi::ErrorCode,
    params,
};
use sha2::{Digest, Sha256};
use workflow_protocol::{
    CreateEventResult, CreateWorldEventRequest, EventPage, EventType, QueueClaim,
    QueueEnqueueResult, QueueMessageRequest, QueueReconcileResult, RunCreatedEventData,
    RunStartedRequest, RunStatus, StepStatus, StoredEvent, UnpositionedWorldEvent, WorkflowRun,
    WorkflowRunPage, WorkflowStep, WorkflowStepPage, WorldError, WorldErrorKind, WorldEvent,
    WorldEventData, WorldEventPage, WorldEventResult, WorldSnapshot, decode_context_value,
    encode_context_value, event_id_to_slot, slot_to_event_id,
};
use workflow_world_core::{plan_run_started, plan_world_event};

use crate::migrations::{
    AppliedMigration, MIGRATIONS, current_schema_version, validate_applied_history,
    validate_registry,
};

const PRELOAD_LIMIT: usize = 100;
const MIGRATION_RETRY_INTERVAL: Duration = Duration::from_millis(10);

mod migrations;
mod worker;

pub use worker::{QueueWorker, QueueWorkerConfig, QueueWorkerReport};

#[must_use]
pub fn sqlite_library_version() -> &'static str {
    rusqlite::version()
}

#[must_use]
pub fn sqlite_schema_version() -> i64 {
    current_schema_version()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DatabaseMetadata {
    pub path: PathBuf,
    pub format: String,
    pub format_version: u32,
    pub context_codec: String,
    pub schema_version: u32,
    pub run_count: u64,
    pub event_count: u64,
    pub step_count: u64,
    pub queue_message_count: u64,
    pub journal_mode: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunMetadata {
    pub run_id: String,
    pub status: RunStatus,
    pub deployment_id: String,
    pub workflow_name: String,
    pub spec_version: u32,
    pub event_count: u64,
    pub step_count: u64,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub updated_at_ms: i64,
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
        )?;
        self.ensure_ready()
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

    pub fn ensure_ready(&self) -> Result<(), WorldError> {
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)
    }

    // @lat: [[rust-portability#SQLite Local World#Event Transactions]]
    pub fn create_event(
        &self,
        request: &CreateWorldEventRequest,
    ) -> Result<WorldEventResult, WorldError> {
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;

        let current_run = read_run(&transaction, &request.run_id)?;
        let old_head = current_run
            .as_ref()
            .map(|_| read_event_head(&transaction, &request.run_id))
            .transpose()?
            .unwrap_or(0);
        if request.event_count.is_some_and(|count| count > old_head) {
            return Err(WorldError::invalid_request(format!(
                "eventCount {} is ahead of durable event head {old_head}",
                request.event_count.unwrap_or_default()
            )));
        }

        let current_step = request
            .event
            .correlation_id()
            .map(|step_id| read_step(&transaction, &request.run_id, step_id))
            .transpose()?
            .flatten();
        let plan = plan_world_event(
            current_run.as_ref(),
            current_step.as_ref(),
            request,
            now_ms()?,
        )?;

        if let Some(run) = &plan.run {
            if plan.insert_run {
                insert_run(&transaction, run)?;
            } else {
                update_run(&transaction, run)?;
            }
        }
        if let Some(step) = &plan.step {
            if plan.insert_step {
                insert_step(&transaction, step)?;
            } else {
                update_step(&transaction, step)?;
            }
        }

        let mut appended = Vec::with_capacity(plan.events.len());
        for event in &plan.events {
            appended.push(append_world_event(&transaction, &request.run_id, event)?);
        }
        let skipped_events = match request.event_count {
            Some(observed) if observed < old_head => Some(read_world_event_page_in_transaction(
                &transaction,
                &request.run_id,
                None,
                observed,
                old_head,
                PRELOAD_LIMIT,
                false,
            )?),
            _ => None,
        };
        let result = WorldEventResult {
            event: appended.last().cloned(),
            run: plan.run,
            step: plan.step,
            step_created: plan.step_created,
            skipped_events,
        };
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn get_run(&self, run_id: &str) -> Result<WorkflowRun, WorldError> {
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        read_run(&connection, run_id)?.ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::RunNotFound,
                format!("workflow run {run_id:?} was not found"),
            )
        })
    }

    pub fn list_runs(
        &self,
        workflow_name: Option<&str>,
        status: Option<RunStatus>,
        cursor: Option<&str>,
        limit: usize,
        descending: bool,
    ) -> Result<WorkflowRunPage, WorldError> {
        validate_page_limit(limit)?;
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        list_runs(
            &connection,
            workflow_name,
            status,
            cursor,
            limit,
            descending,
        )
    }

    pub fn get_step(&self, run_id: &str, step_id: &str) -> Result<WorkflowStep, WorldError> {
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        read_step(&connection, run_id, step_id)?.ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::StepNotFound,
                format!("step {step_id:?} was not found in run {run_id:?}"),
            )
        })
    }

    pub fn list_steps(
        &self,
        run_id: &str,
        cursor: Option<&str>,
        limit: usize,
        descending: bool,
    ) -> Result<WorkflowStepPage, WorldError> {
        validate_page_limit(limit)?;
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        list_steps(&connection, run_id, cursor, limit, descending)
    }

    pub fn get_event(&self, run_id: &str, event_id: &str) -> Result<WorldEvent, WorldError> {
        let slot = event_id_to_slot(event_id)?;
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        read_world_event(&connection, run_id, slot)?.ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::PersistedData,
                format!("event {event_id:?} was not found in run {run_id:?}"),
            )
        })
    }

    pub fn list_events(
        &self,
        run_id: &str,
        correlation_id: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        descending: bool,
    ) -> Result<WorldEventPage, WorldError> {
        validate_page_limit(limit)?;
        let cursor_slot = cursor.map(event_id_to_slot).transpose()?.unwrap_or({
            if descending {
                workflow_protocol::MAX_EVENT_SLOT
            } else {
                0
            }
        });
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        read_world_event_page_in_transaction(
            &connection,
            run_id,
            correlation_id,
            cursor_slot,
            workflow_protocol::MAX_EVENT_SLOT,
            limit,
            descending,
        )
    }

    // @lat: [[rust-portability#Native CLI]]
    pub fn inspect_metadata(&self) -> Result<DatabaseMetadata, WorldError> {
        let connection = self.open_inspection_connection()?;
        self.require_current_schema(&connection)?;
        let (format, format_version, context_codec) = require_database_metadata_row(&connection)?;
        let schema_version = read_applied_migrations(&connection)?
            .last()
            .map_or(0, |migration| migration.version);
        let journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        Ok(DatabaseMetadata {
            path: self.path.clone(),
            format,
            format_version: to_u32(format_version, "database format version")?,
            context_codec,
            schema_version: to_u32(schema_version, "database schema version")?,
            run_count: read_table_count(&connection, "workflow_runs")?,
            event_count: read_table_count(&connection, "workflow_events")?,
            step_count: read_table_count(&connection, "workflow_steps")?,
            queue_message_count: read_table_count(&connection, "workflow_queue_messages")?,
            journal_mode,
        })
    }

    pub fn inspect_run_metadata(&self, run_id: &str) -> Result<RunMetadata, WorldError> {
        let connection = self.open_inspection_connection()?;
        self.require_current_schema(&connection)?;
        require_database_metadata(&connection)?;
        let run = connection
            .query_row(
                r#"
                SELECT run_id, status, deployment_id, workflow_name, spec_version,
                       created_at_ms, started_at_ms, completed_at_ms, updated_at_ms
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
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| {
                WorldError::new(
                    WorldErrorKind::RunNotFound,
                    format!("workflow run {run_id:?} was not found"),
                )
            })?;
        let event_count = connection
            .query_row(
                "SELECT count(*) FROM workflow_events WHERE run_id = ?1",
                [run_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        let step_count = connection
            .query_row(
                "SELECT count(*) FROM workflow_steps WHERE run_id = ?1",
                [run_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        Ok(RunMetadata {
            run_id: run.0,
            status: RunStatus::try_from(run.1.as_str())?,
            deployment_id: run.2,
            workflow_name: run.3,
            spec_version: to_u32(run.4, "run spec version")?,
            event_count: to_u64(event_count, "run event count")?,
            step_count: to_u64(step_count, "run step count")?,
            created_at_ms: run.5,
            started_at_ms: run.6,
            completed_at_ms: run.7,
            updated_at_ms: run.8,
        })
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

    pub fn enqueue_queue_message(
        &self,
        request: &QueueMessageRequest,
    ) -> Result<QueueEnqueueResult, WorldError> {
        validate_queue_message(request)?;
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let result = enqueue_queue_message(&transaction, request)?;
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn claim_queue_message(
        &self,
        scope: &str,
        queue_name: &str,
        lease_owner: &str,
        now_ms: i64,
        lease_duration_ms: i64,
    ) -> Result<Option<QueueClaim>, WorldError> {
        validate_queue_routing(scope, queue_name)?;
        if lease_owner.is_empty() {
            return Err(WorldError::invalid_request(
                "queue lease owner must not be empty",
            ));
        }
        if now_ms < 0 {
            return Err(WorldError::invalid_request(
                "queue claim time must not be negative",
            ));
        }
        if lease_duration_ms <= 0 {
            return Err(WorldError::invalid_request(
                "queue lease duration must be greater than zero",
            ));
        }
        let lease_expires_at_ms = now_ms.checked_add(lease_duration_ms).ok_or_else(|| {
            WorldError::invalid_request("queue lease expiration exceeds the timestamp range")
        })?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "before_queue_claim")?;

        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let message_id = transaction
            .query_row(
                r#"
                SELECT message_id
                FROM workflow_queue_messages
                WHERE scope = ?1
                  AND queue_name = ?2
                  AND available_at_ms <= ?3
                  AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?3)
                ORDER BY available_at_ms ASC, created_at_ms ASC, message_id ASC
                LIMIT 1
                "#,
                params![scope, queue_name, now_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        let Some(message_id) = message_id else {
            transaction.commit().map_err(storage_error)?;
            return Ok(None);
        };

        let changed = transaction
            .execute(
                r#"
                UPDATE workflow_queue_messages
                SET attempt = attempt + 1,
                    lease_token = lower(hex(randomblob(16))),
                    lease_owner = ?2,
                    lease_expires_at_ms = ?3,
                    updated_at_ms = ?4
                WHERE message_id = ?1
                  AND available_at_ms <= ?4
                  AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?4)
                "#,
                params![message_id, lease_owner, lease_expires_at_ms, now_ms],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!("queue message {message_id:?} lost its transaction owner"),
            ));
        }
        let claim = read_queue_claim(&transaction, &message_id)?;
        transaction.commit().map_err(storage_error)?;
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "after_queue_claim_commit")?;
        Ok(Some(claim))
    }

    pub fn reschedule_queue_message(
        &self,
        lease_token: &str,
        now_ms: i64,
        available_at_ms: i64,
    ) -> Result<String, WorldError> {
        if lease_token.is_empty() {
            return Err(WorldError::invalid_request(
                "queue lease token must not be empty",
            ));
        }
        if now_ms < 0 || available_at_ms < 0 {
            return Err(WorldError::invalid_request(
                "queue reschedule times must not be negative",
            ));
        }
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let message_id = transaction
            .query_row(
                "SELECT message_id FROM workflow_queue_messages WHERE lease_token = ?1 AND lease_expires_at_ms > ?2",
                params![lease_token, now_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| queue_claim_lost(lease_token))?;
        transaction
            .execute(
                r#"
                UPDATE workflow_queue_messages
                SET available_at_ms = ?3,
                    lease_token = NULL,
                    lease_owner = NULL,
                    lease_expires_at_ms = NULL,
                    updated_at_ms = ?2
                WHERE message_id = ?1 AND lease_token = ?4 AND lease_expires_at_ms > ?2
                "#,
                params![message_id, now_ms, available_at_ms, lease_token],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(message_id)
    }

    pub fn acknowledge_queue_message(
        &self,
        lease_token: &str,
        now_ms: i64,
    ) -> Result<String, WorldError> {
        if lease_token.is_empty() {
            return Err(WorldError::invalid_request(
                "queue lease token must not be empty",
            ));
        }
        if now_ms < 0 {
            return Err(WorldError::invalid_request(
                "queue acknowledgement time must not be negative",
            ));
        }
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let message_id = transaction
            .query_row(
                "SELECT message_id FROM workflow_queue_messages WHERE lease_token = ?1 AND lease_expires_at_ms > ?2",
                params![lease_token, now_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| queue_claim_lost(lease_token))?;
        let changed = transaction
            .execute(
                "DELETE FROM workflow_queue_messages WHERE message_id = ?1 AND lease_token = ?2 AND lease_expires_at_ms > ?3",
                params![message_id, lease_token, now_ms],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(queue_claim_lost(lease_token));
        }
        transaction.commit().map_err(storage_error)?;
        Ok(message_id)
    }

    pub fn reconcile_active_runs(
        &self,
        scope: &str,
        deployment_id: &str,
        queue_prefix: &str,
        now_ms: i64,
    ) -> Result<QueueReconcileResult, WorldError> {
        if scope.is_empty() {
            return Err(WorldError::invalid_request("queue scope must not be empty"));
        }
        if queue_prefix.is_empty() {
            return Err(WorldError::invalid_request(
                "queue prefix must not be empty",
            ));
        }
        if deployment_id.is_empty() {
            return Err(WorldError::invalid_request(
                "reconciliation deployment ID must not be empty",
            ));
        }
        if now_ms < 0 {
            return Err(WorldError::invalid_request(
                "queue reconciliation time must not be negative",
            ));
        }
        #[cfg(test)]
        process_tests::pause_at_process_test_failpoint(None, "before_queue_reconcile")?;

        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let active_runs = {
            let mut statement = transaction
                .prepare(
                    r#"
                    SELECT run_id, workflow_name
                    FROM workflow_runs
                    WHERE deployment_id = ?1
                      AND status IN ('pending', 'running')
                    ORDER BY run_id ASC
                    "#,
                )
                .map_err(storage_error)?;
            statement
                .query_map([deployment_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        let mut created_message_count = 0;
        let mut message_ids = Vec::with_capacity(active_runs.len());
        for (run_id, workflow_name) in &active_runs {
            let request =
                active_run_queue_message(scope, queue_prefix, run_id, workflow_name, now_ms)?;
            let result = enqueue_queue_message(&transaction, &request)?;
            created_message_count += usize::from(result.created);
            message_ids.push(result.message_id);
        }
        transaction.commit().map_err(storage_error)?;
        Ok(QueueReconcileResult {
            active_run_count: active_runs.len(),
            created_message_count,
            message_ids,
        })
    }

    pub fn queue_message_count(&self, scope: &str) -> Result<usize, WorldError> {
        if scope.is_empty() {
            return Err(WorldError::invalid_request("queue scope must not be empty"));
        }
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        let count = connection
            .query_row(
                "SELECT count(*) FROM workflow_queue_messages WHERE scope = ?1",
                [scope],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        usize::try_from(count)
            .map_err(|_| WorldError::persisted_data(format!("invalid queue row count: {count}")))
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

    fn open_inspection_connection(&self) -> Result<Connection, WorldError> {
        if !self.path.exists() {
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                "SQLite World database does not exist; run migrate first",
            ));
        }
        let connection = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(storage_error)?;
        connection
            .busy_timeout(self.busy_timeout)
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage_error)?;
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
        require_database_metadata(connection)
    }
}

#[derive(Debug)]
struct StoredQueueMessage {
    message_id: String,
    scope: String,
    queue_name: String,
    idempotency_key: String,
    body: Vec<u8>,
}

fn validate_queue_routing(scope: &str, queue_name: &str) -> Result<(), WorldError> {
    if scope.is_empty() {
        return Err(WorldError::invalid_request("queue scope must not be empty"));
    }
    if queue_name.is_empty() {
        return Err(WorldError::invalid_request("queue name must not be empty"));
    }
    Ok(())
}

fn validate_page_limit(limit: usize) -> Result<(), WorldError> {
    if !(1..=1_000).contains(&limit) {
        return Err(WorldError::invalid_request(
            "pagination limit must be between 1 and 1000",
        ));
    }
    Ok(())
}

fn require_database_metadata(connection: &Connection) -> Result<(), WorldError> {
    require_database_metadata_row(connection).map(|_| ())
}

fn require_database_metadata_row(
    connection: &Connection,
) -> Result<(String, i64, String), WorldError> {
    let row = connection
        .query_row(
            "SELECT format, format_version, context_codec FROM workflow_database_metadata WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::UnsupportedSchema,
                "SQLite database is missing Workflow format metadata",
            )
        })?;
    if row.0 != "workflow-sqlite" || row.1 != 1 || row.2 != workflow_protocol::SQLITE_CONTEXT_CODEC
    {
        return Err(WorldError::new(
            WorldErrorKind::UnsupportedSchema,
            "SQLite database has incompatible Workflow format metadata",
        ));
    }
    Ok(row)
}

fn read_table_count(connection: &Connection, table: &str) -> Result<u64, WorldError> {
    let query = match table {
        "workflow_runs" => "SELECT count(*) FROM workflow_runs",
        "workflow_events" => "SELECT count(*) FROM workflow_events",
        "workflow_steps" => "SELECT count(*) FROM workflow_steps",
        "workflow_queue_messages" => "SELECT count(*) FROM workflow_queue_messages",
        _ => {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                "internal inspection table is not allow-listed",
            ));
        }
    };
    let count = connection
        .query_row(query, [], |row| row.get::<_, i64>(0))
        .map_err(storage_error)?;
    to_u64(count, "table row count")
}

fn read_event_head(connection: &Connection, run_id: &str) -> Result<u64, WorldError> {
    let next_slot = connection
        .query_row(
            "SELECT next_event_slot FROM workflow_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(storage_error)?;
    let head = next_slot.checked_sub(1).ok_or_else(|| {
        WorldError::persisted_data(format!("run {run_id:?} has invalid next event slot"))
    })?;
    to_u64(head, "event head")
}

fn list_runs(
    connection: &Connection,
    workflow_name: Option<&str>,
    status: Option<RunStatus>,
    cursor: Option<&str>,
    limit: usize,
    descending: bool,
) -> Result<WorkflowRunPage, WorldError> {
    let comparison = if descending { "<" } else { ">" };
    let order = if descending { "DESC" } else { "ASC" };
    let query = format!(
        r#"
        SELECT run_id
        FROM workflow_runs
        WHERE (?1 IS NULL OR workflow_name = ?1)
          AND (?2 IS NULL OR status = ?2)
          AND (?3 IS NULL OR run_id {comparison} ?3)
        ORDER BY run_id {order}
        LIMIT ?4
        "#
    );
    let status = status.map(RunStatus::as_str);
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;
    let mut statement = connection.prepare(&query).map_err(storage_error)?;
    let ids = statement
        .query_map(params![workflow_name, status, cursor, fetch_limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let has_more = ids.len() > limit;
    let mut data = Vec::with_capacity(ids.len().min(limit));
    for run_id in ids.into_iter().take(limit) {
        data.push(read_run(connection, &run_id)?.ok_or_else(|| {
            WorldError::persisted_data(format!("listed run {run_id:?} disappeared"))
        })?);
    }
    let cursor = if has_more {
        data.last().map(|run| run.run_id.clone())
    } else {
        None
    };
    Ok(WorkflowRunPage {
        data,
        cursor,
        has_more,
    })
}

fn list_steps(
    connection: &Connection,
    run_id: &str,
    cursor: Option<&str>,
    limit: usize,
    descending: bool,
) -> Result<WorkflowStepPage, WorldError> {
    let comparison = if descending { "<" } else { ">" };
    let order = if descending { "DESC" } else { "ASC" };
    let query = format!(
        r#"
        SELECT step_id
        FROM workflow_steps
        WHERE run_id = ?1 AND (?2 IS NULL OR step_id {comparison} ?2)
        ORDER BY step_id {order}
        LIMIT ?3
        "#
    );
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;
    let mut statement = connection.prepare(&query).map_err(storage_error)?;
    let ids = statement
        .query_map(params![run_id, cursor, fetch_limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let has_more = ids.len() > limit;
    let mut data = Vec::with_capacity(ids.len().min(limit));
    for step_id in ids.into_iter().take(limit) {
        data.push(read_step(connection, run_id, &step_id)?.ok_or_else(|| {
            WorldError::persisted_data(format!("listed step {run_id:?}/{step_id:?} disappeared"))
        })?);
    }
    let cursor = if has_more {
        data.last().map(|step| step.step_id.clone())
    } else {
        None
    };
    Ok(WorkflowStepPage {
        data,
        cursor,
        has_more,
    })
}

fn validate_queue_message(request: &QueueMessageRequest) -> Result<(), WorldError> {
    validate_queue_routing(&request.scope, &request.queue_name)?;
    if request.message_id.is_empty() {
        return Err(WorldError::invalid_request(
            "queue message ID must not be empty",
        ));
    }
    if request.idempotency_key.is_empty() {
        return Err(WorldError::invalid_request(
            "queue idempotency key must not be empty",
        ));
    }
    if request.available_at_ms < 0 {
        return Err(WorldError::invalid_request(
            "queue availability time must not be negative",
        ));
    }
    Ok(())
}

fn active_run_queue_message(
    scope: &str,
    queue_prefix: &str,
    run_id: &str,
    workflow_name: &str,
    now_ms: i64,
) -> Result<QueueMessageRequest, WorldError> {
    let mut identity = Sha256::new();
    identity.update(b"workflow-active-run\0");
    identity.update(scope.as_bytes());
    identity.update(b"\0");
    identity.update(run_id.as_bytes());
    let message_id = format!("msg_reconcile_{:x}", identity.finalize());
    let body = serde_json::to_vec(&serde_json::json!({ "runId": run_id }))
        .map_err(persisted_data_error)?;
    let request = QueueMessageRequest {
        message_id,
        scope: scope.to_owned(),
        queue_name: format!("{queue_prefix}{workflow_name}"),
        idempotency_key: format!("active-run:{run_id}"),
        body,
        available_at_ms: now_ms,
    };
    validate_queue_message(&request)?;
    Ok(request)
}

fn enqueue_queue_message(
    transaction: &Transaction<'_>,
    request: &QueueMessageRequest,
) -> Result<QueueEnqueueResult, WorldError> {
    let by_message_id = read_queue_message_by_id(transaction, &request.message_id)?;
    let by_identity = read_queue_message_by_identity(
        transaction,
        &request.scope,
        &request.queue_name,
        &request.idempotency_key,
    )?;
    let existing = match (by_message_id, by_identity) {
        (Some(by_id), Some(by_key)) if by_id.message_id != by_key.message_id => {
            return Err(WorldError::invalid_request(format!(
                "queue message ID {:?} and idempotency key {:?} identify different messages",
                request.message_id, request.idempotency_key
            )));
        }
        (Some(existing), _) | (_, Some(existing)) => Some(existing),
        (None, None) => None,
    };
    if let Some(existing) = existing {
        if existing.message_id != request.message_id
            || existing.scope != request.scope
            || existing.queue_name != request.queue_name
            || existing.idempotency_key != request.idempotency_key
            || existing.body != request.body
        {
            return Err(WorldError::invalid_request(format!(
                "queue idempotency identity {:?} was reused with different message data",
                request.idempotency_key
            )));
        }
        return Ok(QueueEnqueueResult {
            message_id: existing.message_id,
            created: false,
        });
    }

    transaction
        .execute(
            r#"
            INSERT INTO workflow_queue_messages (
              message_id, scope, queue_name, idempotency_key, body,
              available_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)
            "#,
            params![
                request.message_id,
                request.scope,
                request.queue_name,
                request.idempotency_key,
                request.body,
                request.available_at_ms,
            ],
        )
        .map_err(storage_error)?;
    Ok(QueueEnqueueResult {
        message_id: request.message_id.clone(),
        created: true,
    })
}

fn read_queue_message_by_id(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<StoredQueueMessage>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT message_id, scope, queue_name, idempotency_key, body
            FROM workflow_queue_messages
            WHERE message_id = ?1
            "#,
            [message_id],
            read_stored_queue_message,
        )
        .optional()
        .map_err(storage_error)
}

fn read_queue_message_by_identity(
    connection: &Connection,
    scope: &str,
    queue_name: &str,
    idempotency_key: &str,
) -> Result<Option<StoredQueueMessage>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT message_id, scope, queue_name, idempotency_key, body
            FROM workflow_queue_messages
            WHERE scope = ?1 AND queue_name = ?2 AND idempotency_key = ?3
            "#,
            params![scope, queue_name, idempotency_key],
            read_stored_queue_message,
        )
        .optional()
        .map_err(storage_error)
}

fn read_stored_queue_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredQueueMessage> {
    Ok(StoredQueueMessage {
        message_id: row.get(0)?,
        scope: row.get(1)?,
        queue_name: row.get(2)?,
        idempotency_key: row.get(3)?,
        body: row.get(4)?,
    })
}

fn read_queue_claim(connection: &Connection, message_id: &str) -> Result<QueueClaim, WorldError> {
    let (
        message_id,
        scope,
        queue_name,
        body,
        attempt,
        lease_token,
        lease_owner,
        lease_expires_at_ms,
    ) = connection
        .query_row(
            r#"
            SELECT message_id, scope, queue_name, body, attempt,
                   lease_token, lease_owner, lease_expires_at_ms
            FROM workflow_queue_messages
            WHERE message_id = ?1
            "#,
            [message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .map_err(storage_error)?;
    Ok(QueueClaim {
        message_id,
        scope,
        queue_name,
        body,
        attempt: to_u32(attempt, "queue attempt")?,
        lease_token: lease_token.ok_or_else(|| {
            WorldError::persisted_data("claimed queue message is missing its lease token")
        })?,
        lease_owner: lease_owner.ok_or_else(|| {
            WorldError::persisted_data("claimed queue message is missing its lease owner")
        })?,
        lease_expires_at_ms: lease_expires_at_ms.ok_or_else(|| {
            WorldError::persisted_data("claimed queue message is missing its lease expiration")
        })?,
    })
}

fn queue_claim_lost(_lease_token: &str) -> WorldError {
    WorldError::new(
        WorldErrorKind::QueueClaimLost,
        "queue lease is no longer current",
    )
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
              execution_context_cbor, attributes_json, encryption_public_key,
              next_event_slot, created_at_ms, started_at_ms, updated_at_ms,
              output, error, error_code, completed_at_ms
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12,
              ?13, ?14, ?15, ?16
            )
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
                    .map(encode_context_value)
                    .transpose()?,
                encode_attributes(&run.attributes)?,
                run.encryption_public_key,
                run.created_at_ms,
                run.started_at_ms,
                run.updated_at_ms,
                run.output,
                run.error,
                run.error_code,
                run.completed_at_ms,
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
            SET status = ?2,
                started_at_ms = ?3,
                updated_at_ms = ?4,
                output = ?5,
                error = ?6,
                error_code = ?7,
                completed_at_ms = ?8
            WHERE run_id = ?1
            "#,
            params![
                run.run_id,
                run.status.as_str(),
                run.started_at_ms,
                run.updated_at_ms,
                run.output,
                run.error,
                run.error_code,
                run.completed_at_ms,
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

fn insert_step(transaction: &Transaction<'_>, step: &WorkflowStep) -> Result<(), WorldError> {
    transaction
        .execute(
            r#"
            INSERT INTO workflow_steps (
              run_id, step_id, step_name, status, input, output, error, attempt,
              started_at_ms, completed_at_ms, created_at_ms, updated_at_ms,
              retry_after_ms, spec_version
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
            )
            "#,
            params![
                step.run_id,
                step.step_id,
                step.step_name,
                step.status.as_str(),
                step.input,
                step.output,
                step.error,
                i64::from(step.attempt),
                step.started_at_ms,
                step.completed_at_ms,
                step.created_at_ms,
                step.updated_at_ms,
                step.retry_after_ms,
                i64::from(step.spec_version),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn update_step(transaction: &Transaction<'_>, step: &WorkflowStep) -> Result<(), WorldError> {
    let changed = transaction
        .execute(
            r#"
            UPDATE workflow_steps
            SET step_name = ?3,
                status = ?4,
                input = ?5,
                output = ?6,
                error = ?7,
                attempt = ?8,
                started_at_ms = ?9,
                completed_at_ms = ?10,
                updated_at_ms = ?11,
                retry_after_ms = ?12,
                spec_version = ?13
            WHERE run_id = ?1 AND step_id = ?2
            "#,
            params![
                step.run_id,
                step.step_id,
                step.step_name,
                step.status.as_str(),
                step.input,
                step.output,
                step.error,
                i64::from(step.attempt),
                step.started_at_ms,
                step.completed_at_ms,
                step.updated_at_ms,
                step.retry_after_ms,
                i64::from(step.spec_version),
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(WorldError::new(
            WorldErrorKind::StepNotFound,
            format!(
                "step {:?} disappeared from run {:?} during update",
                step.step_id, step.run_id
            ),
        ));
    }
    Ok(())
}

fn read_step(
    connection: &Connection,
    run_id: &str,
    step_id: &str,
) -> Result<Option<WorkflowStep>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT step_name, status, input, output, error, attempt,
                   started_at_ms, completed_at_ms, created_at_ms, updated_at_ms,
                   retry_after_ms, spec_version
            FROM workflow_steps
            WHERE run_id = ?1 AND step_id = ?2
            "#,
            params![run_id, step_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, i64>(8)?,
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
                step_name,
                status,
                input,
                output,
                error,
                attempt,
                started_at_ms,
                completed_at_ms,
                created_at_ms,
                updated_at_ms,
                retry_after_ms,
                spec_version,
            )| {
                Ok(WorkflowStep {
                    run_id: run_id.to_owned(),
                    step_id: step_id.to_owned(),
                    step_name,
                    status: StepStatus::try_from(status.as_str())?,
                    input,
                    output,
                    error,
                    attempt: to_u32(attempt, "step attempt")?,
                    started_at_ms,
                    completed_at_ms,
                    created_at_ms,
                    updated_at_ms,
                    retry_after_ms,
                    spec_version: to_u32(spec_version, "step spec version")?,
                })
            },
        )
        .transpose()
}

fn append_world_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    event: &UnpositionedWorldEvent,
) -> Result<WorldEvent, WorldError> {
    let slot = transaction
        .query_row(
            "SELECT next_event_slot FROM workflow_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(storage_error)?;
    let event_type = event.event.event_type();
    let event_data_present = i64::from(event.event.is_present());
    transaction
        .execute(
            r#"
            INSERT INTO workflow_events (
              run_id, slot, event_type, spec_version, event_data_present,
              created_at_ms, correlation_id, occurred_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                run_id,
                slot,
                event_type.as_str(),
                i64::from(event.spec_version),
                event_data_present,
                event.created_at_ms,
                event.event.correlation_id(),
                event.occurred_at_ms,
            ],
        )
        .map_err(storage_error)?;

    match &event.event {
        WorldEventData::RunCreated(data) => {
            transaction
                .execute(
                    r#"
                    INSERT INTO workflow_run_created_event_data (
                      run_id, slot, deployment_id, workflow_name, input,
                      execution_context_cbor, attributes_json,
                      allow_reserved_attributes, encryption_public_key
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
                            .map(encode_context_value)
                            .transpose()?,
                        data.attributes
                            .as_ref()
                            .map(encode_attributes)
                            .transpose()?,
                        i64::from(data.allow_reserved_attributes),
                        data.encryption_public_key,
                    ],
                )
                .map_err(storage_error)?;
        }
        WorldEventData::RunStarted(_) => {}
        data if data.is_present() => insert_world_event_data(transaction, run_id, slot, data)?,
        _ => {}
    }

    advance_event_head(transaction, run_id, slot)?;
    Ok(WorldEvent {
        run_id: run_id.to_owned(),
        slot: to_u64(slot, "event slot")?,
        event: event.event.clone(),
        spec_version: event.spec_version,
        created_at_ms: event.created_at_ms,
        occurred_at_ms: event.occurred_at_ms,
    })
}

fn insert_world_event_data(
    transaction: &Transaction<'_>,
    run_id: &str,
    slot: i64,
    event: &WorldEventData,
) -> Result<(), WorldError> {
    let (payload, step_name, attempt, retry_after_ms, owner_message_id, error_code, cancel_reason) =
        match event {
            WorldEventData::RunCompleted { output } => {
                (output.as_deref(), None, None, None, None, None, None)
            }
            WorldEventData::RunFailed { error, error_code } => (
                Some(error.as_slice()),
                None,
                None,
                None,
                None,
                error_code.as_deref(),
                None,
            ),
            WorldEventData::RunCancelled { cancel_reason } => {
                (None, None, None, None, None, None, cancel_reason.as_deref())
            }
            WorldEventData::StepCreated {
                step_name, input, ..
            } => (
                Some(input.as_slice()),
                Some(step_name.as_str()),
                None,
                None,
                None,
                None,
                None,
            ),
            WorldEventData::StepStarted {
                step_name,
                attempt,
                owner_message_id,
                ..
            } => (
                None,
                step_name.as_deref(),
                attempt.map(i64::from),
                None,
                owner_message_id.as_deref(),
                None,
                None,
            ),
            WorldEventData::StepCompleted {
                step_name, result, ..
            } => (
                Some(result.as_slice()),
                step_name.as_deref(),
                None,
                None,
                None,
                None,
                None,
            ),
            WorldEventData::StepFailed {
                step_name, error, ..
            } => (
                Some(error.as_slice()),
                step_name.as_deref(),
                None,
                None,
                None,
                None,
                None,
            ),
            WorldEventData::StepRetrying {
                step_name,
                error,
                retry_after_ms,
                ..
            } => (
                Some(error.as_slice()),
                step_name.as_deref(),
                None,
                *retry_after_ms,
                None,
                None,
                None,
            ),
            WorldEventData::RunCreated(_) | WorldEventData::RunStarted(_) => {
                return Err(WorldError::new(
                    WorldErrorKind::Storage,
                    "internal event-data table received an unsupported event",
                ));
            }
        };
    transaction
        .execute(
            r#"
            INSERT INTO workflow_event_data (
              run_id, slot, data_kind, payload, step_name, attempt,
              retry_after_ms, owner_message_id, error_code, cancel_reason
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                run_id,
                slot,
                event.event_type().as_str(),
                payload,
                step_name,
                attempt,
                retry_after_ms,
                owner_message_id,
                error_code,
                cancel_reason,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn advance_event_head(
    transaction: &Transaction<'_>,
    run_id: &str,
    slot: i64,
) -> Result<(), WorldError> {
    let next_slot = slot
        .checked_add(1)
        .ok_or_else(|| WorldError::persisted_data("event slot overflow"))?;
    let changed = transaction
        .execute(
            r#"
            UPDATE workflow_runs
            SET next_event_slot = ?2
            WHERE run_id = ?1 AND next_event_slot = ?2 - 1
            "#,
            params![run_id, next_slot],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(WorldError::new(
            WorldErrorKind::Storage,
            format!("event slot {slot} for run {run_id:?} lost its transaction owner"),
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
                  run_id, slot, deployment_id, workflow_name, input, execution_context_cbor,
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
                        .map(encode_context_value)
                        .transpose()?,
                    data.attributes
                        .as_ref()
                        .map(encode_attributes)
                        .transpose()?,
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
                   execution_context_cbor, attributes_json, encryption_public_key,
                   created_at_ms, started_at_ms, updated_at_ms,
                   output, error, error_code, completed_at_ms
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
                    row.get::<_, Option<Vec<u8>>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<Vec<u8>>>(12)?,
                    row.get::<_, Option<Vec<u8>>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                    row.get::<_, Option<i64>>(15)?,
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
                execution_context_cbor,
                attributes_json,
                encryption_public_key,
                created_at_ms,
                started_at_ms,
                updated_at_ms,
                output,
                error,
                error_code,
                completed_at_ms,
            )| {
                Ok(WorkflowRun {
                    run_id,
                    status: RunStatus::try_from(status.as_str())?,
                    deployment_id,
                    workflow_name,
                    spec_version: to_u32(spec_version, "run spec version")?,
                    input,
                    output,
                    error,
                    error_code,
                    execution_context: execution_context_cbor
                        .as_deref()
                        .map(decode_context_value)
                        .transpose()?,
                    attributes: decode_attributes(&attributes_json)?,
                    encryption_public_key,
                    created_at_ms,
                    started_at_ms,
                    completed_at_ms,
                    updated_at_ms,
                })
            },
        )
        .transpose()
}

#[derive(Debug)]
struct StoredWorldEventData {
    data_kind: String,
    payload: Option<Vec<u8>>,
    step_name: Option<String>,
    attempt: Option<i64>,
    retry_after_ms: Option<i64>,
    owner_message_id: Option<String>,
    error_code: Option<String>,
    cancel_reason: Option<String>,
}

fn read_world_event(
    connection: &Connection,
    run_id: &str,
    slot: u64,
) -> Result<Option<WorldEvent>, WorldError> {
    let slot_i64 = i64::try_from(slot)
        .map_err(|_| WorldError::invalid_request("event slot exceeds SQLite integer range"))?;
    let base = connection
        .query_row(
            r#"
            SELECT event_type, spec_version, event_data_present, created_at_ms,
                   correlation_id, occurred_at_ms
            FROM workflow_events
            WHERE run_id = ?1 AND slot = ?2
            "#,
            params![run_id, slot_i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?;
    let Some((
        event_type,
        spec_version,
        event_data_present,
        created_at_ms,
        correlation_id,
        occurred_at_ms,
    )) = base
    else {
        return Ok(None);
    };
    let event_type = EventType::try_from(event_type.as_str())?;
    let data_present = match event_data_present {
        0 => false,
        1 => true,
        other => {
            return Err(WorldError::persisted_data(format!(
                "event {run_id:?}/{slot} has invalid event_data_present value {other}"
            )));
        }
    };
    let stored_data = read_stored_world_event_data(connection, run_id, slot_i64)?;
    let event = match event_type {
        EventType::RunCreated => {
            if !data_present || stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            WorldEventData::RunCreated(read_run_created_event_data(connection, run_id, slot_i64)?)
        }
        EventType::RunStarted => {
            if data_present || stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            WorldEventData::RunStarted(None)
        }
        EventType::RunCompleted => {
            let data = require_stored_world_event_data(
                stored_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::RunCompleted {
                output: data.payload,
            }
        }
        EventType::RunFailed => {
            let data = require_stored_world_event_data(
                stored_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::RunFailed {
                error: data
                    .payload
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "run_failed payload"))?,
                error_code: data.error_code,
            }
        }
        EventType::RunCancelled => {
            let cancel_reason = match (data_present, stored_data) {
                (false, None) => None,
                (true, Some(data)) if data.data_kind == event_type.as_str() => data.cancel_reason,
                _ => return Err(invalid_event_data_shape(run_id, slot, event_type)),
            };
            WorldEventData::RunCancelled { cancel_reason }
        }
        EventType::StepCreated => {
            let step_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_world_event_data(
                stored_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::StepCreated {
                step_id,
                step_name: data.step_name.ok_or_else(|| {
                    missing_event_data(run_id, slot_i64, "step_created step_name")
                })?,
                input: data
                    .payload
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "step_created payload"))?,
            }
        }
        EventType::StepStarted => {
            let step_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let (step_name, attempt, owner_message_id) = match (data_present, stored_data) {
                (false, None) => (None, None, None),
                (true, Some(data)) if data.data_kind == event_type.as_str() => (
                    data.step_name,
                    data.attempt
                        .map(|attempt| to_u32(attempt, "step_started attempt"))
                        .transpose()?,
                    data.owner_message_id,
                ),
                _ => return Err(invalid_event_data_shape(run_id, slot, event_type)),
            };
            WorldEventData::StepStarted {
                step_id,
                step_name,
                input: None,
                attempt,
                owner_message_id,
            }
        }
        EventType::StepCompleted => {
            let step_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_world_event_data(
                stored_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::StepCompleted {
                step_id,
                step_name: data.step_name,
                result: data.payload.ok_or_else(|| {
                    missing_event_data(run_id, slot_i64, "step_completed payload")
                })?,
            }
        }
        EventType::StepFailed => {
            let step_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_world_event_data(
                stored_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::StepFailed {
                step_id,
                step_name: data.step_name,
                error: data
                    .payload
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "step_failed payload"))?,
            }
        }
        EventType::StepRetrying => {
            let step_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_world_event_data(
                stored_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::StepRetrying {
                step_id,
                step_name: data.step_name,
                error: data
                    .payload
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "step_retrying payload"))?,
                retry_after_ms: data.retry_after_ms,
            }
        }
    };
    Ok(Some(WorldEvent {
        run_id: run_id.to_owned(),
        slot,
        event,
        spec_version: to_u32(spec_version, "event spec version")?,
        created_at_ms,
        occurred_at_ms,
    }))
}

fn read_run_created_event_data(
    connection: &Connection,
    run_id: &str,
    slot: i64,
) -> Result<RunCreatedEventData, WorldError> {
    connection
        .query_row(
            r#"
            SELECT deployment_id, workflow_name, input, execution_context_cbor,
                   attributes_json, allow_reserved_attributes, encryption_public_key
            FROM workflow_run_created_event_data
            WHERE run_id = ?1 AND slot = ?2
            "#,
            params![run_id, slot],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| missing_event_data(run_id, slot, "run_created data"))
        .and_then(
            |(
                deployment_id,
                workflow_name,
                input,
                execution_context_cbor,
                attributes_json,
                allow_reserved_attributes,
                encryption_public_key,
            )| {
                Ok(RunCreatedEventData {
                    deployment_id,
                    workflow_name,
                    input,
                    execution_context: execution_context_cbor
                        .as_deref()
                        .map(decode_context_value)
                        .transpose()?,
                    attributes: attributes_json
                        .as_deref()
                        .map(decode_attributes)
                        .transpose()?,
                    allow_reserved_attributes: match allow_reserved_attributes {
                        0 => false,
                        1 => true,
                        other => {
                            return Err(WorldError::persisted_data(format!(
                                "event {run_id:?}/{slot} has invalid allow_reserved_attributes value {other}"
                            )));
                        }
                    },
                    encryption_public_key,
                })
            },
        )
}

fn read_stored_world_event_data(
    connection: &Connection,
    run_id: &str,
    slot: i64,
) -> Result<Option<StoredWorldEventData>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT data_kind, payload, step_name, attempt, retry_after_ms,
                   owner_message_id, error_code, cancel_reason
            FROM workflow_event_data
            WHERE run_id = ?1 AND slot = ?2
            "#,
            params![run_id, slot],
            |row| {
                Ok(StoredWorldEventData {
                    data_kind: row.get(0)?,
                    payload: row.get(1)?,
                    step_name: row.get(2)?,
                    attempt: row.get(3)?,
                    retry_after_ms: row.get(4)?,
                    owner_message_id: row.get(5)?,
                    error_code: row.get(6)?,
                    cancel_reason: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(storage_error)
}

fn require_stored_world_event_data(
    data: Option<StoredWorldEventData>,
    data_present: bool,
    run_id: &str,
    slot: u64,
    event_type: EventType,
) -> Result<StoredWorldEventData, WorldError> {
    match data {
        Some(data) if data_present && data.data_kind == event_type.as_str() => Ok(data),
        _ => Err(invalid_event_data_shape(run_id, slot, event_type)),
    }
}

fn invalid_event_data_shape(run_id: &str, slot: u64, event_type: EventType) -> WorldError {
    WorldError::persisted_data(format!(
        "event {run_id:?}/{slot} has invalid {} data columns",
        event_type.as_str()
    ))
}

fn require_correlation_id(
    correlation_id: Option<&str>,
    run_id: &str,
    slot: u64,
) -> Result<String, WorldError> {
    correlation_id.map(str::to_owned).ok_or_else(|| {
        WorldError::persisted_data(format!(
            "step event {run_id:?}/{slot} is missing its correlation ID"
        ))
    })
}

#[allow(clippy::too_many_arguments)]
fn read_world_event_page_in_transaction(
    connection: &Connection,
    run_id: &str,
    correlation_id: Option<&str>,
    cursor_slot: u64,
    max_slot: u64,
    limit: usize,
    descending: bool,
) -> Result<WorldEventPage, WorldError> {
    let comparison = if descending { "<" } else { ">" };
    let order = if descending { "DESC" } else { "ASC" };
    let query = format!(
        r#"
        SELECT slot
        FROM workflow_events
        WHERE run_id = ?1
          AND (?2 IS NULL OR correlation_id = ?2)
          AND slot {comparison} ?3
          AND slot <= ?4
        ORDER BY slot {order}
        LIMIT ?5
        "#
    );
    let cursor_slot = i64::try_from(cursor_slot)
        .map_err(|_| WorldError::invalid_request("event cursor exceeds SQLite integer range"))?;
    let max_slot = i64::try_from(max_slot)
        .map_err(|_| WorldError::invalid_request("event range exceeds SQLite integer range"))?;
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;
    let slots = {
        let mut statement = connection.prepare(&query).map_err(storage_error)?;
        statement
            .query_map(
                params![run_id, correlation_id, cursor_slot, max_slot, fetch_limit],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };
    let has_more = slots.len() > limit;
    let mut data = Vec::with_capacity(slots.len().min(limit));
    for slot in slots.into_iter().take(limit) {
        let slot = to_u64(slot, "event slot")?;
        data.push(read_world_event(connection, run_id, slot)?.ok_or_else(|| {
            WorldError::persisted_data(format!("listed event {run_id:?}/{slot} disappeared"))
        })?);
    }
    let cursor = data
        .last()
        .map(|event| slot_to_event_id(event.slot))
        .transpose()?;
    Ok(WorldEventPage {
        data,
        cursor,
        has_more,
    })
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
                   d.deployment_id, d.workflow_name, d.input, d.execution_context_cbor,
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
                row.get::<_, Option<Vec<u8>>>(8)?,
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
            execution_context_cbor,
            attributes_json,
            allow_reserved_attributes,
            encryption_public_key,
        ) = row.map_err(storage_error)?;
        let has_run_created_columns = deployment_id.is_some()
            || workflow_name.is_some()
            || input.is_some()
            || execution_context_cbor.is_some()
            || attributes_json.is_some()
            || allow_reserved_attributes.is_some()
            || encryption_public_key.is_some();
        let event_data = if event_type == EventType::RunCreated.as_str() {
            if event_data_present != 1 {
                return Err(WorldError::persisted_data(format!(
                    "event {run_id:?}/{slot} has invalid run_created data presence"
                )));
            }
            Some(RunCreatedEventData {
                deployment_id: deployment_id
                    .ok_or_else(|| missing_event_data(run_id, slot, "deployment_id"))?,
                workflow_name: workflow_name
                    .ok_or_else(|| missing_event_data(run_id, slot, "workflow_name"))?,
                input: input.ok_or_else(|| missing_event_data(run_id, slot, "input"))?,
                execution_context: execution_context_cbor
                    .as_deref()
                    .map(decode_context_value)
                    .transpose()?,
                attributes: attributes_json
                    .as_deref()
                    .map(decode_attributes)
                    .transpose()?,
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
            })
        } else {
            if has_run_created_columns {
                return Err(WorldError::persisted_data(format!(
                    "event {run_id:?}/{slot} has unexpected run_created data columns"
                )));
            }
            if !matches!(event_data_present, 0 | 1) {
                return Err(WorldError::persisted_data(format!(
                    "event {run_id:?}/{slot} has invalid event_data_present value {event_data_present}"
                )));
            }
            None
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

fn encode_attributes(
    attributes: &std::collections::BTreeMap<String, String>,
) -> Result<String, WorldError> {
    serde_json::to_string(attributes).map_err(persisted_data_error)
}

fn decode_attributes(text: &str) -> Result<std::collections::BTreeMap<String, String>, WorldError> {
    serde_json::from_str(text).map_err(persisted_data_error)
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
