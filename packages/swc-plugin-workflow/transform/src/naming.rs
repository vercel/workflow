use std::fmt::Display;

/// Format a name using a module specifier and identifier.
///
/// The module_path should be either:
/// - A package specifier like "point@0.0.1" or "@myorg/shared@1.2.3"
/// - A relative path like "./src/models/Point"
///
/// TODO: we should have a `Entity` enum with `Workflow` and `Step` instead of a string `prefix`.
pub fn format_name(prefix: &str, module_path: &str, identifier: impl Display) -> String {
    format!("{prefix}//{module_path}//{identifier}")
}

/// Get the module path to use for ID generation.
///
/// If a module_specifier is provided, use it directly.
/// Otherwise, convert the filepath to a relative path format (prefixed with "./").
///
/// The filepath should already be normalized (forward slashes, relative to project root).
pub fn get_module_path(module_specifier: Option<&str>, filepath: &str) -> String {
    match module_specifier {
        Some(specifier) => specifier.to_string(),
        None => {
            // Strip file extension for cleaner IDs
            let path_without_ext = strip_extension(filepath);
            format!("./{}", path_without_ext)
        }
    }
}

/// Strip common JS/TS file extensions from a path.
fn strip_extension(path: &str) -> &str {
    // Order matters: check longer extensions first
    const EXTENSIONS: &[&str] = &[
        ".d.ts", ".d.mts", ".d.cts", ".tsx", ".jsx", ".mts", ".cts", ".ts", ".js", ".mjs", ".cjs",
    ];

    for ext in EXTENSIONS {
        if let Some(stripped) = path.strip_suffix(ext) {
            return stripped;
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests for format_name
    #[test]
    fn test_format_name_with_package_specifier() {
        let result = format_name("class", "point@0.0.1", "Point");
        assert_eq!(result, "class//point@0.0.1//Point");
    }

    #[test]
    fn test_format_name_with_scoped_package() {
        let result = format_name("class", "@myorg/shared@1.2.3", "Point");
        assert_eq!(result, "class//@myorg/shared@1.2.3//Point");
    }

    #[test]
    fn test_format_name_with_relative_path() {
        let result = format_name("workflow", "./src/workflows/order", "handleOrder");
        assert_eq!(result, "workflow//./src/workflows/order//handleOrder");
    }

    #[test]
    fn test_format_name_line_number() {
        let result = format_name("workflow", "./src/index", 42);
        assert_eq!(result, "workflow//./src/index//42");
    }

    #[test]
    fn test_format_name_builtin() {
        let result = format_name("step", "builtin", "__builtin_fetch");
        assert_eq!(result, "step//builtin//__builtin_fetch");
    }

    // Tests for get_module_path
    #[test]
    fn test_get_module_path_with_specifier() {
        let result = get_module_path(Some("point@0.0.1"), "node_modules/point/dist/index.js");
        assert_eq!(result, "point@0.0.1");
    }

    #[test]
    fn test_get_module_path_with_scoped_specifier() {
        let result = get_module_path(
            Some("@myorg/shared@1.2.3"),
            "node_modules/@myorg/shared/dist/index.js",
        );
        assert_eq!(result, "@myorg/shared@1.2.3");
    }

    #[test]
    fn test_get_module_path_without_specifier_ts() {
        let result = get_module_path(None, "src/models/Point.ts");
        assert_eq!(result, "./src/models/Point");
    }

    #[test]
    fn test_get_module_path_without_specifier_tsx() {
        let result = get_module_path(None, "src/components/Button.tsx");
        assert_eq!(result, "./src/components/Button");
    }

    #[test]
    fn test_get_module_path_without_specifier_js() {
        let result = get_module_path(None, "lib/utils.js");
        assert_eq!(result, "./lib/utils");
    }

    #[test]
    fn test_get_module_path_without_specifier_dts() {
        let result = get_module_path(None, "types/index.d.ts");
        assert_eq!(result, "./types/index");
    }

    #[test]
    fn test_get_module_path_without_specifier_mjs() {
        let result = get_module_path(None, "lib/esm/index.mjs");
        assert_eq!(result, "./lib/esm/index");
    }

    // Tests for strip_extension
    #[test]
    fn test_strip_extension_ts() {
        assert_eq!(strip_extension("foo.ts"), "foo");
    }

    #[test]
    fn test_strip_extension_tsx() {
        assert_eq!(strip_extension("foo.tsx"), "foo");
    }

    #[test]
    fn test_strip_extension_dts() {
        assert_eq!(strip_extension("foo.d.ts"), "foo");
    }

    #[test]
    fn test_strip_extension_no_ext() {
        assert_eq!(strip_extension("foo"), "foo");
    }

    #[test]
    fn test_strip_extension_unknown_ext() {
        assert_eq!(strip_extension("foo.css"), "foo.css");
    }

    // Legacy tests (updated to use new format)
    #[test]
    fn test_format_name_unix_path() {
        let module_path = get_module_path(None, "src/workflows/order.ts");
        let result = format_name("workflow", &module_path, "handleOrder");
        assert_eq!(result, "workflow//./src/workflows/order//handleOrder");
    }

    #[test]
    fn test_format_name_with_forward_slashes() {
        let module_path = get_module_path(None, "app/api/route.ts");
        let result = format_name("step", &module_path, "processStep");
        assert_eq!(result, "step//./app/api/route//processStep");
    }
}
