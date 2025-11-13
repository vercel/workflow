use std::path::PathBuf;
use std::fs;
use swc_core::ecma::{
    transforms::testing::{FixtureTestConfig, test_fixture},
    visit::visit_mut_pass,
};
use swc_workflow::{StepTransform, TransformMode};

// Normalize line endings in stderr files for Windows compatibility
// SWC's error handler on Windows outputs CRLF, but expected files have LF
// We normalize the expected file to CRLF on Windows to match the actual output
fn normalize_stderr_file(path: &PathBuf) {
    #[cfg(windows)]
    {
        if let Ok(content) = fs::read_to_string(path) {
            // Normalize: remove all CR, then add CRLF for each line
            // This handles files that might already have CRLF, LF, or mixed
            let normalized = content
                .replace("\r\n", "\n")  // First normalize CRLF to LF
                .replace("\r", "\n")     // Handle old Mac-style CR
                .replace("\n", "\r\n");  // Convert all LF to CRLF
            let _ = fs::write(path, normalized);
        }
    }
}

#[testing::fixture("tests/errors/**/input.js")]
fn step_mode(input: PathBuf) {
    let output = input.parent().unwrap().join("output-step.js");
    if !output.exists() {
        return;
    }
    let stderr_file = input.parent().unwrap().join("output-step.stderr");
    if stderr_file.exists() {
        normalize_stderr_file(&stderr_file);
    }
    test_fixture(
        Default::default(),
        // The errors occur in any mode, so it doesn't matter
        &|_| visit_mut_pass(StepTransform::new(TransformMode::Step, input.file_name().unwrap().to_string_lossy().to_string())),
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
    let output = input.parent().unwrap().join("output-workflow.js");
    if !output.exists() {
        return;
    }
    let stderr_file = input.parent().unwrap().join("output-workflow.stderr");
    if stderr_file.exists() {
        normalize_stderr_file(&stderr_file);
    }
    test_fixture(
        Default::default(),
        // The errors occur in any mode, so it doesn't matter
        &|_| visit_mut_pass(StepTransform::new(TransformMode::Workflow, input.file_name().unwrap().to_string_lossy().to_string())),
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
    let output = input.parent().unwrap().join("output-client.js");
    if !output.exists() {
        return;
    }
    let stderr_file = input.parent().unwrap().join("output-client.stderr");
    if stderr_file.exists() {
        normalize_stderr_file(&stderr_file);
    }
    test_fixture(
        Default::default(),
        // The errors occur in any mode, so it doesn't matter
        &|_| visit_mut_pass(StepTransform::new(TransformMode::Client, input.file_name().unwrap().to_string_lossy().to_string())),
        &input,
        &output,
        FixtureTestConfig {
            allow_error: true,
            module: Some(true),
            ..Default::default()
        },
    );
}
