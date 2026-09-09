//! Ordered SQLite schema migration registry and history validation.

use sha2::{Digest, Sha256};
use workflow_protocol::{WorldError, WorldErrorKind};

#[derive(Clone, Copy, Debug)]
pub(super) struct SchemaMigration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
    pub checksum: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AppliedMigration {
    pub version: i64,
    pub checksum: String,
}

pub(super) const MIGRATIONS: &[SchemaMigration] = &[
    SchemaMigration {
        version: 1,
        name: "initial",
        sql: include_str!("../migrations/0001_initial.sql"),
        checksum: "sha256:d17b42237f57d684c310e992e140096613476aa589317d99e1d5f8228e000b13",
    },
    SchemaMigration {
        version: 2,
        name: "leased-queue",
        sql: include_str!("../migrations/0002_leased_queue.sql"),
        checksum: "sha256:e8e887f52c1f6c0c5485f208026326d9bce280c18e6e1e5cd6e0ca9841017128",
    },
    SchemaMigration {
        version: 3,
        name: "phase1-run-step-storage",
        sql: include_str!("../migrations/0003_phase1_run_step_storage.sql"),
        checksum: "sha256:3c64d7d88d9a8d0c2ec5228c241ca5550ecb7daae1d42b55ac8b5f5e247c046a",
    },
    SchemaMigration {
        version: 4,
        name: "durable-streams",
        sql: include_str!("../migrations/0004_durable_streams.sql"),
        checksum: "sha256:6f4d7123d6805d341ece47fbfa1956ea232b73c686c761e7ad9168e639422a15",
    },
    SchemaMigration {
        version: 5,
        name: "phase2-entities",
        sql: include_str!("../migrations/0005_phase2_entities.sql"),
        checksum: "sha256:bffda993b0bec30b0cea48e1a4fdc0569abcf204f453b72888ce69f353866c91",
    },
];

pub(super) fn current_schema_version() -> i64 {
    MIGRATIONS.last().map_or(0, |migration| migration.version)
}

pub(super) fn migration_checksum(migration: &SchemaMigration) -> String {
    format!("sha256:{:x}", Sha256::digest(migration.sql.as_bytes()))
}

pub(super) fn validate_registry() -> Result<(), WorldError> {
    validate_registry_slice(MIGRATIONS)
}

pub(super) fn validate_applied_history(applied: &[AppliedMigration]) -> Result<usize, WorldError> {
    validate_history(MIGRATIONS, applied)
}

fn validate_registry_slice(registry: &[SchemaMigration]) -> Result<(), WorldError> {
    if registry.is_empty() {
        return Err(WorldError::new(
            WorldErrorKind::Storage,
            "SQLite migration registry must not be empty",
        ));
    }
    for (index, migration) in registry.iter().enumerate() {
        let expected_version = i64::try_from(index + 1).map_err(|_| {
            WorldError::new(
                WorldErrorKind::Storage,
                "SQLite migration registry version overflow",
            )
        })?;
        if migration.version != expected_version {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!(
                    "SQLite migration registry is not contiguous: expected version {expected_version}, got {}",
                    migration.version
                ),
            ));
        }
        if migration.name.trim().is_empty() {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!("SQLite migration {expected_version} has an empty name"),
            ));
        }
        if migration.sql.trim().is_empty() {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!("SQLite migration {expected_version} has empty SQL"),
            ));
        }
        if migration_checksum(migration) != migration.checksum {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!(
                    "SQLite migration {} ({}) SQL does not match its pinned checksum",
                    migration.version, migration.name
                ),
            ));
        }
        if registry[..index]
            .iter()
            .any(|previous| previous.name == migration.name)
        {
            return Err(WorldError::new(
                WorldErrorKind::Storage,
                format!("SQLite migration name {:?} is duplicated", migration.name),
            ));
        }
    }
    Ok(())
}

