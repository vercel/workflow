use std::path::PathBuf;
use swc_core::ecma::{
    transforms::testing::{test_fixture, FixtureTestConfig},
    visit::visit_mut_pass,
};
use swc_workflow::{StepTransform, TransformMode};

/// Determines if a test fixture should use a package path.
/// Returns Some(package_name) for package-based-ids tests, None otherwise.
fn get_package_path(input: &PathBuf) -> Option<String> {
    let parent_name = input
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string());

    match parent_name.as_deref() {
        Some("package-based-ids") => Some("my-package".to_string()),
        _ => None,
    }
}

#[testing::fixture("tests/fixture/**/input.js")]
fn step_mode(input: PathBuf) {
    let step_output = input.parent().unwrap().join("output-step.js");
    let package_path = get_package_path(&input);
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Step,
                input.file_name().unwrap().to_string_lossy().to_string(),
                package_path.clone(),
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
    let package_path = get_package_path(&input);
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Workflow,
                input.file_name().unwrap().to_string_lossy().to_string(),
                package_path.clone(),
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
    let package_path = get_package_path(&input);
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Client,
                input.file_name().unwrap().to_string_lossy().to_string(),
                package_path.clone(),
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
