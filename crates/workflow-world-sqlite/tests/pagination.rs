use rusqlite::Connection;
use tempfile::tempdir;
use workflow_protocol::{
    CreateWorldEventRequest, RunCreatedEventData, WorldErrorKind, WorldEventData,
};
use workflow_world_sqlite::SqliteWorld;

fn request(run_id: &str, event: WorldEventData) -> CreateWorldEventRequest {
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

fn create_run(world: &SqliteWorld, run_id: &str) {
    world
        .create_event(&request(
            run_id,
            WorldEventData::RunCreated(RunCreatedEventData {
                deployment_id: "local-js".to_owned(),
                workflow_name: "workflow//pagination".to_owned(),
                input: Vec::new(),
                execution_context: None,
                attributes: None,
                allow_reserved_attributes: false,
                encryption_public_key: None,
            }),
        ))
        .expect("run should be created");
}

fn create_step(world: &SqliteWorld, run_id: &str, step_id: &str) {
    world
        .create_event(&request(
            run_id,
            WorldEventData::StepCreated {
                step_id: step_id.to_owned(),
                step_name: format!("step//pagination//{step_id}"),
                input: Vec::new(),
            },
        ))
        .expect("step should be created");
}

fn create_hook(world: &SqliteWorld, run_id: &str, hook_id: &str, retained: bool) {
    world
        .create_event(&request(
            run_id,
            WorldEventData::HookCreated {
                hook_id: hook_id.to_owned(),
                token: format!("token-{hook_id}"),
                metadata: None,
                token_retention_until_ms: retained.then_some(i64::MAX),
                is_webhook: Some(false),
                is_system: Some(false),
            },
        ))
        .expect("Hook should be created");
}

fn ids<T>(data: &[T], get_id: impl Fn(&T) -> &str) -> Vec<&str> {
    data.iter().map(get_id).collect()
}

#[test]
fn run_pages_use_creation_time_then_id_and_survive_cursor_row_deletion() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    for run_id in ["run-z", "run-a", "run-c", "run-b"] {
        create_run(&world, run_id);
    }

    let connection = Connection::open(&database_path).expect("test database should open");
    for (run_id, created_at_ms) in [
        ("run-z", 100_i64),
        ("run-a", 200),
        ("run-c", 200),
        ("run-b", 300),
    ] {
        connection
            .execute(
                "UPDATE workflow_runs SET created_at_ms = ?2 WHERE run_id = ?1",
                (run_id, created_at_ms),
            )
            .expect("run timestamp should be fixed");
    }

    let ascending = world
        .list_runs(None, None, None, 10, false)
        .expect("ascending runs should list");
    assert_eq!(
        ids(&ascending.data, |run| &run.run_id),
        ["run-z", "run-a", "run-c", "run-b"]
    );
    let descending = world
        .list_runs(None, None, None, 10, true)
        .expect("descending runs should list");
    assert_eq!(
        ids(&descending.data, |run| &run.run_id),
        ["run-b", "run-c", "run-a", "run-z"]
    );

    let first = world
        .list_runs(None, None, None, 2, false)
        .expect("first run page should list");
    assert_eq!(ids(&first.data, |run| &run.run_id), ["run-z", "run-a"]);
    assert!(first.has_more);
    assert_eq!(
        first.cursor.as_deref(),
        Some("page:v1:00000000000000c872756e2d61")
    );

    connection
        .execute("PRAGMA foreign_keys = ON", [])
        .expect("foreign keys should enable");
    connection
        .execute("DELETE FROM workflow_runs WHERE run_id = 'run-a'", [])
        .expect("cursor run should be deleted");
    let second = world
        .list_runs(None, None, first.cursor.as_deref(), 10, false)
        .expect("run continuation should not depend on the cursor row");
    assert_eq!(ids(&second.data, |run| &run.run_id), ["run-c", "run-b"]);
    assert!(!second.has_more);
}

