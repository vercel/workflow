use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::{
    Array, AsyncTask, Buffer, JsObjectValue, KeyCollectionMode, KeyConversion, KeyFilter, Object,
    TypedArray, TypedArrayType, Unknown,
};
use napi::{Env, Error, JsValue, Result, Status, Task, ValueType};
use napi_derive::napi;
use serde::Serialize;
use serde::ser::Serializer;
use serde_json::json;
use workflow_protocol::{
    ContextValue, CreateWorldEventRequest, MAX_SAFE_CONTEXT_INTEGER, MIN_SAFE_CONTEXT_INTEGER,
    QueueMessageRequest, RunCreatedEventData, RunStatus, WorkflowRun, WorkflowRunPage,
    WorkflowStep, WorkflowStepPage, WorldError, WorldEvent, WorldEventData, WorldEventPage,
    WorldEventResult,
};
use workflow_world_sqlite::{
    QueueWorker, QueueWorkerConfig, QueueWorkerReport, SqliteWorld, sqlite_library_version,
    sqlite_schema_version,
};

const ERROR_MARKER: &str = "WORKFLOW_NATIVE_ERROR:";
const MAX_CONTEXT_DEPTH: usize = 128;

// @lat: [[rust-portability#Native Binding Contract#Node.js Binding]]
#[napi]
pub struct NativeSqliteWorld {
    path: PathBuf,
    closed: Arc<AtomicBool>,
    worker: Mutex<Option<QueueWorker>>,
    worker_stopping: Arc<AtomicBool>,
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
    pub fn migrate(&self) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::Migrate)
    }

    #[napi(catch_unwind)]
    pub fn ensure_ready(&self) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::EnsureReady)
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_event(
        &self,
        env: Env,
        run_id: String,
        event_type: String,
        spec_version: f64,
        event_count: Option<f64>,
        occurred_at_ms: Option<f64>,
        correlation_id: Option<String>,
        payload: Option<Buffer>,
        deployment_id: Option<String>,
        workflow_name: Option<String>,
        execution_context: Unknown<'_>,
        attributes: Option<BTreeMap<String, String>>,
        allow_reserved_attributes: bool,
        encryption_public_key: Option<String>,
        step_name: Option<String>,
        attempt: Option<f64>,
        retry_after_ms: Option<f64>,
        owner_message_id: Option<String>,
        error_code: Option<String>,
        cancel_reason: Option<String>,
    ) -> Result<AsyncTask<WorldTask>> {
        self.ensure_open()?;
        let execution_context = if execution_context.get_type()? == ValueType::Undefined {
            None
        } else {
            Some(context_from_js(&env, execution_context).map_err(|error| {
                native_error(
                    "invalid_request",
                    format!("executionContext is not portable: {error}"),
                )
            })?)
        };
        let event_count = event_count
            .map(|value| number_to_u64(value, "eventCount"))
            .transpose()?;
        let spec_version = number_to_u32(spec_version, "specVersion")?;
        let occurred_at_ms = occurred_at_ms
            .map(|value| number_to_i64(value, "occurredAt"))
            .transpose()?;
        let retry_after_ms = retry_after_ms
            .map(|value| number_to_i64(value, "retryAfter"))
            .transpose()?;
        let attempt = attempt
            .map(|value| number_to_u32(value, "attempt"))
            .transpose()?;
        let payload = payload.map(|value| value.to_vec());
        let event = parse_event_data(
            &event_type,
            correlation_id,
            payload,
            deployment_id,
            workflow_name,
            execution_context,
            attributes,
            allow_reserved_attributes,
            encryption_public_key,
            step_name,
            attempt,
            retry_after_ms,
            owner_message_id,
            error_code,
            cancel_reason,
        )?;
        Ok(AsyncTask::new(WorldTask {
            path: self.path.clone(),
            operation: WorldOperation::CreateEvent(CreateWorldEventRequest {
                run_id,
                spec_version,
                event_count,
                occurred_at_ms,
                event,
            }),
        }))
    }

    #[napi(catch_unwind)]
    pub fn get_run(&self, run_id: String) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::GetRun(run_id))
    }

    #[napi(catch_unwind)]
    pub fn list_runs(
        &self,
        workflow_name: Option<String>,
        status: Option<String>,
        cursor: Option<String>,
        limit: u32,
        descending: bool,
    ) -> Result<AsyncTask<WorldTask>> {
        let status = status
            .as_deref()
            .map(RunStatus::try_from)
            .transpose()
            .map_err(world_error)?;
        self.task(WorldOperation::ListRuns {
            workflow_name,
            status,
            cursor,
            limit: limit as usize,
            descending,
        })
    }

    #[napi(catch_unwind)]
    pub fn get_step(&self, run_id: String, step_id: String) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::GetStep { run_id, step_id })
    }

    #[napi(catch_unwind)]
    pub fn list_steps(
        &self,
        run_id: String,
        cursor: Option<String>,
        limit: u32,
        descending: bool,
    ) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::ListSteps {
            run_id,
            cursor,
            limit: limit as usize,
            descending,
        })
    }

    #[napi(catch_unwind)]
    pub fn get_event(&self, run_id: String, event_id: String) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::GetEvent { run_id, event_id })
    }

    #[napi(catch_unwind)]
    pub fn list_events(
        &self,
        run_id: String,
        correlation_id: Option<String>,
        cursor: Option<String>,
        limit: u32,
        descending: bool,
    ) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::ListEvents {
            run_id,
            correlation_id,
            cursor,
            limit: limit as usize,
            descending,
        })
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue(
        &self,
        message_id: String,
        target: String,
        queue_name: String,
        idempotency_key: String,
        body: Buffer,
        available_at_ms: f64,
    ) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::Enqueue(QueueMessageRequest {
            message_id,
            scope: target,
            queue_name,
            idempotency_key,
            body: body.to_vec(),
            available_at_ms: number_to_i64(available_at_ms, "availableAt")?,
        }))
    }

    #[napi(catch_unwind)]
    pub fn queue_message_count(&self, target: String) -> Result<AsyncTask<WorldTask>> {
        self.task(WorldOperation::QueueMessageCount(target))
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn start_queue_worker(
        &self,
        target: String,
        queue_names: Vec<String>,
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
            scope: target,
            queue_names,
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
    pub fn stop_queue_worker(&self) -> Result<AsyncTask<StopQueueWorkerTask>> {
        self.ensure_open()?;
        if self.worker_stopping.swap(true, Ordering::AcqRel) {
            return Err(native_error(
                "worker_stopping",
                "SQLite World queue worker is already stopping",
            ));
        }
        let worker = self.lock_worker()?.take();
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
                "wait for the SQLite World queue worker to stop before closing",
            ));
        }
        if self.lock_worker()?.is_some() {
            return Err(native_error(
                "worker_running",
                "stop the SQLite World queue worker before closing",
            ));
        }
        Ok(!self.closed.swap(true, Ordering::AcqRel))
    }

    fn task(&self, operation: WorldOperation) -> Result<AsyncTask<WorldTask>> {
        self.ensure_open()?;
        Ok(AsyncTask::new(WorldTask {
            path: self.path.clone(),
            operation,
        }))
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
            .map_err(|_| native_error("binding", "SQLite queue worker lock was poisoned"))
    }
}

