use std::sync::{Arc, Barrier};
use std::thread;

use rusqlite::{Connection, OptionalExtension};
use tempfile::tempdir;
use workflow_protocol::{
    CreateWorldEventRequest, RunCreatedEventData, WorldErrorKind, WorldEventData,
};
use workflow_world_sqlite::{SqliteWorld, StreamInfo};

fn create_run(world: &SqliteWorld, run_id: &str) {
    world
        .create_event(&CreateWorldEventRequest {
            run_id: run_id.to_owned(),
            spec_version: 7,
            event_count: Some(0),
            occurred_at_ms: None,
            resume_id: None,
            resume_payload_digest: None,
            event: WorldEventData::RunCreated(RunCreatedEventData {
                deployment_id: "local-js".to_owned(),
                workflow_name: "workflow//durable-streams".to_owned(),
                input: vec![],
                execution_context: None,
                attributes: None,
                allow_reserved_attributes: false,
                encryption_public_key: None,
            }),
        })
        .expect("run should be created");
}

#[test]
fn closes_and_persists_an_empty_stream_idempotently() {
    let directory = tempdir().expect("temporary directory");
    let world = SqliteWorld::new(directory.path().join("workflow.sqlite"));
    world.migrate().expect("database should migrate");
    create_run(&world, "wrun_empty_stream");

    assert_eq!(
        world
            .get_stream_info("wrun_empty_stream", "missing")
            .expect("missing stream info should be readable"),
        StreamInfo {
            tail_index: -1,
            done: false,
        }
    );
    assert!(
        world
            .write_stream_chunks("wrun_empty_stream", "not-created", &[])
            .expect("an empty batch should be a no-op")
            .is_empty()
    );
    assert!(
        world
            .list_streams("wrun_empty_stream")
            .expect("streams should list")
            .is_empty()
    );

    world
        .close_stream("wrun_empty_stream", "empty")
        .expect("empty stream should close");
    world
        .close_stream("wrun_empty_stream", "empty")
        .expect("repeated close should be idempotent");

    assert_eq!(
        world
            .list_streams("wrun_empty_stream")
            .expect("closed stream should list"),
        ["empty"]
    );
    assert_eq!(
        world
            .get_stream_info("wrun_empty_stream", "empty")
            .expect("closed stream info should be readable"),
        StreamInfo {
            tail_index: -1,
            done: true,
        }
    );
    let page = world
        .get_stream_chunks("wrun_empty_stream", "empty", None, 100)
        .expect("empty stream chunks should be readable");
    assert!(page.data.is_empty());
    assert_eq!(page.cursor, None);
    assert!(!page.has_more);
    assert!(page.done);

    let error = world
        .write_stream_chunk("wrun_empty_stream", "empty", b"too late")
        .expect_err("a closed stream must reject writes");
    assert_eq!(error.kind(), WorldErrorKind::EntityConflict);
}

#[test]
fn concurrent_batches_receive_dense_ordered_indices_without_interleaving() {
    const WRITERS: usize = 12;

    let directory = tempdir().expect("temporary directory");
    let world = SqliteWorld::new(directory.path().join("workflow.sqlite"));
    world.migrate().expect("database should migrate");
    create_run(&world, "wrun_concurrent_stream");

    let barrier = Arc::new(Barrier::new(WRITERS));
    let handles = (0..WRITERS)
        .map(|writer| {
            let world = world.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                world.write_stream_chunks(
                    "wrun_concurrent_stream",
                    "output",
                    &[vec![writer as u8, 0], vec![writer as u8, 1]],
                )
            })
        })
        .collect::<Vec<_>>();

    for handle in handles {
        let written = handle
            .join()
            .expect("writer thread should not panic")
            .expect("writer should append");
        assert_eq!(written.len(), 2);
        assert_eq!(written[1].index, written[0].index + 1);
    }

    let page = world
        .get_stream_chunks("wrun_concurrent_stream", "output", None, 100)
        .expect("all chunks should be readable");
    assert_eq!(page.data.len(), WRITERS * 2);
    assert_eq!(
        page.data
            .iter()
            .map(|chunk| chunk.index)
            .collect::<Vec<_>>(),
        (0..u64::try_from(WRITERS * 2).expect("small fixture")).collect::<Vec<_>>()
    );
    for writer in 0..WRITERS {
        let first = page
            .data
            .iter()
            .position(|chunk| chunk.data == [writer as u8, 0])
            .expect("first batch chunk should exist");
        let second = page
            .data
            .iter()
            .position(|chunk| chunk.data == [writer as u8, 1])
            .expect("second batch chunk should exist");
        assert_eq!(second, first + 1, "one atomic batch must not interleave");
    }
}

