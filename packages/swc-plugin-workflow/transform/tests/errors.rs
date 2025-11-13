#[cfg(windows)]
use std::fs;
use std::path::PathBuf;
#[cfg(windows)]
use std::sync::Once;
use swc_core::ecma::{
    transforms::testing::{FixtureTestConfig, test_fixture},
    visit::visit_mut_pass,
};
use swc_workflow::{StepTransform, TransformMode};

// Normalize line endings in stderr files for Windows compatibility
// SWC's error handler on Windows outputs CRLF, but expected files have LF
// We normalize all expected files once at test startup to match Windows output
#[cfg(windows)]
static NORMALIZE_STDERR_FILES: Once = Once::new();

fn normalize_stderr_files() {
    #[cfg(windows)]
    {
        NORMALIZE_STDERR_FILES.call_once(|| {
            // Use env! to get the manifest directory at compile time
            // This ensures we have the correct path regardless of where the test runs from
            let manifest_dir = env!("CARGO_MANIFEST_DIR");
            let test_dir = PathBuf::from(manifest_dir).join("tests/errors");
            if let Ok(entries) = fs::read_dir(&test_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        // Look for .stderr files in subdirectories
                        if let Ok(sub_entries) = fs::read_dir(&path) {
                            for sub_entry in sub_entries.flatten() {
                                let sub_path = sub_entry.path();
                                if sub_path.extension().and_then(|s| s.to_str()) == Some("stderr") {
                                    if let Ok(content) = fs::read_to_string(&sub_path) {
                                        // Normalize: remove all CR, then add CRLF for each line
                                        let normalized = content
                                            .replace("\r\n", "\n") // First normalize CRLF to LF
                                            .replace("\r", "\n") // Handle old Mac-style CR
                                            .replace("\n", "\r\n"); // Convert all LF to CRLF
                                        let _ = fs::write(&sub_path, normalized);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
    }
}

#[testing::fixture("tests/errors/**/input.js")]
fn step_mode(input: PathBuf) {
    normalize_stderr_files();
    let output = input.parent().unwrap().join("output-step.js");
    if !output.exists() {
        return;
    }
    test_fixture(
        Default::default(),
        // The errors occur in any mode, so it doesn't matter
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Step,
                input.file_name().unwrap().to_string_lossy().to_string(),
            ))
        },
        &input,
        &output,
        FixtureTestConfig {
            allow_error: true,
            module: Some(true),
            ..Default::default()
        },
    );
}

#[testing::fixture("tests/errors/**/input.js")]
fn workflow_mode(input: PathBuf) {
    normalize_stderr_files();
    let output = input.parent().unwrap().join("output-workflow.js");
    if !output.exists() {
        return;
    }
    test_fixture(
        Default::default(),
        // The errors occur in any mode, so it doesn't matter
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Workflow,
                input.file_name().unwrap().to_string_lossy().to_string(),
            ))
        },
        &input,
        &output,
        FixtureTestConfig {
            allow_error: true,
            module: Some(true),
            ..Default::default()
        },
    );
}

#[testing::fixture("tests/errors/**/input.js")]
fn client_mode(input: PathBuf) {
    normalize_stderr_files();
    let output = input.parent().unwrap().join("output-client.js");
    if !output.exists() {
        return;
    }
    test_fixture(
        Default::default(),
        // The errors occur in any mode, so it doesn't matter
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Client,
                input.file_name().unwrap().to_string_lossy().to_string(),
            ))
        },
        &input,
        &output,
        FixtureTestConfig {
            allow_error: true,
            module: Some(true),
            ..Default::default()
        },
    );
}
