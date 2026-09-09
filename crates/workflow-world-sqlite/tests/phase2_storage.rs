use std::collections::BTreeMap;

use tempfile::tempdir;
use workflow_protocol::{
    AttributeChange, AttributeWriter, CreateWorldEventRequest, RunCreatedEventData, WorldErrorKind,
    WorldEventData,
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
                workflow_name: "workflow//phase2".to_owned(),
                input: vec![1, 2, 3],
                execution_context: None,
                attributes: Some(BTreeMap::from([("initial".to_owned(), "yes".to_owned())])),
                allow_reserved_attributes: false,
                encryption_public_key: None,
            }),
        ))
        .expect("run should be created");
}

#[test]
fn attributes_are_materialized_and_round_trip_in_the_event_log() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");
    create_run(&world, "run-attributes");

    let result = world
        .create_event(&request(
            "run-attributes",
            WorldEventData::AttrSet {
                correlation_id: Some("attr-operation".to_owned()),
                changes: vec![
                    AttributeChange {
                        key: "initial".to_owned(),
                        value: None,
                    },
                    AttributeChange {
                        key: "region".to_owned(),
                        value: Some("north".to_owned()),
                    },
                ],
                writer: AttributeWriter::Step {
                    step_id: "step-1".to_owned(),
                    attempt: 2,
                },
                allow_reserved_attributes: false,
            },
        ))
        .expect("attribute update should succeed");

    assert_eq!(
        result
            .run
            .expect("updated run should be returned")
            .attributes,
        BTreeMap::from([("region".to_owned(), "north".to_owned())])
    );
    assert_eq!(
        world
            .get_run("run-attributes")
            .expect("run should be readable")
            .attributes,
        BTreeMap::from([("region".to_owned(), "north".to_owned())])
    );
    let event = world
        .list_events("run-attributes", None, None, 100, false)
        .expect("events should list")
        .data
        .pop()
        .expect("attribute event should exist");
    assert!(matches!(
        event.event,
        WorldEventData::AttrSet {
            correlation_id: Some(ref correlation_id),
            ref changes,
            writer: AttributeWriter::Step { ref step_id, attempt: 2 },
            allow_reserved_attributes: false,
        } if correlation_id == "attr-operation" && step_id == "step-1" && changes.len() == 2
    ));

    let mut divergent = request(
        "run-attributes",
        WorldEventData::AttrSet {
            correlation_id: Some("attr-operation".to_owned()),
            changes: vec![AttributeChange {
                key: "region".to_owned(),
                value: Some("diverged".to_owned()),
            }],
            writer: AttributeWriter::Workflow,
            allow_reserved_attributes: false,
        },
    );
    assert_eq!(
        world
            .create_event(&divergent)
            .expect_err("a correlated attribute replay must be rejected")
            .kind(),
        WorldErrorKind::EntityConflict
    );
    assert_eq!(
        world
            .get_run("run-attributes")
            .expect("run should remain readable")
            .attributes,
        BTreeMap::from([("region".to_owned(), "north".to_owned())]),
        "a rejected replay must not diverge materialized attributes"
    );

    divergent.event = WorldEventData::AttrSet {
        correlation_id: Some("attr-validation-retry".to_owned()),
        changes: vec![AttributeChange {
            key: "$reserved".to_owned(),
            value: Some("blocked".to_owned()),
        }],
        writer: AttributeWriter::Workflow,
        allow_reserved_attributes: false,
    };
    assert_eq!(
        world
            .create_event(&divergent)
            .expect_err("invalid attributes must fail before claiming correlation")
            .kind(),
        WorldErrorKind::InvalidRequest
    );
    if let WorldEventData::AttrSet {
        allow_reserved_attributes,
        ..
    } = &mut divergent.event
    {
        *allow_reserved_attributes = true;
    }
    world
        .create_event(&divergent)
        .expect("a corrected request must be able to claim the correlation");
}

