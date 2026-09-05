//! Cross-process tests for lock arbitration and application-process failure.
//!
//! The named hooks are compiled only into this crate's unit-test binary. They
//! establish deterministic transaction boundaries; they do not simulate power
//! loss or filesystem write reordering.

use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::json;
use tempfile::tempdir;
use workflow_protocol::{
    EventType, RunCreatedEventData, RunStartedRequest, RunStatus, WorldError, WorldErrorKind,
};

use super::{SqliteWorld, storage_error};

const WORKER_FLAG: &str = "WORKFLOW_SQLITE_PROCESS_TEST_WORKER";
const WORKER_MODE: &str = "WORKFLOW_SQLITE_PROCESS_TEST_MODE";
const DATABASE_PATH: &str = "WORKFLOW_SQLITE_PROCESS_TEST_DATABASE";
const READY_PATH: &str = "WORKFLOW_SQLITE_PROCESS_TEST_READY";
const FAILPOINT: &str = "WORKFLOW_SQLITE_PROCESS_TEST_FAILPOINT";
const RELEASE_PATH: &str = "WORKFLOW_SQLITE_PROCESS_TEST_RELEASE";
const RESULT_PATH: &str = "WORKFLOW_SQLITE_PROCESS_TEST_RESULT";
const WORKER_TEST_NAME: &str = "process_tests::process_worker_entry";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(15);
const WORKER_RELEASE_TIMEOUT: Duration = Duration::from_secs(60);

struct WorkerProcess {
    child: Option<Child>,
}

impl WorkerProcess {
    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("worker should still be owned")
    }

    fn disarm(&mut self) {
        self.child.take();
    }

    fn kill_and_wait(&mut self) -> ExitStatus {
        let previous_status = self
            .child_mut()
            .try_wait()
            .expect("worker process status should be readable before kill");
        assert!(
            previous_status.is_none(),
            "worker exited before the parent killed it: {previous_status:?}"
        );
        let kill_result = self.child_mut().kill();
        let wait_result = self.child_mut().wait();
        kill_result.expect("the blocked worker should be forcefully terminated");
        let status = wait_result.expect("the killed worker should be reaped");
        self.disarm();
        status
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if matches!(child.try_wait(), Ok(None) | Err(_)) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn request() -> RunStartedRequest {
    RunStartedRequest {
        run_id: "wrun_process_crash_fixture".to_owned(),
        spec_version: 7,
        event_data: RunCreatedEventData {
            deployment_id: "dpl_process_crash_fixture".to_owned(),
            workflow_name: "workflow//process-crash-fixture".to_owned(),
            input: vec![0, 1, 2, 255],
            execution_context: Some(json!({ "source": "process-test" })),
            attributes: Some(BTreeMap::from([(
                "fixture".to_owned(),
                "process-crash".to_owned(),
            )])),
            allow_reserved_attributes: false,
            encryption_public_key: Some("process-test-public-key".to_owned()),
        },
    }
}

fn env_path(name: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} must be set for the process-test worker"))
}

