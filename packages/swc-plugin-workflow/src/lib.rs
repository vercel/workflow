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
    let cwd =
        metadata.get_context(&swc_core::plugin::metadata::TransformPluginMetadataContextKind::Cwd);

    let relative_filename = if let Some(cwd) = cwd {
        let cwd_path = Path::new(&cwd);
        let file_path = Path::new(&filename);

        // Try to strip the cwd prefix to make it relative
        if let Ok(relative) = file_path.strip_prefix(cwd_path) {
            relative.to_string_lossy().to_string()
        } else {
            // Find common ancestor path
            let cwd_components: Vec<_> = cwd_path.components().collect();
            let file_components: Vec<_> = file_path.components().collect();

            // Find the longest common prefix
            let common_len = cwd_components
                .iter()
                .zip(file_components.iter())
                .take_while(|(a, b)| a == b)
                .count();

            if common_len > 0 {
                // Build relative path from the common ancestor
                let remaining_file: Vec<_> = file_components.into_iter().skip(common_len).collect();
                let relative_path = remaining_file.into_iter().collect::<std::path::PathBuf>();
                relative_path.to_string_lossy().to_string()
            } else {
                filename
            }
        }
    } else {
        filename
    };

    // Normalize path separators to forward slashes for consistent workflow IDs across platforms
    let normalized_filename = relative_filename.replace('\\', "/");

    let mut visitor = StepTransform::new(plugin_config.mode, normalized_filename);
    program.visit_mut_with(&mut visitor);
    program
}