#[test]
fn cross_run_hook_id_conflict_is_typed_and_atomic() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");
    create_run(&world, "run-hook-owner");
    create_run(&world, "run-hook-contender");

    world
        .create_event(&request(
            "run-hook-owner",
            WorldEventData::HookCreated {
                hook_id: "globally-shared-hook-id".to_owned(),
                token: "owner-token".to_owned(),
                metadata: Some(vec![1, 2, 3]),
                token_retention_until_ms: None,
                is_webhook: Some(false),
                is_system: None,
            },
        ))
        .expect("the owner Hook should be created");

    let contender_events_before = world
        .list_events("run-hook-contender", None, None, 100, false)
        .expect("the contender journal should list")
        .data;
    let error = world
        .create_event(&request(
            "run-hook-contender",
            WorldEventData::HookCreated {
                hook_id: "globally-shared-hook-id".to_owned(),
                token: "distinct-token".to_owned(),
                metadata: Some(vec![9, 9, 9]),
                token_retention_until_ms: None,
                is_webhook: Some(true),
                is_system: Some(true),
            },
        ))
        .expect_err("a Hook ID owned by another run must conflict");

    assert_eq!(error.kind(), WorldErrorKind::EntityConflict);
    assert_eq!(
        world
            .list_events("run-hook-contender", None, None, 100, false)
            .expect("the contender journal should remain readable")
            .data,
        contender_events_before,
        "a rejected Hook ID conflict must not append an event"
    );
    assert_eq!(
        world
            .get_hook("globally-shared-hook-id")
            .expect("the original Hook should remain readable")
            .token,
        "owner-token",
        "a rejected Hook ID conflict must not replace the entity"
    );
    assert_eq!(
        world
            .get_hook_by_token("distinct-token")
            .expect_err("the rejected token must not be indexed")
            .kind(),
        WorldErrorKind::HookNotFound
    );
}

#[test]
fn hooks_enforce_tokens_retention_disposal_and_resume_dedup() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");
    create_run(&world, "run-hooks");
    create_run(&world, "run-conflict");

    let created = world
        .create_event(&request(
            "run-hooks",
            WorldEventData::HookCreated {
                hook_id: "hook-1".to_owned(),
                token: "shared-token".to_owned(),
                metadata: Some(vec![7, 8]),
                token_retention_until_ms: Some(i64::MAX),
                is_webhook: None,
                is_system: Some(true),
            },
        ))
        .expect("Hook should be created");
    let hook = created.hook.expect("materialized Hook should be returned");
    assert!(
        hook.is_webhook,
        "omitted isWebhook keeps the legacy true default"
    );
    assert!(hook.is_system);
    assert_eq!(
        world
            .get_hook_by_token("shared-token")
            .expect("Hook should be indexed")
            .hook_id,
        "hook-1"
    );

    let conflict = world
        .create_event(&request(
            "run-conflict",
            WorldEventData::HookCreated {
                hook_id: "hook-other".to_owned(),
                token: "shared-token".to_owned(),
                metadata: None,
                token_retention_until_ms: None,
                is_webhook: Some(false),
                is_system: None,
            },
        ))
        .expect("token conflict is a backend-produced event, not an error");
    assert!(matches!(
        conflict.event.expect("conflict event should be returned").event,
        WorldEventData::HookConflict {
            ref hook_id,
            ref token,
            conflicting_run_id: Some(ref owner),
        } if hook_id == "hook-other" && token == "shared-token" && owner == "run-hooks"
    ));

    let same_id_cross_run = world
        .create_event(&request(
            "run-conflict",
            WorldEventData::HookCreated {
                hook_id: "hook-1".to_owned(),
                token: "shared-token".to_owned(),
                metadata: None,
                token_retention_until_ms: None,
                is_webhook: Some(false),
                is_system: None,
            },
        ))
        .expect("the same Hook ID in another run is still a token conflict");
    assert!(matches!(
        same_id_cross_run
            .event
            .expect("cross-run conflict event should be returned")
            .event,
        WorldEventData::HookConflict {
            ref hook_id,
            ref token,
            conflicting_run_id: Some(ref owner),
        } if hook_id == "hook-1" && token == "shared-token" && owner == "run-hooks"
    ));

    let mut first_resume = request(
        "run-hooks",
        WorldEventData::HookReceived {
            hook_id: "hook-1".to_owned(),
            token: Some("shared-token".to_owned()),
            payload: vec![9, 9, 9],
        },
    );
    first_resume.resume_id = Some("resume-1".to_owned());
    first_resume.resume_payload_digest = Some("digest-1".to_owned());
    let first = world
        .create_event(&first_resume)
        .expect("first resume should be recorded")
        .event
        .expect("resume event should be returned");
    assert_eq!(first.resume_id.as_deref(), Some("resume-1"));

    world
        .create_event(&request(
            "run-hooks",
            WorldEventData::HookDisposed {
                hook_id: "hook-1".to_owned(),
                token: Some("shared-token".to_owned()),
            },
        ))
        .expect("Hook should be disposed");
    assert_eq!(
        world
            .get_hook("hook-1")
            .expect_err("disposed Hook is gone")
            .kind(),
        WorldErrorKind::HookNotFound
    );

    assert_eq!(
        world
            .create_event(&request(
                "run-hooks",
                WorldEventData::HookCreated {
                    hook_id: "hook-1".to_owned(),
                    token: "shared-token".to_owned(),
                    metadata: None,
                    token_retention_until_ms: None,
                    is_webhook: Some(false),
                    is_system: None,
                },
            ))
            .expect_err("replaying a disposed Hook creation must not resurrect it")
            .kind(),
        WorldErrorKind::EntityConflict
    );
    assert_eq!(
        world
            .get_hook("hook-1")
            .expect_err("the disposed Hook must remain absent")
            .kind(),
        WorldErrorKind::HookNotFound
    );

    let duplicate = world
        .create_event(&first_resume)
        .expect("resume redelivery converges even after disposal")
        .event
        .expect("canonical event should be returned");
    assert_eq!(duplicate.slot, first.slot);
    assert_eq!(
        world
            .list_events("run-hooks", None, None, 100, false)
            .expect("events should list")
            .data
            .len(),
        4,
        "redelivery must not append a duplicate event"
    );

    let mut changed_payload = first_resume.clone();
    changed_payload.resume_payload_digest = Some("digest-2".to_owned());
    assert_eq!(
        world
            .create_event(&changed_payload)
            .expect_err("resume ID reuse with a different digest must fail")
            .kind(),
        WorldErrorKind::EntityConflict
    );
}