enum WorldOperation {
    Migrate,
    EnsureReady,
    CreateEvent(CreateWorldEventRequest),
    GetRun(String),
    ListRuns {
        workflow_name: Option<String>,
        status: Option<RunStatus>,
        cursor: Option<String>,
        limit: usize,
        descending: bool,
    },
    GetStep {
        run_id: String,
        step_id: String,
    },
    ListSteps {
        run_id: String,
        cursor: Option<String>,
        limit: usize,
        descending: bool,
    },
    GetEvent {
        run_id: String,
        event_id: String,
    },
    ListEvents {
        run_id: String,
        correlation_id: Option<String>,
        cursor: Option<String>,
        limit: usize,
        descending: bool,
    },
    Enqueue(QueueMessageRequest),
    QueueMessageCount(String),
}

pub struct WorldTask {
    path: PathBuf,
    operation: WorldOperation,
}

#[napi]
impl Task for WorldTask {
    type Output = HostOutput;
    type JsValue = Unknown<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        compute_safely(|| {
            let world = SqliteWorld::new(&self.path);
            match &self.operation {
                WorldOperation::Migrate => {
                    world.migrate().map_err(world_error)?;
                    Ok(HostOutput::Unit(()))
                }
                WorldOperation::EnsureReady => {
                    world.ensure_ready().map_err(world_error)?;
                    Ok(HostOutput::Unit(()))
                }
                WorldOperation::CreateEvent(request) => world
                    .create_event(request)
                    .map(HostEventResult::from)
                    .map(Box::new)
                    .map(HostOutput::EventResult)
                    .map_err(world_error),
                WorldOperation::GetRun(run_id) => world
                    .get_run(run_id)
                    .map(HostRun::from)
                    .map(HostOutput::Run)
                    .map_err(world_error),
                WorldOperation::ListRuns {
                    workflow_name,
                    status,
                    cursor,
                    limit,
                    descending,
                } => world
                    .list_runs(
                        workflow_name.as_deref(),
                        *status,
                        cursor.as_deref(),
                        *limit,
                        *descending,
                    )
                    .map(HostRunPage::from)
                    .map(HostOutput::RunPage)
                    .map_err(world_error),
                WorldOperation::GetStep { run_id, step_id } => world
                    .get_step(run_id, step_id)
                    .map(HostStep::from)
                    .map(HostOutput::Step)
                    .map_err(world_error),
                WorldOperation::ListSteps {
                    run_id,
                    cursor,
                    limit,
                    descending,
                } => world
                    .list_steps(run_id, cursor.as_deref(), *limit, *descending)
                    .map(HostStepPage::from)
                    .map(HostOutput::StepPage)
                    .map_err(world_error),
                WorldOperation::GetEvent { run_id, event_id } => world
                    .get_event(run_id, event_id)
                    .map(HostEvent::from)
                    .map(HostOutput::Event)
                    .map_err(world_error),
                WorldOperation::ListEvents {
                    run_id,
                    correlation_id,
                    cursor,
                    limit,
                    descending,
                } => world
                    .list_events(
                        run_id,
                        correlation_id.as_deref(),
                        cursor.as_deref(),
                        *limit,
                        *descending,
                    )
                    .map(HostEventPage::from)
                    .map(HostOutput::EventPage)
                    .map_err(world_error),
                WorldOperation::Enqueue(request) => world
                    .enqueue_queue_message(request)
                    .map(|result| HostEnqueueResult {
                        message_id: result.message_id,
                        created: result.created,
                    })
                    .map(HostOutput::Enqueue)
                    .map_err(world_error),
                WorldOperation::QueueMessageCount(target) => world
                    .queue_message_count(target)
                    .map(HostOutput::Count)
                    .map_err(world_error),
            }
        })
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        env.to_js_value(&output)
    }
}

