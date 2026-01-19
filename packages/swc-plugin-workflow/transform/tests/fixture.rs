use std::path::PathBuf;
use swc_core::ecma::{
    transforms::testing::{FixtureTestConfig, test_fixture},
    visit::visit_mut_pass,
};
use swc_workflow::{StepTransform, TransformMode};

#[testing::fixture("tests/fixture/**/input.js")]
fn step_mode(input: PathBuf) {
    let step_output = input.parent().unwrap().join("output-step.js");
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Step,
                input.file_name().unwrap().to_string_lossy().to_string(),
            ))
        },
        &input,
        &step_output,
        FixtureTestConfig {
            module: Some(true),
            ..Default::default()
        },
    );
}

#[testing::fixture("tests/fixture/**/input.js")]
fn workflow_mode(input: PathBuf) {
    let workflow_output = input.parent().unwrap().join("output-workflow.js");
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Workflow,
                input.file_name().unwrap().to_string_lossy().to_string(),
            ))
        },
        &input,
        &workflow_output,
        FixtureTestConfig {
            module: Some(true),
            ..Default::default()
        },
    );
}

#[testing::fixture("tests/fixture/**/input.js")]
fn client_mode(input: PathBuf) {
    let client_output = input.parent().unwrap().join("output-client.js");
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Client,
                input.file_name().unwrap().to_string_lossy().to_string(),
            ))
        },
        &input,
        &client_output,
        FixtureTestConfig {
            module: Some(true),
            ..Default::default()
        },
    );
}