#[test]
fn terminal_cleanup_preserves_retained_hooks_and_removes_waits() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");
    create_run(&world, "run-terminal");
    create_run(&world, "run-next");

    world
        .create_event(&request(
            "run-terminal",
            WorldEventData::HookCreated {
                hook_id: "retained".to_owned(),
                token: "retained-token".to_owned(),
                metadata: None,
                token_retention_until_ms: Some(i64::MAX),
                is_webhook: Some(false),
                is_system: Some(false),
            },
        ))
        .expect("retained Hook should be created");
    world
        .create_event(&request(
            "run-terminal",
            WorldEventData::HookCreated {
                hook_id: "ephemeral".to_owned(),
                token: "ephemeral-token".to_owned(),
                metadata: None,
                token_retention_until_ms: None,
                is_webhook: Some(false),
                is_system: Some(false),
            },
        ))
        .expect("ephemeral Hook should be created");
    let wait_created = world
        .create_event(&request(
            "run-terminal",
            WorldEventData::WaitCreated {
                wait_id: "sleep-1".to_owned(),
                resume_at_ms: 12_345,
            },
        ))
        .expect("wait should be created");
    assert_eq!(
        wait_created
            .wait
            .expect("materialized wait should be returned")
            .resume_at_ms,
        Some(12_345)
    );

    world
        .create_event(&request(
            "run-terminal",
            WorldEventData::RunCompleted { output: None },
        ))
        .expect("run should complete");
    assert!(world.get_hook("retained").is_ok());
    assert_eq!(
        world
            .get_hook("ephemeral")
            .expect_err("unretained Hook should be reaped")
            .kind(),
        WorldErrorKind::HookNotFound
    );
    assert_eq!(
        world
            .create_event(&request(
                "run-terminal",
                WorldEventData::WaitCompleted {
                    wait_id: "sleep-1".to_owned(),
                    resume_at_ms: None,
                },
            ))
            .expect_err("terminal cleanup should remove the materialized wait")
            .kind(),
        WorldErrorKind::WaitNotFound
    );

    let retained_conflict = world
        .create_event(&request(
            "run-next",
            WorldEventData::HookCreated {
                hook_id: "replacement".to_owned(),
                token: "retained-token".to_owned(),
                metadata: None,
                token_retention_until_ms: None,
                is_webhook: None,
                is_system: None,
            },
        ))
        .expect("retained token should return a conflict event");
    assert!(matches!(
        retained_conflict.event.expect("event should exist").event,
        WorldEventData::HookConflict { .. }
    ));

    let hooks = world
        .list_hooks(None, None, 100, false)
        .expect("Hooks should list");
    assert_eq!(hooks.data.len(), 1);
    assert_eq!(hooks.data[0].hook_id, "retained");
}

#[test]
fn clear_is_scoped_to_the_selected_database_and_preserves_the_schema() {
    let directory = tempdir().expect("temporary directory should be created");
    let first = SqliteWorld::new(directory.path().join("first.sqlite"));
    let second = SqliteWorld::new(directory.path().join("second.sqlite"));
    first.migrate().expect("first migration should succeed");
    second.migrate().expect("second migration should succeed");
    create_run(&first, "first-run");
    create_run(&second, "second-run");
    first
        .write_stream_chunk("first-run", "output", b"chunk")
        .expect("stream should be written");

    first.clear().expect("clear should succeed");
    assert_eq!(
        first
            .get_run("first-run")
            .expect_err("selected database should be empty")
            .kind(),
        WorldErrorKind::RunNotFound
    );
    first
        .ensure_ready()
        .expect("clear must preserve migrations");
    assert_eq!(
        second
            .get_run("second-run")
            .expect("other database must survive")
            .run_id,
        "second-run"
    );
}
