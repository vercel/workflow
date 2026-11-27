//! Native Node binding for the SQLite World.

use napi_derive::napi;

#[napi(js_name = "createWorld")]
pub fn create_world() -> SqliteWorld {
    // Keep SDK initialization from accepting this unfinished World.
    SqliteWorld { spec_version: 0 }
}

#[napi(object)]
pub struct SqliteWorld {
    pub spec_version: u32,
}
