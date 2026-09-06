use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use serde_json::{Value, json};
use workflow_protocol::{
    CreateEventResult, RunCreatedEventData, RunStartedRequest, StoredEvent, WorkflowRun,
    WorldError, WorldSnapshot,
};
use workflow_world_sqlite::{
    QueueWorker, QueueWorkerConfig, QueueWorkerReport, SqliteWorld, sqlite_library_version,
};

const ERROR_MARKER: &str = "WORKFLOW_NATIVE_ERROR:";

#[napi]
pub struct NativeSqliteWorld {
    path: PathBuf,
    closed: Arc<AtomicBool>,
    worker: Mutex<Option<QueueWorker>>,
    worker_stopping: Arc<AtomicBool>,
}

#[napi]
#[derive(Default)]
pub struct NativeTypeTagSentinel;

#[napi]
impl NativeTypeTagSentinel {
    #[napi(constructor)]
    pub const fn new() -> Self {
        Self
    }
}

#[napi]
impl NativeSqliteWorld {
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> Self {
        Self {
            path: PathBuf::from(path),
            closed: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            worker_stopping: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi(catch_unwind)]
    pub fn migrate(&self) -> Result<AsyncTask<MigrateTask>> {
        self.ensure_open()?;
        Ok(AsyncTask::new(MigrateTask {
            path: self.path.clone(),
        }))
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_resilient_run_started(
        &self,
        run_id: String,
        spec_version: u32,
        deployment_id: String,
        workflow_name: String,
        input: Buffer,
        execution_context_json: Option<String>,
        attributes_json: Option<String>,
        allow_reserved_attributes: bool,
        encryption_public_key: Option<String>,
    ) -> Result<AsyncTask<CreateRunStartedTask>> {
        self.ensure_open()?;
        let execution_context = execution_context_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| native_error("invalid_request", "executionContext is not valid JSON"))?;
        let attributes = attributes_json
            .as_deref()
            .map(serde_json::from_str::<BTreeMap<String, String>>)
            .transpose()
            .map_err(|_| native_error("invalid_request", "attributes are not valid JSON"))?;
        Ok(AsyncTask::new(CreateRunStartedTask {
            path: self.path.clone(),
            request: RunStartedRequest {
                run_id,
                spec_version,
                event_data: RunCreatedEventData {
                    deployment_id,
                    workflow_name,
                    input: input.to_vec(),
                    execution_context,
                    attributes,
                    allow_reserved_attributes,
                    encryption_public_key,
                },
            },
        }))
    }

    #[napi(catch_unwind)]
    pub fn snapshot_contract(&self, run_id: String) -> Result<AsyncTask<SnapshotTask>> {
        self.ensure_open()?;
        Ok(AsyncTask::new(SnapshotTask {
            path: self.path.clone(),
            run_id,
        }))
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn start_queue_worker(
        &self,
        scope: String,
        queue_name: String,
        flow_url: String,
        worker_id: String,
        lease_duration_ms: u32,
        poll_interval_ms: u32,
        retry_delay_ms: u32,
        request_timeout_ms: u32,
    ) -> Result<()> {
        self.ensure_open()?;
        if self.worker_stopping.load(Ordering::Acquire) {
            return Err(native_error(
                "worker_stopping",
                "SQLite World queue worker is still stopping",
            ));
        }
        let mut worker = self.lock_worker()?;
        if worker.is_some() {
            return Err(native_error(
                "invalid_request",
                "SQLite World queue worker is already running",
            ));
        }
        let config = QueueWorkerConfig {
            scope,
            queue_name,
            flow_url,
            worker_id,
            lease_duration: Duration::from_millis(u64::from(lease_duration_ms)),
            poll_interval: Duration::from_millis(u64::from(poll_interval_ms)),
            retry_delay: Duration::from_millis(u64::from(retry_delay_ms)),
            request_timeout: Duration::from_millis(u64::from(request_timeout_ms)),
        };
        *worker =
            Some(QueueWorker::start(SqliteWorld::new(&self.path), config).map_err(world_error)?);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn reconcile_active_runs(
        &self,
        scope: String,
        deployment_id: String,
        queue_prefix: String,
    ) -> Result<AsyncTask<ReconcileActiveRunsTask>> {
        self.ensure_open()?;
        Ok(AsyncTask::new(ReconcileActiveRunsTask {
            path: self.path.clone(),
            scope,
            deployment_id,
            queue_prefix,
        }))
    }

    #[napi(catch_unwind)]
    pub fn queue_message_count(&self, scope: String) -> Result<AsyncTask<QueueMessageCountTask>> {
        self.ensure_open()?;
        Ok(AsyncTask::new(QueueMessageCountTask {
            path: self.path.clone(),
            scope,
        }))
    }

    #[napi(catch_unwind)]
    pub fn stop_queue_worker(&self) -> Result<AsyncTask<StopQueueWorkerTask>> {
        self.ensure_open()?;
        if self.worker_stopping.load(Ordering::Acquire) {
            return Err(native_error(
                "worker_stopping",
                "SQLite World queue worker is already stopping",
            ));
        }
        let worker = self.lock_worker()?.take();
        if worker.is_some() {
            self.worker_stopping.store(true, Ordering::Release);
        }
        Ok(AsyncTask::new(StopQueueWorkerTask {
            worker,
            worker_stopping: Arc::clone(&self.worker_stopping),
        }))
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> Result<bool> {
        if self.worker_stopping.load(Ordering::Acquire) {
            return Err(native_error(
                "worker_stopping",
                "wait for the SQLite World queue worker to stop before closing its handle",
            ));
        }
        if self.lock_worker()?.is_some() {
            return Err(native_error(
                "worker_running",
                "stop the SQLite World queue worker before closing its handle",
            ));
        }
        Ok(!self.closed.swap(true, Ordering::AcqRel))
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(native_error("closed", "SQLite World handle is closed"));
        }
        Ok(())
    }

    fn lock_worker(&self) -> Result<std::sync::MutexGuard<'_, Option<QueueWorker>>> {
        self.worker
            .lock()
            .map_err(|_| native_error("binding", "SQLite World queue worker lock was poisoned"))
    }
}

pub struct MigrateTask {
    path: PathBuf,
}

#[napi]
impl Task for MigrateTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| SqliteWorld::new(&self.path).migrate().map_err(world_error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CreateRunStartedTask {
    path: PathBuf,
    request: RunStartedRequest,
}

#[napi]
impl Task for CreateRunStartedTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| {
            let world = SqliteWorld::new(&self.path);
            let result = world
                .create_resilient_run_started(&self.request)
                .map_err(world_error)?;
            let snapshot = world.snapshot(&self.request.run_id).map_err(world_error)?;
            project_operation(&world, &result, &snapshot).map_err(world_error)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct SnapshotTask {
    path: PathBuf,
    run_id: String,
}

pub struct ReconcileActiveRunsTask {
    path: PathBuf,
    scope: String,
    deployment_id: String,
    queue_prefix: String,
}

pub struct QueueMessageCountTask {
    path: PathBuf,
    scope: String,
}

pub struct StopQueueWorkerTask {
    worker: Option<QueueWorker>,
    worker_stopping: Arc<AtomicBool>,
}

pub struct PanicProbeTask;

#[napi]
impl Task for PanicProbeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| panic!("intentional native task panic probe"))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl Task for SnapshotTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| {
            let snapshot = SqliteWorld::new(&self.path)
                .snapshot(&self.run_id)
                .map_err(world_error)?;
            serde_json::to_string(&json!({
                "run": project_run(&snapshot.run),
                "events": snapshot.events.iter().map(project_event).collect::<Vec<_>>(),
            }))
            .map_err(|error| native_error("binding", error.to_string()))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl Task for ReconcileActiveRunsTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| {
            let result = SqliteWorld::new(&self.path)
                .reconcile_active_runs(
                    &self.scope,
                    &self.deployment_id,
                    &self.queue_prefix,
                    current_time_ms()?,
                )
                .map_err(world_error)?;
            serde_json::to_string(&json!({
                "activeRunCount": result.active_run_count,
                "createdMessageCount": result.created_message_count,
                "messageIds": result.message_ids,
            }))
            .map_err(|error| native_error("binding", error.to_string()))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl Task for QueueMessageCountTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| {
            let count = SqliteWorld::new(&self.path)
                .queue_message_count(&self.scope)
                .map_err(world_error)?;
            u32::try_from(count).map_err(|_| native_error("binding", "queue count overflow"))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl Task for StopQueueWorkerTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = compute_safely(|| {
            let report = match self.worker.take() {
                Some(worker) => worker.stop().map_err(world_error)?,
                None => QueueWorkerReport::default(),
            };
            serde_json::to_string(&json!({
                "claims": report.claims,
                "acknowledgements": report.acknowledgements,
                "reschedules": report.reschedules,
                "deliveryFailures": report.delivery_failures,
                "storageFailures": report.storage_failures,
            }))
            .map_err(|error| native_error("binding", error.to_string()))
        });
        self.worker_stopping.store(false, Ordering::Release);
        result
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(catch_unwind)]
pub fn native_info() -> String {
    json!({
        "adapterProtocolVersion": 1,
        "crateVersion": env!("CARGO_PKG_VERSION"),
        "nodeApiVersion": 8,
        "sqliteVersion": sqlite_library_version(),
    })
    .to_string()
}

#[napi(catch_unwind)]
pub fn native_panic_probe() -> AsyncTask<PanicProbeTask> {
    AsyncTask::new(PanicProbeTask)
}

fn project_operation(
    world: &SqliteWorld,
    result: &CreateEventResult,
    snapshot: &WorldSnapshot,
) -> std::result::Result<String, WorldError> {
    let event = result.event.as_ref().map(project_event);
    let preload = result.preload.as_ref().ok_or_else(|| {
        WorldError::persisted_data("resilient start did not return its requested preload")
    })?;
    let cursor = preload
        .cursor
        .as_deref()
        .ok_or_else(|| WorldError::persisted_data("resilient start returned no cursor"))?;
    let continuation_count = world
        .list_events_after_cursor(&result.run.run_id, cursor, 100)?
        .events
        .len();

    serde_json::to_string(&json!({
        "run": project_run(&result.run),
        "result": {
            "event": event,
            "preloadedSlots": preload.events.iter().map(|event| event.slot).collect::<Vec<_>>(),
            "preloadedEvents": preload.events.iter().map(project_event).collect::<Vec<_>>(),
            "cursorPresent": preload.cursor.is_some(),
            "continuationCount": continuation_count,
            "hasMore": preload.has_more,
        },
        "events": snapshot.events.iter().map(project_event).collect::<Vec<_>>(),
    }))
    .map_err(|error| WorldError::persisted_data(error.to_string()))
}

fn project_run(run: &WorkflowRun) -> Value {
    json!({
        "runId": run.run_id,
        "status": run.status,
        "deploymentId": run.deployment_id,
        "workflowName": run.workflow_name,
        "specVersion": run.spec_version,
        "input": { "$bytes": STANDARD.encode(&run.input) },
        "executionContext": run.execution_context,
        "attributes": run.attributes,
        "encryptionPublicKey": run.encryption_public_key,
        "startedAtPresent": run.started_at_ms.is_some(),
    })
}

fn project_event(event: &StoredEvent) -> Value {
    let mut projection = json!({
        "slot": event.slot,
        "eventType": event.event_type,
        "specVersion": event.spec_version,
        "eventDataPresent": event.event_data.is_some(),
    });
    if let Some(data) = &event.event_data {
        let mut event_data = json!({
            "deploymentId": data.deployment_id,
            "workflowName": data.workflow_name,
            "input": { "$bytes": STANDARD.encode(&data.input) },
        });
        if let Some(execution_context) = &data.execution_context {
            event_data["executionContext"] = execution_context.clone();
        }
        if let Some(attributes) = &data.attributes {
            event_data["attributes"] = json!(attributes);
        }
        if data.allow_reserved_attributes {
            event_data["allowReservedAttributes"] = json!(true);
        }
        if let Some(encryption_public_key) = &data.encryption_public_key {
            event_data["encryptionPublicKey"] = json!(encryption_public_key);
        }
        projection["eventData"] = event_data;
    }
    projection
}

fn current_time_ms() -> Result<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| native_error("clock", "system clock is before Unix epoch"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| native_error("clock", "system clock overflow"))
}

fn world_error(error: WorldError) -> Error {
    let kind = serde_json::to_value(error.kind())
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    native_error_envelope(
        &kind,
        error.message(),
        error.retryable(),
        error.details().clone(),
    )
}

fn native_error(kind: &str, message: impl Into<String>) -> Error {
    native_error_envelope(kind, message, false, json!({}))
}

fn native_error_envelope(
    kind: &str,
    message: impl Into<String>,
    retryable: bool,
    details: Value,
) -> Error {
    let envelope = json!({
        "code": kind,
        "kind": kind,
        "message": message.into(),
        "retryable": retryable,
        "details": details,
    });
    Error::new(Status::GenericFailure, format!("{ERROR_MARKER}{envelope}"))
}

fn compute_safely<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(payload) => {
            let message = if let Some(message) = payload.downcast_ref::<&str>() {
                (*message).to_owned()
            } else if let Some(message) = payload.downcast_ref::<String>() {
                message.clone()
            } else {
                "Rust task panicked with a non-string payload".to_owned()
            };
            std::mem::forget(payload);
            Err(native_error("panic", message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ERROR_MARKER, compute_safely};

    #[test]
    fn task_panics_become_native_errors() {
        let error = compute_safely::<()>(|| panic!("fixture panic"))
            .expect_err("panic should become an error");

        assert!(error.reason.contains(ERROR_MARKER));
        assert!(error.reason.contains("fixture panic"));
    }
}
