use std::fmt::Display;

/// Format a name, filepath, and function name.
///
/// TODO: we should have a `Entity` enum with `Workflow` and `Step` instead of a string `prefix`.
pub fn format_name(prefix: &str, filepath: &str, function_name: impl Display) -> String {
    format!("{prefix}//{filepath}//{function_name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_name_unix_path() {
        let result = format_name("workflow", "src/workflows/order.ts", "handleOrder");
        assert_eq!(result, "workflow//src/workflows/order.ts//handleOrder");
    }

    #[test]
    fn test_format_name_with_forward_slashes() {
        let result = format_name("step", "app/api/route.ts", "processStep");
        assert_eq!(result, "step//app/api/route.ts//processStep");
    }

    #[test]
    fn test_format_name_line_number() {
        let result = format_name("workflow", "src/index.ts", 42);
        assert_eq!(result, "workflow//src/index.ts//42");
    }

    #[test]
    fn test_format_name_builtin() {
        let result = format_name("step", "builtin", "__builtin_fetch");
        assert_eq!(result, "step//builtin//__builtin_fetch");
    }
}
