#![allow(clippy::not_unsafe_ptr_arg_deref)]

use serde::Deserialize;
use std::path::Path;
use swc_core::{
    ecma::{ast::*, visit::*},
    plugin::{plugin_transform, proxies::TransformPluginProgramMetadata},
};
use swc_workflow::{StepTransform, TransformMode};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmConfig {
    mode: TransformMode,
}

#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let plugin_config: WasmConfig = serde_json::from_str(
        &metadata
            .get_transform_plugin_config()
            .expect("failed to get plugin config for workflow transform"),
    )
    .expect("Should provide plugin config");

    let filename = metadata
        .get_context(&swc_core::plugin::metadata::TransformPluginMetadataContextKind::Filename)
        .unwrap_or_else(|| "unknown".to_string());

    // Try to get cwd and make the path relative
    let cwd = metadata.get_context(&swc_core::plugin::metadata::TransformPluginMetadataContextKind::Cwd);

    let relative_filename = if let Some(cwd) = cwd {
        let cwd_norm = normalize_path(&cwd);
        let filename_norm = normalize_path(&filename);

        relativize(&cwd_norm, &filename_norm)
            .and_then(|relative| {
                if relative.is_empty() {
                    None
                } else {
                    Some(relative)
                }
            })
            .unwrap_or_else(|| {
                let cwd_path = Path::new(&cwd);
                let file_path = Path::new(&filename);

                if let Ok(relative) = file_path.strip_prefix(cwd_path) {
                    relative.to_string_lossy().to_string()
                } else {
                    let cwd_components: Vec<_> = cwd_path.components().collect();
                    let file_components: Vec<_> = file_path.components().collect();

                    let common_len = cwd_components
                        .iter()
                        .zip(file_components.iter())
                        .take_while(|(a, b)| a == b)
                        .count();

                    if common_len > 0 {
                        let remaining_file: Vec<_> = file_components.into_iter().skip(common_len).collect();
                        let relative_path = remaining_file.into_iter().collect::<std::path::PathBuf>();
                        relative_path.to_string_lossy().to_string()
                    } else {
                        filename_norm.clone()
                    }
                }
            })
    } else {
        normalize_path(&filename)
    };

    debug_log(&format!(
        "filename={} relative_filename={}",
        filename, relative_filename
    ));

    // Normalize path separators to forward slashes for consistent workflow IDs across platforms
    let normalized_filename = relative_filename.replace('\\', "/");
    
    let mut visitor = StepTransform::new(plugin_config.mode, normalized_filename);
    program.visit_mut_with(&mut visitor);
    program
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        if let Some(first) = normalized.chars().next() {
            let upper = first.to_ascii_uppercase();
            normalized.replace_range(0..1, &upper.to_string());
        }
    }
    normalized
}

fn relativize(cwd: &str, file: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }

    let cwd_segments: Vec<_> = cwd.trim_end_matches('/').split('/').collect();
    let file_segments: Vec<_> = file.split('/').collect();

    if file_segments.is_empty() {
        return Some(String::new());
    }

    let mut index = 0;
    while index < cwd_segments.len() && index < file_segments.len() {
        if cwd_segments[index] != file_segments[index] {
            break;
        }
        index += 1;
    }

    if index == 0 {
        return None;
    }

    let remaining = file_segments[index..].join("/");
    Some(remaining)
}

fn debug_log(message: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::fs::OpenOptions;
        use std::io::Write;

        if let Some(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("workflow_swc_plugin_debug.log"))
            .ok()
        {
            let _ = writeln!(file, "{message}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_drive_letter_uppercase() {
        #[cfg(target_os = "windows")]
        {
            let input = "c:/Users/example/project";
            let normalized = normalize_path(input);
            assert!(normalized.starts_with("C:"));
            assert_eq!(normalized.replace('\\', "/"), normalized);
        }

        #[cfg(not(target_os = "windows"))]
        {
            let input = "c:/Users/example/project";
            let normalized = normalize_path(input);
            assert_eq!(normalized, input);
        }
    }

    #[test]
    fn posix_paths_unchanged() {
        let input = "/Users/example/project";
        let normalized = normalize_path(input);
        assert_eq!(normalized, input);
    }
}