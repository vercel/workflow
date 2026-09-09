//! Language-neutral types for the first executable Rust World contract slice.
//!
//! This is deliberately smaller than the public TypeScript `World` surface.
//! Requests here are normalized after a language binding has decoded them; the
//! crate will grow fixture by fixture as semantics are proven across backends.

#![forbid(unsafe_code)]

mod persisted_codec;

pub use persisted_codec::{
    ContextValue, MAX_SAFE_CONTEXT_INTEGER, MIN_SAFE_CONTEXT_INTEGER, PersistedValue,
    SQLITE_CONTEXT_CODEC, decode_context_value, decode_legacy_cbor_x, decode_legacy_json_text,
    encode_context_value,
};

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    RunCreated,
    RunStarted,
    RunCompleted,
    RunFailed,
    RunCancelled,
    AttrSet,
    StepCreated,
    StepStarted,
    StepCompleted,
    StepFailed,
    StepRetrying,
    HookCreated,
    HookReceived,
    HookDisposed,
    HookConflict,
    WaitCreated,
    WaitCompleted,
    Noop,
}

impl EventType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RunCreated => "run_created",
            Self::RunStarted => "run_started",
            Self::RunCompleted => "run_completed",
            Self::RunFailed => "run_failed",
            Self::RunCancelled => "run_cancelled",
            Self::AttrSet => "attr_set",
            Self::StepCreated => "step_created",
            Self::StepStarted => "step_started",
            Self::StepCompleted => "step_completed",
            Self::StepFailed => "step_failed",
            Self::StepRetrying => "step_retrying",
            Self::HookCreated => "hook_created",
            Self::HookReceived => "hook_received",
            Self::HookDisposed => "hook_disposed",
            Self::HookConflict => "hook_conflict",
            Self::WaitCreated => "wait_created",
            Self::WaitCompleted => "wait_completed",
            Self::Noop => "noop",
        }
    }
}

impl TryFrom<&str> for EventType {
    type Error = WorldError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "run_created" => Ok(Self::RunCreated),
            "run_started" => Ok(Self::RunStarted),
            "run_completed" => Ok(Self::RunCompleted),
            "run_failed" => Ok(Self::RunFailed),
            "run_cancelled" => Ok(Self::RunCancelled),
            "attr_set" => Ok(Self::AttrSet),
            "step_created" => Ok(Self::StepCreated),
            "step_started" => Ok(Self::StepStarted),
            "step_completed" => Ok(Self::StepCompleted),
            "step_failed" => Ok(Self::StepFailed),
            "step_retrying" => Ok(Self::StepRetrying),
            "hook_created" => Ok(Self::HookCreated),
            "hook_received" => Ok(Self::HookReceived),
            "hook_disposed" => Ok(Self::HookDisposed),
            "hook_conflict" => Ok(Self::HookConflict),
            "wait_created" => Ok(Self::WaitCreated),
            "wait_completed" => Ok(Self::WaitCompleted),
            "noop" => Ok(Self::Noop),
            other => Err(WorldError::persisted_data(format!(
                "unsupported event type in persisted storage: {other}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitStatus {
    Waiting,
    Completed,
}

impl WaitStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Completed => "completed",
        }
    }
}

impl TryFrom<&str> for WaitStatus {
    type Error = WorldError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "waiting" => Ok(Self::Waiting),
            "completed" => Ok(Self::Completed),
            other => Err(WorldError::persisted_data(format!(
                "unsupported wait status in persisted storage: {other}"
            ))),
        }
    }
}

impl StepStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

impl TryFrom<&str> for StepStatus {
    type Error = WorldError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(WorldError::persisted_data(format!(
                "unsupported step status in SQLite storage: {other}"
            ))),
        }
    }
}

impl RunStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

impl TryFrom<&str> for RunStatus {
    type Error = WorldError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(WorldError::persisted_data(format!(
                "unsupported run status in SQLite storage: {other}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunCreatedEventData {
    pub deployment_id: String,
    pub workflow_name: String,
    pub input: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_context: Option<ContextValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_reserved_attributes: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_public_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunStartedRequest {
    pub run_id: String,
    pub spec_version: u32,
    pub event_data: RunCreatedEventData,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub run_id: String,
    pub status: RunStatus,
    pub deployment_id: String,
    pub workflow_name: String,
    pub spec_version: u32,
    pub input: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub execution_context: Option<ContextValue>,
    pub attributes: BTreeMap<String, String>,
    pub encryption_public_key: Option<String>,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_ms: Option<i64>,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub run_id: String,
    pub step_id: String,
    pub step_name: String,
    pub status: StepStatus,
    pub input: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Vec<u8>>,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
    pub spec_version: u32,
}

/// A materialized Hook owned by a workflow run.
///
/// Host-specific tenancy fields and transient resume capabilities are added by
/// the binding. This durable shape contains only values with portable local
/// storage semantics.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHook {
    pub run_id: String,
    pub hook_id: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Vec<u8>>,
    pub created_at_ms: i64,
    pub spec_version: u32,
    pub is_webhook: bool,
    pub is_system: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_retention_until_ms: Option<i64>,
}

/// A materialized durable wait owned by a workflow run.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowWait {
    pub wait_id: String,
    pub run_id: String,
    pub status: WaitStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub spec_version: u32,
}

/// A single plaintext workflow-run attribute update. `None` removes the key.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeChange {
    pub key: String,
    pub value: Option<String>,
}

/// The workflow execution context that authored an attribute update.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AttributeWriter {
    Workflow,
    Step { step_id: String, attempt: u32 },
}

