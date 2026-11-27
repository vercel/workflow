//! Native Node binding for the SQLite World.
//!
//! Methods call the Rust World synchronously on the JS thread, as the TS local
//! World calls `node:sqlite`.

use napi::{
    Env, Error, JsError, JsValue, Result,
    bindgen_prelude::{Buffer, JsObjectValue, ToNapiValue},
};
use napi_derive::napi;
use workflow_world_sqlite::{Config, World};

#[napi(object)]
pub struct WorldOptions {
    /// Defaults to `WORKFLOW_LOCAL_DATA_DIR`, then `.workflow-data`.
    pub data_dir: Option<String>,
}

#[napi(js_name = "createWorld")]
pub fn create_world(env: Env, options: Option<WorldOptions>) -> Result<SqliteWorld> {
    // Read the environment even when overridden, as the TS local World merges
    // its options over its environment config.
    let mut config = Config::from_env();
    if let Some(data_dir) = options.and_then(|options| options.data_dir) {
        config.data_dir = data_dir.into();
    }
    let world = World::new(config).map_err(|error| host_error(env, error))?;
    Ok(SqliteWorld { world })
}

#[napi]
pub struct SqliteWorld {
    world: World,
}

#[napi]
impl SqliteWorld {
    #[napi(getter)]
    pub fn spec_version(&self) -> u32 {
        self.world.spec_version()
    }

    /// Temporary host probe, not part of the World contract: returns a copy of
    /// `bytes` read back from SQLite.
    #[napi]
    pub fn echo(&self, env: Env, bytes: Buffer) -> Result<Buffer> {
        self.world
            .echo(&bytes)
            .map(Buffer::from)
            .map_err(|error| host_error(env, error))
    }
}

/// Converts a World failure to a JS error. SQLite failures take the shape of
/// `node:sqlite` errors, which the TS local World surfaces: `code` is
/// `ERR_SQLITE_ERROR`, with SQLite's `errcode` and `errstr`.
fn host_error(env: Env, error: workflow_world_sqlite::Error) -> Error {
    let (Some(errcode), Some(errstr)) = (error.sqlite_code(), error.sqlite_description()) else {
        return Error::from_reason(error.to_string());
    };
    let sqlite_error = || -> Result<Error> {
        let mut object = JsError::from(Error::new("ERR_SQLITE_ERROR", error.to_string()))
            .into_unknown(env)
            .coerce_to_object()?;
        object.set_named_property("errcode", errcode)?;
        object.set_named_property("errstr", errstr)?;
        Ok(object.into_unknown(&env)?.into())
    };
    sqlite_error().unwrap_or_else(|failure| failure)
}
