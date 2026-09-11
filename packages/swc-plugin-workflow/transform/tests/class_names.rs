use std::process::Command;
use swc_core::ecma::{transforms::testing::Tester, visit::visit_mut_pass};
use swc_workflow::{StepTransform, TransformMode};

fn assert_class_names(mode: TransformMode) {
    for members in [
        r#"async run() { 'use step'; return 42; }"#,
        r#"
        static [Symbol.for('workflow-serialize')](instance) { return {}; }
        static [Symbol.for('workflow-deserialize')](data) { return new this(); }
        "#,
    ] {
        let source = r#"
            import assert from 'node:assert/strict';

            globalThis[Symbol.for('WORKFLOW_USE_STEP')] = () => function proxy() {};

            var C = class { static initialName = this.name; __MEMBERS__ };
            let LetClass = class { __MEMBERS__ };
            const ConstClass = class { __MEMBERS__ };
            var Alpha = class { __MEMBERS__ }, Beta = class { __MEMBERS__ };
            var Parenthesized = (class { __MEMBERS__ });
            let Assigned;
            Assigned = class { __MEMBERS__ };
            var Explicit = class InternalName { __MEMBERS__ };
            const objects = {
                Key: class { __MEMBERS__ },
                'key-with-dashes': class { __MEMBERS__ },
            };
            const array = [class { __MEMBERS__ }];
            const conditional = true ? class { __MEMBERS__ } : null;
            function capture(value) { return value; }
            const argument = capture(class { __MEMBERS__ });

            const classes = [
                [C, 'C'],
                [LetClass, 'LetClass'],
                [ConstClass, 'ConstClass'],
                [Alpha, 'Alpha'],
                [Beta, 'Beta'],
                [Parenthesized, 'Parenthesized'],
                [Assigned, 'Assigned'],
                [Explicit, 'InternalName'],
                [objects.Key, 'Key'],
                [objects['key-with-dashes'], 'key-with-dashes'],
                [array[0], ''],
                [conditional, ''],
                [argument, ''],
            ];
            assert.equal(C.initialName, 'C');
            for (const [cls, name] of classes) {
                assert.equal(cls.name, name);
                assert.deepEqual(Object.getOwnPropertyDescriptor(cls, 'name'), {
                    value: name,
                    writable: false,
                    enumerable: false,
                    configurable: true,
                });
            }
        "#
        .replace("__MEMBERS__", members);

        let code = Tester::run(|tester| {
            let program = tester.apply_transform(
                visit_mut_pass(StepTransform::new(mode.clone(), "input.js".into(), None)),
                "input.js",
                Default::default(),
                Some(true),
                &source,
            )?;
            Ok(tester.print(&program, &tester.comments.clone()))
        });

        // Execute both the original and freshly transformed source, rather
        // than relying on snapshots of the generated class identifiers.
        let registered = format!(
            r#"{code}
            const registry = globalThis[Symbol.for('workflow-class-registry')];
            for (const [cls] of classes) {{
                assert.equal(typeof cls.classId, 'string');
                assert.equal(registry.get(cls.classId), cls);
            }}
            "#
        );
        for (label, code) in [("original", &source), ("transformed", &registered)] {
            let output = Command::new("node")
                .args(["--input-type=module", "--eval", code])
                .output()
                .expect("Node.js is required for class-name runtime tests");
            assert!(
                output.status.success(),
                "{label} {mode:?}: {}\n{code}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

#[test]
fn inferred_class_names_step_mode() {
    assert_class_names(TransformMode::Step);
}

#[test]
fn inferred_class_names_workflow_mode() {
    assert_class_names(TransformMode::Workflow);
}

/// Running the transform a second time over its own output must not crash,
/// even though `classId` is defined non-configurable.
///
/// Regression test for a real npm package (`@ai-sdk/gateway`'s
/// `GatewayLanguageModel`) that pairs a named class expression with a
/// self-reference through its *inner* name:
/// `var Foo = class _Foo { static [WORKFLOW_DESERIALIZE]() { return new
/// _Foo(); } }`. A bundler pipeline that re-runs this transform over its own
/// output for the same module (observed with a Vite/Nitro SSR build, where a
/// dependency is reached through more than one build stage) transforms an
/// already-wrapped class a second time. The first pass resolves the class's
/// name from its *binding* (`Foo`), matching `class-expression-binding-name`;
/// on the second pass the class is no longer a bare initializer (it is now
/// wrapped in the first pass's registration IIFE), so the binding name is
/// unavailable and the second pass falls back to the class expression's own
/// inner name (`_Foo`) instead, nesting a second `Object.defineProperty`
/// call for `classId` inside the first. Before the fix in
/// `class_registration_stmts`, that second, unguarded call threw "Cannot
/// redefine property: classId" at module load, crashing the bundle.
#[test]
fn repeated_transform_of_named_class_expression_does_not_crash() {
    let source = r#"
        var GatewayLanguageModel = class _GatewayLanguageModel {
          constructor(modelId) {
            this.modelId = modelId;
          }
          static [Symbol.for('workflow-serialize')](model) {
            return { modelId: model.modelId };
          }
          static [Symbol.for('workflow-deserialize')](options) {
            return new _GatewayLanguageModel(options.modelId);
          }
        };

        export { GatewayLanguageModel };
    "#
    .to_string();

    let transform_once = |source: &str| {
        Tester::run(|tester| {
            let program = tester.apply_transform(
                visit_mut_pass(StepTransform::new(
                    TransformMode::Step,
                    "input.js".into(),
                    None,
                )),
                "input.js",
                Default::default(),
                Some(true),
                source,
            )?;
            Ok(tester.print(&program, &tester.comments.clone()))
        })
    };

    let pass1 = transform_once(&source);
    // The bug only manifests on a second pass over already-transformed code:
    // confirm pass 1 alone is unaffected before layering pass 2 on top of it.
    let pass1_check = format!(
        r#"{pass1}
        import assert from 'node:assert/strict';
        assert.equal(typeof GatewayLanguageModel.classId, 'string');
        "#
    );
    let output = Command::new("node")
        .args(["--input-type=module", "--eval", &pass1_check])
        .output()
        .expect("Node.js is required for class-name runtime tests");
    assert!(
        output.status.success(),
        "pass 1 alone: {}\n{pass1_check}",
        String::from_utf8_lossy(&output.stderr)
    );

    let pass2 = transform_once(&pass1);
    let pass2_check = format!(
        r#"{pass2}
        import assert from 'node:assert/strict';
        const registry = globalThis[Symbol.for('workflow-class-registry')];
        assert.equal(typeof GatewayLanguageModel.classId, 'string');
        assert.equal(registry.get(GatewayLanguageModel.classId), GatewayLanguageModel);
        "#
    );
    let output = Command::new("node")
        .args(["--input-type=module", "--eval", &pass2_check])
        .output()
        .expect("Node.js is required for class-name runtime tests");
    assert!(
        output.status.success(),
        "pass 2 (re-transforming pass 1's output): {}\n{pass2_check}",
        String::from_utf8_lossy(&output.stderr)
    );
}
