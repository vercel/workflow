//! Experimental SQLite backend for the portable local World profile.
//!
//! The pre-release schema covers the current event vocabulary, materialized
//! runs, steps, Hooks and waits, durable streams, checksummed migrations, and a
//! leased loopback-HTTP queue with active-run recovery. It is a local
//! development profile with `synchronous=NORMAL`, not a production or
//! power-loss durability claim.

#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, ffi::ErrorCode,
    params,
};
use sha2::{Digest, Sha256};
use workflow_protocol::{
    AttributeChange, AttributeWriter, CreateEventResult, CreateWorldEventRequest, EventPage,
    EventType, QueueClaim, QueueEnqueueResult, QueueMessageRequest, QueueReconcileResult,
    RunCreatedEventData, RunStartedRequest, RunStatus, StepStatus, StoredEvent,
    UnpositionedWorldEvent, WaitStatus, WorkflowHook, WorkflowRun, WorkflowRunPage, WorkflowStep,
    WorkflowStepPage, WorkflowWait, WorldError, WorldErrorKind, WorldEvent, WorldEventData,
    WorldEventPage, WorldEventResult, WorldSnapshot, decode_context_value, encode_context_value,
    event_id_to_slot, slot_to_event_id,
};
use workflow_world_core::{WorldEventState, plan_run_started, plan_world_event_with_state};

use crate::migrations::{
    AppliedMigration, MIGRATIONS, current_schema_version, validate_applied_history,
    validate_registry,
};

const PRELOAD_LIMIT: usize = 100;
const MIGRATION_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const MAX_STREAM_CHUNK_INDEX: u64 = 9_007_199_254_740_991;
const STREAM_CURSOR_PREFIX: &str = "index:";
const PAGE_CURSOR_PREFIX: &str = "page:v1:";

thread_local! {
    static OPERATION_STARTED_AT: RefCell<Option<Instant>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct RuntimeEngineState {
    checked_out: bool,
    connection: Option<CachedConnection>,
}

struct CachedConnection {
    connection: Connection,
    read_only: bool,
}

#[derive(Default)]
struct RuntimeEngine {
    state: Mutex<RuntimeEngineState>,
    available: Condvar,
}

static RUNTIME_ENGINES: OnceLock<Mutex<HashMap<PathBuf, Weak<RuntimeEngine>>>> = OnceLock::new();

struct EngineLane {
    engine: Arc<RuntimeEngine>,
    started_at: Instant,
    released: bool,
}

impl EngineLane {
    fn acquire(engine: Arc<RuntimeEngine>, budget: Duration) -> Result<Self, WorldError> {
        let started_at = Instant::now();
        let mut state = engine.state.lock().map_err(|_| engine_poisoned_error())?;
        while state.checked_out {
            let remaining = budget.saturating_sub(started_at.elapsed());
            if remaining.is_zero() {
                return Err(storage_busy_error("writer_lane", started_at.elapsed()));
            }
            let (next_state, timeout) = engine
                .available
                .wait_timeout(state, remaining)
                .map_err(|_| engine_poisoned_error())?;
            state = next_state;
            if timeout.timed_out() && state.checked_out {
                return Err(storage_busy_error("writer_lane", started_at.elapsed()));
            }
        }
        state.checked_out = true;
        drop(state);
        OPERATION_STARTED_AT.with(|value| *value.borrow_mut() = Some(started_at));
        Ok(Self {
            engine,
            started_at,
            released: false,
        })
    }

    fn remaining(&self, budget: Duration) -> Result<Duration, WorldError> {
        let remaining = budget.saturating_sub(self.started_at.elapsed());
        if remaining.is_zero() {
            Err(storage_busy_error(
                "connection_acquisition",
                self.started_at.elapsed(),
            ))
        } else {
            Ok(remaining)
        }
    }

    fn take_cached_connection(&self, read_only: bool) -> Result<Option<Connection>, WorldError> {
        let cached = self
            .engine
            .state
            .lock()
            .map_err(|_| engine_poisoned_error())
            .map(|mut state| state.connection.take())?;
        Ok(cached.and_then(|cached| (cached.read_only == read_only).then_some(cached.connection)))
    }

    fn discard_cached_connection(&self) -> Result<(), WorldError> {
        self.engine
            .state
            .lock()
            .map_err(|_| engine_poisoned_error())?
            .connection
            .take();
        Ok(())
    }

    fn into_connection(
        mut self,
        connection: Connection,
        read_only: bool,
        cache_on_drop: bool,
    ) -> EngineConnection {
        self.released = true;
        EngineConnection {
            engine: Arc::clone(&self.engine),
            connection: Some(connection),
            read_only,
            cache_on_drop,
        }
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        OPERATION_STARTED_AT.with(|value| *value.borrow_mut() = None);
        let mut state = self
            .engine
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.checked_out = false;
        self.engine.available.notify_one();
    }
}

impl Drop for EngineLane {
    fn drop(&mut self) {
        self.release();
    }
}

struct EngineConnection {
    engine: Arc<RuntimeEngine>,
    connection: Option<Connection>,
    read_only: bool,
    cache_on_drop: bool,
}

impl EngineConnection {
    fn discard(&mut self) {
        self.cache_on_drop = false;
    }
}

impl Deref for EngineConnection {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.connection
            .as_ref()
            .expect("engine connection must exist until drop")
    }
}

impl DerefMut for EngineConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection
            .as_mut()
            .expect("engine connection must exist until drop")
    }
}

