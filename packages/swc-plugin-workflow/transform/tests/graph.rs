use std::path::PathBuf;
use swc_core::ecma::{
    transforms::testing::{FixtureTestConfig, test_fixture},
    visit::visit_mut_pass,
};
use swc_workflow::{StepTransform, TransformMode};

#[testing::fixture("tests/graph/**/input.js")]
fn graph_mode(input: PathBuf) {
    let graph_output = input.parent().unwrap().join("output-graph.js");
    test_fixture(
        Default::default(),
        &|_| {
            visit_mut_pass(StepTransform::new(
                TransformMode::Graph,
                input.file_name().unwrap().to_string_lossy().to_string(),
                None,
            ))
        },
        &input,
        &graph_output,
        FixtureTestConfig {
            module: Some(true),
            ..Default::default()
        },
    );
}
