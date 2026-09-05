use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use tempfile::tempdir;
use workflow_protocol::{
    RunCreatedEventData, RunStartedRequest, StoredEvent, WorkflowRun, WorldErrorKind,
};
use workflow_world_sqlite::SqliteWorld;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fixture {
    #[serde(rename = "$schema")]
    schema: String,
    fixture_version: u32,
    name: String,
    requires: Vec<String>,
    persisted_spec_version: u32,
    given: Given,
    when: When,
    then: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Given {
    storage: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct When {
    operation: String,
    run_id: String,
    event: RequestedEvent,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RequestedEvent {
    event_type: String,
    spec_version: u32,
    event_data: FixtureEventData,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FixtureEventData {
    deployment_id: String,
    workflow_name: String,
    input: FixtureBytes,
    execution_context: Value,
    attributes: BTreeMap<String, String>,
    allow_reserved_attributes: bool,
    encryption_public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureBytes {
    #[serde(rename = "$bytes")]
    base64: String,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/world-contract/v1/resilient-run-start.json")
}

fn load_fixture() -> Fixture {
    serde_json::from_str(&fs::read_to_string(fixture_path()).expect("fixture should be readable"))
        .expect("fixture should be valid JSON")
}

fn request_from_fixture(fixture: &Fixture) -> RunStartedRequest {
    assert_eq!(fixture.schema, "./fixture.schema.json");
    assert_eq!(fixture.fixture_version, 1);
    assert_eq!(fixture.name, "resilient-run-start-synthesizes-created");
    assert_eq!(fixture.requires, ["run-started-preload"]);
    assert_eq!(fixture.given.storage, "empty");
    assert_eq!(fixture.when.operation, "events.create");
    assert_eq!(fixture.when.event.event_type, "run_started");
    assert_eq!(
        fixture.persisted_spec_version,
        fixture.when.event.spec_version
    );
    RunStartedRequest {
        run_id: fixture.when.run_id.clone(),
        spec_version: fixture.when.event.spec_version,
        event_data: RunCreatedEventData {
            deployment_id: fixture.when.event.event_data.deployment_id.clone(),
            workflow_name: fixture.when.event.event_data.workflow_name.clone(),
            input: STANDARD
                .decode(&fixture.when.event.event_data.input.base64)
                .expect("fixture bytes should be valid base64"),
            execution_context: Some(fixture.when.event.event_data.execution_context.clone()),
            attributes: Some(fixture.when.event.event_data.attributes.clone()),
            allow_reserved_attributes: fixture.when.event.event_data.allow_reserved_attributes,
            encryption_public_key: Some(
                fixture.when.event.event_data.encryption_public_key.clone(),
            ),
        },
    }
}

fn project_run(run: &WorkflowRun) -> Value {
    json!({
        "runId": run.run_id,
        "status": run.status,
        "deploymentId": run.deployment_id,
        "workflowName": run.workflow_name,
        "specVersion": run.spec_version,
        "input": { "$bytes": STANDARD.encode(&run.input) },
        "executionContext": run.execution_context,
        "attributes": run.attributes,
        "encryptionPublicKey": run.encryption_public_key,
        "startedAtPresent": run.started_at_ms.is_some(),
    })
}

fn project_event(event: &StoredEvent) -> Value {
    let mut projection = json!({
        "slot": event.slot,
        "eventType": event.event_type,
        "specVersion": event.spec_version,
        "eventDataPresent": event.event_data.is_some(),
    });
    if let Some(data) = &event.event_data {
        let mut event_data = json!({
            "deploymentId": data.deployment_id,
            "workflowName": data.workflow_name,
            "input": { "$bytes": STANDARD.encode(&data.input) },
        });
        if let Some(execution_context) = &data.execution_context {
            event_data["executionContext"] = execution_context.clone();
        }
        if let Some(attributes) = &data.attributes {
            event_data["attributes"] = json!(attributes);
        }
        if data.allow_reserved_attributes {
            event_data["allowReservedAttributes"] = json!(true);
        }
        if let Some(encryption_public_key) = &data.encryption_public_key {
            event_data["encryptionPublicKey"] = json!(encryption_public_key);
        }
        projection["eventData"] = event_data;
    }
    projection
}

#[test]
fn executes_the_shared_resilient_start_fixture_and_reopens() {
    let fixture = load_fixture();
    let request = request_from_fixture(&fixture);
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);

    assert!(
        !database_path.exists(),
        "constructor must not create the DB"
    );
    world.migrate().expect("migration should succeed");
    let result = world
        .create_resilient_run_started(&request)
        .expect("resilient start should succeed");
    let result_event = result.event.as_ref().expect("fresh start should append");
    let preload = result.preload.as_ref().expect("fixture requires a preload");
    let snapshot = SqliteWorld::new(&database_path)
        .snapshot(&request.run_id)
        .expect("a reopened world should read the durable state");
    assert_eq!(project_run(&snapshot.run), fixture.then["run"]);

    let actual = json!({
        "run": project_run(&result.run),
        "result": {
            "event": project_event(result_event),
            "preloadedSlots": preload.events.iter().map(|event| event.slot).collect::<Vec<_>>(),
            "preloadedEvents": preload.events.iter().map(project_event).collect::<Vec<_>>(),
            "cursorPresent": preload.cursor.is_some(),
            "continuationCount": SqliteWorld::new(&database_path)
                .list_events_after_cursor(
                    &request.run_id,
                    preload.cursor.as_deref().expect("preload should have a cursor"),
                    100,
                )
                .expect("cursor continuation should succeed")
                .events
                .len(),
            "hasMore": preload.has_more,
        },
        "events": snapshot.events.iter().map(project_event).collect::<Vec<_>>(),
    });

    assert_eq!(actual, fixture.then);
}

#[test]
fn rejects_future_specs_without_mutating_storage() {
    let fixture = load_fixture();
    let mut request = request_from_fixture(&fixture);
    request.spec_version += 1;
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");

    let error = world
        .create_resilient_run_started(&request)
        .expect_err("future spec should be rejected");

    assert_eq!(error.kind(), WorldErrorKind::UnsupportedSpec);
    assert_eq!(
        Connection::open(&database_path)
            .expect("inspector should open the database")
            .query_row("SELECT count(*) FROM workflow_runs", [], |row| row
                .get::<_, i64>(0))
            .expect("run count should be readable"),
        0
    );
}

#[test]
fn runtime_open_rejects_a_migration_checksum_mismatch() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    Connection::open(&database_path)
        .expect("inspector should open the database")
        .execute(
            "UPDATE workflow_schema_migrations SET checksum = 'tampered' WHERE version = 1",
            [],
        )
        .expect("checksum should be tampered");

    let error = world
        .snapshot("wrun_missing")
        .expect_err("runtime open should reject schema drift");

    assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);
}

#[test]
fn sqlite_busy_is_reported_as_retryable() {
    let fixture = load_fixture();
    let request = request_from_fixture(&fixture);
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    SqliteWorld::new(&database_path)
        .migrate()
        .expect("migration should succeed");
    let lock_holder = Connection::open(&database_path).expect("lock holder should open");
    lock_holder
        .execute_batch("BEGIN IMMEDIATE;")
        .expect("lock holder should take writer ownership");

    let error = SqliteWorld::new(&database_path)
        .with_busy_timeout(Duration::from_millis(1))
        .create_resilient_run_started(&request)
        .expect_err("second writer should be busy");

    assert_eq!(error.kind(), WorldErrorKind::Storage);
    assert!(error.retryable());
    lock_holder
        .execute_batch("ROLLBACK;")
        .expect("lock holder should release writer ownership");
}

#[cfg(unix)]
#[test]
fn database_and_wal_sidecars_are_private() {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("nested").join("world.sqlite");
    SqliteWorld::new(&database_path)
        .migrate()
        .expect("migration should succeed");
    let connection = Connection::open(&database_path).expect("writer should open the database");
    connection
        .execute_batch(
            "BEGIN IMMEDIATE; UPDATE workflow_schema_migrations SET applied_at_ms = applied_at_ms;",
        )
        .expect("writer should create WAL sidecars");

    for suffix in ["", "-wal", "-shm"] {
        let mut candidate = OsString::from(database_path.as_os_str());
        candidate.push(suffix);
        let candidate = PathBuf::from(candidate);
        assert!(candidate.exists(), "{} should exist", candidate.display());
        assert_eq!(
            fs::metadata(&candidate)
                .expect("SQLite file metadata should be readable")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "{} should be owner-only",
            candidate.display()
        );
    }
    connection
        .execute_batch("ROLLBACK;")
        .expect("writer should release its transaction");
}

#[test]
fn concurrent_retries_use_separate_connections_without_duplicate_events() {
    let fixture = load_fixture();
    let request = Arc::new(request_from_fixture(&fixture));
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    SqliteWorld::new(&database_path)
        .migrate()
        .expect("migration should succeed");
    let barrier = Arc::new(Barrier::new(3));

    let handles = (0..2)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let request = Arc::clone(&request);
            let world = SqliteWorld::new(&database_path);
            thread::spawn(move || {
                barrier.wait();
                world.create_resilient_run_started(&request)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();

    let results = handles
        .into_iter()
        .map(|handle| handle.join().expect("writer should not panic"))
        .collect::<Result<Vec<_>, _>>()
        .expect("both retries should succeed");
    let snapshot = SqliteWorld::new(&database_path)
        .snapshot(&request.run_id)
        .expect("snapshot should succeed");

    assert_eq!(snapshot.events.len(), 2);
    assert_eq!(
        snapshot
            .events
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result.event.is_some())
            .count(),
        1
    );
}

#[test]
fn a_failed_second_append_rolls_back_the_run_and_reuses_slot_one() {
    let fixture = load_fixture();
    let request = request_from_fixture(&fixture);
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");

    Connection::open(&database_path)
        .expect("failure injector should open the database")
        .execute_batch(
            r#"
            CREATE TRIGGER fail_run_started
            BEFORE INSERT ON workflow_events
            WHEN NEW.event_type = 'run_started'
            BEGIN
              SELECT RAISE(ABORT, 'injected run_started failure');
            END;
            "#,
        )
        .expect("failure trigger should be installed");

    assert!(world.create_resilient_run_started(&request).is_err());
    assert!(world.snapshot(&request.run_id).is_err());

    Connection::open(&database_path)
        .expect("failure injector should reopen the database")
        .execute_batch("DROP TRIGGER fail_run_started;")
        .expect("failure trigger should be removed");
    world
        .create_resilient_run_started(&request)
        .expect("retry should succeed after rollback");
    let snapshot = world
        .snapshot(&request.run_id)
        .expect("snapshot should succeed after retry");

    assert_eq!(
        snapshot
            .events
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}
