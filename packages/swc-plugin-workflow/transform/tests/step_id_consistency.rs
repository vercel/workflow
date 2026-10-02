//! Step and workflow mode must agree on every step's ID: workflow mode looks a
//! step up by the ID that step mode registered for the same function body.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};
use swc_core::{
    common::errors::HANDLER,
    ecma::{
        ast::{EsVersion, Program},
        visit::VisitMutWith,
    },
};
use swc_ecma_parser::{Syntax, parse_file_as_module};
use swc_workflow::{StepTransform, TransformMode};

const LOOKUP: &str = "WORKFLOW_USE_STEP\")](\"";

/// String literals starting with `step//`, ignoring the manifest comment.
fn step_id_literals(code: &str) -> BTreeSet<String> {
    code.lines()
        .filter(|line| !line.starts_with("/**__internal_workflows"))
        .flat_map(|line| line.split('"').skip(1).step_by(2))
        .filter(|literal| literal.starts_with("step//"))
        .map(str::to_string)
        .collect()
}

fn lookups(code: &str) -> BTreeSet<String> {
    code.match_indices(LOOKUP)
        .filter_map(|(at, _)| {
            let rest = &code[at + LOOKUP.len()..];
            rest.split('"').next().map(str::to_string)
        })
        .filter(|id| id.starts_with("step//"))
        .collect()
}

#[testing::fixture("tests/fixture/**/input.js")]
#[testing::fixture("tests/fixture/**/input.ts")]
fn workflow_lookups_are_registered(input: PathBuf) {
    let dir = input.parent().unwrap();
    let step = fs::read_to_string(dir.join("output-step.js")).unwrap();
    let workflow = fs::read_to_string(dir.join("output-workflow.js")).unwrap();

    let registered = step_id_literals(&step);
    let unregistered: Vec<_> = lookups(&workflow)
        .into_iter()
        .filter(|id| !registered.contains(id))
        .collect();
    assert!(
        unregistered.is_empty(),
        "{}: workflow mode looks up step IDs that step mode never registers: {:?}",
        dir.display(),
        unregistered
    );
}

/// Run `mode` over `input` and return the step name it assigned to each source
/// span (only for steps whose names may get a `~N` suffix).
fn step_name_assignments(input: &PathBuf, mode: TransformMode) -> BTreeMap<(u32, u32), String> {
    testing::run_test(false, |cm, handler| {
        let fm = cm.load_file(input).unwrap();
        let syntax = match input.extension().and_then(|e| e.to_str()) {
            Some("ts") | Some("tsx") => Syntax::Typescript(Default::default()),
            _ => Default::default(),
        };
        let module =
            parse_file_as_module(&fm, syntax, EsVersion::latest(), None, &mut vec![]).unwrap();
        // Visit a `Program`, as the plugin does: workflow mode takes step mode's
        // names in `visit_mut_program`.
        let mut program = Program::Module(module);
        let mut transform = StepTransform::new(
            mode,
            input.file_name().unwrap().to_string_lossy().to_string(),
            None,
        );
        HANDLER.set(handler, || program.visit_mut_with(&mut transform));
        Ok(transform
            .step_name_assignments()
            .iter()
            .map(|(lo, hi, name)| ((*lo, *hi), name.clone()))
            .collect())
    })
    .unwrap()
}

/// The same function body must get the same step name in both modes. Checking
/// only that every looked-up ID is registered would miss two bodies whose IDs
/// are swapped between the modes. Step mode also names steps that workflow
/// mode never sees (e.g. steps nested in a step body), so only the steps
/// workflow mode names are compared.
#[testing::fixture("tests/fixture/**/input.js")]
#[testing::fixture("tests/fixture/**/input.ts")]
fn modes_assign_same_step_names(input: PathBuf) {
    let step = step_name_assignments(&input, TransformMode::Step);
    let workflow = step_name_assignments(&input, TransformMode::Workflow);
    let mismatched: Vec<_> = workflow
        .iter()
        .filter(|(span, name)| step.get(*span) != Some(*name))
        .map(|(span, name)| (span, name, step.get(span)))
        .collect();
    assert!(
        mismatched.is_empty(),
        "{}: workflow mode names differ from step mode's for the same source spans \
         (span, workflow name, step name): {:?}",
        input.display(),
        mismatched
    );
}
