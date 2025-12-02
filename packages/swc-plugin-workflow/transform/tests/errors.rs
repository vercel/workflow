use std::path::PathBuf;
use swc_core::ecma::{
    transforms::testing::{FixtureTestConfig, test_fixture},
    visit::visit_mut_pass,
};
use swc_workflow::{StepTransform, TransformMode};

#[testing::fixture("tests/errors/**/input.js")]
fn step_mode(input: PathBuf) {
    let output = input.parent().unwrap().join("output-step.js");
    if !output.exists() {
        return;
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

#[testing::fixture("tests/errors/**/input.js")]
fn browser_mode(input: PathBuf) {
    // Browser mode error tests only run when there's an explicit browser output file
    let browser_output = input.parent().unwrap().join("output-browser.js");
    if !browser_output.exists() {
        return;
    }
    test_fixture(
        Default::default(),
        &|_| visit_mut_pass(StepTransform::new(TransformMode::Browser, input.file_name().unwrap().to_string_lossy().to_string())),
        &input,
        &browser_output,
        FixtureTestConfig {
            allow_error: true,
            module: Some(true),
            ..Default::default()
        },
    );
}
