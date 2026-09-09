//! Pure transition planning for the first Rust World contract slice.
//!
//! Backends call this planner against a transactional snapshot that can
//! linearize the outcome. Plans that mutate state must be applied under the
//! same write transaction; the planner does not allocate slots or linearize
//! concurrent writers by itself.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};

use workflow_protocol::{
    AttributeChange, AttributeWriter, CreateWorldEventRequest, EventType, RunCreatedEventData,
    RunStartPlan, RunStartedRequest, RunStatus, SUPPORTED_PERSISTED_SPEC_VERSION, StepStatus,
    UnpositionedEvent, UnpositionedWorldEvent, WaitStatus, WorkflowHook, WorkflowRun, WorkflowStep,
    WorkflowWait, WorldError, WorldErrorKind, WorldEventData, WorldMutationPlan,
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

/// Transactional entity state used to plan one World event.
///
/// `hook_with_id` is the live Hook that currently owns a requested
/// `hook_created` ID, even when it belongs to another run. `hook_with_token` is
/// the live Hook (including one retained by minimum retention) that currently
/// owns a requested `hook_created` token. Backends must read both under the same
/// transaction that applies the returned plan.
#[derive(Clone, Copy, Debug, Default)]
pub struct WorldEventState<'a> {
    pub run: Option<&'a WorkflowRun>,
    pub step: Option<&'a WorkflowStep>,
    pub hook: Option<&'a WorkflowHook>,
    pub hook_with_id: Option<&'a WorkflowHook>,
    pub hook_with_token: Option<&'a WorkflowHook>,
    pub wait: Option<&'a WorkflowWait>,
}

// @lat: [[rust-portability#Proposed System Shape#Ownership Boundaries]]
/// Plan one World event without performing I/O or allocating a slot.
///
/// A backend must obtain `current_run` and `current_step` while holding its
/// write transaction, call this function, and apply the returned plan before
/// committing that same transaction. This compatibility entry point supplies
/// no Hook or wait state; Phase 2 backends use [`plan_world_event_with_state`].
pub fn plan_world_event(
    current_run: Option<&WorkflowRun>,
    current_step: Option<&WorkflowStep>,
    request: &CreateWorldEventRequest,
    now_ms: i64,
) -> Result<WorldMutationPlan, WorldError> {
    plan_world_event_with_state(
        WorldEventState {
            run: current_run,
            step: current_step,
            ..WorldEventState::default()
        },
        request,
        now_ms,
    )
}

