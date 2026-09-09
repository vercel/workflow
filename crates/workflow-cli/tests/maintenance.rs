use std::process::{Command, Output};

use rusqlite::Connection;
use serde_json::Value;
use tempfile::tempdir;
use workflow_protocol::{QueueMessageRequest, RunCreatedEventData, RunStartedRequest};
use workflow_world_sqlite::SqliteWorld;

fn workflow(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_workflow"))
        .args(args)
        .output()
        .expect("native workflow CLI should start")
}

fn stdout_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("stdout should contain JSON")
}

#[test]
fn version_reports_native_compatibility_axes() {
    let output = workflow(&["--json", "version"]);
    assert!(output.status.success());
    let value = stdout_json(&output);
    assert_eq!(value["rustVersionFloor"], "1.88.0");
    assert_eq!(value["sqliteVersion"], "3.53.2");
    assert_eq!(value["sqliteSchemaVersion"], 5);
    assert_eq!(value["persistedSpecMin"], 7);
    assert_eq!(value["persistedSpecMax"], 7);
}

#[test]
fn inspect_does_not_create_or_migrate_a_database() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("missing.sqlite");
    let output = workflow(&[
        "--json",
        "sqlite",
        "inspect",
        "--database",
        database_path
            .to_str()
            .expect("temporary path should be UTF-8"),
    ]);
    assert!(!output.status.success());
    assert!(!database_path.exists());

    SqliteWorld::new(&database_path)
        .migrate()
        .expect("setup migration should succeed");
    Connection::open(&database_path)
        .expect("test inspector should open")
        .execute(
            "DELETE FROM workflow_schema_migrations WHERE version = 5",
            [],
        )
        .expect("test should make schema history one version old");

    let output = workflow(&[
        "--json",
        "sqlite",
        "inspect",
        "--database",
        database_path
            .to_str()
            .expect("temporary path should be UTF-8"),
    ]);
    assert!(!output.status.success());
    let applied_version = Connection::open(&database_path)
        .expect("test inspector should reopen")
        .query_row(
            "SELECT max(version) FROM workflow_schema_migrations",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("migration version should be readable");
    assert_eq!(applied_version, 4, "read-only inspect must not migrate");
}

#[test]
fn explicit_migration_and_inspection_leave_queued_work_unclaimed() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let requested_path = directory
        .path()
        .join("nonexistent-segment")
        .join("..")
        .join("world.sqlite");
    let database = requested_path
        .to_str()
        .expect("temporary path should be UTF-8");

    let migration = workflow(&["--json", "sqlite", "migrate", "--database", database]);
    assert!(migration.status.success());
    assert_eq!(stdout_json(&migration)["database"]["schemaVersion"], 5);

    let world = SqliteWorld::new(&database_path);
    world
        .create_resilient_run_started(&RunStartedRequest {
            run_id: "wrun_phase1_cli".to_owned(),
            spec_version: 7,
            event_data: RunCreatedEventData {
                deployment_id: "local-js".to_owned(),
                workflow_name: "workflow//phase1//cli".to_owned(),
                input: vec![1],
                execution_context: None,
                attributes: None,
                allow_reserved_attributes: false,
                encryption_public_key: None,
            },
        })
        .expect("run setup should succeed");
    world
        .enqueue_queue_message(&QueueMessageRequest {
            message_id: "msg_phase1_cli".to_owned(),
            scope: "local-js".to_owned(),
            queue_name: "__wkf_workflow_phase1".to_owned(),
            idempotency_key: "phase1-cli".to_owned(),
            body: br#"{"runId":"wrun_phase1_cli"}"#.to_vec(),
            available_at_ms: 1,
        })
        .expect("queue setup should succeed");
    Connection::open(&database_path)
        .expect("test corrupter should open")
        .execute(
            "UPDATE workflow_runs SET execution_context_cbor = x'ff' WHERE run_id = 'wrun_phase1_cli'",
            [],
        )
        .expect("test should corrupt a payload column");
    assert_eq!(
        world
            .queue_message_count("local-js")
            .expect("queue count should be readable"),
        1
    );

    let inspection = workflow(&[
        "--json",
        "sqlite",
        "inspect",
        "--database",
        database,
        "--run",
        "wrun_phase1_cli",
    ]);
    assert!(inspection.status.success());
    assert_eq!(stdout_json(&inspection)["database"]["queueMessageCount"], 1);
    assert_eq!(stdout_json(&inspection)["run"]["runId"], "wrun_phase1_cli");
    assert_eq!(
        world
            .queue_message_count("local-js")
            .expect("queue count should remain readable"),
        1,
        "read-only inspect must not claim or consume queued work"
    );

    let doctor = workflow(&["--json", "doctor", "--database", database]);
    assert!(doctor.status.success());
    assert_eq!(stdout_json(&doctor)["database"]["queueMessageCount"], 1);
    assert_eq!(
        world
            .queue_message_count("local-js")
            .expect("doctor must leave queued work alone"),
        1
    );
}
