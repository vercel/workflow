//! Functional tests of the public World API.

use std::{error::Error, path::Path};

use workflow_world_sqlite::{Config, World};

type TestResult = Result<(), Box<dyn Error>>;

fn world_at(data_dir: &Path) -> workflow_world_sqlite::Result<World> {
    let mut config = Config::from_env();
    config.data_dir = data_dir.into();
    World::new(config)
}

// @lat: [[world-sqlite#Rust crate#Configuration]]
#[test]
fn new_is_lazy_and_uses_world_db_in_the_data_directory() -> TestResult {
    let directory = tempfile::tempdir()?;
    let data_dir = directory.path().join("data");
    let world = world_at(&data_dir)?;
    assert!(!data_dir.exists());
    world.echo(b"")?;
    assert!(data_dir.join("world.db").is_file());
    Ok(())
}

// @lat: [[world-sqlite#Host probe]]
#[test]
fn echo_round_trips_binary_values() -> TestResult {
    let directory = tempfile::tempdir()?;
    let world = world_at(directory.path())?;
    // Empty, NUL-containing and non-UTF-8 values must all stay BLOBs.
    for bytes in [&b""[..], &[0, 1, 0, 255, 254][..], &[7; 100_000][..]] {
        assert_eq!(world.echo(bytes)?, bytes);
    }
    Ok(())
}

// @lat: [[world-sqlite#Rust crate#Errors]]
#[test]
fn sqlite_failures_expose_sqlite_result_codes() -> TestResult {
    let directory = tempfile::tempdir()?;
    std::fs::write(directory.path().join("world.db"), [b'x'; 1024])?;
    let error = world_at(directory.path())?.echo(b"").unwrap_err();
    // SQLITE_NOTADB defines no extended codes, so it is the same everywhere.
    assert_eq!(error.sqlite_code(), Some(26));
    assert_eq!(error.sqlite_description(), Some("file is not a database"));
    // Hosts match SQLite's own text at the start of the message.
    assert!(error.to_string().starts_with("file is not a database"));
    Ok(())
}

// Holds no state yet; guards connection sharing against keeping a failed open.
#[test]
fn failures_are_not_cached() -> TestResult {
    let directory = tempfile::tempdir()?;
    let data_dir = directory.path().join("blocked");
    std::fs::write(&data_dir, b"not a directory")?;
    let world = world_at(&data_dir)?;
    let error = world.echo(b"").unwrap_err();
    assert_eq!(error.sqlite_code(), None);
    std::fs::remove_file(&data_dir)?;
    world.echo(b"")?;
    Ok(())
}
