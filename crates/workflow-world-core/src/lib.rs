//! Pure transition planning for the first Rust World contract slice.
//!
//! Backends call this planner against a transactional snapshot that can
//! linearize the outcome. Plans that mutate state must be applied under the
//! same write transaction; the planner does not allocate slots or linearize
//! concurrent writers by itself.

#![forbid(unsafe_code)]

use workflow_protocol::{
    EventType, RunStartPlan, RunStartedRequest, RunStatus, SUPPORTED_PERSISTED_SPEC_VERSION,
    UnpositionedEvent, WorkflowRun, WorldError, WorldErrorKind,
};

const ATTRIBUTE_KEY_MAX_LENGTH: usize = 256;
const ATTRIBUTE_VALUE_MAX_BYTES: usize = 256;
const ATTRIBUTE_MAX_PER_RUN: usize = 64;

pub fn plan_run_started(
    current_run: Option<&WorkflowRun>,
    request: &RunStartedRequest,
    now_ms: i64,
) -> Result<RunStartPlan, WorldError> {
    validate_request(request)?;
    if let Some(run) = current_run {
        validate_persisted_spec(run.spec_version)?;
    }

    match current_run {
        None => {
            let run = WorkflowRun {
                run_id: request.run_id.clone(),
                status: RunStatus::Running,
                deployment_id: request.event_data.deployment_id.clone(),
                workflow_name: request.event_data.workflow_name.clone(),
                spec_version: request.spec_version,
                input: request.event_data.input.clone(),
                execution_context: request.event_data.execution_context.clone(),
                attributes: request.event_data.attributes.clone().unwrap_or_default(),
                encryption_public_key: request.event_data.encryption_public_key.clone(),
                created_at_ms: now_ms,
                started_at_ms: Some(now_ms),
                updated_at_ms: now_ms,
            };

            Ok(RunStartPlan {
                run,
                insert_run: true,
                events: vec![
                    UnpositionedEvent {
                        event_type: EventType::RunCreated,
                        spec_version: request.spec_version,
                        created_at_ms: now_ms,
                        event_data: Some(request.event_data.clone()),
                    },
                    UnpositionedEvent {
                        event_type: EventType::RunStarted,
                        spec_version: request.spec_version,
                        created_at_ms: now_ms,
                        event_data: None,
                    },
                ],
            })
        }
        Some(run) if run.status == RunStatus::Running => Ok(RunStartPlan {
            run: run.clone(),
            insert_run: false,
            events: Vec::new(),
        }),
        Some(run) if run.status == RunStatus::Pending => {
            let mut started = run.clone();
            started.status = RunStatus::Running;
            started.started_at_ms = Some(now_ms);
            started.updated_at_ms = now_ms;
            Ok(RunStartPlan {
                run: started,
                insert_run: false,
                events: vec![UnpositionedEvent {
                    event_type: EventType::RunStarted,
                    spec_version: request.spec_version,
                    created_at_ms: now_ms,
                    event_data: None,
                }],
            })
        }
        Some(run) => Err(WorldError::new(
            WorldErrorKind::RunExpired,
            format!(
                "workflow run {:?} is already in terminal state {:?}",
                run.run_id, run.status
            ),
        )),
    }
}

fn validate_request(request: &RunStartedRequest) -> Result<(), WorldError> {
    if request.run_id.is_empty() {
        return Err(WorldError::invalid_request("runId must not be empty"));
    }
    validate_persisted_spec(request.spec_version)?;
    if request.event_data.deployment_id.is_empty() {
        return Err(WorldError::invalid_request(
            "eventData.deploymentId must not be empty",
        ));
    }
    if request.event_data.workflow_name.is_empty() {
        return Err(WorldError::invalid_request(
            "eventData.workflowName must not be empty",
        ));
    }
    if request
        .event_data
        .execution_context
        .as_ref()
        .is_some_and(|value| !value.is_object())
    {
        return Err(WorldError::invalid_request(
            "eventData.executionContext must be an object when present",
        ));
    }
    validate_attributes(request)?;
    Ok(())
}

fn validate_persisted_spec(spec_version: u32) -> Result<(), WorldError> {
    if spec_version == SUPPORTED_PERSISTED_SPEC_VERSION {
        return Ok(());
    }
    Err(WorldError::new(
        WorldErrorKind::UnsupportedSpec,
        format!(
            "this Rust World slice supports persisted spec {SUPPORTED_PERSISTED_SPEC_VERSION}, got {spec_version}"
        ),
    ))
}

