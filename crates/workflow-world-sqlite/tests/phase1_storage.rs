use std::sync::{Arc, Barrier};
use std::thread;

use rusqlite::Connection;
use tempfile::tempdir;
use workflow_protocol::{
    CreateWorldEventRequest, MAX_EVENT_SLOT, RunCreatedEventData, RunStatus, StepStatus,
    WorldErrorKind, WorldEventData,
};
use workflow_world_sqlite::SqliteWorld;
use workflow_world_testkit::{Phase1World, exercise_phase1_contract};

struct ContractWorld<'a>(&'a SqliteWorld);

impl Phase1World for ContractWorld<'_> {
    fn create_event(
        &self,
        request: &CreateWorldEventRequest,
    ) -> Result<workflow_protocol::WorldEventResult, workflow_protocol::WorldError> {
        self.0.create_event(request)
    }

    fn get_run(
        &self,
        run_id: &str,
    ) -> Result<workflow_protocol::WorkflowRun, workflow_protocol::WorldError> {
        self.0.get_run(run_id)
    }

    fn get_step(
        &self,
        run_id: &str,
        step_id: &str,
    ) -> Result<workflow_protocol::WorkflowStep, workflow_protocol::WorldError> {
        self.0.get_step(run_id, step_id)
    }

    fn list_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<workflow_protocol::WorldEvent>, workflow_protocol::WorldError> {
        self.0
            .list_events(run_id, None, None, 100, false)
            .map(|page| page.data)
    }
}

fn request(run_id: &str, event_count: u64, event: WorldEventData) -> CreateWorldEventRequest {
    CreateWorldEventRequest {
        run_id: run_id.to_owned(),
        spec_version: 7,
        event_count: Some(event_count),
        occurred_at_ms: None,
        event,
    }
}

#[test]
fn executes_the_backend_neutral_phase_one_contract() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");

    exercise_phase1_contract(&ContractWorld(&world)).expect("Phase 1 contract should pass");
}

#[test]
fn rejects_a_database_that_lost_its_workflow_format_metadata() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    Connection::open(&database_path)
        .expect("test corrupter should open")
        .execute("DELETE FROM workflow_database_metadata", [])
        .expect("test should remove format metadata");

    let error = world
        .ensure_ready()
        .expect_err("runtime must reject storage without format metadata");
    assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);
    let error = world
        .migrate()
        .expect_err("migration must not silently repair incompatible metadata");
    assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);
}

#[test]
fn stores_a_dense_phase_one_lifecycle_across_concurrent_writers_and_reopen() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    let run_id = "wrun_phase1_storage";

    let created = world
        .create_event(&request(
            run_id,
            0,
            WorldEventData::RunCreated(RunCreatedEventData {
                deployment_id: "local-js".to_owned(),
                workflow_name: "workflow//phase1//storage".to_owned(),
                input: vec![1, 2, 3],
                execution_context: None,
                attributes: None,
                allow_reserved_attributes: false,
                encryption_public_key: None,
            }),
        ))
        .expect("run creation should succeed");
    assert_eq!(created.run.expect("run result").status, RunStatus::Pending);
    world
        .create_event(&request(run_id, 1, WorldEventData::RunStarted(None)))
        .expect("run start should succeed");

    let barrier = Arc::new(Barrier::new(3));
    let writers = ["alpha", "beta"].map(|suffix| {
        let path = database_path.clone();
        let barrier = Arc::clone(&barrier);
        thread::spawn(move || {
            barrier.wait();
            SqliteWorld::new(path).create_event(&request(
                run_id,
                2,
                WorldEventData::StepCreated {
                    step_id: format!("step_{suffix}"),
                    step_name: format!("step//phase1//{suffix}"),
                    input: suffix.as_bytes().to_vec(),
                },
            ))
        })
    });
    barrier.wait();
    let results = writers.map(|writer| {
        writer
            .join()
            .expect("writer thread should not panic")
            .expect("concurrent append should succeed")
    });
    assert_eq!(
        results
            .iter()
            .filter(|result| {
                result
                    .skipped_events
                    .as_ref()
                    .is_some_and(|page| page.data.len() == 1)
            })
            .count(),
        1,
        "the writer serialized second must receive the slot it skipped"
    );

    let first_page = world
        .list_events(run_id, None, None, 2, false)
        .expect("first event page should be readable");
    assert_eq!(
        first_page
            .data
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(first_page.has_more);
    let second_page = world
        .list_events(run_id, None, first_page.cursor.as_deref(), 10, false)
        .expect("second event page should be readable");
    assert_eq!(
        second_page
            .data
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        [3, 4]
    );
    assert!(!second_page.has_more);
    assert_eq!(
        second_page.cursor.as_deref(),
        Some("evnt_00000000000000000000000004")
    );

    let run_page = world
        .list_runs(None, None, None, 10, false)
        .expect("run page should be readable");
    assert!(!run_page.has_more);
    assert_eq!(run_page.cursor.as_deref(), Some(run_id));
    let step_page = world
        .list_steps(run_id, None, 10, false)
        .expect("step page should be readable");
    assert!(!step_page.has_more);
    assert_eq!(
        step_page.cursor.as_deref(),
        step_page.data.last().map(|step| step.step_id.as_str())
    );

    world
        .create_event(&request(
            run_id,
            4,
            WorldEventData::StepStarted {
                step_id: "step_alpha".to_owned(),
                step_name: None,
                input: None,
                attempt: Some(1),
                owner_message_id: None,
            },
        ))
        .expect("step start should succeed");
    let completed = world
        .create_event(&request(
            run_id,
            5,
            WorldEventData::StepCompleted {
                step_id: "step_alpha".to_owned(),
                step_name: Some("step//phase1//alpha".to_owned()),
                result: vec![9, 8],
            },
        ))
        .expect("step completion should succeed");
    assert_eq!(
        completed.step.expect("step result").status,
        StepStatus::Completed
    );
    world
        .create_event(&request(
            run_id,
            6,
            WorldEventData::RunCompleted {
                output: Some(vec![7]),
            },
        ))
        .expect("run completion should succeed");

    let reopened = SqliteWorld::new(&database_path);
    let run = reopened
        .get_run(run_id)
        .expect("reopened run should be readable");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output, Some(vec![7]));
    assert!(run.completed_at_ms.is_some());
    let step = reopened
        .get_step(run_id, "step_alpha")
        .expect("reopened step should be readable");
    assert_eq!(step.status, StepStatus::Completed);
    assert_eq!(step.output, Some(vec![9, 8]));
    let correlated = reopened
        .list_events(run_id, Some("step_alpha"), None, 10, false)
        .expect("correlated events should be readable");
    assert_eq!(correlated.data.len(), 3);
    assert_eq!(
        reopened
            .list_events(run_id, None, None, 10, false)
            .expect("dense log should be readable")
            .data
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6, 7]
    );
}

