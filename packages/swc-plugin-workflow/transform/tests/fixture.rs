use std::path::PathBuf;
use swc_core::ecma::{
    transforms::testing::{test_fixture, FixtureTestConfig},
    visit::visit_mut_pass,
};
use swc_ecma_parser::Syntax;
use swc_workflow::{StepTransform, TransformMode};

fn syntax_for(input: &PathBuf) -> Syntax {
    match input.extension().and_then(|e| e.to_str()) {
        Some("ts") | Some("tsx") => Syntax::Typescript(Default::default()),
        _ => Default::default(),
    }
}

#[testing::fixture("tests/fixture/**/input.js")]
#[testing::fixture("tests/fixture/**/input.ts")]
fn step_mode(input: PathBuf) {
    let step_output = input.parent().unwrap().join("output-step.js");
    test_fixture(
        syntax_for(&input),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Step,
                input.file_name().unwrap().to_string_lossy().to_string(),
                None,
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
#[testing::fixture("tests/fixture/**/input.ts")]
fn workflow_mode(input: PathBuf) {
    let workflow_output = input.parent().unwrap().join("output-workflow.js");
    test_fixture(
        syntax_for(&input),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Workflow,
                input.file_name().unwrap().to_string_lossy().to_string(),
                None,
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