impl Drop for EngineConnection {
    fn drop(&mut self) {
        OPERATION_STARTED_AT.with(|value| *value.borrow_mut() = None);
        let connection = self.connection.take();
        let mut state = self
            .engine
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.cache_on_drop {
            state.connection = connection.map(|connection| CachedConnection {
                connection,
                read_only: self.read_only,
            });
        }
        state.checked_out = false;
        self.engine.available.notify_one();
    }
}

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamChunk {
    pub index: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamChunkPage {
    pub data: Vec<StreamChunk>,
    pub cursor: Option<String>,
    pub has_more: bool,
    pub done: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamInfo {
    pub tail_index: i64,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowHookPage {
    pub data: Vec<WorkflowHook>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone)]
pub struct SqliteWorld {
    path: PathBuf,
    busy_timeout: Duration,
    read_only: bool,
    engine: Arc<RuntimeEngine>,
}

impl fmt::Debug for SqliteWorld {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SqliteWorld")
            .field("path", &self.path)
            .field("busy_timeout", &self.busy_timeout)
            .field("read_only", &self.read_only)
            .finish_non_exhaustive()
    }
}

impl SqliteWorld {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = resolve_database_identity(path.into());
        Self {
            engine: runtime_engine(&path),
            path,
            busy_timeout: Duration::from_secs(5),
            read_only: false,
        }
    }

    #[must_use]
    pub fn new_read_only(path: impl Into<PathBuf>) -> Self {
        let mut world = Self::new(path);
        world.read_only = true;
        world
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
        self.require_writable()?;
        validate_registry()?;
        prepare_database_path(&self.path)?;
        let lane = EngineLane::acquire(Arc::clone(&self.engine), self.busy_timeout)?;
        lane.discard_cached_connection()?;
        let remaining = lane.remaining(self.busy_timeout)?;
        let result =
            retry_with_busy_budget(remaining, MIGRATION_RETRY_INTERVAL, |attempt_timeout| {
                self.migrate_once(attempt_timeout)
            });
        drop(lane);
        result?;
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
        drop(connection);
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

        let accepted_at_ms = now_ms()?;
        prune_expired_hooks(&transaction, accepted_at_ms)?;
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

        if let Some(existing) = read_committed_resume_event(&transaction, request)? {
            transaction.commit().map_err(storage_error)?;
            return Ok(WorldEventResult {
                event: Some(existing),
                ..WorldEventResult::default()
            });
        }

        let current_step = match &request.event {
            WorldEventData::StepCreated { step_id, .. }
            | WorldEventData::StepStarted { step_id, .. }
            | WorldEventData::StepCompleted { step_id, .. }
            | WorldEventData::StepFailed { step_id, .. }
            | WorldEventData::StepRetrying { step_id, .. } => {
                read_step(&transaction, &request.run_id, step_id)?
            }
            _ => None,
        };
        let hook_with_id = match &request.event {
            WorldEventData::HookCreated { hook_id, .. }
            | WorldEventData::HookReceived { hook_id, .. }
            | WorldEventData::HookDisposed { hook_id, .. } => read_hook(&transaction, hook_id)?,
            _ => None,
        };
        let current_hook = hook_with_id
            .as_ref()
            .filter(|hook| hook.run_id == request.run_id);
        let hook_with_token = match &request.event {
            WorldEventData::HookCreated { token, .. } => read_hook_by_token(&transaction, token)?,
            _ => None,
        };
        let current_wait = match &request.event {
            WorldEventData::WaitCreated { wait_id, .. }
            | WorldEventData::WaitCompleted { wait_id, .. } => {
                read_wait(&transaction, &request.run_id, wait_id)?
            }
            _ => None,
        };
        let plan = plan_world_event_with_state(
            WorldEventState {
                run: current_run.as_ref(),
                step: current_step.as_ref(),
                hook: current_hook,
                hook_with_id: hook_with_id.as_ref(),
                hook_with_token: hook_with_token.as_ref(),
                wait: current_wait.as_ref(),
            },
            request,
            accepted_at_ms,
        )?;

        // Validate and plan before checking the durable correlation claim so
        // an invalid first attempt never claims an operation. Because this is
        // an IMMEDIATE transaction, the precheck and the partial unique index
        // together serialize sequential and cross-process replays. Checking
        // before applying the plan also prevents a disposed Hook from being
        // resurrected by replaying its original hook_created correlation.
        reject_duplicate_entity_creation(&transaction, request)?;

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
        if plan.cleanup_hooks_for_run {
            delete_unretained_hooks_for_run(&transaction, &request.run_id, accepted_at_ms)?;
        }
        if plan.delete_waits_for_run {
            transaction
                .execute(
                    "DELETE FROM workflow_waits WHERE run_id = ?1",
                    [&request.run_id],
                )
                .map_err(storage_error)?;
        }
        if let Some(hook) = &plan.hook {
            if plan.insert_hook {
                insert_hook(&transaction, hook)?;
            } else if plan.delete_hook {
                delete_hook(&transaction, hook)?;
            }
        }
        if let Some(wait) = &plan.wait {
            if plan.insert_wait {
                let correlation_id = request.event.correlation_id().ok_or_else(|| {
                    WorldError::new(
                        WorldErrorKind::Storage,
                        "wait insertion plan is missing its correlation ID",
                    )
                })?;
                insert_wait(&transaction, wait, correlation_id)?;
            } else {
                update_wait(&transaction, wait)?;
            }
        }

        let mut appended = Vec::with_capacity(plan.events.len());
        for event in &plan.events {
            appended.push(append_world_event(
                &transaction,
                &request.run_id,
                event,
                request.resume_payload_digest.as_deref(),
            )?);
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
            hook: plan.hook,
            wait: plan.wait,
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
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let page = list_runs(
            &transaction,
            workflow_name,
            status,
            cursor,
            limit,
            descending,
        )?;
        transaction.commit().map_err(storage_error)?;
        Ok(page)
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
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let page = list_steps(&transaction, run_id, cursor, limit, descending)?;
        transaction.commit().map_err(storage_error)?;
        Ok(page)
    }

    pub fn get_hook(&self, hook_id: &str) -> Result<WorkflowHook, WorldError> {
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        read_available_hook(&connection, hook_id, now_ms()?)?.ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::HookNotFound,
                format!("Hook {hook_id:?} was not found"),
            )
            .with_details(serde_json::json!({ "identifier": hook_id }))
        })
    }

    pub fn get_hook_by_token(&self, token: &str) -> Result<WorkflowHook, WorldError> {
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        read_available_hook_by_token(&connection, token, now_ms()?)?.ok_or_else(|| {
            WorldError::new(
                WorldErrorKind::HookNotFound,
                format!("Hook token {token:?} was not found"),
            )
            .with_details(serde_json::json!({ "identifier": token }))
        })
    }

    pub fn list_hooks(
        &self,
        run_id: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
        descending: bool,
    ) -> Result<WorkflowHookPage, WorldError> {
        validate_page_limit(limit)?;
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let page = list_hooks(&transaction, run_id, cursor, limit, descending, now_ms()?)?;
        transaction.commit().map_err(storage_error)?;
        Ok(page)
    }

    /// Clear all data owned by this selected database while preserving its schema.
    pub fn clear(&self) -> Result<(), WorldError> {
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        transaction
            .execute("DELETE FROM workflow_queue_messages", [])
            .map_err(storage_error)?;
        transaction
            .execute("DELETE FROM workflow_streams", [])
            .map_err(storage_error)?;
        transaction
            .execute("DELETE FROM workflow_runs", [])
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }

    /// Append one binary chunk and return its durable zero-based index.
    pub fn write_stream_chunk(
        &self,
        run_id: &str,
        name: &str,
        data: &[u8],
    ) -> Result<StreamChunk, WorldError> {
        let chunks = [data.to_vec()];
        self.write_stream_chunks(run_id, name, &chunks)?
            .into_iter()
            .next()
            .ok_or_else(|| {
                WorldError::new(
                    WorldErrorKind::Storage,
                    "internal stream write returned no chunk",
                )
            })
    }

    /// Atomically append a group of binary chunks at consecutive indices.
    pub fn write_stream_chunks(
        &self,
        run_id: &str,
        name: &str,
        chunks: &[Vec<u8>],
    ) -> Result<Vec<StreamChunk>, WorldError> {
        validate_stream_identity(run_id, name)?;
        if chunks.is_empty() {
            self.ensure_ready()?;
            return Ok(Vec::new());
        }

        let chunk_count = u64::try_from(chunks.len())
            .map_err(|_| WorldError::invalid_request("stream chunk count overflow"))?;
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        transaction
            .execute(
                r#"
                INSERT INTO workflow_streams (
                  run_id, name, next_chunk_index, closed
                ) VALUES (?1, ?2, 0, 0)
                ON CONFLICT (run_id, name) DO NOTHING
                "#,
                params![run_id, name],
            )
            .map_err(storage_error)?;

        let (first_index, closed) = transaction
            .query_row(
                r#"
                SELECT next_chunk_index, closed
                FROM workflow_streams
                WHERE run_id = ?1 AND name = ?2
                "#,
                params![run_id, name],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(storage_error)?;
        if closed != 0 {
            return Err(WorldError::new(
                WorldErrorKind::EntityConflict,
                format!("stream {name:?} in run {run_id:?} is already closed"),
            ));
        }
        let first_index = to_u64(first_index, "stream next chunk index")?;
        let next_index = first_index.checked_add(chunk_count).ok_or_else(|| {
            WorldError::invalid_request("stream chunk index exceeds the supported range")
        })?;
        if next_index > MAX_STREAM_CHUNK_INDEX + 1 {
            return Err(WorldError::invalid_request(
                "stream chunk index exceeds the supported range",
            ));
        }

        let mut inserted_indices = Vec::with_capacity(chunks.len());
        {
            let mut statement = transaction
                .prepare(
                    r#"
                    INSERT INTO workflow_stream_chunks (
                      run_id, name, chunk_index, data
                    ) VALUES (?1, ?2, ?3, ?4)
                    "#,
                )
                .map_err(storage_error)?;
            for (offset, data) in chunks.iter().enumerate() {
                let offset = u64::try_from(offset)
                    .map_err(|_| WorldError::invalid_request("stream chunk offset overflow"))?;
                let index = first_index.checked_add(offset).ok_or_else(|| {
                    WorldError::invalid_request("stream chunk index exceeds the supported range")
                })?;
                let sqlite_index = i64::try_from(index).map_err(|_| {
                    WorldError::invalid_request("stream chunk index exceeds SQLite integer range")
                })?;
                statement
                    .execute(params![run_id, name, sqlite_index, data])
                    .map_err(storage_error)?;
                inserted_indices.push(index);
            }
        }
        transaction
            .execute(
                r#"
                UPDATE workflow_streams
                SET next_chunk_index = ?3
                WHERE run_id = ?1 AND name = ?2
                "#,
                params![
                    run_id,
                    name,
                    i64::try_from(next_index).map_err(|_| {
                        WorldError::invalid_request(
                            "stream next chunk index exceeds SQLite integer range",
                        )
                    })?
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(inserted_indices
            .into_iter()
            .zip(chunks)
            .map(|(index, data)| StreamChunk {
                index,
                data: data.clone(),
            })
            .collect())
    }

    /// Mark a stream complete. Closing an absent stream creates an empty stream.
    pub fn close_stream(&self, run_id: &str, name: &str) -> Result<(), WorldError> {
        validate_stream_identity(run_id, name)?;
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        transaction
            .execute(
                r#"
                INSERT INTO workflow_streams (
                  run_id, name, next_chunk_index, closed
                ) VALUES (?1, ?2, 0, 1)
                ON CONFLICT (run_id, name) DO UPDATE SET closed = 1
                "#,
                params![run_id, name],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }

    /// List every open or closed stream owned by a run.
    pub fn list_streams(&self, run_id: &str) -> Result<Vec<String>, WorldError> {
        if run_id.is_empty() {
            return Err(WorldError::invalid_request(
                "stream run ID must not be empty",
            ));
        }
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        let mut statement = connection
            .prepare(
                r#"
                SELECT name
                FROM workflow_streams
                WHERE run_id = ?1
                ORDER BY name ASC
                "#,
            )
            .map_err(storage_error)?;
        statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)
    }

    /// Read one snapshot page of already-persisted stream chunks.
    pub fn get_stream_chunks(
        &self,
        run_id: &str,
        name: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<StreamChunkPage, WorldError> {
        validate_stream_identity(run_id, name)?;
        validate_page_limit(limit)?;
        let start_index = cursor.map(parse_stream_cursor).transpose()?.unwrap_or(0);
        let sqlite_start = i64::try_from(start_index).map_err(|_| {
            WorldError::invalid_request("stream cursor exceeds SQLite integer range")
        })?;
        let fetch_limit = i64::try_from(limit + 1)
            .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;

        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let stream = read_stream_state(&transaction, run_id, name)?;
        let done = stream.is_some_and(|(_, closed)| closed);
        let rows = {
            let mut statement = transaction
                .prepare(
                    r#"
                    SELECT chunk_index, data
                    FROM workflow_stream_chunks
                    WHERE run_id = ?1 AND name = ?2 AND chunk_index >= ?3
                    ORDER BY chunk_index ASC
                    LIMIT ?4
                    "#,
                )
                .map_err(storage_error)?;
            statement
                .query_map(params![run_id, name, sqlite_start, fetch_limit], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(storage_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        let has_more = rows.len() > limit;
        let mut data = Vec::with_capacity(rows.len().min(limit));
        for (index, bytes) in rows.into_iter().take(limit) {
            data.push(StreamChunk {
                index: to_u64(index, "stream chunk index")?,
                data: bytes,
            });
        }
        let cursor = if has_more {
            let next = data
                .last()
                .ok_or_else(|| {
                    WorldError::new(
                        WorldErrorKind::Storage,
                        "stream page reports more data without a chunk",
                    )
                })?
                .index
                .checked_add(1)
                .ok_or_else(|| WorldError::persisted_data("stream chunk index overflow"))?;
            Some(stream_cursor(next)?)
        } else {
            None
        };
        transaction.commit().map_err(storage_error)?;
        Ok(StreamChunkPage {
            data,
            cursor,
            has_more,
            done,
        })
    }

    /// Read the durable tail and completion marker for a stream.
    pub fn get_stream_info(&self, run_id: &str, name: &str) -> Result<StreamInfo, WorldError> {
        validate_stream_identity(run_id, name)?;
        let connection = self.open_runtime_connection()?;
        self.require_current_schema(&connection)?;
        let Some((next_index, done)) = read_stream_state(&connection, run_id, name)? else {
            return Ok(StreamInfo {
                tail_index: -1,
                done: false,
            });
        };
        let tail_index = if next_index == 0 {
            -1
        } else {
            i64::try_from(next_index - 1).map_err(|_| {
                WorldError::persisted_data("stream tail index exceeds SQLite integer range")
            })?
        };
        Ok(StreamInfo { tail_index, done })
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
                workflow_protocol::MAX_EVENT_SLOT + 1
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

    pub fn renew_queue_message(
        &self,
        lease_token: &str,
        now_ms: i64,
        lease_duration_ms: i64,
    ) -> Result<i64, WorldError> {
        if lease_token.is_empty() {
            return Err(WorldError::invalid_request(
                "queue lease token must not be empty",
            ));
        }
        if now_ms < 0 {
            return Err(WorldError::invalid_request(
                "queue lease renewal time must not be negative",
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
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let renewed_until_ms = transaction
            .query_row(
                r#"
                UPDATE workflow_queue_messages
                SET lease_expires_at_ms = MAX(lease_expires_at_ms, ?3),
                    updated_at_ms = ?2
                WHERE lease_token = ?1 AND lease_expires_at_ms > ?2
                RETURNING lease_expires_at_ms
                "#,
                params![lease_token, now_ms, lease_expires_at_ms],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| queue_claim_lost(lease_token))?;
        transaction.commit().map_err(storage_error)?;
        Ok(renewed_until_ms)
    }

    /// Record that a claimed delivery reached an HTTP handler response.
    ///
    /// Repeating this operation for the same candidate delivery is idempotent.
    /// Transport failures deliberately never call it, so reconnects retain the
    /// same handler-visible attempt number.
    pub fn record_queue_delivery_response(
        &self,
        lease_token: &str,
        delivery_attempt: u32,
        now_ms: i64,
    ) -> Result<String, WorldError> {
        if lease_token.is_empty() {
            return Err(WorldError::invalid_request(
                "queue lease token must not be empty",
            ));
        }
        if delivery_attempt == 0 {
            return Err(WorldError::invalid_request(
                "queue delivery attempt must be greater than zero",
            ));
        }
        if now_ms < 0 {
            return Err(WorldError::invalid_request(
                "queue delivery response time must not be negative",
            ));
        }
        let mut connection = self.open_runtime_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        self.require_current_schema(&transaction)?;
        let message_id = transaction
            .query_row(
                r#"
                UPDATE workflow_queue_messages
                SET delivery_attempt = MAX(delivery_attempt, ?2),
                    updated_at_ms = ?3
                WHERE lease_token = ?1 AND lease_expires_at_ms > ?3
                RETURNING message_id
                "#,
                params![lease_token, i64::from(delivery_attempt), now_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| queue_claim_lost(lease_token))?;
        transaction.commit().map_err(storage_error)?;
        Ok(message_id)
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

    fn open_runtime_connection(&self) -> Result<EngineConnection, WorldError> {
        if !self.path.exists() {
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                "SQLite World database does not exist; run migrate first",
            ));
        }
        let lane = EngineLane::acquire(Arc::clone(&self.engine), self.busy_timeout)?;
        let remaining = lane.remaining(self.busy_timeout)?;
        let connection = match lane.take_cached_connection(self.read_only)? {
            Some(connection) => connection,
            None => {
                let flags = if self.read_only {
                    OpenFlags::SQLITE_OPEN_READ_ONLY
                } else {
                    OpenFlags::SQLITE_OPEN_READ_WRITE
                };
                Connection::open_with_flags(&self.path, flags).map_err(|error| {
                    storage_error_at(error, "connection_acquisition", lane.started_at)
                })?
            }
        };
        let mut connection = lane.into_connection(connection, self.read_only, true);
        let configured = if self.read_only {
            Self::configure_read_only_connection(&connection, remaining)
        } else {
            Self::configure_connection_with_timeout(&connection, remaining)
        };
        if let Err(error) = configured {
            connection.discard();
            return Err(error);
        }
        Ok(connection)
    }

    fn open_inspection_connection(&self) -> Result<EngineConnection, WorldError> {
        if !self.path.exists() {
            return Err(WorldError::new(
                WorldErrorKind::NotMigrated,
                "SQLite World database does not exist; run migrate first",
            ));
        }
        let lane = EngineLane::acquire(Arc::clone(&self.engine), self.busy_timeout)?;
        lane.discard_cached_connection()?;
        let remaining = lane.remaining(self.busy_timeout)?;
        let connection = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| storage_error_at(error, "connection_acquisition", lane.started_at))?;
        connection.busy_timeout(remaining).map_err(storage_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage_error)?;
        Ok(lane.into_connection(connection, true, false))
    }

    fn configure_read_only_connection(
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

    fn configure_connection_with_timeout(
        connection: &Connection,
        busy_timeout: Duration,
    ) -> Result<(), WorldError> {
        connection
            .busy_timeout(busy_timeout)
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "wal_autocheckpoint", 1000_i64)
            .map_err(storage_error)?;
        require_connection_pragmas(connection)
    }

    fn require_writable(&self) -> Result<(), WorldError> {
        if self.read_only {
            Err(WorldError::invalid_request(
                "SQLite World was opened for read-only observability",
            ))
        } else {
            Ok(())
        }
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
        require_runtime_pragmas(connection)?;
        require_database_metadata(connection)
    }
}

fn require_connection_pragmas(connection: &Connection) -> Result<(), WorldError> {
    let foreign_keys = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
        .map_err(storage_error)?;
    let synchronous = connection
        .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
        .map_err(storage_error)?;
    let wal_autocheckpoint = connection
        .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get::<_, i64>(0))
        .map_err(storage_error)?;
    if foreign_keys != 1 || synchronous != 1 || wal_autocheckpoint != 1000 {
        return Err(WorldError::new(
            WorldErrorKind::Storage,
            "SQLite connection did not retain required runtime settings",
        )
        .with_details(serde_json::json!({
            "subsystem": "sqlite",
            "reason": "invalid_connection_pragmas",
            "foreignKeys": foreign_keys,
            "synchronous": synchronous,
            "walAutocheckpoint": wal_autocheckpoint,
        })));
    }
    Ok(())
}

fn require_runtime_pragmas(connection: &Connection) -> Result<(), WorldError> {
    let journal_mode = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(WorldError::new(
            WorldErrorKind::Storage,
            format!("SQLite World requires WAL journal mode, found {journal_mode:?}"),
        )
        .with_details(serde_json::json!({
            "subsystem": "sqlite",
            "reason": "journal_mode_not_wal",
            "journalMode": journal_mode,
        })));
    }
    Ok(())
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

fn validate_stream_identity(run_id: &str, name: &str) -> Result<(), WorldError> {
    if run_id.is_empty() {
        return Err(WorldError::invalid_request(
            "stream run ID must not be empty",
        ));
    }
    if name.is_empty() {
        return Err(WorldError::invalid_request("stream name must not be empty"));
    }
    Ok(())
}

fn reject_duplicate_entity_creation(
    connection: &Connection,
    request: &CreateWorldEventRequest,
) -> Result<(), WorldError> {
    let event_type = request.event.event_type();
    if !matches!(
        event_type,
        EventType::StepCreated
            | EventType::HookCreated
            | EventType::WaitCreated
            | EventType::AttrSet
    ) {
        return Ok(());
    }
    let Some(correlation_id) = request.event.correlation_id() else {
        return Ok(());
    };
    let exists = connection
        .query_row(
            r#"
            SELECT 1
            FROM workflow_events
            WHERE run_id = ?1 AND correlation_id = ?2 AND event_type = ?3
            LIMIT 1
            "#,
            params![request.run_id, correlation_id, event_type.as_str()],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage_error)?
        .is_some();
    if exists {
        return Err(WorldError::new(
            WorldErrorKind::EntityConflict,
            format!(
                "{} for correlation ID {correlation_id:?} already exists in run {:?}",
                event_type.as_str(),
                request.run_id
            ),
        ));
    }
    Ok(())
}

fn read_stream_state(
    connection: &Connection,
    run_id: &str,
    name: &str,
) -> Result<Option<(u64, bool)>, WorldError> {
    let state = connection
        .query_row(
            r#"
            SELECT next_chunk_index, closed
            FROM workflow_streams
            WHERE run_id = ?1 AND name = ?2
            "#,
            params![run_id, name],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((next_index, closed)) = state else {
        return Ok(None);
    };
    let next_index = to_u64(next_index, "stream next chunk index")?;
    if next_index > MAX_STREAM_CHUNK_INDEX + 1 || !matches!(closed, 0 | 1) {
        return Err(WorldError::persisted_data(format!(
            "stream {name:?} in run {run_id:?} has invalid durable state"
        )));
    }
    Ok(Some((next_index, closed == 1)))
}

fn stream_cursor(index: u64) -> Result<String, WorldError> {
    if index > MAX_STREAM_CHUNK_INDEX + 1 {
        return Err(WorldError::invalid_request(
            "stream cursor exceeds the supported index range",
        ));
    }
    Ok(format!("{STREAM_CURSOR_PREFIX}{index}"))
}

fn parse_stream_cursor(cursor: &str) -> Result<u64, WorldError> {
    let digits = cursor
        .strip_prefix(STREAM_CURSOR_PREFIX)
        .ok_or_else(|| WorldError::invalid_request(format!("invalid stream cursor: {cursor:?}")))?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(WorldError::invalid_request(format!(
            "invalid stream cursor: {cursor:?}"
        )));
    }
    let index = digits
        .parse::<u64>()
        .map_err(|_| WorldError::invalid_request(format!("invalid stream cursor: {cursor:?}")))?;
    if stream_cursor(index)?.as_str() != cursor {
        return Err(WorldError::invalid_request(format!(
            "non-canonical stream cursor: {cursor:?}"
        )));
    }
    Ok(index)
}

#[derive(Debug, Eq, PartialEq)]
struct PageCursor {
    created_at_ms: i64,
    id: String,
}

fn page_cursor(created_at_ms: i64, id: &str) -> String {
    let mut payload = Vec::with_capacity(size_of::<i64>() + id.len());
    payload.extend_from_slice(&created_at_ms.to_be_bytes());
    payload.extend_from_slice(id.as_bytes());

    let mut encoded = String::with_capacity(PAGE_CURSOR_PREFIX.len() + payload.len() * 2);
    encoded.push_str(PAGE_CURSOR_PREFIX);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in payload {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn parse_page_cursor(cursor: &str) -> Result<PageCursor, WorldError> {
    let encoded = cursor
        .strip_prefix(PAGE_CURSOR_PREFIX)
        .ok_or_else(|| WorldError::invalid_request(format!("invalid page cursor: {cursor:?}")))?;
    if encoded.len() < (size_of::<i64>() + 1) * 2 || encoded.len() % 2 != 0 {
        return Err(WorldError::invalid_request(format!(
            "invalid page cursor: {cursor:?}"
        )));
    }

    let mut payload = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        let high = decode_hex_nibble(pair[0]).ok_or_else(|| {
            WorldError::invalid_request(format!("invalid page cursor: {cursor:?}"))
        })?;
        let low = decode_hex_nibble(pair[1]).ok_or_else(|| {
            WorldError::invalid_request(format!("invalid page cursor: {cursor:?}"))
        })?;
        payload.push((high << 4) | low);
    }

    let timestamp = payload[..size_of::<i64>()]
        .try_into()
        .map_err(|_| WorldError::invalid_request("invalid page cursor timestamp"))?;
    let id = String::from_utf8(payload[size_of::<i64>()..].to_vec())
        .map_err(|_| WorldError::invalid_request("invalid page cursor identifier"))?;
    let parsed = PageCursor {
        created_at_ms: i64::from_be_bytes(timestamp),
        id,
    };
    if page_cursor(parsed.created_at_ms, &parsed.id) != cursor {
        return Err(WorldError::invalid_request(format!(
            "non-canonical page cursor: {cursor:?}"
        )));
    }
    Ok(parsed)
}

const fn decode_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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
    let cursor = cursor.map(parse_page_cursor).transpose()?;
    let query = format!(
        r#"
        SELECT run_id
        FROM workflow_runs
        WHERE (?1 IS NULL OR workflow_name = ?1)
          AND (?2 IS NULL OR status = ?2)
          AND (
            ?3 IS NULL
            OR created_at_ms {comparison} ?3
            OR (created_at_ms = ?3 AND run_id {comparison} ?4)
          )
        ORDER BY created_at_ms {order}, run_id {order}
        LIMIT ?5
        "#
    );
    let status = status.map(RunStatus::as_str);
    let cursor_created_at_ms = cursor.as_ref().map(|cursor| cursor.created_at_ms);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id.as_str());
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;
    let mut statement = connection.prepare(&query).map_err(storage_error)?;
    let ids = statement
        .query_map(
            params![
                workflow_name,
                status,
                cursor_created_at_ms,
                cursor_id,
                fetch_limit
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    #[cfg(test)]
    process_tests::pause_at_process_test_failpoint(None, "after_list_run_ids")?;
    let has_more = ids.len() > limit;
    let mut data = Vec::with_capacity(ids.len().min(limit));
    for run_id in ids.into_iter().take(limit) {
        data.push(read_run(connection, &run_id)?.ok_or_else(|| {
            WorldError::persisted_data(format!("listed run {run_id:?} disappeared"))
        })?);
    }
    let cursor = data
        .last()
        .map(|run| page_cursor(run.created_at_ms, &run.run_id));
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
    let cursor = cursor.map(parse_page_cursor).transpose()?;
    let query = format!(
        r#"
        SELECT step_id
        FROM workflow_steps
        WHERE run_id = ?1
          AND (
            ?2 IS NULL
            OR created_at_ms {comparison} ?2
            OR (created_at_ms = ?2 AND step_id {comparison} ?3)
          )
        ORDER BY created_at_ms {order}, step_id {order}
        LIMIT ?4
        "#
    );
    let cursor_created_at_ms = cursor.as_ref().map(|cursor| cursor.created_at_ms);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id.as_str());
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;
    let mut statement = connection.prepare(&query).map_err(storage_error)?;
    let ids = statement
        .query_map(
            params![run_id, cursor_created_at_ms, cursor_id, fetch_limit],
            |row| row.get::<_, String>(0),
        )
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    #[cfg(test)]
    process_tests::pause_at_process_test_failpoint(None, "after_list_step_ids")?;
    let has_more = ids.len() > limit;
    let mut data = Vec::with_capacity(ids.len().min(limit));
    for step_id in ids.into_iter().take(limit) {
        data.push(read_step(connection, run_id, &step_id)?.ok_or_else(|| {
            WorldError::persisted_data(format!("listed step {run_id:?}/{step_id:?} disappeared"))
        })?);
    }
    let cursor = data
        .last()
        .map(|step| page_cursor(step.created_at_ms, &step.step_id));
    Ok(WorkflowStepPage {
        data,
        cursor,
        has_more,
    })
}

fn list_hooks(
    connection: &Connection,
    run_id: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
    descending: bool,
    at_ms: i64,
) -> Result<WorkflowHookPage, WorldError> {
    let comparison = if descending { "<" } else { ">" };
    let order = if descending { "DESC" } else { "ASC" };
    let cursor = cursor.map(parse_page_cursor).transpose()?;
    let query = format!(
        r#"
        SELECT h.hook_id
        FROM workflow_hooks h
        JOIN workflow_runs r ON r.run_id = h.run_id
        WHERE (?1 IS NULL OR h.run_id = ?1)
          AND (
            ?2 IS NULL
            OR h.created_at_ms {comparison} ?2
            OR (h.created_at_ms = ?2 AND h.hook_id {comparison} ?3)
          )
          AND (
            r.status NOT IN ('completed', 'failed', 'cancelled')
            OR h.token_retention_until_ms > ?4
          )
        ORDER BY h.created_at_ms {order}, h.hook_id {order}
        LIMIT ?5
        "#
    );
    let cursor_created_at_ms = cursor.as_ref().map(|cursor| cursor.created_at_ms);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id.as_str());
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| WorldError::invalid_request("pagination limit overflow"))?;
    let mut statement = connection.prepare(&query).map_err(storage_error)?;
    let ids = statement
        .query_map(
            params![run_id, cursor_created_at_ms, cursor_id, at_ms, fetch_limit],
            |row| row.get::<_, String>(0),
        )
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    #[cfg(test)]
    process_tests::pause_at_process_test_failpoint(None, "after_list_hook_ids")?;
    let has_more = ids.len() > limit;
    let mut data = Vec::with_capacity(ids.len().min(limit));
    for hook_id in ids.into_iter().take(limit) {
        data.push(read_hook(connection, &hook_id)?.ok_or_else(|| {
            WorldError::persisted_data(format!("listed Hook {hook_id:?} disappeared"))
        })?);
    }
    let cursor = data
        .last()
        .map(|hook| page_cursor(hook.created_at_ms, &hook.hook_id));
    Ok(WorkflowHookPage {
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
        if existing.scope != request.scope
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
        delivery_attempt,
        lease_token,
        lease_owner,
        lease_expires_at_ms,
    ) = connection
        .query_row(
            r#"
            SELECT message_id, scope, queue_name, body, attempt,
                   delivery_attempt, lease_token, lease_owner,
                   lease_expires_at_ms
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
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
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
        delivery_attempt: to_u32(delivery_attempt, "queue delivery attempt")?
            .checked_add(1)
            .ok_or_else(|| WorldError::persisted_data("queue delivery attempt overflow"))?,
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
                completed_at_ms = ?8,
                attributes_json = ?9
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
                encode_attributes(&run.attributes)?,
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

fn insert_hook(transaction: &Transaction<'_>, hook: &WorkflowHook) -> Result<(), WorldError> {
    transaction
        .execute(
            r#"
            INSERT INTO workflow_hooks (
              hook_id, run_id, token, metadata, created_at_ms, spec_version,
              is_webhook, is_system, token_retention_until_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                hook.hook_id,
                hook.run_id,
                hook.token,
                hook.metadata,
                hook.created_at_ms,
                i64::from(hook.spec_version),
                i64::from(hook.is_webhook),
                i64::from(hook.is_system),
                hook.token_retention_until_ms,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn delete_hook(transaction: &Transaction<'_>, hook: &WorkflowHook) -> Result<(), WorldError> {
    let changed = transaction
        .execute(
            "DELETE FROM workflow_hooks WHERE hook_id = ?1 AND run_id = ?2",
            params![hook.hook_id, hook.run_id],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(WorldError::new(
            WorldErrorKind::HookNotFound,
            format!(
                "Hook {:?} disappeared from run {:?} during disposal",
                hook.hook_id, hook.run_id
            ),
        ));
    }
    Ok(())
}

fn read_hook(connection: &Connection, hook_id: &str) -> Result<Option<WorkflowHook>, WorldError> {
    read_hook_query(
        connection,
        r#"
        SELECT hook_id, run_id, token, metadata, created_at_ms, spec_version,
               is_webhook, is_system, token_retention_until_ms
        FROM workflow_hooks
        WHERE hook_id = ?1
        "#,
        hook_id,
    )
}

fn read_hook_by_token(
    connection: &Connection,
    token: &str,
) -> Result<Option<WorkflowHook>, WorldError> {
    read_hook_query(
        connection,
        r#"
        SELECT hook_id, run_id, token, metadata, created_at_ms, spec_version,
               is_webhook, is_system, token_retention_until_ms
        FROM workflow_hooks
        WHERE token = ?1
        "#,
        token,
    )
}

fn read_hook_query(
    connection: &Connection,
    query: &str,
    key: &str,
) -> Result<Option<WorkflowHook>, WorldError> {
    connection
        .query_row(query, [key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<Vec<u8>>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<i64>>(8)?,
            ))
        })
        .optional()
        .map_err(storage_error)?
        .map(
            |(
                hook_id,
                run_id,
                token,
                metadata,
                created_at_ms,
                spec_version,
                is_webhook,
                is_system,
                token_retention_until_ms,
            )| {
                Ok(WorkflowHook {
                    run_id,
                    hook_id,
                    token,
                    metadata,
                    created_at_ms,
                    spec_version: to_u32(spec_version, "Hook spec version")?,
                    is_webhook: decode_sqlite_bool(is_webhook, "Hook is_webhook")?,
                    is_system: decode_sqlite_bool(is_system, "Hook is_system")?,
                    token_retention_until_ms,
                })
            },
        )
        .transpose()
}

fn hook_is_available(
    connection: &Connection,
    hook: &WorkflowHook,
    at_ms: i64,
) -> Result<bool, WorldError> {
    let status = connection
        .query_row(
            "SELECT status FROM workflow_runs WHERE run_id = ?1",
            [&hook.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| {
            WorldError::persisted_data(format!(
                "Hook {:?} has no owning workflow run",
                hook.hook_id
            ))
        })?;
    let status = RunStatus::try_from(status.as_str())?;
    Ok(!status.is_terminal()
        || hook
            .token_retention_until_ms
            .is_some_and(|retention| retention > at_ms))
}

fn read_available_hook(
    connection: &Connection,
    hook_id: &str,
    at_ms: i64,
) -> Result<Option<WorkflowHook>, WorldError> {
    let hook = read_hook(connection, hook_id)?;
    match hook {
        Some(hook) if hook_is_available(connection, &hook, at_ms)? => Ok(Some(hook)),
        _ => Ok(None),
    }
}

fn read_available_hook_by_token(
    connection: &Connection,
    token: &str,
    at_ms: i64,
) -> Result<Option<WorkflowHook>, WorldError> {
    let hook = read_hook_by_token(connection, token)?;
    match hook {
        Some(hook) if hook_is_available(connection, &hook, at_ms)? => Ok(Some(hook)),
        _ => Ok(None),
    }
}

fn prune_expired_hooks(transaction: &Transaction<'_>, at_ms: i64) -> Result<(), WorldError> {
    transaction
        .execute(
            r#"
            DELETE FROM workflow_hooks
            WHERE EXISTS (
              SELECT 1 FROM workflow_runs
              WHERE workflow_runs.run_id = workflow_hooks.run_id
                AND workflow_runs.status IN ('completed', 'failed', 'cancelled')
            )
              AND (
                token_retention_until_ms IS NULL
                OR token_retention_until_ms <= ?1
              )
            "#,
            [at_ms],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn delete_unretained_hooks_for_run(
    transaction: &Transaction<'_>,
    run_id: &str,
    at_ms: i64,
) -> Result<(), WorldError> {
    transaction
        .execute(
            r#"
            DELETE FROM workflow_hooks
            WHERE run_id = ?1
              AND (
                token_retention_until_ms IS NULL
                OR token_retention_until_ms <= ?2
              )
            "#,
            params![run_id, at_ms],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn insert_wait(
    transaction: &Transaction<'_>,
    wait: &WorkflowWait,
    correlation_id: &str,
) -> Result<(), WorldError> {
    transaction
        .execute(
            r#"
            INSERT INTO workflow_waits (
              wait_id, run_id, correlation_id, status, resume_at_ms,
              completed_at_ms, created_at_ms, updated_at_ms, spec_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                wait.wait_id,
                wait.run_id,
                correlation_id,
                wait.status.as_str(),
                wait.resume_at_ms,
                wait.completed_at_ms,
                wait.created_at_ms,
                wait.updated_at_ms,
                i64::from(wait.spec_version),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn update_wait(transaction: &Transaction<'_>, wait: &WorkflowWait) -> Result<(), WorldError> {
    let changed = transaction
        .execute(
            r#"
            UPDATE workflow_waits
            SET status = ?2, resume_at_ms = ?3, completed_at_ms = ?4,
                updated_at_ms = ?5
            WHERE wait_id = ?1
            "#,
            params![
                wait.wait_id,
                wait.status.as_str(),
                wait.resume_at_ms,
                wait.completed_at_ms,
                wait.updated_at_ms,
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(WorldError::new(
            WorldErrorKind::WaitNotFound,
            format!("wait {:?} disappeared during update", wait.wait_id),
        ));
    }
    Ok(())
}

fn read_wait(
    connection: &Connection,
    run_id: &str,
    correlation_id: &str,
) -> Result<Option<WorkflowWait>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT wait_id, status, resume_at_ms, completed_at_ms,
                   created_at_ms, updated_at_ms, spec_version
            FROM workflow_waits
            WHERE run_id = ?1 AND correlation_id = ?2
            "#,
            params![run_id, correlation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(
            |(
                wait_id,
                status,
                resume_at_ms,
                completed_at_ms,
                created_at_ms,
                updated_at_ms,
                spec_version,
            )| {
                Ok(WorkflowWait {
                    wait_id,
                    run_id: run_id.to_owned(),
                    status: WaitStatus::try_from(status.as_str())?,
                    resume_at_ms,
                    completed_at_ms,
                    created_at_ms,
                    updated_at_ms,
                    spec_version: to_u32(spec_version, "wait spec version")?,
                })
            },
        )
        .transpose()
}

fn read_committed_resume_event(
    connection: &Connection,
    request: &CreateWorldEventRequest,
) -> Result<Option<WorldEvent>, WorldError> {
    if request.run_id.is_empty() {
        return Err(WorldError::invalid_request("runId must not be empty"));
    }
    if request.spec_version != workflow_protocol::SUPPORTED_PERSISTED_SPEC_VERSION {
        return Err(WorldError::new(
            WorldErrorKind::UnsupportedSpec,
            format!(
                "this SQLite World supports persisted spec {}, got {}",
                workflow_protocol::SUPPORTED_PERSISTED_SPEC_VERSION,
                request.spec_version
            ),
        ));
    }
    if request.occurred_at_ms.is_some_and(|value| value < 0) {
        return Err(WorldError::invalid_request(
            "event timestamps must not be negative",
        ));
    }
    if request.resume_id.as_ref().is_some_and(String::is_empty) {
        return Err(WorldError::invalid_request("resumeId must not be empty"));
    }
    if request
        .resume_payload_digest
        .as_ref()
        .is_some_and(String::is_empty)
    {
        return Err(WorldError::invalid_request(
            "resumePayloadDigest must not be empty",
        ));
    }
    if request.resume_payload_digest.is_some() && request.resume_id.is_none() {
        return Err(WorldError::invalid_request(
            "resumePayloadDigest requires resumeId",
        ));
    }

    let Some(resume_id) = request.resume_id.as_deref() else {
        return Ok(None);
    };
    let WorldEventData::HookReceived { hook_id, .. } = &request.event else {
        return Err(WorldError::invalid_request(
            "resume idempotency fields are valid only for hook_received",
        ));
    };
    let existing = connection
        .query_row(
            r#"
            SELECT slot, resume_payload_digest
            FROM workflow_events
            WHERE run_id = ?1 AND resume_id = ?2
            "#,
            params![request.run_id, resume_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((slot, existing_digest)) = existing else {
        return Ok(None);
    };
    if let (Some(request_digest), Some(existing_digest)) = (
        request.resume_payload_digest.as_deref(),
        existing_digest.as_deref(),
    ) && request_digest != existing_digest
    {
        return Err(WorldError::new(
            WorldErrorKind::EntityConflict,
            format!(
                "hook_received resumeId {resume_id:?} is already recorded with a different payload"
            ),
        ));
    }
    let slot = to_u64(slot, "resume event slot")?;
    let event = read_world_event(connection, &request.run_id, slot)?.ok_or_else(|| {
        WorldError::persisted_data(format!(
            "resume id {resume_id:?} points at missing event {slot}"
        ))
    })?;
    match &event.event {
        WorldEventData::HookReceived {
            hook_id: existing_hook_id,
            ..
        } if existing_hook_id == hook_id => Ok(Some(event)),
        WorldEventData::HookReceived { .. } => Err(WorldError::new(
            WorldErrorKind::EntityConflict,
            format!(
                "hook_received resumeId {resume_id:?} is already recorded for a different Hook"
            ),
        )),
        _ => Err(WorldError::persisted_data(format!(
            "resume id {resume_id:?} points at a non-hook_received event"
        ))),
    }
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
    resume_payload_digest: Option<&str>,
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
              created_at_ms, correlation_id, occurred_at_ms, resume_id,
              resume_payload_digest
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
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
                event.resume_id,
                resume_payload_digest,
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
        data @ (WorldEventData::RunCompleted { .. }
        | WorldEventData::RunFailed { .. }
        | WorldEventData::RunCancelled { .. }
        | WorldEventData::StepCreated { .. }
        | WorldEventData::StepStarted { .. }
        | WorldEventData::StepCompleted { .. }
        | WorldEventData::StepFailed { .. }
        | WorldEventData::StepRetrying { .. })
            if data.is_present() =>
        {
            insert_world_event_data(transaction, run_id, slot, data)?;
        }
        data @ (WorldEventData::AttrSet { .. }
        | WorldEventData::HookCreated { .. }
        | WorldEventData::HookReceived { .. }
        | WorldEventData::HookDisposed { .. }
        | WorldEventData::HookConflict { .. }
        | WorldEventData::WaitCreated { .. }
        | WorldEventData::WaitCompleted { .. }
        | WorldEventData::Noop { .. })
            if data.is_present() =>
        {
            insert_phase2_world_event_data(transaction, run_id, slot, data)?;
        }
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
        resume_id: event.resume_id.clone(),
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
            WorldEventData::RunCreated(_)
            | WorldEventData::RunStarted(_)
            | WorldEventData::AttrSet { .. }
            | WorldEventData::HookCreated { .. }
            | WorldEventData::HookReceived { .. }
            | WorldEventData::HookDisposed { .. }
            | WorldEventData::HookConflict { .. }
            | WorldEventData::WaitCreated { .. }
            | WorldEventData::WaitCompleted { .. }
            | WorldEventData::Noop { .. } => {
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

fn insert_phase2_world_event_data(
    transaction: &Transaction<'_>,
    run_id: &str,
    slot: i64,
    event: &WorldEventData,
) -> Result<(), WorldError> {
    let mut payload: Option<&[u8]> = None;
    let mut token: Option<&str> = None;
    let mut metadata: Option<&[u8]> = None;
    let mut token_retention_until_ms = None;
    let mut is_webhook = None;
    let mut is_system = None;
    let mut conflicting_run_id: Option<&str> = None;
    let mut resume_at_ms = None;
    let mut attribute_changes_json = None;
    let mut attribute_writer_json = None;
    let mut allow_reserved_attributes = None;
    let mut sealed = None;

    match event {
        WorldEventData::AttrSet {
            changes,
            writer,
            allow_reserved_attributes: allow_reserved,
            ..
        } => {
            attribute_changes_json =
                Some(serde_json::to_string(changes).map_err(persisted_data_error)?);
            attribute_writer_json =
                Some(serde_json::to_string(writer).map_err(persisted_data_error)?);
            allow_reserved_attributes = Some(i64::from(*allow_reserved));
        }
        WorldEventData::HookCreated {
            token: event_token,
            metadata: event_metadata,
            token_retention_until_ms: retention,
            is_webhook: webhook,
            is_system: system,
            ..
        } => {
            token = Some(event_token);
            metadata = event_metadata.as_deref();
            token_retention_until_ms = *retention;
            is_webhook = webhook.map(i64::from);
            is_system = system.map(i64::from);
        }
        WorldEventData::HookReceived {
            token: event_token,
            payload: event_payload,
            ..
        } => {
            token = event_token.as_deref();
            payload = Some(event_payload);
        }
        WorldEventData::HookDisposed {
            token: event_token, ..
        } => token = event_token.as_deref(),
        WorldEventData::HookConflict {
            token: event_token,
            conflicting_run_id: owner,
            ..
        } => {
            token = Some(event_token);
            conflicting_run_id = owner.as_deref();
        }
        WorldEventData::WaitCreated {
            resume_at_ms: resume_at,
            ..
        } => resume_at_ms = Some(*resume_at),
        WorldEventData::WaitCompleted {
            resume_at_ms: resume_at,
            ..
        } => resume_at_ms = *resume_at,
        WorldEventData::Noop {
            sealed: event_sealed,
        } => sealed = event_sealed.map(i64::from),
        _ => {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                "phase-2 event-data table received an unsupported event",
            ));
        }
    }

    transaction
        .execute(
            r#"
            INSERT INTO workflow_phase2_event_data (
              run_id, slot, data_kind, payload, token, metadata,
              token_retention_until_ms, is_webhook, is_system,
              conflicting_run_id, resume_at_ms, attribute_changes_json,
              attribute_writer_json, allow_reserved_attributes, sealed
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
              ?14, ?15
            )
            "#,
            params![
                run_id,
                slot,
                event.event_type().as_str(),
                payload,
                token,
                metadata,
                token_retention_until_ms,
                is_webhook,
                is_system,
                conflicting_run_id,
                resume_at_ms,
                attribute_changes_json,
                attribute_writer_json,
                allow_reserved_attributes,
                sealed,
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

#[derive(Debug)]
struct StoredPhase2EventData {
    data_kind: String,
    payload: Option<Vec<u8>>,
    token: Option<String>,
    metadata: Option<Vec<u8>>,
    token_retention_until_ms: Option<i64>,
    is_webhook: Option<i64>,
    is_system: Option<i64>,
    conflicting_run_id: Option<String>,
    resume_at_ms: Option<i64>,
    attribute_changes_json: Option<String>,
    attribute_writer_json: Option<String>,
    allow_reserved_attributes: Option<i64>,
    sealed: Option<i64>,
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
                   correlation_id, occurred_at_ms, resume_id
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
                    row.get::<_, Option<String>>(6)?,
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
        resume_id,
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
    let phase2_data = read_stored_phase2_event_data(connection, run_id, slot_i64)?;
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
        EventType::AttrSet => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let data = require_stored_phase2_event_data(
                phase2_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            let changes = serde_json::from_str::<Vec<AttributeChange>>(
                data.attribute_changes_json
                    .as_deref()
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "attr_set changes"))?,
            )
            .map_err(persisted_data_error)?;
            let writer = serde_json::from_str::<AttributeWriter>(
                data.attribute_writer_json
                    .as_deref()
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "attr_set writer"))?,
            )
            .map_err(persisted_data_error)?;
            let allow_reserved_attributes = decode_sqlite_bool(
                data.allow_reserved_attributes.ok_or_else(|| {
                    missing_event_data(run_id, slot_i64, "attr_set allow_reserved_attributes")
                })?,
                "attr_set allow_reserved_attributes",
            )?;
            WorldEventData::AttrSet {
                correlation_id,
                changes,
                writer,
                allow_reserved_attributes,
            }
        }
        EventType::HookCreated => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let hook_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_phase2_event_data(
                phase2_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::HookCreated {
                hook_id,
                token: data
                    .token
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "hook_created token"))?,
                metadata: data.metadata,
                token_retention_until_ms: data.token_retention_until_ms,
                is_webhook: data
                    .is_webhook
                    .map(|value| decode_sqlite_bool(value, "hook_created is_webhook"))
                    .transpose()?,
                is_system: data
                    .is_system
                    .map(|value| decode_sqlite_bool(value, "hook_created is_system"))
                    .transpose()?,
            }
        }
        EventType::HookReceived => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let hook_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_phase2_event_data(
                phase2_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::HookReceived {
                hook_id,
                token: data.token,
                payload: data
                    .payload
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "hook_received payload"))?,
            }
        }
        EventType::HookDisposed => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let hook_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let token = match (data_present, phase2_data) {
                (false, None) => None,
                (true, Some(data)) if data.data_kind == event_type.as_str() => data.token,
                _ => return Err(invalid_event_data_shape(run_id, slot, event_type)),
            };
            WorldEventData::HookDisposed { hook_id, token }
        }
        EventType::HookConflict => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let hook_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_phase2_event_data(
                phase2_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::HookConflict {
                hook_id,
                token: data
                    .token
                    .ok_or_else(|| missing_event_data(run_id, slot_i64, "hook_conflict token"))?,
                conflicting_run_id: data.conflicting_run_id,
            }
        }
        EventType::WaitCreated => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let wait_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let data = require_stored_phase2_event_data(
                phase2_data,
                data_present,
                run_id,
                slot,
                event_type,
            )?;
            WorldEventData::WaitCreated {
                wait_id,
                resume_at_ms: data.resume_at_ms.ok_or_else(|| {
                    missing_event_data(run_id, slot_i64, "wait_created resume_at_ms")
                })?,
            }
        }
        EventType::WaitCompleted => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let wait_id = require_correlation_id(correlation_id.as_deref(), run_id, slot)?;
            let resume_at_ms = match (data_present, phase2_data) {
                (false, None) => None,
                (true, Some(data)) if data.data_kind == event_type.as_str() => data.resume_at_ms,
                _ => return Err(invalid_event_data_shape(run_id, slot, event_type)),
            };
            WorldEventData::WaitCompleted {
                wait_id,
                resume_at_ms,
            }
        }
        EventType::Noop => {
            if stored_data.is_some() {
                return Err(invalid_event_data_shape(run_id, slot, event_type));
            }
            let sealed = match (data_present, phase2_data) {
                (false, None) => None,
                (true, Some(data)) if data.data_kind == event_type.as_str() => data
                    .sealed
                    .map(|value| decode_sqlite_bool(value, "noop sealed"))
                    .transpose()?,
                _ => return Err(invalid_event_data_shape(run_id, slot, event_type)),
            };
            WorldEventData::Noop { sealed }
        }
    };
    Ok(Some(WorldEvent {
        run_id: run_id.to_owned(),
        slot,
        event,
        spec_version: to_u32(spec_version, "event spec version")?,
        created_at_ms,
        occurred_at_ms,
        resume_id,
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

fn read_stored_phase2_event_data(
    connection: &Connection,
    run_id: &str,
    slot: i64,
) -> Result<Option<StoredPhase2EventData>, WorldError> {
    connection
        .query_row(
            r#"
            SELECT data_kind, payload, token, metadata,
                   token_retention_until_ms, is_webhook, is_system,
                   conflicting_run_id, resume_at_ms, attribute_changes_json,
                   attribute_writer_json, allow_reserved_attributes, sealed
            FROM workflow_phase2_event_data
            WHERE run_id = ?1 AND slot = ?2
            "#,
            params![run_id, slot],
            |row| {
                Ok(StoredPhase2EventData {
                    data_kind: row.get(0)?,
                    payload: row.get(1)?,
                    token: row.get(2)?,
                    metadata: row.get(3)?,
                    token_retention_until_ms: row.get(4)?,
                    is_webhook: row.get(5)?,
                    is_system: row.get(6)?,
                    conflicting_run_id: row.get(7)?,
                    resume_at_ms: row.get(8)?,
                    attribute_changes_json: row.get(9)?,
                    attribute_writer_json: row.get(10)?,
                    allow_reserved_attributes: row.get(11)?,
                    sealed: row.get(12)?,
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

fn require_stored_phase2_event_data(
    data: Option<StoredPhase2EventData>,
    data_present: bool,
    run_id: &str,
    slot: u64,
    event_type: EventType,
) -> Result<StoredPhase2EventData, WorldError> {
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
            "event {run_id:?}/{slot} is missing its correlation ID"
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

fn decode_sqlite_bool(value: i64, label: &str) -> Result<bool, WorldError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(WorldError::persisted_data(format!(
            "invalid {label}: {value}"
        ))),
    }
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

fn resolve_database_identity(path: PathBuf) -> PathBuf {
    let absolute = std::path::absolute(&path).unwrap_or(path);
    if let Ok(canonical) = fs::canonicalize(&absolute) {
        return canonical;
    }

    let mut ancestor = absolute.as_path();
    let mut missing_components = Vec::new();
    loop {
        if let Ok(mut canonical) = fs::canonicalize(ancestor) {
            for component in missing_components.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(file_name) = ancestor.file_name() else {
            return absolute;
        };
        missing_components.push(file_name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            return absolute;
        };
        ancestor = parent;
    }
}

fn runtime_engine(path: &Path) -> Arc<RuntimeEngine> {
    let registry = RUNTIME_ENGINES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut engines = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    engines.retain(|_, engine| engine.strong_count() > 0);
    if let Some(engine) = engines.get(path).and_then(Weak::upgrade) {
        return engine;
    }
    let engine = Arc::new(RuntimeEngine::default());
    engines.insert(path.to_path_buf(), Arc::downgrade(&engine));
    engine
}

fn engine_poisoned_error() -> WorldError {
    WorldError::new(
        WorldErrorKind::Storage,
        "SQLite runtime engine state was poisoned",
    )
    .with_details(serde_json::json!({
        "subsystem": "sqlite",
        "reason": "engine_poisoned",
    }))
}

fn storage_busy_error(wait_stage: &str, elapsed: Duration) -> WorldError {
    WorldError::new(
        WorldErrorKind::Storage,
        "SQLite storage operation exceeded its busy budget",
    )
    .with_retryable(true)
    .with_details(serde_json::json!({
        "subsystem": "sqlite",
        "reason": "storage_busy",
        "waitStage": wait_stage,
        "elapsedMs": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
    }))
}

fn storage_error_at<E>(error: E, wait_stage: &str, started_at: Instant) -> WorldError
where
    E: std::error::Error + 'static,
{
    storage_error_with_elapsed(error, wait_stage, Some(started_at.elapsed()))
}

fn storage_error<E>(error: E) -> WorldError
where
    E: std::error::Error + 'static,
{
    let elapsed =
        OPERATION_STARTED_AT.with(|value| value.borrow().as_ref().map(std::time::Instant::elapsed));
    storage_error_with_elapsed(error, "sqlite_lock", elapsed)
}

fn storage_error_with_elapsed<E>(
    error: E,
    wait_stage: &str,
    elapsed: Option<Duration>,
) -> WorldError
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
    let details = if retryable {
        serde_json::json!({
            "subsystem": "sqlite",
            "reason": "storage_busy",
            "waitStage": wait_stage,
            "elapsedMs": elapsed
                .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
                .unwrap_or_default(),
        })
    } else {
        serde_json::json!({ "subsystem": "sqlite" })
    };
    WorldError::new(WorldErrorKind::Storage, "SQLite storage operation failed")
        .with_retryable(retryable)
        .with_details(details)
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
mod runtime_engine_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tempfile::tempdir;
    use workflow_protocol::WorldErrorKind;

    use super::SqliteWorld;

    #[cfg(unix)]
    #[test]
    fn nested_missing_database_paths_resolve_symlinked_ancestors_to_one_engine() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("temporary directory should be created");
        let real = directory.path().join("real");
        std::fs::create_dir(&real).expect("real directory should be created");
        let alias = directory.path().join("alias");
        symlink(&real, &alias).expect("directory symlink should be created");

        let through_real = SqliteWorld::new(real.join("missing/nested/world.sqlite"));
        let through_alias = SqliteWorld::new(alias.join("missing/nested/world.sqlite"));

        assert_eq!(through_real.path, through_alias.path);
        assert!(Arc::ptr_eq(&through_real.engine, &through_alias.engine));
    }

    #[test]
    fn worlds_for_one_database_share_and_reuse_one_runtime_connection() {
        let directory = tempdir().expect("temporary directory should be created");
        let database_path = directory.path().join("world.sqlite");
        let first = SqliteWorld::new(&database_path);
        let second = SqliteWorld::new(&database_path);

        assert!(Arc::ptr_eq(&first.engine, &second.engine));
        first.migrate().expect("migration should succeed");
        {
            let connection = first
                .open_runtime_connection()
                .expect("first checkout should succeed");
            connection
                .execute("CREATE TEMP TABLE shared_engine_marker (value TEXT)", [])
                .expect("temporary marker should be created");
        }
        {
            let connection = second
                .open_runtime_connection()
                .expect("second checkout should succeed");
            let exists = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name = 'shared_engine_marker')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .expect("temporary marker should be readable");
            assert!(
                exists,
                "the second World should reuse the engine connection"
            );
        }
    }

    #[test]
    fn engine_lane_wait_uses_the_operation_budget_and_reports_its_stage() {
        let directory = tempdir().expect("temporary directory should be created");
        let database_path = directory.path().join("world.sqlite");
        let first = SqliteWorld::new(&database_path);
        first.migrate().expect("migration should succeed");
        let _held = first
            .open_runtime_connection()
            .expect("engine lane should be acquired");

        let error = SqliteWorld::new(&database_path)
            .with_busy_timeout(Duration::from_millis(10))
            .ensure_ready()
            .expect_err("another checkout should exhaust its engine lane budget");

        assert_eq!(error.kind(), WorldErrorKind::Storage);
        assert!(error.retryable());
        assert_eq!(error.details()["reason"], "storage_busy");
        assert_eq!(error.details()["waitStage"], "writer_lane");
        assert!(error.details()["elapsedMs"].as_u64().unwrap_or_default() >= 9);
    }
}

#[cfg(test)]
mod process_tests;
