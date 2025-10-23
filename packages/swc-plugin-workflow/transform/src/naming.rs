use std::fmt::Display;

/// Format a name, filepath, and function name.
///
/// TODO: we should have a `Entity` enum with `Workflow` and `Step` instead of a string `prefix`.
pub fn format_name(prefix: &str, filepath: &str, function_name: impl Display) -> String {
    format!("{prefix}//{filepath}//{function_name}")
}
