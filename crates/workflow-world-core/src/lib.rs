//! Pure transition planning for the first Rust World contract slice.
//!
//! Backends call this planner against a transactional snapshot that can
//! linearize the outcome. Plans that mutate state must be applied under the
//! same write transaction; the planner does not allocate slots or linearize
//! concurrent writers by itself.

#![forbid(unsafe_code)]

use workflow_protocol::{
    CreateWorldEventRequest, EventType, RunCreatedEventData, RunStartPlan, RunStartedRequest,
    RunStatus, SUPPORTED_PERSISTED_SPEC_VERSION, StepStatus, UnpositionedEvent,
    UnpositionedWorldEvent, WorkflowRun, WorkflowStep, WorldError, WorldErrorKind, WorldEventData,
    WorldMutationPlan,
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
                output: None,
                error: None,
                error_code: None,
                execution_context: request.event_data.execution_context.clone(),
                attributes: request.event_data.attributes.clone().unwrap_or_default(),
                encryption_public_key: request.event_data.encryption_public_key.clone(),
                created_at_ms: now_ms,
                started_at_ms: Some(now_ms),
                completed_at_ms: None,
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

// @lat: [[rust-portability#Proposed System Shape#Ownership Boundaries]]
/// Plan one Phase 1 run/step event without performing I/O or allocating a slot.
///
/// A backend must obtain `current_run` and `current_step` while holding its
/// write transaction, call this function, and apply the returned plan before
/// committing that same transaction.
pub fn plan_world_event(
    current_run: Option<&WorkflowRun>,
    current_step: Option<&WorkflowStep>,
    request: &CreateWorldEventRequest,
    now_ms: i64,
) -> Result<WorldMutationPlan, WorldError> {
    validate_world_event_request(request, now_ms)?;
    if let Some(run) = current_run {
        validate_persisted_spec(run.spec_version)?;
        if run.run_id != request.run_id {
            return Err(WorldError::invalid_request(
                "the locked run does not match the event request",
            ));
        }
    }
    if let Some(step) = current_step {
        validate_persisted_spec(step.spec_version)?;
        if step.run_id != request.run_id {
            return Err(WorldError::invalid_request(
                "the locked step does not belong to the event request run",
            ));
        }
    }

    // `created_at_ms` is the backend acceptance time. The caller's logical
    // clock is retained independently as `occurred_at_ms` on the event.
    let created_at_ms = now_ms;
    let make_event = |event| UnpositionedWorldEvent {
        event,
        spec_version: request.spec_version,
        created_at_ms,
        occurred_at_ms: request.occurred_at_ms,
    };
    let empty_plan = || WorldMutationPlan {
        run: None,
        insert_run: false,
        step: None,
        insert_step: false,
        step_created: false,
        events: Vec::new(),
    };

    match &request.event {
        WorldEventData::RunCreated(data) => {
            if current_run.is_some() {
                return Err(entity_conflict(format!(
                    "workflow run {:?} already exists",
                    request.run_id
                )));
            }
            validate_run_created_data(data, request.spec_version)?;
            let run = WorkflowRun {
                run_id: request.run_id.clone(),
                status: RunStatus::Pending,
                deployment_id: data.deployment_id.clone(),
                workflow_name: data.workflow_name.clone(),
                spec_version: request.spec_version,
                input: data.input.clone(),
                output: None,
                error: None,
                error_code: None,
                execution_context: data.execution_context.clone(),
                attributes: data.attributes.clone().unwrap_or_default(),
                encryption_public_key: data.encryption_public_key.clone(),
                created_at_ms,
                started_at_ms: None,
                completed_at_ms: None,
                updated_at_ms: created_at_ms,
            };
            Ok(WorldMutationPlan {
                run: Some(run),
                insert_run: true,
                events: vec![make_event(WorldEventData::RunCreated(data.clone()))],
                ..empty_plan()
            })
        }
        WorldEventData::RunStarted(resilient_data) => {
            let event_data = match (current_run, resilient_data) {
                (None, None) => return Err(run_not_found(&request.run_id)),
                (_, Some(data)) => data.clone(),
                (Some(run), None) => run_created_data_from_run(run),
            };
            let start_request = RunStartedRequest {
                run_id: request.run_id.clone(),
                spec_version: request.spec_version,
                event_data,
            };
            let start_plan = plan_run_started(current_run, &start_request, created_at_ms)?;
            let events = start_plan
                .events
                .into_iter()
                .map(|event| {
                    let event = match event.event_type {
                        EventType::RunCreated => WorldEventData::RunCreated(
                            event.event_data.expect("run_created plan has event data"),
                        ),
                        EventType::RunStarted => WorldEventData::RunStarted(None),
                        _ => unreachable!("run start planner emitted an unrelated event"),
                    };
                    UnpositionedWorldEvent {
                        event,
                        spec_version: request.spec_version,
                        created_at_ms,
                        occurred_at_ms: request.occurred_at_ms,
                    }
                })
                .collect();
            Ok(WorldMutationPlan {
                run: Some(start_plan.run),
                insert_run: start_plan.insert_run,
                events,
                ..empty_plan()
            })
        }
        WorldEventData::RunCompleted { output } => {
            let mut run = require_run(current_run, &request.run_id)?.clone();
            require_active_run(&run)?;
            run.status = RunStatus::Completed;
            run.output = output.clone();
            run.error = None;
            run.error_code = None;
            run.completed_at_ms = Some(created_at_ms);
            run.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                run: Some(run),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::RunFailed { error, error_code } => {
            let mut run = require_run(current_run, &request.run_id)?.clone();
            require_active_run(&run)?;
            run.status = RunStatus::Failed;
            run.output = None;
            run.error = Some(error.clone());
            run.error_code = error_code.clone();
            run.completed_at_ms = Some(created_at_ms);
            run.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                run: Some(run),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::RunCancelled { .. } => {
            let mut run = require_run(current_run, &request.run_id)?.clone();
            if run.status == RunStatus::Cancelled {
                return Ok(WorldMutationPlan {
                    run: Some(run),
                    ..empty_plan()
                });
            }
            require_active_run(&run)?;
            run.status = RunStatus::Cancelled;
            run.output = None;
            run.error = None;
            run.error_code = None;
            run.completed_at_ms = Some(created_at_ms);
            run.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                run: Some(run),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::StepCreated {
            step_id,
            step_name,
            input,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            require_child_creation_allowed(run)?;
            validate_step_identity(step_id, step_name)?;
            if current_step.is_some() {
                return Err(entity_conflict(format!(
                    "step {step_id:?} already exists in run {:?}",
                    request.run_id
                )));
            }
            let step = WorkflowStep {
                run_id: request.run_id.clone(),
                step_id: step_id.clone(),
                step_name: step_name.clone(),
                status: StepStatus::Pending,
                input: input.clone(),
                output: None,
                error: None,
                attempt: 0,
                started_at_ms: None,
                completed_at_ms: None,
                created_at_ms,
                updated_at_ms: created_at_ms,
                retry_after_ms: None,
                spec_version: request.spec_version,
            };
            Ok(WorldMutationPlan {
                step: Some(step),
                insert_step: true,
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::StepStarted {
            step_id,
            step_name,
            input,
            attempt,
            owner_message_id,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            let lazy = input.is_some();
            let (mut step, insert_step, step_created, mut events) = if lazy {
                require_child_creation_allowed(run)?;
                if current_step.is_some() {
                    return Err(entity_conflict(format!(
                        "step {step_id:?} already exists in run {:?}",
                        request.run_id
                    )));
                }
                let step_name = step_name.as_deref().ok_or_else(|| {
                    WorldError::invalid_request("lazy step_started requires eventData.stepName")
                })?;
                validate_step_identity(step_id, step_name)?;
                let input = input
                    .as_ref()
                    .expect("lazy step start was selected from an input");
                let step = WorkflowStep {
                    run_id: request.run_id.clone(),
                    step_id: step_id.clone(),
                    step_name: step_name.to_owned(),
                    status: StepStatus::Pending,
                    input: input.clone(),
                    output: None,
                    error: None,
                    attempt: 0,
                    started_at_ms: None,
                    completed_at_ms: None,
                    created_at_ms,
                    updated_at_ms: created_at_ms,
                    retry_after_ms: None,
                    spec_version: request.spec_version,
                };
                let created = make_event(WorldEventData::StepCreated {
                    step_id: step_id.clone(),
                    step_name: step_name.to_owned(),
                    input: input.clone(),
                });
                (step, true, true, vec![created])
            } else {
                let step = require_step(current_step, &request.run_id, step_id)?.clone();
                if run.status.is_terminal() {
                    return Err(WorldError::new(
                        WorldErrorKind::RunExpired,
                        format!(
                            "cannot start step {step_id:?} on terminal run {:?}",
                            request.run_id
                        ),
                    ));
                }
                (step, false, false, Vec::new())
            };
            if step.status.is_terminal() {
                return Err(entity_conflict(format!(
                    "cannot modify step {step_id:?} in terminal state {:?}",
                    step.status
                )));
            }
            if step
                .retry_after_ms
                .is_some_and(|retry_after| retry_after > now_ms)
            {
                return Err(WorldError::new(
                    WorldErrorKind::TooEarly,
                    format!("step {step_id:?} cannot start before retryAfter"),
                ));
            }
            step.status = StepStatus::Running;
            step.started_at_ms.get_or_insert(created_at_ms);
            step.attempt = step.attempt.checked_add(1).ok_or_else(|| {
                WorldError::persisted_data(format!("step {step_id:?} attempt overflow"))
            })?;
            step.retry_after_ms = None;
            step.updated_at_ms = created_at_ms;
            events.push(make_event(WorldEventData::StepStarted {
                step_id: step_id.clone(),
                step_name: step_name.clone(),
                input: None,
                attempt: *attempt,
                owner_message_id: owner_message_id.clone(),
            }));
            Ok(WorldMutationPlan {
                step: Some(step),
                insert_step,
                step_created,
                events,
                ..empty_plan()
            })
        }
        WorldEventData::StepCompleted {
            step_id,
            step_name: _,
            result,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            let mut step = require_mutable_step(current_step, &request.run_id, step_id)?;
            require_terminal_step_transition_allowed(run, &step)?;
            step.status = StepStatus::Completed;
            step.output = Some(result.clone());
            step.completed_at_ms = Some(created_at_ms);
            step.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                step: Some(step),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::StepFailed {
            step_id,
            step_name: _,
            error,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            let mut step = require_mutable_step(current_step, &request.run_id, step_id)?;
            require_terminal_step_transition_allowed(run, &step)?;
            step.status = StepStatus::Failed;
            step.error = Some(error.clone());
            step.completed_at_ms = Some(created_at_ms);
            step.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                step: Some(step),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::StepRetrying {
            step_id,
            step_name: _,
            error,
            retry_after_ms,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            if run.status.is_terminal() {
                return Err(WorldError::new(
                    WorldErrorKind::RunExpired,
                    format!(
                        "cannot retry step {step_id:?} on terminal run {:?}",
                        request.run_id
                    ),
                ));
            }
            let mut step = require_mutable_step(current_step, &request.run_id, step_id)?;
            step.status = StepStatus::Pending;
            step.error = Some(error.clone());
            step.retry_after_ms = *retry_after_ms;
            step.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                step: Some(step),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
    }
}

fn validate_world_event_request(
    request: &CreateWorldEventRequest,
    now_ms: i64,
) -> Result<(), WorldError> {
    if request.run_id.is_empty() {
        return Err(WorldError::invalid_request("runId must not be empty"));
    }
    validate_persisted_spec(request.spec_version)?;
    if now_ms < 0 || request.occurred_at_ms.is_some_and(|value| value < 0) {
        return Err(WorldError::invalid_request(
            "event timestamps must not be negative",
        ));
    }
    if request
        .event_count
        .is_some_and(|count| count > workflow_protocol::MAX_EVENT_SLOT)
    {
        return Err(WorldError::invalid_request(
            "eventCount exceeds the maximum event slot",
        ));
    }
    Ok(())
}

fn validate_run_created_data(data: &RunCreatedEventData, spec: u32) -> Result<(), WorldError> {
    validate_request(&RunStartedRequest {
        run_id: "validation".to_owned(),
        spec_version: spec,
        event_data: data.clone(),
    })
}

fn run_created_data_from_run(run: &WorkflowRun) -> RunCreatedEventData {
    RunCreatedEventData {
        deployment_id: run.deployment_id.clone(),
        workflow_name: run.workflow_name.clone(),
        input: run.input.clone(),
        execution_context: run.execution_context.clone(),
        attributes: Some(run.attributes.clone()),
        allow_reserved_attributes: true,
        encryption_public_key: run.encryption_public_key.clone(),
    }
}

fn require_run<'a>(
    current_run: Option<&'a WorkflowRun>,
    run_id: &str,
) -> Result<&'a WorkflowRun, WorldError> {
    current_run.ok_or_else(|| run_not_found(run_id))
}

fn run_not_found(run_id: &str) -> WorldError {
    WorldError::new(
        WorldErrorKind::RunNotFound,
        format!("workflow run {run_id:?} was not found"),
    )
}

fn require_active_run(run: &WorkflowRun) -> Result<(), WorldError> {
    if run.status.is_terminal() {
        return Err(entity_conflict(format!(
            "cannot transition run {:?} from terminal state {:?}",
            run.run_id, run.status
        )));
    }
    Ok(())
}

fn require_child_creation_allowed(run: &WorkflowRun) -> Result<(), WorldError> {
    if run.status.is_terminal() {
        return Err(entity_conflict(format!(
            "cannot create a step on run {:?} in terminal state {:?}",
            run.run_id, run.status
        )));
    }
    Ok(())
}

fn validate_step_identity(step_id: &str, step_name: &str) -> Result<(), WorldError> {
    if step_id.is_empty() {
        return Err(WorldError::invalid_request(
            "step correlationId must not be empty",
        ));
    }
    if step_name.is_empty() {
        return Err(WorldError::invalid_request("stepName must not be empty"));
    }
    Ok(())
}

fn require_step<'a>(
    current_step: Option<&'a WorkflowStep>,
    run_id: &str,
    step_id: &str,
) -> Result<&'a WorkflowStep, WorldError> {
    current_step.ok_or_else(|| {
        WorldError::new(
            WorldErrorKind::StepNotFound,
            format!("step {step_id:?} was not found in run {run_id:?}"),
        )
    })
}

fn require_mutable_step(
    current_step: Option<&WorkflowStep>,
    run_id: &str,
    step_id: &str,
) -> Result<WorkflowStep, WorldError> {
    let step = require_step(current_step, run_id, step_id)?.clone();
    if step.status.is_terminal() {
        return Err(entity_conflict(format!(
            "cannot modify step {step_id:?} in terminal state {:?}",
            step.status
        )));
    }
    Ok(step)
}

fn require_terminal_step_transition_allowed(
    run: &WorkflowRun,
    step: &WorkflowStep,
) -> Result<(), WorldError> {
    if run.status.is_terminal() && step.status != StepStatus::Running {
        return Err(WorldError::new(
            WorldErrorKind::RunExpired,
            format!(
                "cannot finish non-running step {:?} on terminal run {:?}",
                step.step_id, run.run_id
            ),
        ));
    }
    Ok(())
}

fn entity_conflict(message: impl Into<String>) -> WorldError {
    WorldError::new(WorldErrorKind::EntityConflict, message)
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
    use workflow_protocol::{
        CreateWorldEventRequest, EventType, RunCreatedEventData, RunStartedRequest, RunStatus,
        StepStatus, WorldErrorKind, WorldEventData,
    };

    use super::{plan_run_started, plan_world_event};

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

    #[test]
    fn plans_the_phase_one_run_and_step_lifecycle() {
        let create_request = CreateWorldEventRequest {
            run_id: "wrun_phase1".to_owned(),
            spec_version: 7,
            event_count: Some(0),
            occurred_at_ms: Some(100),
            event: WorldEventData::RunCreated(request().event_data),
        };
        let create = plan_world_event(None, None, &create_request, 200)
            .expect("run creation should be planned");
        let pending_run = create.run.expect("run should be materialized");
        assert_eq!(pending_run.status, RunStatus::Pending);
        assert_eq!(pending_run.created_at_ms, 200);
        assert_eq!(create.events[0].created_at_ms, 200);
        assert_eq!(create.events[0].occurred_at_ms, Some(100));

        let start_request = CreateWorldEventRequest {
            run_id: pending_run.run_id.clone(),
            spec_version: 7,
            event_count: Some(1),
            occurred_at_ms: None,
            event: WorldEventData::RunStarted(None),
        };
        let start = plan_world_event(Some(&pending_run), None, &start_request, 300)
            .expect("run start should be planned");
        let running_run = start.run.expect("run should be updated");
        assert_eq!(running_run.status, RunStatus::Running);
        assert_eq!(running_run.started_at_ms, Some(300));

        let step_request = CreateWorldEventRequest {
            run_id: running_run.run_id.clone(),
            spec_version: 7,
            event_count: Some(2),
            occurred_at_ms: None,
            event: WorldEventData::StepStarted {
                step_id: "step_phase1".to_owned(),
                step_name: Some("step//phase1".to_owned()),
                input: Some(vec![1, 2, 3]),
                attempt: Some(1),
                owner_message_id: Some("msg_phase1".to_owned()),
            },
        };
        let started = plan_world_event(Some(&running_run), None, &step_request, 400)
            .expect("lazy step start should be planned");
        assert!(started.insert_step);
        assert!(started.step_created);
        assert_eq!(started.events.len(), 2);
        assert!(matches!(
            started.events[0].event,
            WorldEventData::StepCreated { .. }
        ));
        assert!(matches!(
            started.events[1].event,
            WorldEventData::StepStarted { .. }
        ));
        let running_step = started.step.expect("step should be materialized");
        assert_eq!(running_step.status, StepStatus::Running);
        assert_eq!(running_step.attempt, 1);

        let completed_request = CreateWorldEventRequest {
            run_id: running_run.run_id.clone(),
            spec_version: 7,
            event_count: Some(4),
            occurred_at_ms: None,
            event: WorldEventData::StepCompleted {
                step_id: running_step.step_id.clone(),
                step_name: Some(running_step.step_name.clone()),
                result: vec![9],
            },
        };
        let completed = plan_world_event(
            Some(&running_run),
            Some(&running_step),
            &completed_request,
            500,
        )
        .expect("step completion should be planned");
        let completed_step = completed.step.expect("step should be updated");
        assert_eq!(completed_step.status, StepStatus::Completed);
        assert_eq!(completed_step.output, Some(vec![9]));

        let duplicate = plan_world_event(
            Some(&running_run),
            Some(&completed_step),
            &completed_request,
            600,
        )
        .expect_err("terminal steps must reject further writes");
        assert_eq!(duplicate.kind(), WorldErrorKind::EntityConflict);
    }
}