/// Host-normalized request for one event accepted by a World backend.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateWorldEventRequest {
    pub run_id: String,
    pub spec_version: u32,
    pub event_count: Option<u64>,
    pub occurred_at_ms: Option<i64>,
    /// Idempotency key for a lazily persisted `hook_received` delivery.
    pub resume_id: Option<String>,
    /// Digest used to reject reuse of a resume id with another payload.
    pub resume_payload_digest: Option<String>,
    pub event: WorldEventData,
}

/// Event data after host values have been converted and payloads made opaque.
#[derive(Clone, Debug, PartialEq)]
pub enum WorldEventData {
    RunCreated(RunCreatedEventData),
    RunStarted(Option<RunCreatedEventData>),
    RunCompleted {
        output: Option<Vec<u8>>,
    },
    RunFailed {
        error: Vec<u8>,
        error_code: Option<String>,
    },
    RunCancelled {
        cancel_reason: Option<String>,
    },
    AttrSet {
        correlation_id: Option<String>,
        changes: Vec<AttributeChange>,
        writer: AttributeWriter,
        allow_reserved_attributes: bool,
    },
    StepCreated {
        step_id: String,
        step_name: String,
        input: Vec<u8>,
    },
    StepStarted {
        step_id: String,
        step_name: Option<String>,
        input: Option<Vec<u8>>,
        attempt: Option<u32>,
        owner_message_id: Option<String>,
    },
    StepCompleted {
        step_id: String,
        step_name: Option<String>,
        result: Vec<u8>,
    },
    StepFailed {
        step_id: String,
        step_name: Option<String>,
        error: Vec<u8>,
    },
    StepRetrying {
        step_id: String,
        step_name: Option<String>,
        error: Vec<u8>,
        retry_after_ms: Option<i64>,
    },
    HookCreated {
        hook_id: String,
        token: String,
        metadata: Option<Vec<u8>>,
        token_retention_until_ms: Option<i64>,
        is_webhook: Option<bool>,
        is_system: Option<bool>,
    },
    HookReceived {
        hook_id: String,
        token: Option<String>,
        payload: Vec<u8>,
    },
    HookDisposed {
        hook_id: String,
        token: Option<String>,
    },
    /// Backend-produced event returned when a requested Hook token is owned.
    HookConflict {
        hook_id: String,
        token: String,
        conflicting_run_id: Option<String>,
    },
    WaitCreated {
        wait_id: String,
        resume_at_ms: i64,
    },
    WaitCompleted {
        wait_id: String,
        resume_at_ms: Option<i64>,
    },
    /// Backend-produced filler representing a sealed abandoned log position.
    Noop {
        sealed: Option<bool>,
    },
}

impl WorldEventData {
    #[must_use]
    pub const fn event_type(&self) -> EventType {
        match self {
            Self::RunCreated(_) => EventType::RunCreated,
            Self::RunStarted(_) => EventType::RunStarted,
            Self::RunCompleted { .. } => EventType::RunCompleted,
            Self::RunFailed { .. } => EventType::RunFailed,
            Self::RunCancelled { .. } => EventType::RunCancelled,
            Self::AttrSet { .. } => EventType::AttrSet,
            Self::StepCreated { .. } => EventType::StepCreated,
            Self::StepStarted { .. } => EventType::StepStarted,
            Self::StepCompleted { .. } => EventType::StepCompleted,
            Self::StepFailed { .. } => EventType::StepFailed,
            Self::StepRetrying { .. } => EventType::StepRetrying,
            Self::HookCreated { .. } => EventType::HookCreated,
            Self::HookReceived { .. } => EventType::HookReceived,
            Self::HookDisposed { .. } => EventType::HookDisposed,
            Self::HookConflict { .. } => EventType::HookConflict,
            Self::WaitCreated { .. } => EventType::WaitCreated,
            Self::WaitCompleted { .. } => EventType::WaitCompleted,
            Self::Noop { .. } => EventType::Noop,
        }
    }

