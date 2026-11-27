use std::{env, path::PathBuf, sync::OnceLock};

/// Configuration for a [`World`](crate::World).
#[non_exhaustive]
pub struct Config {
    /// The data directory, which holds the database file.
    pub data_dir: PathBuf,
}

impl Config {
    /// The defaults, from the environment as in the TS local World's config:
    /// `WORKFLOW_LOCAL_DATA_DIR || '.workflow-data'`, read once per process.
    pub fn from_env() -> Self {
        static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
        let data_dir = DATA_DIR.get_or_init(|| {
            env::var_os("WORKFLOW_LOCAL_DATA_DIR")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| ".workflow-data".into())
                .into()
        });
        Self {
            data_dir: data_dir.clone(),
        }
    }
}