#[test]
fn step_pages_use_creation_time_then_id_and_survive_cursor_row_deletion() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    create_run(&world, "run-steps");
    for step_id in ["step-z", "step-a", "step-c", "step-b"] {
        create_step(&world, "run-steps", step_id);
    }

    let connection = Connection::open(&database_path).expect("test database should open");
    for (step_id, created_at_ms) in [
        ("step-z", 100_i64),
        ("step-a", 200),
        ("step-c", 200),
        ("step-b", 300),
    ] {
        connection
            .execute(
                "UPDATE workflow_steps SET created_at_ms = ?3 WHERE run_id = ?1 AND step_id = ?2",
                ("run-steps", step_id, created_at_ms),
            )
            .expect("step timestamp should be fixed");
    }

    let descending = world
        .list_steps("run-steps", None, 10, true)
        .expect("descending steps should list");
    assert_eq!(
        ids(&descending.data, |step| &step.step_id),
        ["step-b", "step-c", "step-a", "step-z"]
    );

    let first = world
        .list_steps("run-steps", None, 2, false)
        .expect("first step page should list");
    assert_eq!(ids(&first.data, |step| &step.step_id), ["step-z", "step-a"]);
    assert!(first.has_more);
    assert_eq!(
        first.cursor.as_deref(),
        Some("page:v1:00000000000000c8737465702d61")
    );

    connection
        .execute(
            "DELETE FROM workflow_steps WHERE run_id = 'run-steps' AND step_id = 'step-a'",
            [],
        )
        .expect("cursor step should be deleted");
    let second = world
        .list_steps("run-steps", first.cursor.as_deref(), 10, false)
        .expect("step continuation should not depend on the cursor row");
    assert_eq!(
        ids(&second.data, |step| &step.step_id),
        ["step-c", "step-b"]
    );
    assert!(!second.has_more);
}

#[test]
fn hook_pages_use_creation_time_then_id_and_keep_terminal_retained_hooks() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    create_run(&world, "run-hooks");
    for hook_id in ["hook-z", "hook-a", "hook-c", "hook-b"] {
        create_hook(&world, "run-hooks", hook_id, true);
    }
    create_hook(&world, "run-hooks", "hook-ephemeral", false);

    let connection = Connection::open(&database_path).expect("test database should open");
    for (hook_id, created_at_ms) in [
        ("hook-z", 100_i64),
        ("hook-a", 200),
        ("hook-c", 200),
        ("hook-b", 300),
    ] {
        connection
            .execute(
                "UPDATE workflow_hooks SET created_at_ms = ?2 WHERE hook_id = ?1",
                (hook_id, created_at_ms),
            )
            .expect("Hook timestamp should be fixed");
    }
    world
        .create_event(&request(
            "run-hooks",
            WorldEventData::RunCompleted { output: None },
        ))
        .expect("run should complete");

    let descending = world
        .list_hooks(Some("run-hooks"), None, 10, true)
        .expect("descending retained Hooks should list");
    assert_eq!(
        ids(&descending.data, |hook| &hook.hook_id),
        ["hook-b", "hook-c", "hook-a", "hook-z"]
    );

    let first = world
        .list_hooks(Some("run-hooks"), None, 2, false)
        .expect("first Hook page should list");
    assert_eq!(ids(&first.data, |hook| &hook.hook_id), ["hook-z", "hook-a"]);
    assert!(first.has_more);
    assert_eq!(
        first.cursor.as_deref(),
        Some("page:v1:00000000000000c8686f6f6b2d61")
    );

    connection
        .execute("DELETE FROM workflow_hooks WHERE hook_id = 'hook-a'", [])
        .expect("cursor Hook should be deleted");
    let second = world
        .list_hooks(Some("run-hooks"), first.cursor.as_deref(), 10, false)
        .expect("Hook continuation should not depend on the cursor row");
    assert_eq!(
        ids(&second.data, |hook| &hook.hook_id),
        ["hook-c", "hook-b"]
    );
    assert!(!second.has_more);
    assert_eq!(
        world
            .get_hook("hook-ephemeral")
            .expect_err("terminal cleanup should remove an unretained Hook")
            .kind(),
        WorldErrorKind::HookNotFound
    );
}

#[test]
fn entity_pages_reject_malformed_and_noncanonical_cursors() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");

    for cursor in [
        "",
        "run-a",
        "page:v2:00000000000000c872756e2d61",
        "page:v1:",
        "page:v1:0000000000000000",
        "page:v1:00000000000000007",
        "page:v1:00000000000000c87A",
        "page:v1:0000000000000000ff",
    ] {
        assert_eq!(
            world
                .list_runs(None, None, Some(cursor), 10, false)
                .expect_err("invalid run cursor should fail")
                .kind(),
            WorldErrorKind::InvalidRequest
        );
        assert_eq!(
            world
                .list_steps("missing-run", Some(cursor), 10, false)
                .expect_err("invalid step cursor should fail")
                .kind(),
            WorldErrorKind::InvalidRequest
        );
        assert_eq!(
            world
                .list_hooks(None, Some(cursor), 10, false)
                .expect_err("invalid Hook cursor should fail")
                .kind(),
            WorldErrorKind::InvalidRequest
        );
    }
}
