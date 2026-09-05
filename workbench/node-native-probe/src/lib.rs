use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
use workflow_world_sqlite::{SqliteWorld, sqlite_library_version};

const ERROR_MARKER: &str = "WORKFLOW_NATIVE_ERROR:";

#[napi]
pub struct NativeSqliteWorld {
    path: PathBuf,
    closed: Arc<AtomicBool>,
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
    pub fn close(&self) -> bool {
        !self.closed.swap(true, Ordering::AcqRel)
    }

    fn ensure_open(&self) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(native_error("closed", "SQLite World handle is closed"));
        }
        Ok(())
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
