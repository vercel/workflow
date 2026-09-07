use std::fs;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};
use tempfile::tempdir;
use workflow_protocol::{
    QueueMessageRequest, RunCreatedEventData, RunStartedRequest, WorldErrorKind,
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
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Given {
    active_run: ActiveRun,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ActiveRun {
    run_id: String,
    deployment_id: String,
    workflow_name: String,
    input: FixtureBytes,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct When {
    scope: String,
    deployment_id: String,
    queue_prefix: String,
    queue_name: String,
    lease_duration_ms: i64,
    operations: Vec<Operation>,
}

#[derive(Debug, Deserialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation"
)]
enum Operation {
    Reconcile {
        at_ms: i64,
        expect: Value,
    },
    Claim {
        worker_id: String,
        at_ms: i64,
        expect: Value,
    },
    Reschedule {
        at_ms: i64,
        available_at_ms: i64,
        expect: Value,
    },
    Acknowledge {
        at_ms: i64,
        expect: Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureBytes {
    #[serde(rename = "$bytes")]
    base64: String,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/world-contract/v1/leased-queue.json")
}

fn load_fixture() -> Fixture {
    serde_json::from_str(&fs::read_to_string(fixture_path()).expect("fixture should be readable"))
        .expect("fixture should be valid JSON")
}

fn active_run_request(fixture: &Fixture) -> RunStartedRequest {
    let run = &fixture.given.active_run;
    RunStartedRequest {
        run_id: run.run_id.clone(),
        spec_version: fixture.persisted_spec_version,
        event_data: RunCreatedEventData {
            deployment_id: run.deployment_id.clone(),
            workflow_name: run.workflow_name.clone(),
            input: STANDARD
                .decode(&run.input.base64)
                .expect("fixture bytes should be valid base64"),
            execution_context: None,
            attributes: None,
            allow_reserved_attributes: false,
            encryption_public_key: None,
        },
    }
}

#[test]
fn executes_the_shared_leased_queue_trace() {
    let fixture = load_fixture();
    assert_eq!(fixture.schema, "./leased-queue.schema.json");
    assert_eq!(fixture.fixture_version, 1);
    assert_eq!(fixture.name, "leased-queue-recovers-and-reconciles");
    assert_eq!(
        fixture.requires,
        ["leased-queue", "active-run-reconciliation"]
    );

    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    world
        .create_resilient_run_started(&active_run_request(&fixture))
        .expect("active fixture run should be created");

    let mut current_lease_token = None;
    let mut latest_message_ids = Vec::new();
    for operation in &fixture.when.operations {
        let actual = match operation {
            Operation::Reconcile { at_ms, expect: _ } => {
                let result = world
                    .reconcile_active_runs(
                        &fixture.when.scope,
                        &fixture.when.deployment_id,
                        &fixture.when.queue_prefix,
                        *at_ms,
                    )
                    .expect("reconciliation should succeed");
                latest_message_ids.clone_from(&result.message_ids);
                json!({
                    "activeRunCount": result.active_run_count,
                    "createdMessageCount": result.created_message_count,
                    "messageIds": result.message_ids,
                    "queuedMessageCount": world
                        .queue_message_count(&fixture.when.scope)
                        .expect("queue count should be readable"),
                })
            }
            Operation::Claim {
                worker_id,
                at_ms,
                expect: _,
            } => {
                let claim = world
                    .claim_queue_message(
                        &fixture.when.scope,
                        &fixture.when.queue_name,
                        worker_id,
                        *at_ms,
                        fixture.when.lease_duration_ms,
                    )
                    .expect("claim should succeed");
                current_lease_token = claim.as_ref().map(|claim| claim.lease_token.clone());
                claim.map_or(Value::Null, |claim| {
                    json!({
                        "messageId": claim.message_id,
                        "attempt": claim.attempt,
                        "leaseOwner": claim.lease_owner,
                        "leaseExpiresAtMs": claim.lease_expires_at_ms,
                        "body": { "$bytes": STANDARD.encode(claim.body) },
                    })
                })
            }
            Operation::Reschedule {
                at_ms,
                available_at_ms,
                expect: _,
            } => {
                let message_id = world
                    .reschedule_queue_message(
                        current_lease_token
                            .take()
                            .expect("reschedule must follow a successful claim")
                            .as_str(),
                        *at_ms,
                        *available_at_ms,
                    )
                    .expect("reschedule should succeed");
                json!({
                    "messageId": message_id,
                    "queuedMessageCount": world
                        .queue_message_count(&fixture.when.scope)
                        .expect("queue count should be readable"),
                })
            }
            Operation::Acknowledge { at_ms, expect: _ } => {
                let message_id = world
                    .acknowledge_queue_message(
                        current_lease_token
                            .take()
                            .expect("acknowledgement must follow a successful claim")
                            .as_str(),
                        *at_ms,
                    )
                    .expect("acknowledgement should succeed");
                json!({
                    "messageId": message_id,
                    "queuedMessageCount": world
                        .queue_message_count(&fixture.when.scope)
                        .expect("queue count should be readable"),
                })
            }
        };
        let expected = match operation {
            Operation::Reconcile { expect, .. }
            | Operation::Claim { expect, .. }
            | Operation::Reschedule { expect, .. }
            | Operation::Acknowledge { expect, .. } => expect,
        };
        assert_eq!(&actual, expected);
    }

    assert_eq!(
        world
            .queue_message_count(&fixture.when.scope)
            .expect("final queue count should be readable"),
        fixture.then["queuedMessageCount"]
            .as_u64()
            .expect("fixture count should be unsigned") as usize
    );
    assert_eq!(json!(latest_message_ids), fixture.then["messageIds"]);
}

#[test]
fn reconciliation_filters_deployments_and_expired_claims_lose_authority() {
    let fixture = load_fixture();
    let directory = tempdir().expect("temporary directory should be created");
    let database_path = directory.path().join("world.sqlite");
    let world = SqliteWorld::new(&database_path);
    world.migrate().expect("migration should succeed");
    world
        .create_resilient_run_started(&active_run_request(&fixture))
        .expect("matching active run should be created");
    let mut other_deployment = active_run_request(&fixture);
    other_deployment.run_id = "wrun_other_deployment".to_owned();
    other_deployment.event_data.deployment_id = "dpl_other".to_owned();
    world
        .create_resilient_run_started(&other_deployment)
        .expect("other deployment run should be created");

    let reconciliation = world
        .reconcile_active_runs(
            &fixture.when.scope,
            &fixture.when.deployment_id,
            &fixture.when.queue_prefix,
            1_000,
        )
        .expect("matching deployment should reconcile");
    assert_eq!(reconciliation.active_run_count, 1);
    assert_eq!(reconciliation.created_message_count, 1);

    let claim = world
        .claim_queue_message(
            &fixture.when.scope,
            &fixture.when.queue_name,
            "expiring-worker",
            1_000,
            100,
        )
        .expect("message should be claimable")
        .expect("reconciliation should have created a message");
    let error = world
        .acknowledge_queue_message(&claim.lease_token, claim.lease_expires_at_ms)
        .expect_err("a lease token must lose authority at its expiry boundary");
    assert_eq!(error.kind(), WorldErrorKind::QueueClaimLost);

    let recovered = world
        .claim_queue_message(
            &fixture.when.scope,
            &fixture.when.queue_name,
            "recovery-worker",
            claim.lease_expires_at_ms,
            100,
        )
        .expect("expired message should be claimable")
        .expect("expired message should remain queued");
    assert_eq!(recovered.message_id, claim.message_id);
    assert_eq!(recovered.attempt, 2);
}

#[test]
fn an_idempotency_key_reuses_the_first_message_id() {
    let directory = tempdir().expect("temporary directory should be created");
    let world = SqliteWorld::new(directory.path().join("world.sqlite"));
    world.migrate().expect("migration should succeed");
    let first = QueueMessageRequest {
        message_id: "msg_first".to_owned(),
        scope: "local-js".to_owned(),
        queue_name: "__wkf_workflow_idempotent".to_owned(),
        idempotency_key: "same-operation".to_owned(),
        body: br#"{"runId":"wrun_idempotent"}"#.to_vec(),
        available_at_ms: 1,
    };
    let created = world
        .enqueue_queue_message(&first)
        .expect("first enqueue should succeed");
    assert!(created.created);

    let duplicate = QueueMessageRequest {
        message_id: "msg_second-proposal".to_owned(),
        ..first.clone()
    };
    let reused = world
        .enqueue_queue_message(&duplicate)
        .expect("idempotent enqueue should reuse durable state");
    assert!(!reused.created);
    assert_eq!(reused.message_id, first.message_id);

    let conflicting = QueueMessageRequest {
        body: br#"{"runId":"wrun_different"}"#.to_vec(),
        ..duplicate
    };
    assert_eq!(
        world
            .enqueue_queue_message(&conflicting)
            .expect_err("an idempotency key cannot change its payload")
            .kind(),
        WorldErrorKind::InvalidRequest
    );
}
