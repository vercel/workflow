//! Language-neutral types for the first executable Rust World contract slice.
//!
//! This is deliberately smaller than the public TypeScript `World` surface.
//! Requests here are normalized after a language binding has decoded them; the
//! crate will grow fixture by fixture as semantics are proven across backends.

#![forbid(unsafe_code)]

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
}

impl EventType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RunCreated => "run_created",
            Self::RunStarted => "run_started",
        }
    }
}

impl TryFrom<&str> for EventType {
    type Error = WorldError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "run_created" => Ok(Self::RunCreated),
            "run_started" => Ok(Self::RunStarted),
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
    pub execution_context: Option<Value>,
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
    pub execution_context: Option<Value>,
    pub attributes: BTreeMap<String, String>,
    pub encryption_public_key: Option<String>,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub updated_at_ms: i64,
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
    pub attempt: u32,
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
    NotMigrated,
    UnsupportedSchema,
    PersistedData,
    QueueClaimLost,
    Storage,
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
    use super::{MAX_EVENT_SLOT, event_id_to_slot, slot_to_event_id};

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