fn validate_attributes(request: &RunStartedRequest) -> Result<(), WorldError> {
    let Some(attributes) = &request.event_data.attributes else {
        return Ok(());
    };
    if attributes.len() > ATTRIBUTE_MAX_PER_RUN {
        return Err(WorldError::invalid_request(format!(
            "run attribute count {} exceeds limit {ATTRIBUTE_MAX_PER_RUN}",
            attributes.len()
        )));
    }
    for (key, value) in attributes {
        let key_length = key.encode_utf16().count();
        if key_length == 0 {
            return Err(WorldError::invalid_request(
                "attribute key must not be empty",
            ));
        }
        if key_length > ATTRIBUTE_KEY_MAX_LENGTH {
            return Err(WorldError::invalid_request(format!(
                "attribute key length {key_length} exceeds limit {ATTRIBUTE_KEY_MAX_LENGTH}"
            )));
        }
        if key.starts_with('$') && !request.event_data.allow_reserved_attributes {
            return Err(WorldError::invalid_request(format!(
                "attribute key {key:?} uses the reserved $ prefix"
            )));
        }
        if value.len() > ATTRIBUTE_VALUE_MAX_BYTES {
            return Err(WorldError::invalid_request(format!(
                "attribute value byte length {} exceeds limit {ATTRIBUTE_VALUE_MAX_BYTES}",
                value.len()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;
    use workflow_protocol::{EventType, RunCreatedEventData, RunStartedRequest, RunStatus};

    use super::plan_run_started;

    fn request() -> RunStartedRequest {
        RunStartedRequest {
            run_id: "wrun_fixture".to_owned(),
            spec_version: 7,
            event_data: RunCreatedEventData {
                deployment_id: "dpl_fixture".to_owned(),
                workflow_name: "workflow//fixture".to_owned(),
                input: vec![0, 1, 2, 255],
                execution_context: Some(
                    json!({ "fixture": true })
                        .try_into()
                        .expect("fixture context"),
                ),
                attributes: Some(BTreeMap::from([
                    ("$rootRunId".to_owned(), "wrun_root".to_owned()),
                    ("fixture".to_owned(), "resilient-start".to_owned()),
                ])),
                allow_reserved_attributes: true,
                encryption_public_key: Some("fixture-public-key".to_owned()),
            },
        }
    }

    #[test]
    fn missing_run_plans_created_before_started() {
        let plan = plan_run_started(None, &request(), 123).expect("plan should succeed");

        assert!(plan.insert_run);
        assert_eq!(plan.run.status, RunStatus::Running);
        assert_eq!(plan.run.started_at_ms, Some(123));
        assert_eq!(plan.events.len(), 2);
        assert_eq!(plan.events[0].event_type, EventType::RunCreated);
        assert!(plan.events[0].event_data.is_some());
        assert_eq!(plan.events[1].event_type, EventType::RunStarted);
        assert!(plan.events[1].event_data.is_none());
    }

    #[test]
    fn repeated_start_of_running_run_is_idempotent() {
        let first = plan_run_started(None, &request(), 123).expect("first plan should succeed");
        let second =
            plan_run_started(Some(&first.run), &request(), 456).expect("retry should succeed");

        assert!(!second.insert_run);
        assert!(second.events.is_empty());
        assert_eq!(second.run, first.run);
    }

    #[test]
    fn rejects_unknown_spec_before_planning_mutations() {
        let mut request = request();
        request.spec_version = 8;
        let error = plan_run_started(None, &request, 123).expect_err("spec 8 is unsupported");

        assert_eq!(
            error.kind(),
            workflow_protocol::WorldErrorKind::UnsupportedSpec
        );
    }

    #[test]
    fn rejects_a_persisted_run_from_an_unknown_spec() {
        let request = request();
        let mut run = plan_run_started(None, &request, 123)
            .expect("known spec should succeed")
            .run;
        run.spec_version = 8;
        let error = plan_run_started(Some(&run), &request, 456).expect_err("spec 8 is unsupported");

        assert_eq!(
            error.kind(),
            workflow_protocol::WorldErrorKind::UnsupportedSpec
        );
    }
}