pub struct StopQueueWorkerTask {
    worker: Option<QueueWorker>,
    worker_stopping: Arc<AtomicBool>,
}

#[napi]
impl Task for StopQueueWorkerTask {
    type Output = HostQueueWorkerReport;
    type JsValue = Unknown<'static>;

    fn compute(&mut self) -> Result<Self::Output> {
        let result = compute_safely(|| {
            let report = match self.worker.take() {
                Some(worker) => worker.stop().map_err(world_error)?,
                None => QueueWorkerReport::default(),
            };
            Ok(report.into())
        });
        self.worker_stopping.store(false, Ordering::Release);
        result
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        env.to_js_value(&output)
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum HostOutput {
    Unit(()),
    EventResult(Box<HostEventResult>),
    Run(HostRun),
    RunPage(HostRunPage),
    Step(HostStep),
    StepPage(HostStepPage),
    Event(HostEvent),
    EventPage(HostEventPage),
    Enqueue(HostEnqueueResult),
    Count(usize),
}

#[derive(Clone, Debug)]
struct HostBytes(Vec<u8>);

impl Serialize for HostBytes {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRun {
    run_id: String,
    status: &'static str,
    deployment_id: String,
    workflow_name: String,
    spec_version: u32,
    input: HostBytes,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_context: Option<ContextValue>,
    attributes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encryption_public_key: Option<String>,
    created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at_ms: Option<i64>,
    updated_at_ms: i64,
}

impl From<WorkflowRun> for HostRun {
    fn from(run: WorkflowRun) -> Self {
        Self {
            run_id: run.run_id,
            status: run.status.as_str(),
            deployment_id: run.deployment_id,
            workflow_name: run.workflow_name,
            spec_version: run.spec_version,
            input: HostBytes(run.input),
            output: run.output.map(HostBytes),
            error: run.error.map(HostBytes),
            error_code: run.error_code,
            execution_context: run.execution_context,
            attributes: run.attributes,
            encryption_public_key: run.encryption_public_key,
            created_at_ms: run.created_at_ms,
            started_at_ms: run.started_at_ms,
            completed_at_ms: run.completed_at_ms,
            updated_at_ms: run.updated_at_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStep {
    run_id: String,
    step_id: String,
    step_name: String,
    status: &'static str,
    input: HostBytes,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostBytes>,
    attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at_ms: Option<i64>,
    created_at_ms: i64,
    updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<i64>,
    spec_version: u32,
}

impl From<WorkflowStep> for HostStep {
    fn from(step: WorkflowStep) -> Self {
        Self {
            run_id: step.run_id,
            step_id: step.step_id,
            step_name: step.step_name,
            status: step.status.as_str(),
            input: HostBytes(step.input),
            output: step.output.map(HostBytes),
            error: step.error.map(HostBytes),
            attempt: step.attempt,
            started_at_ms: step.started_at_ms,
            completed_at_ms: step.completed_at_ms,
            created_at_ms: step.created_at_ms,
            updated_at_ms: step.updated_at_ms,
            retry_after_ms: step.retry_after_ms,
            spec_version: step.spec_version,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent {
    event_type: &'static str,
    run_id: String,
    event_id: String,
    spec_version: u32,
    created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    occurred_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_data: Option<HostEventData>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct HostEventData {
    #[serde(skip_serializing_if = "Option::is_none")]
    deployment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workflow_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_context: Option<ContextValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attributes: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allow_reserved_attributes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encryption_public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancel_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<HostBytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_message_id: Option<String>,
}

impl From<WorldEvent> for HostEvent {
    fn from(event: WorldEvent) -> Self {
        let event_type = event.event.event_type().as_str();
        let correlation_id = event.event.correlation_id().map(str::to_owned);
        let event_data = match event.event {
            WorldEventData::RunCreated(data) => Some(HostEventData {
                deployment_id: Some(data.deployment_id),
                workflow_name: Some(data.workflow_name),
                input: Some(HostBytes(data.input)),
                execution_context: data.execution_context,
                attributes: data.attributes,
                allow_reserved_attributes: data.allow_reserved_attributes.then_some(true),
                encryption_public_key: data.encryption_public_key,
                ..HostEventData::default()
            }),
            WorldEventData::RunStarted(_) => None,
            WorldEventData::RunCompleted { output } => Some(HostEventData {
                output: output.map(HostBytes),
                ..HostEventData::default()
            }),
            WorldEventData::RunFailed { error, error_code } => Some(HostEventData {
                error: Some(HostBytes(error)),
                error_code,
                ..HostEventData::default()
            }),
            WorldEventData::RunCancelled { cancel_reason } => {
                cancel_reason.map(|cancel_reason| HostEventData {
                    cancel_reason: Some(cancel_reason),
                    ..HostEventData::default()
                })
            }
            WorldEventData::StepCreated {
                step_name, input, ..
            } => Some(HostEventData {
                step_name: Some(step_name),
                input: Some(HostBytes(input)),
                ..HostEventData::default()
            }),
            WorldEventData::StepStarted {
                step_name,
                attempt,
                owner_message_id,
                ..
            } => {
                if step_name.is_none() && attempt.is_none() && owner_message_id.is_none() {
                    None
                } else {
                    Some(HostEventData {
                        step_name,
                        attempt,
                        owner_message_id,
                        ..HostEventData::default()
                    })
                }
            }
            WorldEventData::StepCompleted {
                step_name, result, ..
            } => Some(HostEventData {
                step_name,
                result: Some(HostBytes(result)),
                ..HostEventData::default()
            }),
            WorldEventData::StepFailed {
                step_name, error, ..
            } => Some(HostEventData {
                step_name,
                error: Some(HostBytes(error)),
                ..HostEventData::default()
            }),
            WorldEventData::StepRetrying {
                step_name,
                error,
                retry_after_ms,
                ..
            } => Some(HostEventData {
                step_name,
                error: Some(HostBytes(error)),
                retry_after_ms,
                ..HostEventData::default()
            }),
        };
        Self {
            event_type,
            run_id: event.run_id,
            event_id: workflow_protocol::slot_to_event_id(event.slot)
                .expect("stored event slot is validated"),
            spec_version: event.spec_version,
            created_at_ms: event.created_at_ms,
            occurred_at_ms: event.occurred_at_ms,
            correlation_id,
            event_data,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEventResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<HostEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<HostRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<HostStep>,
    #[serde(skip_serializing_if = "is_false")]
    step_created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    events: Option<Vec<HostEvent>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    has_more: Option<bool>,
}

impl From<WorldEventResult> for HostEventResult {
    fn from(result: WorldEventResult) -> Self {
        let (events, cursor, has_more) = result.skipped_events.map_or((None, None, None), |page| {
            (
                Some(page.data.into_iter().map(HostEvent::from).collect()),
                page.cursor,
                Some(page.has_more),
            )
        });
        Self {
            event: result.event.map(HostEvent::from),
            run: result.run.map(HostRun::from),
            step: result.step.map(HostStep::from),
            step_created: result.step_created,
            events,
            cursor,
            has_more,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRunPage {
    data: Vec<HostRun>,
    cursor: Option<String>,
    has_more: bool,
}

impl From<WorkflowRunPage> for HostRunPage {
    fn from(page: WorkflowRunPage) -> Self {
        Self {
            data: page.data.into_iter().map(HostRun::from).collect(),
            cursor: page.cursor,
            has_more: page.has_more,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStepPage {
    data: Vec<HostStep>,
    cursor: Option<String>,
    has_more: bool,
}

impl From<WorkflowStepPage> for HostStepPage {
    fn from(page: WorkflowStepPage) -> Self {
        Self {
            data: page.data.into_iter().map(HostStep::from).collect(),
            cursor: page.cursor,
            has_more: page.has_more,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEventPage {
    data: Vec<HostEvent>,
    cursor: Option<String>,
    has_more: bool,
}

impl From<WorldEventPage> for HostEventPage {
    fn from(page: WorldEventPage) -> Self {
        Self {
            data: page.data.into_iter().map(HostEvent::from).collect(),
            cursor: page.cursor,
            has_more: page.has_more,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEnqueueResult {
    message_id: String,
    created: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostQueueWorkerReport {
    claims: u64,
    acknowledgements: u64,
    reschedules: u64,
    delivery_failures: u64,
    storage_failures: u64,
}

impl From<QueueWorkerReport> for HostQueueWorkerReport {
    fn from(report: QueueWorkerReport) -> Self {
        Self {
            claims: report.claims,
            acknowledgements: report.acknowledgements,
            reschedules: report.reschedules,
            delivery_failures: report.delivery_failures,
            storage_failures: report.storage_failures,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInfo {
    crate_version: &'static str,
    node_api_version: u32,
    sqlite_version: &'static str,
    schema_version: i64,
    persisted_spec_min: u32,
    persisted_spec_max: u32,
    enabled_backends: [&'static str; 1],
}

#[napi(catch_unwind)]
pub fn native_info(env: Env) -> Result<Unknown<'static>> {
    env.to_js_value(&NativeInfo {
        crate_version: env!("CARGO_PKG_VERSION"),
        node_api_version: 8,
        sqlite_version: sqlite_library_version(),
        schema_version: sqlite_schema_version(),
        persisted_spec_min: workflow_protocol::SUPPORTED_PERSISTED_SPEC_VERSION,
        persisted_spec_max: workflow_protocol::SUPPORTED_PERSISTED_SPEC_VERSION,
        enabled_backends: ["sqlite"],
    })
}

#[allow(clippy::too_many_arguments)]
fn parse_event_data(
    event_type: &str,
    correlation_id: Option<String>,
    payload: Option<Vec<u8>>,
    deployment_id: Option<String>,
    workflow_name: Option<String>,
    execution_context: Option<ContextValue>,
    attributes: Option<BTreeMap<String, String>>,
    allow_reserved_attributes: bool,
    encryption_public_key: Option<String>,
    step_name: Option<String>,
    attempt: Option<u32>,
    retry_after_ms: Option<i64>,
    owner_message_id: Option<String>,
    error_code: Option<String>,
    cancel_reason: Option<String>,
) -> Result<WorldEventData> {
    let required = |value: Option<String>, name: &str| {
        value.ok_or_else(|| native_error("invalid_request", format!("{name} is required")))
    };
    let required_payload = |value: Option<Vec<u8>>, name: &str| {
        value.ok_or_else(|| native_error("invalid_request", format!("{name} is required")))
    };
    let required_step = || required(correlation_id.clone(), "correlationId");
    let run_data = |required_fields: bool| -> Result<Option<RunCreatedEventData>> {
        let has_data = deployment_id.is_some()
            || workflow_name.is_some()
            || payload.is_some()
            || execution_context.is_some()
            || attributes.is_some()
            || encryption_public_key.is_some();
        if !required_fields && !has_data {
            return Ok(None);
        }
        Ok(Some(RunCreatedEventData {
            deployment_id: required(deployment_id.clone(), "deploymentId")?,
            workflow_name: required(workflow_name.clone(), "workflowName")?,
            input: required_payload(payload.clone(), "input")?,
            execution_context: execution_context.clone(),
            attributes: attributes.clone(),
            allow_reserved_attributes,
            encryption_public_key: encryption_public_key.clone(),
        }))
    };
    match event_type {
        "run_created" => Ok(WorldEventData::RunCreated(
            run_data(true)?.expect("required run data"),
        )),
        "run_started" => Ok(WorldEventData::RunStarted(run_data(false)?)),
        "run_completed" => Ok(WorldEventData::RunCompleted { output: payload }),
        "run_failed" => Ok(WorldEventData::RunFailed {
            error: required_payload(payload, "error")?,
            error_code,
        }),
        "run_cancelled" => Ok(WorldEventData::RunCancelled { cancel_reason }),
        "step_created" => Ok(WorldEventData::StepCreated {
            step_id: required_step()?,
            step_name: required(step_name, "stepName")?,
            input: required_payload(payload, "input")?,
        }),
        "step_started" => Ok(WorldEventData::StepStarted {
            step_id: required_step()?,
            step_name,
            input: payload,
            attempt,
            owner_message_id,
        }),
        "step_completed" => Ok(WorldEventData::StepCompleted {
            step_id: required_step()?,
            step_name,
            result: required_payload(payload, "result")?,
        }),
        "step_failed" => Ok(WorldEventData::StepFailed {
            step_id: required_step()?,
            step_name,
            error: required_payload(payload, "error")?,
        }),
        "step_retrying" => Ok(WorldEventData::StepRetrying {
            step_id: required_step()?,
            step_name,
            error: required_payload(payload, "error")?,
            retry_after_ms,
        }),
        other => Err(native_error(
            "unsupported_operation",
            format!("event type {other:?} is outside the Phase 1 run/step slice"),
        )),
    }
}

fn context_from_js(env: &Env, value: Unknown<'_>) -> Result<ContextValue> {
    context_from_js_at_depth(env, value, &mut Vec::new(), 0)
}

fn context_from_js_at_depth<'env>(
    env: &Env,
    value: Unknown<'env>,
    stack: &mut Vec<Unknown<'env>>,
    depth: usize,
) -> Result<ContextValue> {
    if depth > MAX_CONTEXT_DEPTH {
        return Err(Error::new(
            Status::InvalidArg,
            format!("nesting exceeds {MAX_CONTEXT_DEPTH} levels"),
        ));
    }
    match value.get_type()? {
        ValueType::Null => Ok(ContextValue::Null),
        ValueType::Boolean => Ok(ContextValue::Bool(unsafe { value.cast::<bool>()? })),
        ValueType::Number => {
            let value = unsafe { value.cast::<f64>()? };
            if !value.is_finite() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "floating-point values must be finite",
                ));
            }
            if value.fract() == 0.0 && !(value == 0.0 && value.is_sign_negative()) {
                if !(MIN_SAFE_CONTEXT_INTEGER as f64..=MAX_SAFE_CONTEXT_INTEGER as f64)
                    .contains(&value)
                {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "integer exceeds JavaScript's safe integer range",
                    ));
                }
                Ok(ContextValue::Integer(value as i64))
            } else {
                Ok(ContextValue::Float(value))
            }
        }
        ValueType::String => Ok(ContextValue::String(unsafe { value.cast::<String>()? })),
        ValueType::Object => context_object_from_js(env, value, stack, depth),
        ValueType::Undefined => Err(Error::new(Status::InvalidArg, "undefined is not supported")),
        ValueType::BigInt => Err(Error::new(Status::InvalidArg, "BigInt is not supported")),
        ValueType::Function => Err(Error::new(
            Status::InvalidArg,
            "functions are not supported",
        )),
        ValueType::Symbol => Err(Error::new(Status::InvalidArg, "symbols are not supported")),
        ValueType::External | ValueType::Unknown => Err(Error::new(
            Status::InvalidArg,
            "unsupported JavaScript value type",
        )),
    }
}

fn context_object_from_js<'env>(
    env: &Env,
    value: Unknown<'env>,
    stack: &mut Vec<Unknown<'env>>,
    depth: usize,
) -> Result<ContextValue> {
    if value.is_dataview()? {
        return Err(Error::new(
            Status::InvalidArg,
            "DataView is not supported; pass a Uint8Array",
        ));
    }
    if value.is_typedarray()? {
        let typed_array = unsafe { value.cast::<TypedArray<'_>>()? };
        if typed_array.typed_array_type != TypedArrayType::Uint8 {
            return Err(Error::new(
                Status::InvalidArg,
                "only Uint8Array byte views are supported",
            ));
        }
        return Ok(ContextValue::Bytes(typed_array.arraybuffer.to_vec()));
    }
    if value.is_buffer()? {
        return Ok(ContextValue::Bytes(
            unsafe { value.cast::<Buffer>()? }.to_vec(),
        ));
    }
    if value.is_arraybuffer()? {
        return Err(Error::new(
            Status::InvalidArg,
            "ArrayBuffer is not supported; pass a Uint8Array",
        ));
    }
    for ancestor in stack.iter().copied() {
        if env.strict_equals(ancestor, value)? {
            return Err(Error::new(
                Status::InvalidArg,
                "cyclic references are not supported",
            ));
        }
    }
    stack.push(value);
    let result = (|| {
        if value.is_array()? {
            let array = unsafe { value.cast::<Array<'_>>()? };
            let mut values = Vec::with_capacity(array.len() as usize);
            for index in 0..array.len() {
                let item = array
                    .get::<Unknown<'_>>(index)?
                    .ok_or_else(|| Error::new(Status::InvalidArg, "array element disappeared"))?;
                values.push(context_from_js_at_depth(env, item, stack, depth + 1)?);
            }
            Ok(ContextValue::Array(values))
        } else {
            let object = unsafe { value.cast::<Object<'_>>()? };
            require_plain_object(&object)?;
            let keys = object.get_all_property_names(
                KeyCollectionMode::OwnOnly,
                KeyFilter::Enumerable,
                KeyConversion::NumbersToStrings,
            )?;
            let mut values = BTreeMap::new();
            for index in 0..keys.get_array_length()? {
                let key_value = keys.get_element::<Unknown<'_>>(index)?;
                if key_value.get_type()? != ValueType::String {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "object keys must be enumerable strings",
                    ));
                }
                let key = unsafe { key_value.cast::<String>()? };
                let item = object
                    .get::<Unknown<'_>>(&key)?
                    .ok_or_else(|| Error::new(Status::InvalidArg, "object property disappeared"))?;
                values.insert(key, context_from_js_at_depth(env, item, stack, depth + 1)?);
            }
            Ok(ContextValue::Object(values))
        }
    })();
    stack.pop();
    result
}

fn require_plain_object(object: &Object<'_>) -> Result<()> {
    let prototype = object.get_prototype()?;
    match prototype.get_type()? {
        ValueType::Null => Ok(()),
        ValueType::Object => {
            let prototype = unsafe { prototype.cast::<Object<'_>>()? };
            if prototype.get_prototype()?.get_type()? == ValueType::Null {
                Ok(())
            } else {
                Err(Error::new(
                    Status::InvalidArg,
                    "only plain objects are supported",
                ))
            }
        }
        _ => Err(Error::new(
            Status::InvalidArg,
            "only plain objects are supported",
        )),
    }
}

fn number_to_i64(value: f64, label: &str) -> Result<i64> {
    if !value.is_finite()
        || value.fract() != 0.0
        || !(MIN_SAFE_CONTEXT_INTEGER as f64..=MAX_SAFE_CONTEXT_INTEGER as f64).contains(&value)
    {
        return Err(native_error(
            "invalid_request",
            format!("{label} must be a safe integer"),
        ));
    }
    Ok(value as i64)
}

fn number_to_u64(value: f64, label: &str) -> Result<u64> {
    let value = number_to_i64(value, label)?;
    u64::try_from(value)
        .map_err(|_| native_error("invalid_request", format!("{label} must not be negative")))
}

fn number_to_u32(value: f64, label: &str) -> Result<u32> {
    let value = number_to_u64(value, label)?;
    u32::try_from(value).map_err(|_| {
        native_error(
            "invalid_request",
            format!("{label} must be between 0 and {}", u32::MAX),
        )
    })
}

fn world_error(error: WorldError) -> Error {
    native_error_envelope(
        error.kind().as_str(),
        error.message(),
        error.retryable(),
        error.details().clone(),
    )
}

fn native_error(kind: &str, message: impl Into<String>) -> Error {
    native_error_envelope(kind, &message.into(), false, json!({}))
}

fn native_error_envelope(
    kind: &str,
    message: &str,
    retryable: bool,
    details: serde_json::Value,
) -> Error {
    let envelope = json!({
        "code": kind,
        "kind": kind,
        "message": message,
        "retryable": retryable,
        "details": details,
    });
    Error::new(Status::GenericFailure, format!("{ERROR_MARKER}{envelope}"))
}

fn compute_safely<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|panic| {
        let message = if let Some(message) = panic.downcast_ref::<&str>() {
            (*message).to_owned()
        } else if let Some(message) = panic.downcast_ref::<String>() {
            message.clone()
        } else {
            "native task panicked".to_owned()
        };
        Err(native_error("internal", message))
    })
}

const fn is_false(value: &bool) -> bool {
    !*value
}