#[test]
fn paginates_with_validated_index_cursors_and_survives_reopen() {
    let directory = tempdir().expect("temporary directory");
    let database_path = directory.path().join("workflow.sqlite");
    {
        let world = SqliteWorld::new(&database_path);
        world.migrate().expect("database should migrate");
        create_run(&world, "wrun_persisted_stream");
        world
            .write_stream_chunk("wrun_persisted_stream", "output", b"zero")
            .expect("single chunk should append");
        world
            .write_stream_chunks(
                "wrun_persisted_stream",
                "output",
                &[b"one".to_vec(), b"two".to_vec(), b"three".to_vec()],
            )
            .expect("chunk batch should append");

        let first = world
            .get_stream_chunks("wrun_persisted_stream", "output", None, 2)
            .expect("first page should load");
        assert_eq!(
            first
                .data
                .iter()
                .map(|chunk| (chunk.index, chunk.data.as_slice()))
                .collect::<Vec<_>>(),
            [(0, b"zero".as_slice()), (1, b"one".as_slice())]
        );
        assert_eq!(first.cursor.as_deref(), Some("index:2"));
        assert!(first.has_more);
        assert!(!first.done);

        let second = world
            .get_stream_chunks(
                "wrun_persisted_stream",
                "output",
                first.cursor.as_deref(),
                2,
            )
            .expect("second page should load");
        assert_eq!(
            second
                .data
                .iter()
                .map(|chunk| (chunk.index, chunk.data.as_slice()))
                .collect::<Vec<_>>(),
            [(2, b"two".as_slice()), (3, b"three".as_slice())]
        );
        assert_eq!(second.cursor, None);
        assert!(!second.has_more);
        assert!(!second.done);

        world
            .close_stream("wrun_persisted_stream", "output")
            .expect("stream should close");
    }

    let reopened = SqliteWorld::new(&database_path);
    reopened
        .ensure_ready()
        .expect("reopened database should be ready");
    assert_eq!(
        reopened
            .get_stream_info("wrun_persisted_stream", "output")
            .expect("stream info should persist"),
        StreamInfo {
            tail_index: 3,
            done: true,
        }
    );
    let page = reopened
        .get_stream_chunks("wrun_persisted_stream", "output", Some("index:2"), 10)
        .expect("persisted page should load");
    assert_eq!(
        page.data
            .iter()
            .map(|chunk| chunk.data.as_slice())
            .collect::<Vec<_>>(),
        [b"two".as_slice(), b"three".as_slice()]
    );
    assert!(page.done);

    for cursor in [
        "",
        "2",
        "index:",
        "index:02",
        "index:-1",
        "index:9007199254740993",
    ] {
        let error = reopened
            .get_stream_chunks("wrun_persisted_stream", "output", Some(cursor), 10)
            .expect_err("malformed cursor should fail");
        assert_eq!(error.kind(), WorldErrorKind::InvalidRequest);
    }
    for limit in [0, 1_001] {
        let error = reopened
            .get_stream_chunks("wrun_persisted_stream", "output", None, limit)
            .expect_err("invalid limit should fail");
        assert_eq!(error.kind(), WorldErrorKind::InvalidRequest);
    }
}

#[test]
fn run_cascade_keeps_database_local_clear_simple() {
    let directory = tempdir().expect("temporary directory");
    let database_path = directory.path().join("workflow.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("database should migrate");
    create_run(&world, "wrun_stream_clear");
    create_run(&world, "wrun_stream_survivor");
    world
        .write_stream_chunks(
            "wrun_stream_clear",
            "with-data",
            &[b"a".to_vec(), b"b".to_vec()],
        )
        .expect("chunks should append");
    world
        .close_stream("wrun_stream_clear", "empty")
        .expect("empty stream should close");
    world
        .write_stream_chunk("wrun_stream_survivor", "with-data", b"survives")
        .expect("the other run's same-named stream should append");

    let connection = Connection::open(&database_path).expect("database should open");
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .expect("foreign keys should enable");
    connection
        .execute(
            "DELETE FROM workflow_runs WHERE run_id = ?1",
            ["wrun_stream_clear"],
        )
        .expect("deleting the run should cascade");
    let streams = connection
        .query_row("SELECT count(*) FROM workflow_streams", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("stream count should load");
    let chunks = connection
        .query_row("SELECT count(*) FROM workflow_stream_chunks", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("chunk count should load");
    assert_eq!((streams, chunks), (1, 1));
    let surviving = world
        .get_stream_chunks("wrun_stream_survivor", "with-data", None, 10)
        .expect("the other run's stream should survive the cascade");
    assert_eq!(surviving.data.len(), 1);
    assert_eq!(surviving.data[0].index, 0);
    assert_eq!(surviving.data[0].data, b"survives");
    assert_eq!(
        connection
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(true))
            .optional()
            .expect("foreign key check should run"),
        None
    );
}

#[test]
fn synthetic_health_streams_do_not_require_a_run_and_clear_removes_them() {
    let directory = tempdir().expect("temporary directory");
    let world = SqliteWorld::new(directory.path().join("workflow.sqlite"));
    world.migrate().expect("database should migrate");

    world
        .write_stream_chunks(
            "wrun_health_synthetic",
            "health",
            &[b"healthy".to_vec(), b"portable".to_vec()],
        )
        .expect("health stream should not require a materialized run");
    world
        .close_stream("wrun_health_synthetic", "health")
        .expect("health stream should close");
    assert_eq!(
        world
            .list_streams("wrun_health_synthetic")
            .expect("health stream should list"),
        ["health"]
    );

    world.clear().expect("database should clear");
    assert!(
        world
            .list_streams("wrun_health_synthetic")
            .expect("cleared health streams should list")
            .is_empty()
    );
}
