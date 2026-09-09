//! Backend-neutral executable contract traces for Rust World implementations.
//!
//! This crate is dev-only infrastructure. Backends adapt their concrete API to
//! [`Phase1World`] and run the same trace instead of copying lifecycle rules
//! into backend-specific tests.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use workflow_protocol::{
    CreateWorldEventRequest, EventType, RunCreatedEventData, RunStatus, StepStatus, WorkflowRun,
    WorkflowStep, WorldError, WorldEvent, WorldEventData, WorldEventResult,
};

pub const PHASE1_CONTRACT_RUN_ID: &str = "wrun_phase1_contract";
pub const PHASE1_CONTRACT_STEP_ID: &str = "step_phase1_contract";

/// Minimal storage surface required by the Phase 1 run/step contract trace.
pub trait Phase1World {
    fn create_event(
        &self,
        request: &CreateWorldEventRequest,
    ) -> Result<WorldEventResult, WorldError>;

    fn get_run(&self, run_id: &str) -> Result<WorkflowRun, WorldError>;

    fn get_step(&self, run_id: &str, step_id: &str) -> Result<WorkflowStep, WorldError>;

    fn list_events(&self, run_id: &str) -> Result<Vec<WorldEvent>, WorldError>;
}

fn request(
    event_count: u64,
    occurred_at_ms: Option<i64>,
    event: WorldEventData,
) -> CreateWorldEventRequest {
    request_for(PHASE1_CONTRACT_RUN_ID, event_count, occurred_at_ms, event)
}

fn request_for(
    run_id: &str,
    event_count: u64,
    occurred_at_ms: Option<i64>,
    event: WorldEventData,
) -> CreateWorldEventRequest {
    CreateWorldEventRequest {
        run_id: run_id.to_owned(),
        spec_version: 7,
        event_count: Some(event_count),
        occurred_at_ms,
        resume_id: None,
        resume_payload_digest: None,
        event,
    }
}

fn run_created_data(workflow_name: &str, input: Vec<u8>) -> RunCreatedEventData {
    RunCreatedEventData {
        deployment_id: "local-js".to_owned(),
        workflow_name: workflow_name.to_owned(),
        input,
        execution_context: None,
        attributes: None,
        allow_reserved_attributes: false,
        encryption_public_key: None,
    }
}

fn create_and_start_run(world: &impl Phase1World, run_id: &str) -> Result<(), WorldError> {
    world.create_event(&request_for(
        run_id,
        0,
        None,
        WorldEventData::RunCreated(run_created_data(
            "workflow//phase1//terminal-cases",
            vec![1],
        )),
    ))?;
    world.create_event(&request_for(
        run_id,
        1,
        None,
        WorldEventData::RunStarted(None),
    ))?;
    Ok(())
}