fn validate_history(
    registry: &[SchemaMigration],
    applied: &[AppliedMigration],
) -> Result<usize, WorldError> {
    for (index, actual) in applied.iter().enumerate() {
        let expected_version = i64::try_from(index + 1).map_err(|_| {
            WorldError::new(
                WorldErrorKind::UnsupportedSchema,
                "SQLite World migration history length overflow",
            )
        })?;
        if actual.version != expected_version {
            return Err(WorldError::new(
                WorldErrorKind::UnsupportedSchema,
                format!(
                    "SQLite World migration history is not a contiguous prefix: expected version {}, got {}",
                    expected_version, actual.version
                ),
            ));
        }
        if let Some(expected) = registry.get(index)
            && actual.checksum != expected.checksum
        {
            return Err(WorldError::new(
                WorldErrorKind::UnsupportedSchema,
                format!(
                    "SQLite World migration {} ({}) checksum does not match this binary",
                    expected.version, expected.name
                ),
            ));
        }
    }
    if applied.len() > registry.len() {
        let database_version = applied.last().map_or(0, |migration| migration.version);
        return Err(WorldError::new(
            WorldErrorKind::UnsupportedSchema,
            format!(
                "SQLite World schema migration {database_version} is newer than supported schema {}",
                registry.last().map_or(0, |migration| migration.version)
            ),
        ));
    }
    Ok(applied.len())
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, TransactionBehavior};
    use workflow_protocol::WorldErrorKind;

    use super::{
        AppliedMigration, MIGRATIONS, SchemaMigration, migration_checksum, validate_history,
        validate_registry, validate_registry_slice,
    };

    const THREE_MIGRATIONS: &[SchemaMigration] = &[
        SchemaMigration {
            version: 1,
            name: "one",
            sql: "SELECT 1;",
            checksum: "sha256:17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a",
        },
        SchemaMigration {
            version: 2,
            name: "two",
            sql: "SELECT 2;",
            checksum: "sha256:8e7003d62f9d8cbd28da2f243bb0d215bfd4622c716be09be89a8764d9f4c7cb",
        },
        SchemaMigration {
            version: 3,
            name: "three",
            sql: "SELECT 3;",
            checksum: "sha256:6d51e258cb323b98bf07dd6658c78c08adaf998a8e717f85e02d9c7ce869608b",
        },
    ];

    fn applied(migration: &SchemaMigration) -> AppliedMigration {
        AppliedMigration {
            version: migration.version,
            checksum: migration.checksum.to_owned(),
        }
    }

    #[test]
    fn checked_in_registry_is_contiguous_and_nonempty() {
        validate_registry().expect("checked-in migrations should form a valid registry");
        assert_eq!(MIGRATIONS[0].version, 1);
        for migration in MIGRATIONS {
            assert_eq!(migration_checksum(migration), migration.checksum);
        }
    }

    #[test]
    fn accepts_only_a_contiguous_applied_prefix() {
        let valid = [applied(&THREE_MIGRATIONS[0]), applied(&THREE_MIGRATIONS[1])];
        assert_eq!(
            validate_history(THREE_MIGRATIONS, &valid).expect("prefix should be valid"),
            2
        );

        let gap = [applied(&THREE_MIGRATIONS[1])];
        let error = validate_history(THREE_MIGRATIONS, &gap)
            .expect_err("history beginning at version two has a gap");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);

        let internal_gap = [applied(&THREE_MIGRATIONS[0]), applied(&THREE_MIGRATIONS[2])];
        let error = validate_history(THREE_MIGRATIONS, &internal_gap)
            .expect_err("an internal history gap should be rejected");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);
        assert!(error.message().contains("contiguous prefix"));

        let future = [
            applied(&THREE_MIGRATIONS[0]),
            applied(&THREE_MIGRATIONS[1]),
            applied(&THREE_MIGRATIONS[2]),
            AppliedMigration {
                version: 4,
                checksum: "sha256:future".to_owned(),
            },
        ];
        let error = validate_history(THREE_MIGRATIONS, &future)
            .expect_err("future migration should be rejected");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);

        let known_prefix_then_future = [
            applied(&THREE_MIGRATIONS[0]),
            AppliedMigration {
                version: 2,
                checksum: "sha256:unknown-to-old-binary".to_owned(),
            },
        ];
        let error = validate_history(&THREE_MIGRATIONS[..1], &known_prefix_then_future)
            .expect_err("an old binary should report a contiguous future tail");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);
        assert!(error.message().contains("newer than supported"));

        let known_prefix_then_gap = [
            applied(&THREE_MIGRATIONS[0]),
            AppliedMigration {
                version: 3,
                checksum: "sha256:unknown-to-old-binary".to_owned(),
            },
        ];
        let error = validate_history(&THREE_MIGRATIONS[..1], &known_prefix_then_gap)
            .expect_err("a future tail must still be globally contiguous");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);
        assert!(error.message().contains("expected version 2, got 3"));
    }

    #[test]
    fn rejects_checksum_drift_and_invalid_registry_entries() {
        let drifted = [AppliedMigration {
            version: 1,
            checksum: "sha256:drifted".to_owned(),
        }];
        let error = validate_history(THREE_MIGRATIONS, &drifted)
            .expect_err("checksum drift should be rejected");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);

        let drifted_old_entry = [
            AppliedMigration {
                version: 1,
                checksum: "sha256:drifted".to_owned(),
            },
            applied(&THREE_MIGRATIONS[1]),
        ];
        let error = validate_history(THREE_MIGRATIONS, &drifted_old_entry)
            .expect_err("validation must inspect every historical checksum, not only the latest");
        assert_eq!(error.kind(), WorldErrorKind::UnsupportedSchema);

        let invalid = [SchemaMigration {
            version: 2,
            name: "invalid",
            sql: "SELECT 1;",
            checksum: "sha256:17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a",
        }];
        let error =
            validate_registry_slice(&invalid).expect_err("registry must begin with migration one");
        assert_eq!(error.kind(), WorldErrorKind::Storage);
    }

    #[test]
    fn every_checked_in_migration_stays_inside_the_runner_transaction() {
        let mut connection = Connection::open_in_memory().expect("test database should open");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("outer transaction should begin");
        for migration in MIGRATIONS {
            transaction
                .execute_batch(migration.sql)
                .unwrap_or_else(|error| {
                    panic!(
                        "migration {} ({}) should be transaction-safe: {error}",
                        migration.version, migration.name
                    )
                });
            assert!(
                !transaction.is_autocommit(),
                "migration {} must not end the outer transaction",
                migration.version
            );
        }
        transaction
            .rollback()
            .expect("validation transaction should roll back");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_runs'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("schema should remain readable"),
            0
        );
    }
}