fn wait_for_marker(worker: &mut WorkerProcess, path: &Path, expected: &str) {
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        if fs::read_to_string(path).is_ok_and(|contents| contents == expected) {
            return;
        }
        if let Some(status) = worker
            .child_mut()
            .try_wait()
            .expect("worker process status should be readable")
        {
            worker.disarm();
            panic!("worker exited before publishing marker {expected:?}: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for worker marker {expected:?}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_success(worker: &mut WorkerProcess, label: &str) {
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        if let Some(status) = worker
            .child_mut()
            .try_wait()
            .expect("worker process status should be readable")
        {
            worker.disarm();
            assert!(status.success(), "{label} exited unsuccessfully: {status}");
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        thread::sleep(Duration::from_millis(10));
    }
}

fn spawn_worker(
    mode: &str,
    database_path: &Path,
    ready_path: &Path,
    failpoint: Option<&str>,
    release_path: Option<&Path>,
    result_path: Option<&Path>,
) -> WorkerProcess {
    let mut command = Command::new(env::current_exe().expect("test executable should be known"));
    command
        .arg("--ignored")
        .arg("--exact")
        .arg(WORKER_TEST_NAME)
        .arg("--test-threads=1")
        .arg("--nocapture")
        .env(WORKER_FLAG, "1")
        .env(WORKER_MODE, mode)
        .env(DATABASE_PATH, database_path)
        .env(READY_PATH, ready_path)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(failpoint) = failpoint {
        command.env(FAILPOINT, failpoint);
    }
    if let Some(release_path) = release_path {
        command.env(RELEASE_PATH, release_path);
    }
    if let Some(result_path) = result_path {
        command.env(RESULT_PATH, result_path);
    }
    WorkerProcess {
        child: Some(command.spawn().expect("worker process should start")),
    }
}

fn table_count(database_path: &Path, table: &str) -> i64 {
    assert!(
        matches!(
            table,
            "workflow_runs" | "workflow_events" | "workflow_run_created_event_data"
        ),
        "test helper must only query known tables"
    );
    Connection::open(database_path)
        .expect("inspector should open the database")
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("table count should be readable")
}

fn wal_path(database_path: &Path) -> PathBuf {
    let mut path = OsString::from(database_path.as_os_str());
    path.push("-wal");
    PathBuf::from(path)
}

fn assert_database_integrity(database_path: &Path) {
    let connection = Connection::open(database_path).expect("inspector should open the database");
    let journal_mode = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
        .expect("journal mode should be readable");
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .expect("integrity check should complete");
    assert_eq!(integrity, "ok");

    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .expect("foreign key check should prepare");
    let mut rows = statement
        .query([])
        .expect("foreign key check should execute");
    assert!(
        rows.next()
            .expect("foreign key check row should be readable")
            .is_none(),
        "foreign key check should report no violations"
    );
}

fn assert_empty_database(database_path: &Path) {
    assert_database_integrity(database_path);
    assert_eq!(table_count(database_path, "workflow_runs"), 0);
    assert_eq!(table_count(database_path, "workflow_events"), 0);
    assert_eq!(
        table_count(database_path, "workflow_run_created_event_data"),
        0
    );
    let missing = SqliteWorld::new(database_path)
        .snapshot(&request().run_id)
        .expect_err("an aborted transaction must not leave a visible run");
    assert_eq!(missing.kind(), WorldErrorKind::RunNotFound);
}

fn assert_complete_database(database_path: &Path) {
    assert_database_integrity(database_path);
    let expected = request();
    let snapshot = SqliteWorld::new(database_path)
        .snapshot(&expected.run_id)
        .expect("complete state should be readable after reopen");
    assert_eq!(snapshot.run.status, RunStatus::Running);
    assert_eq!(
        snapshot.run.deployment_id,
        expected.event_data.deployment_id
    );
    assert_eq!(
        snapshot.run.workflow_name,
        expected.event_data.workflow_name
    );
    assert_eq!(snapshot.run.spec_version, expected.spec_version);
    assert_eq!(snapshot.run.input, expected.event_data.input);
    assert_eq!(
        snapshot.run.execution_context,
        expected.event_data.execution_context
    );
    assert_eq!(
        snapshot.run.attributes,
        expected.event_data.attributes.unwrap_or_default()
    );
    assert_eq!(
        snapshot.run.encryption_public_key,
        expected.event_data.encryption_public_key
    );
    assert_eq!(
        snapshot
            .events
            .iter()
            .map(|event| {
                (
                    event.slot,
                    event.event_type,
                    event.spec_version,
                    event.event_data.is_some(),
                )
            })
            .collect::<Vec<_>>(),
        vec![
            (1, EventType::RunCreated, 7, true),
            (2, EventType::RunStarted, 7, false),
        ]
    );
    assert_eq!(snapshot.events[0].event_data, Some(request().event_data));

    let connection = Connection::open(database_path).expect("inspector should open the database");
    let next_slot = connection
        .query_row(
            "SELECT next_event_slot FROM workflow_runs WHERE run_id = ?1",
            [&request().run_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("next event slot should be readable");
    assert_eq!(next_slot, 3);
    assert_eq!(table_count(database_path, "workflow_runs"), 1);
    assert_eq!(table_count(database_path, "workflow_events"), 2);
    assert_eq!(
        table_count(database_path, "workflow_run_created_event_data"),
        1
    );
}

fn write_release(path: &Path) {
    fs::write(path, b"release").expect("worker release gate should open");
}

pub(super) fn pause_at_process_test_failpoint(
    connection: Option<&Connection>,
    name: &str,
) -> Result<(), WorldError> {
    if env::var_os(WORKER_FLAG).is_none() || env::var(FAILPOINT).as_deref() != Ok(name) {
        return Ok(());
    }
    if let Some(connection) = connection {
        connection.cache_flush().map_err(storage_error)?;
    }
    fs::write(env_path(READY_PATH), name.as_bytes()).map_err(storage_error)?;

    if let Some(release_path) = env::var_os(RELEASE_PATH).map(PathBuf::from) {
        let deadline = Instant::now() + WORKER_RELEASE_TIMEOUT;
        while !release_path.exists() {
            if Instant::now() >= deadline {
                return Err(WorldError::new(
                    WorldErrorKind::Storage,
                    format!("process-test worker timed out at {name}"),
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
        return Ok(());
    }

    thread::sleep(Duration::from_secs(30));
    std::process::abort();
}

#[test]
fn processes_that_both_observed_a_missing_run_still_linearize_one_append() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    SqliteWorld::new(&database_path)
        .migrate()
        .expect("migration should succeed");
    let release_path = directory.path().join("release");

    let mut workers = (0..2)
        .map(|index| {
            let ready_path = directory.path().join(format!("ready-{index}"));
            let result_path = directory.path().join(format!("result-{index}"));
            let child = spawn_worker(
                "start",
                &database_path,
                &ready_path,
                Some("after_read_miss"),
                Some(&release_path),
                Some(&result_path),
            );
            (child, ready_path, result_path)
        })
        .collect::<Vec<_>>();

    for (child, ready_path, _) in &mut workers {
        wait_for_marker(child, ready_path, "after_read_miss");
    }
    write_release(&release_path);
    for (index, (child, _, _)) in workers.iter_mut().enumerate() {
        wait_for_success(child, &format!("concurrent worker {index}"));
    }

    let outcomes = workers
        .iter()
        .map(|(_, _, result_path)| {
            fs::read_to_string(result_path).expect("worker result should be written")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| outcome.as_str() == "appended")
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| outcome.as_str() == "idempotent")
            .count(),
        1
    );
    assert_complete_database(&database_path);
}

#[test]
fn a_second_process_gets_retryable_busy_while_the_writer_holds_the_transaction() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    SqliteWorld::new(&database_path)
        .migrate()
        .expect("migration should succeed");
    let holder_ready = directory.path().join("holder-ready");
    let holder_release = directory.path().join("holder-release");
    let holder_result = directory.path().join("holder-result");
    let mut holder = spawn_worker(
        "start",
        &database_path,
        &holder_ready,
        Some("after_first_event_append"),
        Some(&holder_release),
        Some(&holder_result),
    );
    wait_for_marker(&mut holder, &holder_ready, "after_first_event_append");

    let contender_ready = directory.path().join("contender-ready");
    let contender_result = directory.path().join("contender-result");
    let mut contender = spawn_worker(
        "expect-busy",
        &database_path,
        &contender_ready,
        None,
        None,
        Some(&contender_result),
    );
    wait_for_success(&mut contender, "busy contender");
    assert_eq!(
        fs::read_to_string(&contender_result).expect("busy result should be written"),
        "busy-retryable"
    );

    write_release(&holder_release);
    wait_for_success(&mut holder, "lock holder");
    assert_eq!(
        fs::read_to_string(&holder_result).expect("holder result should be written"),
        "appended"
    );
    let retry = SqliteWorld::new(&database_path)
        .create_resilient_run_started(&request())
        .expect("retry after the lock is released should succeed");
    assert!(retry.event.is_none(), "the committed retry is idempotent");
    assert_complete_database(&database_path);
}

#[test]
fn killing_a_writer_at_precommit_boundaries_leaves_no_partial_state_or_burned_slots() {
    const PRECOMMIT_FAILPOINTS: &[&str] = &[
        "after_begin_immediate",
        "after_run_write",
        "after_first_event_append",
        "after_second_event_append",
        "before_commit",
    ];

    for failpoint in PRECOMMIT_FAILPOINTS {
        let directory = tempdir().expect("temporary directory should be created");
        let database_path = directory.path().join("world.sqlite");
        let ready_path = directory.path().join("crash-ready");
        let world = SqliteWorld::new(&database_path);
        world.migrate().expect("migration should succeed");

        let mut worker = spawn_worker(
            "start",
            &database_path,
            &ready_path,
            Some(failpoint),
            None,
            None,
        );
        wait_for_marker(&mut worker, &ready_path, failpoint);
        if *failpoint == "after_first_event_append" {
            let wal_length = fs::metadata(wal_path(&database_path))
                .expect("flushing the transaction should create a WAL file")
                .len();
            assert!(
                wal_length > 32,
                "the WAL must contain more than its 32-byte header, got {wal_length} bytes"
            );
        }
        assert_eq!(table_count(&database_path, "workflow_runs"), 0);
        assert_eq!(table_count(&database_path, "workflow_events"), 0);
        assert_eq!(
            table_count(&database_path, "workflow_run_created_event_data"),
            0
        );

        let status = worker.kill_and_wait();
        assert!(
            !status.success(),
            "the worker paused at {failpoint} must not commit before it dies"
        );
        assert_empty_database(&database_path);

        let result = world
            .create_resilient_run_started(&request())
            .unwrap_or_else(|error| panic!("retry after {failpoint} should succeed: {error}"));
        let event = result.event.expect("retry should perform the append");
        assert_eq!(event.slot, 2);
        assert_eq!(event.event_type, EventType::RunStarted);
        assert_complete_database(&database_path);
    }
}

#[test]
fn killing_after_commit_preserves_the_full_transaction_and_retry_is_idempotent() {
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let ready_path = directory.path().join("postcommit-ready");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    let mut worker = spawn_worker(
        "start",
        &database_path,
        &ready_path,
        Some("after_commit_before_preload"),
        None,
        None,
    );
    wait_for_marker(&mut worker, &ready_path, "after_commit_before_preload");
    let status = worker.kill_and_wait();
    assert!(!status.success(), "the paused worker should be killed");

    assert_complete_database(&database_path);
    let retry = world
        .create_resilient_run_started(&request())
        .expect("retry after losing the first response should succeed");
    assert!(
        retry.event.is_none(),
        "the retry must not duplicate the event"
    );
    assert_eq!(
        retry
            .preload
            .expect("idempotent retry should still preload")
            .events
            .iter()
            .map(|event| event.slot)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_complete_database(&database_path);
}

#[test]
#[ignore = "spawned by the multiprocess tests"]
fn process_worker_entry() {
    if env::var_os(WORKER_FLAG).is_none() {
        return;
    }
    let mode = env::var(WORKER_MODE).expect("worker mode should be set");
    let database_path = env_path(DATABASE_PATH);

    match mode.as_str() {
        "start" => {
            let result = SqliteWorld::new(&database_path)
                .create_resilient_run_started(&request())
                .expect("worker start should succeed");
            let result_path = env_path(RESULT_PATH);
            fs::write(
                result_path,
                if result.event.is_some() {
                    b"appended".as_slice()
                } else {
                    b"idempotent".as_slice()
                },
            )
            .expect("worker result should be persisted");
        }
        "expect-busy" => {
            fs::write(env_path(READY_PATH), b"ready").expect("busy worker should signal readiness");
            let error = SqliteWorld::new(&database_path)
                .with_busy_timeout(Duration::from_millis(1))
                .create_resilient_run_started(&request())
                .expect_err("the lock holder should make the contender busy");
            assert_eq!(error.kind(), WorldErrorKind::Storage);
            assert!(error.retryable(), "SQLITE_BUSY must remain retryable");
            fs::write(env_path(RESULT_PATH), b"busy-retryable")
                .expect("busy result should be persisted");
        }
        other => panic!("unknown process-test worker mode: {other}"),
    }
}