/// Execute the backend-neutral Phase 1 run/step lifecycle and assert its views.
// @lat: [[rust-portability#Verification Strategy#Contract Fixtures]]
pub fn exercise_phase1_contract(world: &impl Phase1World) -> Result<(), WorldError> {
    let created = world.create_event(&request(
        0,
        Some(10),
        WorldEventData::RunCreated(RunCreatedEventData {
            deployment_id: "local-js".to_owned(),
            workflow_name: "workflow//phase1//contract".to_owned(),
            input: vec![1, 2, 3],
            execution_context: None,
            attributes: Some(BTreeMap::from([(
                "contract".to_owned(),
                "phase1".to_owned(),
            )])),
            allow_reserved_attributes: false,
            encryption_public_key: None,
        }),
    ))?;
    let pending = created.run.expect("run_created must materialize its run");
    assert_eq!(pending.status, RunStatus::Pending);
    assert_eq!(created.event.expect("run_created must append").slot, 1);

    let started = world.create_event(&request(1, None, WorldEventData::RunStarted(None)))?;
    assert_eq!(
        started.run.expect("run_started must return its run").status,
        RunStatus::Running
    );

    let step_started = world.create_event(&request(
        2,
        None,
        WorldEventData::StepStarted {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: Some("step//phase1//contract".to_owned()),
            input: Some(vec![4, 5]),
            attempt: Some(1),
            owner_message_id: Some("msg_phase1_contract".to_owned()),
        },
    ))?;
    assert!(step_started.step_created);
    assert_eq!(
        step_started
            .step
            .expect("lazy step_started must materialize its step")
            .status,
        StepStatus::Running
    );
    assert_eq!(
        step_started
            .event
            .expect("lazy step_started must append")
            .slot,
        4,
        "lazy start must append synthetic step_created before step_started"
    );

    let retrying = world.create_event(&request(
        4,
        None,
        WorldEventData::StepRetrying {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: Some("step//phase1//contract".to_owned()),
            error: vec![6],
            retry_after_ms: Some(0),
        },
    ))?;
    assert_eq!(
        retrying
            .step
            .expect("step_retrying must return its step")
            .status,
        StepStatus::Pending
    );

    let restarted = world.create_event(&request(
        4,
        None,
        WorldEventData::StepStarted {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: None,
            input: None,
            attempt: Some(2),
            owner_message_id: None,
        },
    ))?;
    assert_eq!(
        restarted
            .step
            .as_ref()
            .expect("second step_started must return its step")
            .attempt,
        2
    );
    assert_eq!(
        restarted
            .skipped_events
            .expect("stale eventCount must preload skipped events")
            .data
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        [5]
    );

    world.create_event(&request(
        6,
        None,
        WorldEventData::StepCompleted {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: Some("step//phase1//contract".to_owned()),
            result: vec![7, 8],
        },
    ))?;
    world.create_event(&request(
        7,
        None,
        WorldEventData::RunCompleted {
            output: Some(vec![9]),
        },
    ))?;

    let run = world.get_run(PHASE1_CONTRACT_RUN_ID)?;
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output, Some(vec![9]));
    assert_eq!(
        run.attributes.get("contract").map(String::as_str),
        Some("phase1")
    );

    let step = world.get_step(PHASE1_CONTRACT_RUN_ID, PHASE1_CONTRACT_STEP_ID)?;
    assert_eq!(step.status, StepStatus::Completed);
    assert_eq!(step.output, Some(vec![7, 8]));
    assert_eq!(step.attempt, 2);

    let events = world.list_events(PHASE1_CONTRACT_RUN_ID)?;
    assert_eq!(
        events.iter().map(|event| event.slot).collect::<Vec<_>>(),
        (1..=8).collect::<Vec<_>>()
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.event.event_type())
            .collect::<Vec<_>>(),
        [
            EventType::RunCreated,
            EventType::RunStarted,
            EventType::StepCreated,
            EventType::StepStarted,
            EventType::StepRetrying,
            EventType::StepStarted,
            EventType::StepCompleted,
            EventType::RunCompleted,
        ]
    );
    assert_eq!(events[0].occurred_at_ms, Some(10));

    let failed_run_id = "wrun_phase1_contract_failed";
    create_and_start_run(world, failed_run_id)?;
    world.create_event(&request_for(
        failed_run_id,
        2,
        None,
        WorldEventData::RunFailed {
            error: vec![10],
            error_code: Some("USER_ERROR".to_owned()),
        },
    ))?;
    let failed_run = world.get_run(failed_run_id)?;
    assert_eq!(failed_run.status, RunStatus::Failed);
    assert_eq!(failed_run.error, Some(vec![10]));
    assert_eq!(failed_run.error_code.as_deref(), Some("USER_ERROR"));
    assert!(matches!(
        &world.list_events(failed_run_id)?[2].event,
        WorldEventData::RunFailed { error, error_code }
            if error == &[10] && error_code.as_deref() == Some("USER_ERROR")
    ));

    let cancelled_run_id = "wrun_phase1_contract_cancelled";
    world.create_event(&request_for(
        cancelled_run_id,
        0,
        None,
        WorldEventData::RunCreated(run_created_data("workflow//phase1//cancelled", vec![11])),
    ))?;
    world.create_event(&request_for(
        cancelled_run_id,
        1,
        None,
        WorldEventData::RunCancelled {
            cancel_reason: Some("contract cancellation".to_owned()),
        },
    ))?;
    assert_eq!(
        world.get_run(cancelled_run_id)?.status,
        RunStatus::Cancelled
    );
    assert!(matches!(
        &world.list_events(cancelled_run_id)?[1].event,
        WorldEventData::RunCancelled { cancel_reason }
            if cancel_reason.as_deref() == Some("contract cancellation")
    ));

    let failed_step_run_id = "wrun_phase1_contract_step_failed";
    create_and_start_run(world, failed_step_run_id)?;
    world.create_event(&request_for(
        failed_step_run_id,
        2,
        None,
        WorldEventData::StepCreated {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: "step//phase1//failed".to_owned(),
            input: vec![12],
        },
    ))?;
    world.create_event(&request_for(
        failed_step_run_id,
        3,
        None,
        WorldEventData::StepStarted {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: None,
            input: None,
            attempt: Some(1),
            owner_message_id: None,
        },
    ))?;
    world.create_event(&request_for(
        failed_step_run_id,
        4,
        None,
        WorldEventData::StepFailed {
            step_id: PHASE1_CONTRACT_STEP_ID.to_owned(),
            step_name: Some("step//phase1//failed".to_owned()),
            error: vec![13],
        },
    ))?;
    let failed_step = world.get_step(failed_step_run_id, PHASE1_CONTRACT_STEP_ID)?;
    assert_eq!(failed_step.status, StepStatus::Failed);
    assert_eq!(failed_step.error, Some(vec![13]));
    assert!(matches!(
        &world.list_events(failed_step_run_id)?[4].event,
        WorldEventData::StepFailed { error, .. } if error == &[13]
    ));
    Ok(())
}