    #[must_use]
    pub fn correlation_id(&self) -> Option<&str> {
        match self {
            Self::StepCreated { step_id, .. }
            | Self::StepStarted { step_id, .. }
            | Self::StepCompleted { step_id, .. }
            | Self::StepFailed { step_id, .. }
            | Self::StepRetrying { step_id, .. } => Some(step_id),
            Self::AttrSet { correlation_id, .. } => correlation_id.as_deref(),
            Self::HookCreated { hook_id, .. }
            | Self::HookReceived { hook_id, .. }
            | Self::HookDisposed { hook_id, .. }
            | Self::HookConflict { hook_id, .. } => Some(hook_id),
            Self::WaitCreated { wait_id, .. } | Self::WaitCompleted { wait_id, .. } => {
                Some(wait_id)
            }
            _ => None,
        }
    }

    #[must_use]
    pub const fn is_present(&self) -> bool {
        !matches!(
            self,
            Self::RunStarted(None)
                | Self::RunCancelled {
                    cancel_reason: None
                }
                | Self::StepStarted {
                    step_name: None,
                    attempt: None,
                    owner_message_id: None,
                    ..
                }
                | Self::HookDisposed { token: None, .. }
                | Self::WaitCompleted {
                    resume_at_ms: None,
                    ..
                }
                | Self::Noop { sealed: None }
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct UnpositionedWorldEvent {
    pub event: WorldEventData,
    pub spec_version: u32,
    pub created_at_ms: i64,
    pub occurred_at_ms: Option<i64>,
    pub resume_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorldEvent {
    pub run_id: String,
    pub slot: u64,
    pub event: WorldEventData,
    pub spec_version: u32,
    pub created_at_ms: i64,
    pub occurred_at_ms: Option<i64>,
    pub resume_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorldEventPage {
    pub data: Vec<WorldEvent>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowRunPage {
    pub data: Vec<WorkflowRun>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowStepPage {
    pub data: Vec<WorkflowStep>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorldEventResult {
    pub event: Option<WorldEvent>,
    pub run: Option<WorkflowRun>,
    pub step: Option<WorkflowStep>,
    pub hook: Option<WorkflowHook>,
    pub wait: Option<WorkflowWait>,
    pub step_created: bool,
    pub skipped_events: Option<WorldEventPage>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorldMutationPlan {
    pub run: Option<WorkflowRun>,
    pub insert_run: bool,
    pub step: Option<WorkflowStep>,
    pub insert_step: bool,
    pub step_created: bool,
    /// Hook to insert or delete. `delete_hook` distinguishes deletion.
    pub hook: Option<WorkflowHook>,
    pub insert_hook: bool,
    pub delete_hook: bool,
    pub wait: Option<WorkflowWait>,
    pub insert_wait: bool,
    /// Apply terminal-run Hook cleanup, preserving active minimum retention.
    pub cleanup_hooks_for_run: bool,
    /// Delete all materialized waits for a terminal run.
    pub delete_waits_for_run: bool,
    pub events: Vec<UnpositionedWorldEvent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub run_id: String,
    pub slot: u64,
    pub event_type: EventType,
    pub spec_version: u32,
    pub created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_data: Option<RunCreatedEventData>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UnpositionedEvent {
    pub event_type: EventType,
    pub spec_version: u32,
    pub created_at_ms: i64,
    pub event_data: Option<RunCreatedEventData>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunStartPlan {
    pub run: WorkflowRun,
    pub insert_run: bool,
    pub events: Vec<UnpositionedEvent>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventPage {
    pub events: Vec<StoredEvent>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CreateEventResult {
    pub run: WorkflowRun,
    pub event: Option<StoredEvent>,
    pub preload: Option<EventPage>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorldSnapshot {
    pub run: WorkflowRun,
    pub events: Vec<StoredEvent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueueMessageRequest {
    pub message_id: String,
    pub scope: String,
    pub queue_name: String,
    pub idempotency_key: String,
    pub body: Vec<u8>,
    pub available_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueueEnqueueResult {
    pub message_id: String,
    pub created: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueueClaim {
    pub message_id: String,
    pub scope: String,
    pub queue_name: String,
    pub body: Vec<u8>,
    /// Durable lease-claim count, used for queue recovery diagnostics.
    pub attempt: u32,
    /// Candidate handler delivery number. This advances only after an HTTP
    /// response proves that the handler accepted the delivery.
    pub delivery_attempt: u32,
    pub lease_token: String,
    pub lease_owner: String,
    pub lease_expires_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueueReconcileResult {
    pub active_run_count: usize,
    pub created_message_count: usize,
    pub message_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorldErrorKind {
    InvalidRequest,
    UnsupportedSpec,
    RunExpired,
    RunNotFound,
    StepNotFound,
    HookNotFound,
    WaitNotFound,
    EntityConflict,
    TooEarly,
    UnsupportedOperation,
    Closed,
    NotMigrated,
    UnsupportedSchema,
    PersistedData,
    QueueClaimLost,
    Storage,
}

impl WorldErrorKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnsupportedSpec => "unsupported_spec",
            Self::RunExpired => "run_expired",
            Self::RunNotFound => "run_not_found",
            Self::StepNotFound => "step_not_found",
            Self::HookNotFound => "hook_not_found",
            Self::WaitNotFound => "wait_not_found",
            Self::EntityConflict => "entity_conflict",
            Self::TooEarly => "too_early",
            Self::UnsupportedOperation => "unsupported_operation",
            Self::Closed => "closed",
            Self::NotMigrated => "not_migrated",
            Self::UnsupportedSchema => "unsupported_schema",
            Self::PersistedData => "persisted_data",
            Self::QueueClaimLost => "queue_claim_lost",
            Self::Storage => "storage",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorldError {
    kind: WorldErrorKind,
    message: String,
    retryable: bool,
    details: Value,
}

impl WorldError {
    #[must_use]
    pub fn new(kind: WorldErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable: false,
            details: Value::Object(Default::default()),
        }
    }

    #[must_use]
    pub const fn kind(&self) -> WorldErrorKind {
        self.kind
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    #[must_use]
    pub const fn retryable(&self) -> bool {
        self.retryable
    }

    #[must_use]
    pub fn details(&self) -> &Value {
        &self.details
    }

    #[must_use]
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    #[must_use]
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(WorldErrorKind::InvalidRequest, message)
    }

    #[must_use]
    pub fn persisted_data(message: impl Into<String>) -> Self {
        Self::new(WorldErrorKind::PersistedData, message)
    }
}

impl Display for WorldError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for WorldError {}

pub const MAX_EVENT_SLOT: u64 = 9_007_199_254_740_991;
pub const SUPPORTED_PERSISTED_SPEC_VERSION: u32 = 7;

const fn is_false(value: &bool) -> bool {
    !*value
}

pub fn slot_to_event_id(slot: u64) -> Result<String, WorldError> {
    if !(1..=MAX_EVENT_SLOT).contains(&slot) {
        return Err(WorldError::invalid_request(format!(
            "invalid event slot: {slot}"
        )));
    }
    Ok(format!("evnt_{slot:026}"))
}

pub fn event_id_to_slot(event_id: &str) -> Result<u64, WorldError> {
    let digits = event_id.strip_prefix("evnt_").ok_or_else(|| {
        WorldError::invalid_request(format!("invalid event cursor: {event_id:?}"))
    })?;
    if digits.len() != 26 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(WorldError::invalid_request(format!(
            "invalid event cursor: {event_id:?}"
        )));
    }
    let slot = digits
        .parse::<u64>()
        .map_err(|_| WorldError::invalid_request(format!("invalid event cursor: {event_id:?}")))?;
    if slot_to_event_id(slot)?.as_str() != event_id {
        return Err(WorldError::invalid_request(format!(
            "non-canonical event cursor: {event_id:?}"
        )));
    }
    Ok(slot)
}

#[cfg(test)]
mod tests {
    use super::{EventType, MAX_EVENT_SLOT, event_id_to_slot, slot_to_event_id};

    #[test]
    fn all_current_event_types_round_trip_the_persisted_names() {
        let event_types = [
            EventType::RunCreated,
            EventType::RunStarted,
            EventType::RunCompleted,
            EventType::RunFailed,
            EventType::RunCancelled,
            EventType::AttrSet,
            EventType::StepCreated,
            EventType::StepStarted,
            EventType::StepCompleted,
            EventType::StepFailed,
            EventType::StepRetrying,
            EventType::HookCreated,
            EventType::HookReceived,
            EventType::HookDisposed,
            EventType::HookConflict,
            EventType::WaitCreated,
            EventType::WaitCompleted,
            EventType::Noop,
        ];

        for event_type in event_types {
            assert_eq!(
                EventType::try_from(event_type.as_str()).expect("known event type should parse"),
                event_type
            );
        }
    }

    #[test]
    fn event_ids_match_the_typescript_slot_format() {
        assert_eq!(
            slot_to_event_id(1).expect("slot should be valid"),
            "evnt_00000000000000000000000001"
        );
        assert!(slot_to_event_id(0).is_err());
        assert!(slot_to_event_id(MAX_EVENT_SLOT + 1).is_err());
    }

    #[test]
    fn event_cursor_round_trips_and_rejects_non_canonical_values() {
        let event_id = slot_to_event_id(42).expect("slot should be valid");
        assert_eq!(
            event_id_to_slot(&event_id).expect("cursor should parse"),
            42
        );
        assert!(event_id_to_slot("evnt_42").is_err());
        assert!(event_id_to_slot("step_00000000000000000000000042").is_err());
    }
}