#[test]
fn descending_event_listing_includes_the_maximum_slot() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    let run_id = "wrun_maximum_slot";

    world
        .create_event(&request(
            run_id,
            0,
            WorldEventData::RunCreated(RunCreatedEventData {
                deployment_id: "local-js".to_owned(),
                workflow_name: "workflow//phase1//maximum-slot".to_owned(),
                input: Vec::new(),
                execution_context: None,
                attributes: None,
                allow_reserved_attributes: false,
                encryption_public_key: None,
            }),
        ))
        .expect("run creation should succeed");

    // Advancing through every legal slot is not practical in a boundary test.
    // Move the durable allocator to the last slot, then append through the
    // normal transaction path so the row itself still has production shape.
    Connection::open(&database_path)
        .expect("test database should open")
        .execute(
            "UPDATE workflow_runs SET next_event_slot = ?2 WHERE run_id = ?1",
            (run_id, MAX_EVENT_SLOT as i64),
        )
        .expect("test should position the event allocator");
    world
        .create_event(&request(
            run_id,
            MAX_EVENT_SLOT - 1,
            WorldEventData::RunStarted(None),
        ))
        .expect("the maximum event slot should be appendable");

    let page = world
        .list_events(run_id, None, None, 1, true)
        .expect("descending events should be readable");
    assert_eq!(page.data[0].slot, MAX_EVENT_SLOT);
}

#[test]
fn matches_terminal_step_retry_and_repeated_cancellation_semantics() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");
    let run_id = "wrun_terminal_retry";
    let step_id = "step_terminal_retry";

    world
        .create_event(&request(
            run_id,
            0,
            WorldEventData::RunCreated(RunCreatedEventData {
                deployment_id: "local-js".to_owned(),
                workflow_name: "workflow//phase1//terminal-retry".to_owned(),
                input: Vec::new(),
                execution_context: None,
                attributes: None,
                allow_reserved_attributes: false,
                encryption_public_key: None,
            }),
        ))
        .expect("run creation should succeed");
    world
        .create_event(&request(run_id, 1, WorldEventData::RunStarted(None)))
        .expect("run start should succeed");
    world
        .create_event(&request(
            run_id,
            2,
            WorldEventData::StepStarted {
                step_id: step_id.to_owned(),
                step_name: Some("step//phase1//terminal-retry".to_owned()),
                input: Some(Vec::new()),
                attempt: Some(1),
                owner_message_id: None,
            },
        ))
        .expect("lazy step start should succeed");
    let cancelled = world
        .create_event(&request(
            run_id,
            4,
            WorldEventData::RunCancelled {
                cancel_reason: Some("test".to_owned()),
            },
        ))
        .expect("run cancellation should succeed")
        .run
        .expect("cancellation should return the run");

    let retrying = world
        .create_event(&request(
            run_id,
            5,
            WorldEventData::StepRetrying {
                step_id: step_id.to_owned(),
                step_name: Some("step//phase1//terminal-retry".to_owned()),
                error: vec![1],
                retry_after_ms: None,
            },
        ))
        .expect("an in-flight step may retry after its run is cancelled");
    assert_eq!(
        retrying.step.expect("retry should return the step").status,
        StepStatus::Pending
    );
    let retry_error = world
        .create_event(&request(
            run_id,
            6,
            WorldEventData::StepRetrying {
                step_id: step_id.to_owned(),
                step_name: Some("step//phase1//terminal-retry".to_owned()),
                error: vec![2],
                retry_after_ms: None,
            },
        ))
        .expect_err("a pending step may not retry after its run is cancelled");
    assert_eq!(retry_error.kind(), WorldErrorKind::RunExpired);

    let repeated = world
        .create_event(&request(
            run_id,
            6,
            WorldEventData::RunCancelled {
                cancel_reason: Some("repeated".to_owned()),
            },
        ))
        .expect("repeated cancellation should be idempotent");
    assert_eq!(
        repeated
            .event
            .expect("repeated cancellation must append")
            .slot,
        7
    );
    assert_eq!(
        repeated
            .run
            .expect("repeated cancellation should return the run")
            .completed_at_ms,
        cancelled.completed_at_ms
    );
}