/// Plan one World event from a complete transactional entity snapshot.
pub fn plan_world_event_with_state(
    state: WorldEventState<'_>,
    request: &CreateWorldEventRequest,
    now_ms: i64,
) -> Result<WorldMutationPlan, WorldError> {
    let WorldEventState {
        run: current_run,
        step: current_step,
        hook: current_hook,
        hook_with_id,
        hook_with_token,
        wait: current_wait,
    } = state;
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
    if let Some(hook) = current_hook {
        validate_persisted_spec(hook.spec_version)?;
        if hook.run_id != request.run_id {
            return Err(WorldError::invalid_request(
                "the locked Hook does not belong to the event request run",
            ));
        }
    }
    if let Some(hook) = hook_with_id {
        validate_persisted_spec(hook.spec_version)?;
    }
    if let Some(hook) = hook_with_token {
        validate_persisted_spec(hook.spec_version)?;
    }
    if let Some(wait) = current_wait {
        validate_persisted_spec(wait.spec_version)?;
        if wait.run_id != request.run_id {
            return Err(WorldError::invalid_request(
                "the locked wait does not belong to the event request run",
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
        resume_id: request.resume_id.clone(),
    };
    let empty_plan = WorldMutationPlan::default;

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
                        resume_id: request.resume_id.clone(),
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
                cleanup_hooks_for_run: true,
                delete_waits_for_run: true,
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
                cleanup_hooks_for_run: true,
                delete_waits_for_run: true,
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::RunCancelled { .. } => {
            let mut run = require_run(current_run, &request.run_id)?.clone();
            if run.status == RunStatus::Cancelled {
                return Ok(WorldMutationPlan {
                    run: Some(run),
                    cleanup_hooks_for_run: true,
                    delete_waits_for_run: true,
                    events: vec![make_event(request.event.clone())],
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
                cleanup_hooks_for_run: true,
                delete_waits_for_run: true,
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::AttrSet {
            correlation_id,
            changes,
            writer,
            allow_reserved_attributes,
        } => {
            let mut run = require_run(current_run, &request.run_id)?.clone();
            require_active_run(&run)?;
            if correlation_id.as_ref().is_some_and(String::is_empty) {
                return Err(WorldError::invalid_request(
                    "attribute correlationId must not be empty",
                ));
            }
            validate_attribute_changes(
                changes,
                writer,
                &run.attributes,
                *allow_reserved_attributes,
            )?;
            for change in changes {
                match &change.value {
                    Some(value) => {
                        run.attributes.insert(change.key.clone(), value.clone());
                    }
                    None => {
                        run.attributes.remove(&change.key);
                    }
                }
            }
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
                let remaining_ms = step
                    .retry_after_ms
                    .expect("retryAfter was checked as present")
                    .saturating_sub(now_ms);
                let retry_after = remaining_ms / 1_000 + i64::from(remaining_ms % 1_000 != 0);
                return Err(WorldError::new(
                    WorldErrorKind::TooEarly,
                    format!("step {step_id:?} cannot start before retryAfter"),
                )
                .with_details(serde_json::json!({ "retryAfter": retry_after })));
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
            let mut step = require_mutable_step(current_step, &request.run_id, step_id)?;
            require_terminal_step_transition_allowed(run, &step)?;
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
        WorldEventData::HookCreated {
            hook_id,
            token,
            metadata,
            token_retention_until_ms,
            is_webhook,
            is_system,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            require_entity_creation_allowed(run, "Hook")?;
            validate_hook_creation(hook_id, token, *token_retention_until_ms)?;
            if current_hook.is_some() {
                return Err(entity_conflict(format!(
                    "Hook {hook_id:?} already exists in run {:?}",
                    request.run_id
                )));
            }
            if let Some(owner) = hook_with_token {
                if owner.token != *token {
                    return Err(WorldError::invalid_request(
                        "the locked Hook token owner does not match the requested token",
                    ));
                }
                if owner.run_id == request.run_id && owner.hook_id == *hook_id {
                    return Err(entity_conflict(format!(
                        "Hook {hook_id:?} already exists in run {:?}",
                        request.run_id
                    )));
                }
                return Ok(WorldMutationPlan {
                    events: vec![make_event(WorldEventData::HookConflict {
                        hook_id: hook_id.clone(),
                        token: token.clone(),
                        conflicting_run_id: Some(owner.run_id.clone()),
                    })],
                    ..empty_plan()
                });
            }
            if let Some(owner) = hook_with_id {
                if owner.hook_id != *hook_id {
                    return Err(WorldError::invalid_request(
                        "the locked Hook ID owner does not match the requested Hook ID",
                    ));
                }
                return Err(entity_conflict(format!(
                    "Hook {hook_id:?} already exists in run {:?}",
                    owner.run_id
                )));
            }
            let hook = WorkflowHook {
                run_id: request.run_id.clone(),
                hook_id: hook_id.clone(),
                token: token.clone(),
                metadata: metadata.clone(),
                created_at_ms,
                spec_version: request.spec_version,
                // Missing isWebhook is the legacy webhook form. Current
                // runtimes always send false explicitly for createHook().
                is_webhook: is_webhook.unwrap_or(true),
                is_system: is_system.unwrap_or(false),
                token_retention_until_ms: *token_retention_until_ms,
            };
            Ok(WorldMutationPlan {
                hook: Some(hook),
                insert_hook: true,
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::HookReceived { hook_id, token, .. } => {
            let run = require_run(current_run, &request.run_id)?;
            if run.status.is_terminal() {
                return Err(WorldError::new(
                    WorldErrorKind::RunExpired,
                    format!(
                        "cannot receive Hook {hook_id:?} on terminal run {:?}",
                        request.run_id
                    ),
                ));
            }
            let hook = require_hook(current_hook, &request.run_id, hook_id)?;
            if token.as_ref().is_some_and(|token| token != &hook.token) {
                return Err(WorldError::invalid_request(
                    "eventData.token does not match the durable Hook token",
                ));
            }
            Ok(WorldMutationPlan {
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::HookDisposed { hook_id, .. } => {
            require_run(current_run, &request.run_id)?;
            let hook = require_hook(current_hook, &request.run_id, hook_id)?.clone();
            Ok(WorldMutationPlan {
                hook: Some(hook),
                delete_hook: true,
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::WaitCreated {
            wait_id,
            resume_at_ms,
        } => {
            let run = require_run(current_run, &request.run_id)?;
            require_entity_creation_allowed(run, "wait")?;
            validate_wait_id(wait_id)?;
            validate_nonnegative_timestamp(*resume_at_ms, "eventData.resumeAt")?;
            if current_wait.is_some() {
                return Err(entity_conflict(format!(
                    "wait {wait_id:?} already exists in run {:?}",
                    request.run_id
                )));
            }
            let wait = WorkflowWait {
                wait_id: workflow_wait_id(&request.run_id, wait_id),
                run_id: request.run_id.clone(),
                status: WaitStatus::Waiting,
                resume_at_ms: Some(*resume_at_ms),
                completed_at_ms: None,
                created_at_ms,
                updated_at_ms: created_at_ms,
                spec_version: request.spec_version,
            };
            Ok(WorldMutationPlan {
                wait: Some(wait),
                insert_wait: true,
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::WaitCompleted {
            wait_id,
            resume_at_ms,
        } => {
            require_run(current_run, &request.run_id)?;
            validate_wait_id(wait_id)?;
            if let Some(resume_at_ms) = resume_at_ms {
                validate_nonnegative_timestamp(*resume_at_ms, "eventData.resumeAt")?;
            }
            let mut wait = require_wait(current_wait, &request.run_id, wait_id)?.clone();
            if wait.status == WaitStatus::Completed {
                return Err(entity_conflict(format!(
                    "wait {wait_id:?} is already completed in run {:?}",
                    request.run_id
                )));
            }
            wait.status = WaitStatus::Completed;
            wait.completed_at_ms = Some(created_at_ms);
            wait.updated_at_ms = created_at_ms;
            Ok(WorldMutationPlan {
                wait: Some(wait),
                events: vec![make_event(request.event.clone())],
                ..empty_plan()
            })
        }
        WorldEventData::HookConflict { .. } | WorldEventData::Noop { .. } => {
            Err(WorldError::invalid_request(format!(
                "{} is produced only by a World backend",
                request.event.event_type().as_str()
            )))
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
    if (request.resume_id.is_some() || request.resume_payload_digest.is_some())
        && !matches!(&request.event, WorldEventData::HookReceived { .. })
    {
        return Err(WorldError::invalid_request(
            "resume idempotency fields are valid only for hook_received",
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
    require_entity_creation_allowed(run, "step")
}

fn require_entity_creation_allowed(run: &WorkflowRun, entity: &str) -> Result<(), WorldError> {
    if run.status.is_terminal() {
        return Err(entity_conflict(format!(
            "cannot create a {entity} on run {:?} in terminal state {:?}",
            run.run_id, run.status
        )));
    }
    Ok(())
}

fn validate_hook_creation(
    hook_id: &str,
    token: &str,
    token_retention_until_ms: Option<i64>,
) -> Result<(), WorldError> {
    if hook_id.is_empty() {
        return Err(WorldError::invalid_request(
            "Hook correlationId must not be empty",
        ));
    }
    if token.is_empty() {
        return Err(WorldError::invalid_request("Hook token must not be empty"));
    }
    if let Some(token_retention_until_ms) = token_retention_until_ms {
        validate_nonnegative_timestamp(token_retention_until_ms, "eventData.tokenRetentionUntil")?;
    }
    Ok(())
}

fn require_hook<'a>(
    current_hook: Option<&'a WorkflowHook>,
    run_id: &str,
    hook_id: &str,
) -> Result<&'a WorkflowHook, WorldError> {
    let hook = current_hook.ok_or_else(|| {
        WorldError::new(
            WorldErrorKind::HookNotFound,
            format!("Hook {hook_id:?} was not found in run {run_id:?}"),
        )
    })?;
    if hook.hook_id != hook_id {
        return Err(WorldError::invalid_request(
            "the locked Hook does not match the event correlationId",
        ));
    }
    Ok(hook)
}

fn validate_wait_id(wait_id: &str) -> Result<(), WorldError> {
    if wait_id.is_empty() {
        return Err(WorldError::invalid_request(
            "wait correlationId must not be empty",
        ));
    }
    Ok(())
}

/// Build the public materialized wait identifier from an event correlation ID.
#[must_use]
pub fn workflow_wait_id(run_id: &str, correlation_id: &str) -> String {
    format!("{run_id}-{correlation_id}")
}

fn require_wait<'a>(
    current_wait: Option<&'a WorkflowWait>,
    run_id: &str,
    wait_id: &str,
) -> Result<&'a WorkflowWait, WorldError> {
    let wait = current_wait.ok_or_else(|| {
        WorldError::new(
            WorldErrorKind::WaitNotFound,
            format!("wait {wait_id:?} was not found in run {run_id:?}"),
        )
    })?;
    if wait.wait_id != workflow_wait_id(run_id, wait_id) {
        return Err(WorldError::invalid_request(
            "the locked wait does not match the event correlationId",
        ));
    }
    Ok(wait)
}

fn validate_nonnegative_timestamp(value: i64, field: &str) -> Result<(), WorldError> {
    if value < 0 {
        return Err(WorldError::invalid_request(format!(
            "{field} must not be negative"
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

fn validate_attribute_changes(
    changes: &[AttributeChange],
    writer: &AttributeWriter,
    existing: &BTreeMap<String, String>,
    allow_reserved_attributes: bool,
) -> Result<(), WorldError> {
    if let AttributeWriter::Step { step_id, .. } = writer
        && step_id.is_empty()
    {
        return Err(WorldError::invalid_request(
            "attribute writer stepId must not be empty",
        ));
    }

    let mut seen = BTreeSet::new();
    let mut next_keys = existing.keys().cloned().collect::<BTreeSet<_>>();
    for change in changes {
        let key_length = change.key.encode_utf16().count();
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
        if change.key.starts_with('$') && !allow_reserved_attributes {
            return Err(WorldError::invalid_request(format!(
                "attribute key {:?} uses the reserved $ prefix",
                change.key
            )));
        }
        if !seen.insert(change.key.as_str()) {
            return Err(WorldError::invalid_request(format!(
                "attribute key {:?} appears more than once in the same batch",
                change.key
            )));
        }
        match &change.value {
            Some(value) => {
                if value.len() > ATTRIBUTE_VALUE_MAX_BYTES {
                    return Err(WorldError::invalid_request(format!(
                        "attribute value byte length {} exceeds limit {ATTRIBUTE_VALUE_MAX_BYTES}",
                        value.len()
                    )));
                }
                next_keys.insert(change.key.clone());
            }
            None => {
                next_keys.remove(&change.key);
            }
        }
    }
    if next_keys.len() > ATTRIBUTE_MAX_PER_RUN {
        return Err(WorldError::invalid_request(format!(
            "run attribute count would exceed limit {ATTRIBUTE_MAX_PER_RUN} (post-merge {})",
            next_keys.len()
        )));
    }
    Ok(())
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
        AttributeChange, AttributeWriter, CreateWorldEventRequest, EventType, RunCreatedEventData,
        RunStartedRequest, RunStatus, StepStatus, WaitStatus, WorkflowHook, WorkflowRun,
        WorldErrorKind, WorldEventData,
    };

    use super::{
        WorldEventState, plan_run_started, plan_world_event, plan_world_event_with_state,
        workflow_wait_id,
    };

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

    fn running_run(run_id: &str) -> WorkflowRun {
        let mut request = request();
        request.run_id = run_id.to_owned();
        plan_run_started(None, &request, 100)
            .expect("run should start")
            .run
    }

    fn event_request(run_id: &str, event: WorldEventData) -> CreateWorldEventRequest {
        CreateWorldEventRequest {
            run_id: run_id.to_owned(),
            spec_version: 7,
            event_count: None,
            occurred_at_ms: None,
            resume_id: None,
            resume_payload_digest: None,
            event,
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
            resume_id: None,
            resume_payload_digest: None,
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
            resume_id: None,
            resume_payload_digest: None,
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
            resume_id: None,
            resume_payload_digest: None,
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
            resume_id: None,
            resume_payload_digest: None,
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

    #[test]
    fn plans_attribute_set_merge_and_removal() {
        let mut run = running_run("wrun_attributes");
        run.attributes = BTreeMap::from([
            ("keep".to_owned(), "before".to_owned()),
            ("remove".to_owned(), "present".to_owned()),
        ]);
        let request = event_request(
            &run.run_id,
            WorldEventData::AttrSet {
                correlation_id: Some("attr_1".to_owned()),
                changes: vec![
                    AttributeChange {
                        key: "keep".to_owned(),
                        value: Some("after".to_owned()),
                    },
                    AttributeChange {
                        key: "remove".to_owned(),
                        value: None,
                    },
                    AttributeChange {
                        key: "added".to_owned(),
                        value: Some("new".to_owned()),
                    },
                ],
                writer: AttributeWriter::Workflow,
                allow_reserved_attributes: false,
            },
        );

        let plan = plan_world_event(Some(&run), None, &request, 250)
            .expect("attribute update should be planned");
        let updated = plan.run.expect("run should be updated");
        assert_eq!(
            updated.attributes,
            BTreeMap::from([
                ("added".to_owned(), "new".to_owned()),
                ("keep".to_owned(), "after".to_owned()),
            ])
        );
        assert_eq!(updated.updated_at_ms, 250);
        assert_eq!(plan.events.len(), 1);
        assert_eq!(plan.events[0].event.event_type(), EventType::AttrSet);
    }

    #[test]
    fn rejects_invalid_attribute_batches_before_mutating_the_run() {
        let mut run = running_run("wrun_attribute_limits");
        run.attributes = (0..64)
            .map(|index| (format!("key_{index}"), "value".to_owned()))
            .collect();
        let too_many = event_request(
            &run.run_id,
            WorldEventData::AttrSet {
                correlation_id: None,
                changes: vec![AttributeChange {
                    key: "one_too_many".to_owned(),
                    value: Some("value".to_owned()),
                }],
                writer: AttributeWriter::Workflow,
                allow_reserved_attributes: false,
            },
        );
        let error = plan_world_event(Some(&run), None, &too_many, 250)
            .expect_err("post-merge count must be validated");
        assert_eq!(error.kind(), WorldErrorKind::InvalidRequest);

        let duplicate = event_request(
            &run.run_id,
            WorldEventData::AttrSet {
                correlation_id: None,
                changes: vec![
                    AttributeChange {
                        key: "key_0".to_owned(),
                        value: None,
                    },
                    AttributeChange {
                        key: "key_0".to_owned(),
                        value: Some("replacement".to_owned()),
                    },
                ],
                writer: AttributeWriter::Workflow,
                allow_reserved_attributes: false,
            },
        );
        let error = plan_world_event(Some(&run), None, &duplicate, 250)
            .expect_err("duplicate keys must be rejected");
        assert_eq!(error.kind(), WorldErrorKind::InvalidRequest);

        let reserved = event_request(
            &run.run_id,
            WorldEventData::AttrSet {
                correlation_id: None,
                changes: vec![AttributeChange {
                    key: "$private".to_owned(),
                    value: Some("value".to_owned()),
                }],
                writer: AttributeWriter::Workflow,
                allow_reserved_attributes: false,
            },
        );
        let error = plan_world_event(Some(&run), None, &reserved, 250)
            .expect_err("reserved keys require an explicit opt-in");
        assert_eq!(error.kind(), WorldErrorKind::InvalidRequest);
    }

    #[test]
    fn plans_the_basic_hook_lifecycle() {
        let run = running_run("wrun_hooks");
        let create_request = event_request(
            &run.run_id,
            WorldEventData::HookCreated {
                hook_id: "hook_1".to_owned(),
                token: "token_1".to_owned(),
                metadata: Some(vec![1, 2, 3]),
                token_retention_until_ms: Some(5_000),
                is_webhook: None,
                is_system: Some(true),
            },
        );
        let created = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                ..WorldEventState::default()
            },
            &create_request,
            200,
        )
        .expect("Hook creation should be planned");
        assert!(created.insert_hook);
        let hook = created.hook.expect("Hook should be materialized");
        assert_eq!(hook.run_id, run.run_id);
        assert_eq!(hook.hook_id, "hook_1");
        assert_eq!(hook.token, "token_1");
        assert!(hook.is_webhook);
        assert!(hook.is_system);
        assert_eq!(hook.token_retention_until_ms, Some(5_000));

        let mut received_request = event_request(
            &run.run_id,
            WorldEventData::HookReceived {
                hook_id: hook.hook_id.clone(),
                token: Some(hook.token.clone()),
                payload: vec![9, 8],
            },
        );
        received_request.resume_id = Some("resume_1".to_owned());
        received_request.resume_payload_digest = Some("digest_1".to_owned());
        let received = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                hook: Some(&hook),
                ..WorldEventState::default()
            },
            &received_request,
            300,
        )
        .expect("Hook receipt should be journaled");
        assert!(received.hook.is_none());
        assert_eq!(
            received.events[0].event.event_type(),
            EventType::HookReceived
        );
        assert_eq!(received.events[0].resume_id.as_deref(), Some("resume_1"));

        let disposed_request = event_request(
            &run.run_id,
            WorldEventData::HookDisposed {
                hook_id: hook.hook_id.clone(),
                token: None,
            },
        );
        let disposed = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                hook: Some(&hook),
                ..WorldEventState::default()
            },
            &disposed_request,
            400,
        )
        .expect("Hook disposal should be planned");
        assert!(disposed.delete_hook);
        assert_eq!(disposed.hook, Some(hook));
    }

    #[test]
    fn rejects_a_hook_received_token_that_disagrees_with_the_entity() {
        let run = running_run("wrun_hook_token");
        let hook = WorkflowHook {
            run_id: run.run_id.clone(),
            hook_id: "hook_1".to_owned(),
            token: "expected".to_owned(),
            metadata: None,
            created_at_ms: 100,
            spec_version: 7,
            is_webhook: false,
            is_system: false,
            token_retention_until_ms: None,
        };
        let request = event_request(
            &run.run_id,
            WorldEventData::HookReceived {
                hook_id: hook.hook_id.clone(),
                token: Some("different".to_owned()),
                payload: vec![],
            },
        );
        let error = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                hook: Some(&hook),
                ..WorldEventState::default()
            },
            &request,
            200,
        )
        .expect_err("the event token must match the durable Hook");
        assert_eq!(error.kind(), WorldErrorKind::InvalidRequest);
    }

    #[test]
    fn represents_hook_token_conflicts_as_backend_events() {
        let run = running_run("wrun_hook_conflict");
        let owner = WorkflowHook {
            run_id: "wrun_owner".to_owned(),
            hook_id: "hook_owner".to_owned(),
            token: "shared_token".to_owned(),
            metadata: None,
            created_at_ms: 100,
            spec_version: 7,
            is_webhook: false,
            is_system: false,
            token_retention_until_ms: None,
        };
        let request = event_request(
            &run.run_id,
            WorldEventData::HookCreated {
                hook_id: "hook_new".to_owned(),
                token: "shared_token".to_owned(),
                metadata: None,
                token_retention_until_ms: None,
                is_webhook: None,
                is_system: None,
            },
        );

        let plan = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                hook_with_token: Some(&owner),
                ..WorldEventState::default()
            },
            &request,
            200,
        )
        .expect("a token collision should become a Hook conflict event");
        assert!(!plan.insert_hook);
        assert!(plan.hook.is_none());
        assert!(matches!(
            &plan.events[0].event,
            WorldEventData::HookConflict {
                hook_id,
                token,
                conflicting_run_id: Some(run_id),
            } if hook_id == "hook_new" && token == "shared_token" && run_id == "wrun_owner"
        ));
    }

    #[test]
    fn rejects_a_hook_id_owned_by_another_run_when_the_token_is_distinct() {
        let run = running_run("wrun_hook_id_conflict");
        let owner = WorkflowHook {
            run_id: "wrun_owner".to_owned(),
            hook_id: "hook_shared_id".to_owned(),
            token: "owner_token".to_owned(),
            metadata: None,
            created_at_ms: 100,
            spec_version: 7,
            is_webhook: false,
            is_system: false,
            token_retention_until_ms: None,
        };
        let request = event_request(
            &run.run_id,
            WorldEventData::HookCreated {
                hook_id: owner.hook_id.clone(),
                token: "distinct_token".to_owned(),
                metadata: None,
                token_retention_until_ms: None,
                is_webhook: None,
                is_system: None,
            },
        );

        let error = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                hook_with_id: Some(&owner),
                ..WorldEventState::default()
            },
            &request,
            200,
        )
        .expect_err("a globally owned Hook ID must not be inserted again");

        assert_eq!(error.kind(), WorldErrorKind::EntityConflict);
        assert!(error.message().contains("wrun_owner"));
    }

    #[test]
    fn plans_wait_creation_and_completion() {
        let run = running_run("wrun_waits");
        let create_request = event_request(
            &run.run_id,
            WorldEventData::WaitCreated {
                wait_id: "wait_1".to_owned(),
                resume_at_ms: 500,
            },
        );
        let created = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                ..WorldEventState::default()
            },
            &create_request,
            200,
        )
        .expect("wait creation should be planned");
        assert!(created.insert_wait);
        let wait = created.wait.expect("wait should be materialized");
        assert_eq!(wait.wait_id, workflow_wait_id(&run.run_id, "wait_1"));
        assert_eq!(wait.status, WaitStatus::Waiting);
        assert_eq!(wait.resume_at_ms, Some(500));

        let complete_request = event_request(
            &run.run_id,
            WorldEventData::WaitCompleted {
                wait_id: "wait_1".to_owned(),
                resume_at_ms: Some(550),
            },
        );
        let completed = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                wait: Some(&wait),
                ..WorldEventState::default()
            },
            &complete_request,
            600,
        )
        .expect("wait completion should be planned");
        let completed_wait = completed.wait.expect("wait should be updated");
        assert_eq!(completed_wait.status, WaitStatus::Completed);
        assert_eq!(completed_wait.resume_at_ms, Some(500));
        assert_eq!(completed_wait.completed_at_ms, Some(600));
        assert!(matches!(
            completed.events[0].event,
            WorldEventData::WaitCompleted {
                resume_at_ms: Some(550),
                ..
            }
        ));

        let error = plan_world_event_with_state(
            WorldEventState {
                run: Some(&run),
                wait: Some(&completed_wait),
                ..WorldEventState::default()
            },
            &complete_request,
            700,
        )
        .expect_err("a completed wait must reject another completion");
        assert_eq!(error.kind(), WorldErrorKind::EntityConflict);
    }

    #[test]
    fn terminal_run_plans_request_child_cleanup() {
        let run = running_run("wrun_terminal_cleanup");
        let request = event_request(
            &run.run_id,
            WorldEventData::RunCompleted {
                output: Some(vec![4, 2]),
            },
        );
        let plan = plan_world_event(Some(&run), None, &request, 200)
            .expect("run completion should be planned");

        assert!(plan.cleanup_hooks_for_run);
        assert!(plan.delete_waits_for_run);
        assert_eq!(
            plan.run.expect("run should be updated").status,
            RunStatus::Completed
        );
    }
}
