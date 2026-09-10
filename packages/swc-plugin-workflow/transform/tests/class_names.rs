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
