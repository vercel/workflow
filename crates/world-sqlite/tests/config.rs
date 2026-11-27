//! Environment defaults. Cargo runs this file as its own process, so the
//! once-per-process environment read starts fresh here.

use std::{env, path::Path};

use workflow_world_sqlite::Config;

// @lat: [[world-sqlite#Rust crate#Configuration#Environment]]
#[test]
fn from_env_reads_the_environment_once_per_process() {
    // SAFETY: this binary's only test runs here, and no other thread reads or
    // writes the environment meanwhile.
    unsafe { env::set_var("WORKFLOW_LOCAL_DATA_DIR", "environment") };
    assert_eq!(Config::from_env().data_dir, Path::new("environment"));
    // SAFETY: as above.
    unsafe { env::set_var("WORKFLOW_LOCAL_DATA_DIR", "changed") };
    assert_eq!(Config::from_env().data_dir, Path::new("environment"));
}
