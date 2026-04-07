use serde::{Deserialize, Serialize};
use swc_common::{
    errors::{DiagnosticBuilder, Handler, HANDLER},
    sync::Lrc,
    FileName, SourceMap, GLOBALS,
};
use swc_ecma_ast::EsVersion;
use swc_ecma_codegen::{text_writer::JsWriter, Emitter};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_visit::VisitMutWith;
use swc_workflow::{StepTransform, TransformMode};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransformConfig {
    mode: TransformMode,
    #[serde(default)]
    module_specifier: Option<String>,
    #[serde(default = "default_filename")]
    filename: String,
}

fn default_filename() -> String {
    "input.ts".to_string()
}

#[derive(Serialize, Clone)]
struct TransformOutput {
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct BatchOutput {
    workflow: TransformOutput,
    step: TransformOutput,
    client: TransformOutput,
}

/// Custom emitter that silently consumes diagnostics.
///
/// The SWC transform emits errors via the HANDLER thread-local.
/// This emitter prevents the handler from panicking when diagnostics
/// are emitted — the transform still produces useful output even
/// when there are diagnostic warnings/errors.
#[derive(Default)]
struct SilentEmitter;

impl swc_common::errors::Emitter for SilentEmitter {
    fn emit(&mut self, _db: &mut DiagnosticBuilder<'_>) {
        // Silently consume diagnostics.
    }
}

fn transform_single(source: &str, config: &TransformConfig) -> TransformOutput {
    let cm: Lrc<SourceMap> = Lrc::new(SourceMap::default());
    let fm = cm.new_source_file(
        Lrc::new(FileName::Custom(config.filename.clone())),
        source.to_string(),
    );

    let handler = Handler::with_emitter(true, false, Box::new(SilentEmitter));

    GLOBALS.set(&swc_common::Globals::new(), || {
        HANDLER.set(&handler, || {
            let lexer = Lexer::new(
                Syntax::Typescript(TsSyntax {
                    tsx: true,
                    ..Default::default()
                }),
                EsVersion::Es2022,
                StringInput::from(&*fm),
                None,
            );

            let mut parser = Parser::new_from(lexer);
            let mut program = match parser.parse_program() {
                Ok(p) => p,
                Err(e) => {
                    return TransformOutput {
                        code: String::new(),
                        error: Some(format!("Parse error: {}", e.kind().msg())),
                    };
                }
            };

            // Check for additional parse errors emitted via diagnostics
            for e in parser.take_errors() {
                return TransformOutput {
                    code: String::new(),
                    error: Some(format!("Parse error: {}", e.kind().msg())),
                };
            }

            let mut visitor = StepTransform::new(
                config.mode.clone(),
                config.filename.clone(),
                config.module_specifier.clone(),
            );
            program.visit_mut_with(&mut visitor);

            let mut buf = vec![];
            {
                let writer = JsWriter::new(cm.clone(), "\n", &mut buf, None);
                let mut emitter = Emitter {
                    cfg: swc_ecma_codegen::Config::default()
                        .with_target(EsVersion::Es2022)
                        .with_minify(false),
                    cm: cm.clone(),
                    comments: None,
                    wr: writer,
                };

                if let Err(e) = emitter.emit_program(&program) {
                    return TransformOutput {
                        code: String::new(),
                        error: Some(format!("Codegen error: {}", e)),
                    };
                }
            }

            let code = String::from_utf8(buf).unwrap_or_default();
            TransformOutput { code, error: None }
        })
    })
}

/// Transform source code using the workflow SWC plugin.
///
/// `config_json` should be a JSON string like:
/// `{"mode": "workflow", "moduleSpecifier": "my-package@1.0.0", "filename": "input.ts"}`
///
/// Returns a JSON string with `{"code": "...", "error": "..."}`.
#[wasm_bindgen]
pub fn transform(source: &str, config_json: &str) -> String {
    let config: TransformConfig = match serde_json::from_str(config_json) {
        Ok(c) => c,
        Err(e) => {
            let output = TransformOutput {
                code: String::new(),
                error: Some(format!("Invalid config: {}", e)),
            };
            return serde_json::to_string(&output).unwrap();
        }
    };

    let output = transform_single(source, &config);
    serde_json::to_string(&output).unwrap()
}

/// Transform source code in all three modes at once (workflow, step, client).
///
/// `config_json` should be a JSON string like:
/// `{"moduleSpecifier": "my-package@1.0.0", "filename": "input.ts"}`
///
/// Returns a JSON string with `{"workflow": {...}, "step": {...}, "client": {...}}`.
#[wasm_bindgen(js_name = "transformAll")]
pub fn transform_all(source: &str, config_json: &str) -> String {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BatchConfig {
        #[serde(default)]
        module_specifier: Option<String>,
        #[serde(default = "default_filename")]
        filename: String,
    }

    let batch_config: BatchConfig = match serde_json::from_str(config_json) {
        Ok(c) => c,
        Err(e) => {
            let error_output = TransformOutput {
                code: String::new(),
                error: Some(format!("Invalid config: {}", e)),
            };
            let output = BatchOutput {
                workflow: error_output.clone(),
                step: error_output.clone(),
                client: error_output,
            };
            return serde_json::to_string(&output).unwrap();
        }
    };

    let modes = [
        TransformMode::Workflow,
        TransformMode::Step,
        TransformMode::Client,
    ];
    let mut results = Vec::with_capacity(3);

    for mode in &modes {
        let config = TransformConfig {
            mode: mode.clone(),
            module_specifier: batch_config.module_specifier.clone(),
            filename: batch_config.filename.clone(),
        };
        results.push(transform_single(source, &config));
    }

    let output = BatchOutput {
        workflow: results.remove(0),
        step: results.remove(0),
        client: results.remove(0),
    };

    serde_json::to_string(&output).unwrap()
}
