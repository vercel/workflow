mod naming;

use serde::Deserialize;
use std::collections::HashSet;
use swc_core::{
    common::{DUMMY_SP, SyntaxContext, errors::HANDLER},
    ecma::{
        ast::*,
        visit::{VisitMut, VisitMutWith, noop_visit_mut_type},
    },
};

#[derive(Debug, Clone)]
enum WorkflowErrorKind {
    NonAsyncFunction {
        span: swc_core::common::Span,
        directive: &'static str,
    },
    MisplacedDirective {
        span: swc_core::common::Span,
        directive: String,
        location: DirectiveLocation,
    },
    MisspelledDirective {
        span: swc_core::common::Span,
        directive: String,
        expected: &'static str,
    },
    ForbiddenExpression {
        span: swc_core::common::Span,
        expr: &'static str,
        directive: &'static str,
    },
    InvalidExport {
        span: swc_core::common::Span,
        directive: &'static str,
    },
}

#[derive(Debug, Clone)]
enum DirectiveLocation {
    Module,
    FunctionBody,
}

fn emit_error(error: WorkflowErrorKind) {
    let (span, msg) = match error {
        WorkflowErrorKind::NonAsyncFunction { span, directive } => (
            span,
            format!(
                "Functions marked with \"{}\" must be async functions",
                directive
            ),
        ),
        WorkflowErrorKind::MisplacedDirective {
            span,
            directive,
            location,
        } => (
            span,
            format!(
                "The \"{}\" directive must be at the top of the {}",
                directive,
                match location {
                    DirectiveLocation::Module => "file",
                    DirectiveLocation::FunctionBody => "function body",
                }
            ),
        ),
        WorkflowErrorKind::MisspelledDirective {
            span,
            directive,
            expected,
        } => (
            span,
            format!(
                "Did you mean \"{}\"? \"{}\" is not a supported directive",
                expected, directive
            ),
        ),
        WorkflowErrorKind::ForbiddenExpression {
            span,
            expr,
            directive,
        } => (
            span,
            format!(
                "Functions marked with \"{}\" cannot use `{}`",
                directive, expr
            ),
        ),
        WorkflowErrorKind::InvalidExport { span, directive } => (
            span,
            format!(
                "Only async functions can be exported from a \"{}\" file",
                directive
            ),
        ),
    };

    HANDLER.with(|handler| handler.struct_span_err(span, &msg).emit());
}

// Helper function to detect similar strings (typos)
fn detect_similar_strings(a: &str, b: &str) -> bool {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();

    if (a_chars.len() as i32 - b_chars.len() as i32).abs() > 1 {
        return false;
    }

    let mut differences = 0;
    let mut i = 0;
    let mut j = 0;

    while i < a_chars.len() && j < b_chars.len() {
        if a_chars[i] != b_chars[j] {
            differences += 1;
            if differences > 1 {
                return false;
            }

            if a_chars.len() > b_chars.len() {
                i += 1;
            } else if b_chars.len() > a_chars.len() {
                j += 1;
            } else {
                i += 1;
                j += 1;
            }
        } else {
            i += 1;
            j += 1;
        }
    }

    differences + (a_chars.len() - i) + (b_chars.len() - j) == 1
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum TransformMode {
    Step,
    Workflow,
    Client,
}

#[derive(Debug)]
pub struct StepTransform {
    mode: TransformMode,
    filename: String,
    // Track if the file has a top-level "use step" directive
    has_file_step_directive: bool,
    // Track if the file has a top-level "use workflow" directive
    has_file_workflow_directive: bool,
    // Set of function names that are step functions
    step_function_names: HashSet<String>,
    // Set of function names that are workflow functions
    workflow_function_names: HashSet<String>,
    // Set of function names that have been registered (to avoid duplicates)
    registered_functions: HashSet<String>,
    // Collect registration calls for step mode
    registration_calls: Vec<Stmt>,
    // Track closure variables
    names: Vec<Name>,
    should_track_names: bool,
    in_module_level: bool,
    in_callee: bool,
    // Track context for validation
    in_step_function: bool,
    in_workflow_function: bool,
    // Track workflow functions that need to be expanded into multiple exports
    workflow_exports_to_expand: Vec<(String, Expr, swc_core::common::Span)>,
    // Track workflow functions that need workflowId property in client mode
    workflow_functions_needing_id: Vec<(String, swc_core::common::Span)>,
    // Track step function exports that need to be converted to const declarations in workflow mode
    step_exports_to_convert: Vec<(String, String, swc_core::common::Span)>, // (fn_name, step_id, span)
}

// Structure to track variable names and their access patterns
#[derive(Debug, Clone, PartialEq, Eq)]
struct Name {
    id: Id,
    props: Vec<NameProp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NameProp {
    sym: swc_core::atoms::Atom,
    optional: bool,
}

impl From<&Ident> for Name {
    fn from(ident: &Ident) -> Self {
        Name {
            id: ident.to_id(),
            props: vec![],
        }
    }
}

impl TryFrom<&Expr> for Name {
    type Error = ();

    fn try_from(expr: &Expr) -> Result<Self, Self::Error> {
        match expr {
            Expr::Ident(ident) => Ok(Name::from(ident)),
            Expr::Member(member) => {
                if let MemberProp::Ident(prop) = &member.prop {
                    let mut name = Name::try_from(&*member.obj)?;
                    name.props.push(NameProp {
                        sym: prop.sym.clone(),
                        optional: false,
                    });
                    Ok(name)
                } else {
                    Err(())
                }
            }
            Expr::OptChain(opt_chain) => {
                if let OptChainBase::Member(member) = &*opt_chain.base {
                    if let MemberProp::Ident(prop) = &member.prop {
                        let mut name = Name::try_from(&*member.obj)?;
                        name.props.push(NameProp {
                            sym: prop.sym.clone(),
                            optional: opt_chain.optional,
                        });
                        Ok(name)
                    } else {
                        Err(())
                    }
                } else {
                    Err(())
                }
            }
            _ => Err(()),
        }
    }
}

impl StepTransform {
    pub fn new(mode: TransformMode, filename: String) -> Self {
        Self {
            mode,
            filename,
            has_file_step_directive: false,
            has_file_workflow_directive: false,
            step_function_names: HashSet::new(),
            workflow_function_names: HashSet::new(),
            registered_functions: HashSet::new(),
            registration_calls: Vec::new(),
            names: Vec::new(),
            should_track_names: false,
            in_module_level: true,
            in_callee: false,
            in_step_function: false,
            in_workflow_function: false,
            workflow_exports_to_expand: Vec::new(),
            workflow_functions_needing_id: Vec::new(),
            step_exports_to_convert: Vec::new(),
        }
    }

    // Create an identifier by combining filename and function name or line number
    // with appropriate prefix based on function type
    fn create_id(
        &self,
        fn_name: Option<&str>,
        span: swc_core::common::Span,
        is_workflow: bool,
    ) -> String {
        match fn_name {
            Some(name) if name.starts_with("__builtin") => {
                // Special case for __builtin functions: use only the function name
                name.to_string()
            }
            Some(name) => {
                let prefix = if is_workflow { "workflow" } else { "step" };
                naming::format_name(prefix, &self.filename, name)
            }
            None => {
                let prefix = if is_workflow { "workflow" } else { "step" };
                naming::format_name(prefix, &self.filename, span.lo.0)
            }
        }
    }

    // Helper function to convert parameter patterns to expressions
    fn pat_to_expr(&self, pat: &Pat) -> Expr {
        match pat {
            Pat::Ident(ident) => Expr::Ident(Ident::new(
                ident.id.sym.clone(),
                DUMMY_SP,
                SyntaxContext::empty(),
            )),
            Pat::Object(obj_pat) => {
                // Reconstruct object from destructured bindings
                let props = obj_pat
                    .props
                    .iter()
                    .filter_map(|prop| {
                        match prop {
                            ObjectPatProp::KeyValue(kv) => {
                                let key = match &kv.key {
                                    PropName::Ident(ident) => {
                                        PropName::Ident(IdentName::new(ident.sym.clone(), DUMMY_SP))
                                    }
                                    PropName::Str(s) => PropName::Str(Str {
                                        span: DUMMY_SP,
                                        value: s.value.clone(),
                                        raw: None,
                                    }),
                                    PropName::Num(n) => PropName::Num(Number {
                                        span: DUMMY_SP,
                                        value: n.value,
                                        raw: None,
                                    }),
                                    PropName::BigInt(bi) => PropName::BigInt(BigInt {
                                        span: DUMMY_SP,
                                        value: bi.value.clone(),
                                        raw: None,
                                    }),
                                    PropName::Computed(_computed) => {
                                        // For computed properties, we need to handle differently
                                        // For now, skip them
                                        return None;
                                    }
                                };

                                Some(PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key,
                                    value: Box::new(self.pat_to_expr(&kv.value)),
                                }))))
                            }
                            ObjectPatProp::Assign(assign) => {
                                // Shorthand property like {a} in {a, b}
                                Some(PropOrSpread::Prop(Box::new(Prop::Shorthand(Ident::new(
                                    assign.key.sym.clone(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                )))))
                            }
                            ObjectPatProp::Rest(rest) => {
                                // Handle rest pattern like {...rest}
                                Some(PropOrSpread::Spread(SpreadElement {
                                    dot3_token: DUMMY_SP,
                                    expr: Box::new(self.pat_to_expr(&rest.arg)),
                                }))
                            }
                        }
                    })
                    .collect();

                Expr::Object(ObjectLit {
                    span: DUMMY_SP,
                    props,
                })
            }
            Pat::Array(array_pat) => {
                // Reconstruct array from destructured bindings
                let elems = array_pat
                    .elems
                    .iter()
                    .map(|elem| {
                        elem.as_ref().map(|pat| ExprOrSpread {
                            spread: None,
                            expr: Box::new(self.pat_to_expr(pat)),
                        })
                    })
                    .collect();

                Expr::Array(ArrayLit {
                    span: DUMMY_SP,
                    elems,
                })
            }
            Pat::Rest(rest_pat) => {
                // For rest patterns in function parameters, just use the identifier
                self.pat_to_expr(&rest_pat.arg)
            }
            Pat::Assign(assign_pat) => {
                // For default parameters, use the left side identifier
                self.pat_to_expr(&assign_pat.left)
            }
            _ => {
                // For other patterns, fall back to null
                // This includes: Pat::Invalid, Pat::Expr
                Expr::Lit(Lit::Null(Null { span: DUMMY_SP }))
            }
        }
    }

    // Check if a function has the "use step" directive
    fn has_use_step_directive(&self, body: &Option<BlockStmt>) -> bool {
        if let Some(body) = body {
            let mut is_first_meaningful = true;

            for stmt in body.stmts.iter() {
                if let Stmt::Expr(ExprStmt {
                    expr,
                    span: stmt_span,
                    ..
                }) = stmt
                {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use step" {
                            if !is_first_meaningful {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *stmt_span,
                                    directive: value.to_string(),
                                    location: DirectiveLocation::FunctionBody,
                                });
                            }
                            return true;
                        } else if detect_similar_strings(value, "use step") {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *stmt_span,
                                directive: value.to_string(),
                                expected: "use step",
                            });
                        }
                    }
                }
                // Any non-directive statement means directives can't come after
                is_first_meaningful = false;
            }

            false
        } else {
            false
        }
    }

    // Check if a function has the "use workflow" directive
    fn has_use_workflow_directive(&self, body: &Option<BlockStmt>) -> bool {
        if let Some(body) = body {
            let mut is_first_meaningful = true;

            for stmt in body.stmts.iter() {
                if let Stmt::Expr(ExprStmt {
                    expr,
                    span: stmt_span,
                    ..
                }) = stmt
                {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use workflow" {
                            if !is_first_meaningful {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *stmt_span,
                                    directive: value.to_string(),
                                    location: DirectiveLocation::FunctionBody,
                                });
                            }
                            return true;
                        } else if detect_similar_strings(value, "use workflow") {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *stmt_span,
                                directive: value.to_string(),
                                expected: "use workflow",
                            });
                        }
                    }
                }
                // Any non-directive statement means directives can't come after
                is_first_meaningful = false;
            }

            false
        } else {
            false
        }
    }

    // Check if the module has a top-level "use step" directive
    fn check_module_directive(&mut self, items: &[ModuleItem]) -> bool {
        let mut found_directive = false;
        let mut is_first_meaningful = true;

        for item in items {
            match item {
                ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, span, .. })) => {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use step" {
                            if !is_first_meaningful {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *span,
                                    directive: value.to_string(),
                                    location: DirectiveLocation::Module,
                                });
                            } else {
                                found_directive = true;
                                // Don't break - continue checking for other directives
                            }
                        } else if value == "use workflow" {
                            // Can't have both directives
                            if found_directive {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *span,
                                    directive: value.to_string(),
                                    location: DirectiveLocation::Module,
                                });
                            }
                        } else if detect_similar_strings(value, "use step") {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *span,
                                directive: value.to_string(),
                                expected: "use step",
                            });
                        }
                    }
                    // Any non-directive expression statement means directives can't come after
                    if !found_directive {
                        is_first_meaningful = false;
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => {
                    // Imports after directive are not allowed
                    if found_directive {
                        // This is okay - imports can come after directives
                    } else {
                        // But directives can't come after imports
                        is_first_meaningful = false;
                    }
                }
                _ => {
                    // Any other module item means directives can't come after
                    is_first_meaningful = false;
                }
            }
        }

        found_directive
    }

    // Check if the module has a top-level "use workflow" directive
    fn check_module_workflow_directive(&mut self, items: &[ModuleItem]) -> bool {
        let mut found_directive = false;
        let mut is_first_meaningful = true;

        for item in items {
            match item {
                ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, span, .. })) => {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use workflow" {
                            if !is_first_meaningful {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *span,
                                    directive: value.to_string(),
                                    location: DirectiveLocation::Module,
                                });
                            } else {
                                found_directive = true;
                                // Don't break - continue checking for other directives
                            }
                        } else if value == "use step" {
                            // Can't have both directives
                            if found_directive {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *span,
                                    directive: value.to_string(),
                                    location: DirectiveLocation::Module,
                                });
                            }
                        } else if detect_similar_strings(value, "use workflow") {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *span,
                                directive: value.to_string(),
                                expected: "use workflow",
                            });
                        }
                    }
                    // Any non-directive expression statement means directives can't come after
                    if !found_directive {
                        is_first_meaningful = false;
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => {
                    // Imports after directive are not allowed
                    if found_directive {
                        // This is okay - imports can come after directives
                    } else {
                        // But directives can't come after imports
                        is_first_meaningful = false;
                    }
                }
                _ => {
                    // Any other module item means directives can't come after
                    is_first_meaningful = false;
                }
            }
        }

        found_directive
    }

    // Remove "use step" directive from function body
    fn remove_use_step_directive(&self, body: &mut Option<BlockStmt>) {
        if let Some(body) = body {
            if !body.stmts.is_empty() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use step" {
                            body.stmts.remove(0);
                        }
                    }
                }
            }
        }
    }

    // Remove "use workflow" directive from function body
    fn remove_use_workflow_directive(&self, body: &mut Option<BlockStmt>) {
        if let Some(body) = body {
            if !body.stmts.is_empty() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use workflow" {
                            body.stmts.remove(0);
                        }
                    }
                }
            }
        }
    }

    // Check if an arrow function has the "use step" directive
    fn has_use_step_directive_arrow(&self, body: &BlockStmtOrExpr) -> bool {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            if let Some(first_stmt) = body.stmts.first() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = first_stmt {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        return value == "use step";
                    }
                }
            }
        }
        false
    }

    // Check if an arrow function has the "use workflow" directive
    fn has_use_workflow_directive_arrow(&self, body: &BlockStmtOrExpr) -> bool {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            if let Some(first_stmt) = body.stmts.first() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = first_stmt {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        return value == "use workflow";
                    }
                }
            }
        }
        false
    }

    // Remove "use step" directive from arrow function body
    fn remove_use_step_directive_arrow(&self, body: &mut BlockStmtOrExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            if !body.stmts.is_empty() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use step" {
                            body.stmts.remove(0);
                        }
                    }
                }
            }
        }
    }

    // Remove "use workflow" directive from arrow function body
    fn remove_use_workflow_directive_arrow(&self, body: &mut BlockStmtOrExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            if !body.stmts.is_empty() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use workflow" {
                            body.stmts.remove(0);
                        }
                    }
                }
            }
        }
    }

    // Generate the import for registerStepFunction (step mode)
    fn create_register_import(&self) -> ModuleItem {
        ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
            span: DUMMY_SP,
            specifiers: vec![ImportSpecifier::Named(ImportNamedSpecifier {
                span: DUMMY_SP,
                local: Ident::new(
                    "registerStepFunction".into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ),
                imported: None,
                is_type_only: false,
            })],
            src: Box::new(Str {
                span: DUMMY_SP,
                value: "workflow/internal/private".into(),
                raw: None,
            }),
            type_only: false,
            with: None,
            phase: ImportPhase::Evaluation,
        }))
    }

    // Create a proxy call to globalThis[Symbol.for("WORKFLOW_USE_STEP")] (workflow mode)
    fn create_step_proxy(&self, step_id: &str) -> Expr {
        Expr::Call(CallExpr {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            callee: Callee::Expr(Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: Box::new(Expr::Ident(Ident::new(
                        "globalThis".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    ))),
                    prop: MemberProp::Computed(ComputedPropName {
                        span: DUMMY_SP,
                        expr: Box::new(Expr::Call(CallExpr {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                span: DUMMY_SP,
                                obj: Box::new(Expr::Ident(Ident::new(
                                    "Symbol".into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                ))),
                                prop: MemberProp::Ident(IdentName::new("for".into(), DUMMY_SP)),
                            }))),
                            args: vec![ExprOrSpread {
                                spread: None,
                                expr: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: "WORKFLOW_USE_STEP".into(),
                                    raw: None,
                                }))),
                            }],
                            type_args: None,
                        })),
                    }),
                }))),
                args: vec![ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: step_id.into(),
                        raw: None,
                    }))),
                }],
                type_args: None,
            }))),
            args: vec![],
            type_args: None,
        })
    }

    // Create an initializer for a step function in workflow mode
    // Produces: globalThis[Symbol.for("WORKFLOW_USE_STEP")](step_id)
    fn create_step_initializer(&self, step_id: &str) -> Expr {
        Expr::Call(CallExpr {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                span: DUMMY_SP,
                obj: Box::new(Expr::Ident(Ident::new(
                    "globalThis".into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ))),
                prop: MemberProp::Computed(ComputedPropName {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Call(CallExpr {
                        span: DUMMY_SP,
                        ctxt: SyntaxContext::empty(),
                        callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: Box::new(Expr::Ident(Ident::new(
                                "Symbol".into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            ))),
                            prop: MemberProp::Ident(IdentName::new("for".into(), DUMMY_SP)),
                        }))),
                        args: vec![ExprOrSpread {
                            spread: None,
                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                span: DUMMY_SP,
                                value: "WORKFLOW_USE_STEP".into(),
                                raw: None,
                            }))),
                        }],
                        type_args: None,
                    })),
                }),
            }))),
            args: vec![ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: step_id.into(),
                    raw: None,
                }))),
            }],
            type_args: None,
        })
    }

    // Create a statement that adds workflowId property to a function (client mode)
    fn create_workflow_id_assignment(&self, fn_name: &str, span: swc_core::common::Span) -> Stmt {
        let workflow_id = self.create_id(Some(fn_name), span, true);

        // Create: functionName.workflowId = "workflowId"
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Assign(AssignExpr {
                span: DUMMY_SP,
                op: AssignOp::Assign,
                left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: Box::new(Expr::Ident(Ident::new(
                        fn_name.into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    ))),
                    prop: MemberProp::Ident(IdentName::new("workflowId".into(), DUMMY_SP)),
                })),
                right: Box::new(Expr::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: workflow_id.into(),
                    raw: None,
                }))),
            })),
        })
    }

    // Mark a step function with the STEP_FUNCTION_NAME_SYMBOL in workflow mode
    fn create_step_function_marking(&self, fn_name: &str, span: swc_core::common::Span) -> Stmt {
        let step_id = self.create_id(Some(fn_name), span, false);

        // Create: Object.defineProperty(functionName, Symbol.for('WORKFLOW_STEP_FUNCTION_NAME'), {
        //   value: "stepId",
        //   writable: false,
        //   enumerable: false,
        //   configurable: false
        // })
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: Box::new(Expr::Ident(Ident::new(
                        "Object".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    ))),
                    prop: MemberProp::Ident(IdentName::new("defineProperty".into(), DUMMY_SP)),
                }))),
                args: vec![
                    // First argument: functionName
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Ident(Ident::new(
                            fn_name.into(),
                            DUMMY_SP,
                            SyntaxContext::empty(),
                        ))),
                    },
                    // Second argument: Symbol.for('WORKFLOW_STEP_FUNCTION_NAME')
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Call(CallExpr {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                span: DUMMY_SP,
                                obj: Box::new(Expr::Ident(Ident::new(
                                    "Symbol".into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                ))),
                                prop: MemberProp::Ident(IdentName::new("for".into(), DUMMY_SP)),
                            }))),
                            args: vec![ExprOrSpread {
                                spread: None,
                                expr: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: "WORKFLOW_STEP_FUNCTION_NAME".into(),
                                    raw: None,
                                }))),
                            }],
                            type_args: None,
                        })),
                    },
                    // Third argument: property descriptor object
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Object(ObjectLit {
                            span: DUMMY_SP,
                            props: vec![
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new("value".into(), DUMMY_SP)),
                                    value: Box::new(Expr::Lit(Lit::Str(Str {
                                        span: DUMMY_SP,
                                        value: step_id.into(),
                                        raw: None,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new(
                                        "writable".into(),
                                        DUMMY_SP,
                                    )),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: false,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new(
                                        "enumerable".into(),
                                        DUMMY_SP,
                                    )),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: false,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new(
                                        "configurable".into(),
                                        DUMMY_SP,
                                    )),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: false,
                                    }))),
                                }))),
                            ],
                        })),
                    },
                ],
                type_args: None,
            })),
        })
    }

    // Create a registration call for step mode
    fn create_registration_call(&mut self, name: &str, span: swc_core::common::Span) {
        // Only register each function once
        if !self.registered_functions.contains(name) {
            self.registered_functions.insert(name.to_string());

            // Create the step ID
            let step_id = self.create_id(Some(name), span, false);

            self.registration_calls.push(Stmt::Expr(ExprStmt {
                span: DUMMY_SP,
                expr: Box::new(Expr::Call(CallExpr {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    callee: Callee::Expr(Box::new(Expr::Ident(Ident::new(
                        "registerStepFunction".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    )))),
                    args: vec![
                        // First argument: step ID
                        ExprOrSpread {
                            spread: None,
                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                span: DUMMY_SP,
                                value: step_id.into(),
                                raw: None,
                            }))),
                        },
                        // Second argument: function reference
                        ExprOrSpread {
                            spread: None,
                            expr: Box::new(Expr::Ident(Ident::new(
                                name.into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            ))),
                        },
                    ],
                    type_args: None,
                })),
            }));
        }
    }

    // Validate that the function is async
    fn validate_async_function(&self, function: &Function, span: swc_core::common::Span) -> bool {
        if !function.is_async {
            HANDLER.with(|handler| {
                handler
                    .struct_span_err(
                        span,
                        "Functions marked with \"use step\" must be async functions",
                    )
                    .emit()
            });
            false
        } else {
            true
        }
    }

    // Check if a function should be treated as a step function
    fn should_transform_function(&self, function: &Function, is_exported: bool) -> bool {
        let has_directive = self.has_use_step_directive(&function.body);

        // Function has explicit directive OR file has directive and function is exported
        (has_directive || (self.has_file_step_directive && is_exported)) && function.is_async
    }

    // Check if a function should be treated as a workflow function
    fn should_transform_workflow_function(&self, function: &Function, is_exported: bool) -> bool {
        let has_directive = self.has_use_workflow_directive(&function.body);

        // Function has explicit directive OR file has workflow directive and function is exported
        (has_directive || (self.has_file_workflow_directive && is_exported)) && function.is_async
    }

    // Legacy method - now replaced by analyze_usage_comprehensive
    // TODO: Remove this once we're confident the new implementation works
    #[allow(dead_code)]
    fn analyze_import_usage(&self, module: &Module) -> HashSet<String> {
        let mut used_identifiers = HashSet::new();
        let mut visitor = UsageCollector {
            used_identifiers: &mut used_identifiers,
            step_function_names: &self.step_function_names,
            in_step_function: false,
        };

        for item in &module.body {
            match item {
                ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => {
                    // Skip import declarations
                }
                _ => {
                    // Visit all other items
                    let mut item_clone = item.clone();
                    item_clone.visit_mut_with(&mut visitor);
                }
            }
        }

        used_identifiers
    }

    // Remove dead code (unused functions, variables, statements, and imports) recursively
    fn remove_dead_code(&self, items: &mut Vec<ModuleItem>) {
        // Only runs in workflow and client mode
        if !matches!(self.mode, TransformMode::Workflow | TransformMode::Client) {
            return;
        }

        // Keep removing dead code until no more changes are made
        loop {
            // Analyze which identifiers are used
            let module = Module {
                span: DUMMY_SP,
                body: items.clone(),
                shebang: None,
            };
            let used_identifiers = self.analyze_usage_comprehensive(&module);

            // Note: used_identifiers now contains only actually referenced identifiers

            let mut items_changed = false;
            let mut items_to_remove = Vec::new();

            // Check each item for whether it should be removed
            for (i, item) in items.iter().enumerate() {
                let should_remove = match item {
                    // Remove unused function declarations
                    ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                        let fn_name = fn_decl.ident.sym.to_string();
                        // Don't remove if it's used or if it's a step/workflow function
                        !used_identifiers.contains(&fn_name)
                            && !self.step_function_names.contains(&fn_name)
                            && !self.workflow_function_names.contains(&fn_name)
                    }
                    // Remove unused variable declarations
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
                        // Check if all variables in this declaration are unused
                        var_decl.decls.iter().all(|declarator| {
                            // Don't remove if the initializer contains functions (which might have directives)
                            if let Some(init) = &declarator.init {
                                if self.contains_function_expr(init) {
                                    return false;
                                }
                            }

                            match &declarator.name {
                                Pat::Ident(binding) => {
                                    let name = binding.id.sym.to_string();
                                    !used_identifiers.contains(&name)
                                        && !self.step_function_names.contains(&name)
                                        && !self.workflow_function_names.contains(&name)
                                }
                                // For destructuring patterns, be conservative and keep them
                                // unless we can determine all bindings are unused
                                Pat::Array(array_pat) => {
                                    self.all_bindings_unused(array_pat, &used_identifiers)
                                }
                                Pat::Object(obj_pat) => {
                                    self.all_object_bindings_unused(obj_pat, &used_identifiers)
                                }
                                _ => false, // Keep other patterns
                            }
                        })
                    }
                    // Remove unused expression statements (but keep side effects and directives)
                    ModuleItem::Stmt(Stmt::Expr(expr_stmt)) => {
                        // Don't remove expression statements that might have side effects
                        // Only remove pure identifier expressions and non-string literals
                        match &*expr_stmt.expr {
                            Expr::Ident(_) => true,
                            // Keep all string literals (might be directives or misspelled directives)
                            Expr::Lit(Lit::Str(_)) => false,
                            Expr::Lit(_) => true,
                            _ => false,
                        }
                    }
                    // Don't remove exports, imports (handled separately), or other items
                    _ => false,
                };

                if should_remove {
                    items_to_remove.push(i);
                }
            }

            // Remove unused items (in reverse order to maintain indices)
            if !items_to_remove.is_empty() {
                items_changed = true;
                for i in items_to_remove.into_iter().rev() {
                    items.remove(i);
                }
            }

            // Remove unused imports
            let mut imports_to_remove = Vec::new();
            let mut imports_modified = false;

            for (i, item) in items.iter_mut().enumerate() {
                if let ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) = item {
                    let mut new_specifiers = Vec::new();

                    for spec in &import_decl.specifiers {
                        let local_name = match spec {
                            ImportSpecifier::Named(named) => named.local.sym.to_string(),
                            ImportSpecifier::Default(default) => default.local.sym.to_string(),
                            ImportSpecifier::Namespace(ns) => ns.local.sym.to_string(),
                        };

                        // Keep the import if it's used
                        if used_identifiers.contains(&local_name) {
                            new_specifiers.push(spec.clone());
                        }
                    }

                    // Update or mark for removal
                    if new_specifiers.is_empty() {
                        imports_to_remove.push(i);
                    } else if new_specifiers.len() != import_decl.specifiers.len() {
                        imports_modified = true;
                        import_decl.specifiers = new_specifiers;
                    }
                }
            }

            // Remove imports marked for removal (in reverse order to maintain indices)
            let imports_removed = !imports_to_remove.is_empty();
            for i in imports_to_remove.into_iter().rev() {
                items.remove(i);
            }

            // If nothing changed, we're done
            if !items_changed && !imports_removed && !imports_modified {
                break;
            }
        }
    }

    // Helper to check if an expression contains a function expression or object with methods
    fn contains_function_expr(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Fn(_) | Expr::Arrow(_) => true,
            Expr::Object(obj_lit) => {
                // Check if object contains any method properties
                obj_lit.props.iter().any(
                    |prop| matches!(prop, PropOrSpread::Prop(p) if matches!(&**p, Prop::Method(_))),
                )
            }
            _ => false,
        }
    }

    // Helper to check if all bindings in an array pattern are unused
    fn all_bindings_unused(
        &self,
        array_pat: &ArrayPat,
        used_identifiers: &HashSet<String>,
    ) -> bool {
        array_pat.elems.iter().all(|elem| {
            match elem {
                Some(pat) => {
                    match pat {
                        Pat::Ident(binding) => {
                            let name = binding.id.sym.to_string();
                            !used_identifiers.contains(&name)
                                && !self.step_function_names.contains(&name)
                                && !self.workflow_function_names.contains(&name)
                        }
                        Pat::Array(nested) => self.all_bindings_unused(nested, used_identifiers),
                        Pat::Object(nested) => {
                            self.all_object_bindings_unused(nested, used_identifiers)
                        }
                        _ => false, // Keep other patterns
                    }
                }
                None => true, // Holes in array patterns are fine
            }
        })
    }

    // Helper to check if all bindings in an object pattern are unused
    fn all_object_bindings_unused(
        &self,
        obj_pat: &ObjectPat,
        used_identifiers: &HashSet<String>,
    ) -> bool {
        obj_pat.props.iter().all(|prop| {
            match prop {
                ObjectPatProp::KeyValue(kv) => {
                    match &*kv.value {
                        Pat::Ident(binding) => {
                            let name = binding.id.sym.to_string();
                            !used_identifiers.contains(&name)
                                && !self.step_function_names.contains(&name)
                                && !self.workflow_function_names.contains(&name)
                        }
                        Pat::Array(nested) => self.all_bindings_unused(nested, used_identifiers),
                        Pat::Object(nested) => {
                            self.all_object_bindings_unused(nested, used_identifiers)
                        }
                        _ => false, // Keep other patterns
                    }
                }
                ObjectPatProp::Assign(assign) => {
                    let name = assign.key.sym.to_string();
                    !used_identifiers.contains(&name)
                        && !self.step_function_names.contains(&name)
                        && !self.workflow_function_names.contains(&name)
                }
                ObjectPatProp::Rest(rest) => {
                    match &*rest.arg {
                        Pat::Ident(binding) => {
                            let name = binding.id.sym.to_string();
                            !used_identifiers.contains(&name)
                                && !self.step_function_names.contains(&name)
                                && !self.workflow_function_names.contains(&name)
                        }
                        _ => false, // Keep other patterns
                    }
                }
            }
        })
    }

    // Comprehensive usage analysis that considers all remaining code
    fn analyze_usage_comprehensive(&self, module: &Module) -> HashSet<String> {
        let mut used_identifiers = HashSet::new();

        // First, mark exported identifiers as used
        for item in &module.body {
            if let ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) = item {
                match &export_decl.decl {
                    Decl::Fn(fn_decl) => {
                        let fn_name = fn_decl.ident.sym.to_string();
                        // Exported functions are considered used unless they're step functions
                        if !self.step_function_names.contains(&fn_name) {
                            used_identifiers.insert(fn_name);
                        }
                    }
                    Decl::Var(var_decl) => {
                        for declarator in &var_decl.decls {
                            if let Pat::Ident(binding) = &declarator.name {
                                used_identifiers.insert(binding.id.sym.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // Then, visit all items to find used identifiers
        let mut visitor = ComprehensiveUsageCollector {
            used_identifiers: &mut used_identifiers,
            step_function_names: &self.step_function_names,
            current_function: None,
        };

        // Visit the module directly (not clones) to analyze the already-transformed code
        let mut module_clone = module.clone();
        module_clone.visit_mut_with(&mut visitor);

        used_identifiers
    }

    // Check if a function has a step directive (regardless of async status)
    fn has_step_directive(&self, function: &Function, is_exported: bool) -> bool {
        (self.has_file_step_directive && is_exported) || self.has_use_step_directive(&function.body)
    }

    // Check if a function has a workflow directive (regardless of async status)
    fn has_workflow_directive(&self, function: &Function, is_exported: bool) -> bool {
        (self.has_file_workflow_directive && is_exported)
            || self.has_use_workflow_directive(&function.body)
    }

    // Check if an arrow function has a step directive (regardless of async status)
    fn has_step_directive_arrow(&self, arrow_fn: &ArrowExpr, is_exported: bool) -> bool {
        (self.has_file_step_directive && is_exported)
            || self.has_use_step_directive_arrow(&arrow_fn.body)
    }

    // Check if an arrow function has a workflow directive (regardless of async status)
    fn has_workflow_directive_arrow(&self, arrow_fn: &ArrowExpr, is_exported: bool) -> bool {
        (self.has_file_workflow_directive && is_exported)
            || self.has_use_workflow_directive_arrow(&arrow_fn.body)
    }

    // Generate metadata comment for the transformed file
    fn generate_metadata_comment(&self) -> String {
        let mut metadata = std::collections::HashMap::new();

        // Build steps metadata
        if !self.step_function_names.is_empty() {
            // Sort function names for deterministic ordering
            let mut sorted_step_names: Vec<_> = self.step_function_names.iter().collect();
            sorted_step_names.sort();

            let steps_entries: Vec<String> = sorted_step_names
                .into_iter()
                .map(|fn_name| {
                    let step_id = self.create_id(Some(fn_name), DUMMY_SP, false);
                    format!("\"{}\":{{\"stepId\":\"{}\"}}", fn_name, step_id)
                })
                .collect();

            metadata.insert("steps", format!("{{{}}}", steps_entries.join(",")));
        }

        // Build workflows metadata
        if !self.workflow_function_names.is_empty() {
            // Sort function names for deterministic ordering
            let mut sorted_workflow_names: Vec<_> = self.workflow_function_names.iter().collect();
            sorted_workflow_names.sort();

            let workflow_entries: Vec<String> = sorted_workflow_names
                .into_iter()
                .map(|fn_name| {
                    let workflow_id = self.create_id(Some(fn_name), DUMMY_SP, true);
                    format!("\"{}\":{{\"workflowId\":\"{}\"}}", fn_name, workflow_id)
                })
                .collect();

            metadata.insert("workflows", format!("{{{}}}", workflow_entries.join(",")));
        }

        // Build the final comment structure
        let relative_filename = self.filename.replace('\\', "/"); // Normalize path separators
        let mut parts = Vec::new();

        if metadata.contains_key("workflows") {
            parts.push(format!(
                "\"workflows\":{{\"{}\":{}}}",
                relative_filename, metadata["workflows"]
            ));
        }
        if metadata.contains_key("steps") {
            parts.push(format!(
                "\"steps\":{{\"{}\":{}}}",
                relative_filename, metadata["steps"]
            ));
        }

        if parts.is_empty() {
            String::new()
        } else {
            format!("/**__internal_workflows{{{}}}*/", parts.join(","))
        }
    }
}

// Helper visitor to collect identifier usage
struct UsageCollector<'a> {
    used_identifiers: &'a mut HashSet<String>,
    step_function_names: &'a HashSet<String>,
    in_step_function: bool,
}

impl<'a> VisitMut for UsageCollector<'a> {
    fn visit_mut_fn_decl(&mut self, fn_decl: &mut FnDecl) {
        let fn_name = fn_decl.ident.sym.to_string();
        let is_step_function = self.step_function_names.contains(&fn_name);

        if is_step_function {
            // Don't visit step function bodies
            return;
        }

        fn_decl.visit_mut_children_with(self);
    }

    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if !self.in_step_function {
            self.used_identifiers.insert(ident.sym.to_string());
        }
    }

    fn visit_mut_export_decl(&mut self, export_decl: &mut ExportDecl) {
        match &mut export_decl.decl {
            Decl::Fn(fn_decl) => {
                let fn_name = fn_decl.ident.sym.to_string();
                if self.step_function_names.contains(&fn_name) {
                    // Don't visit step function bodies
                    return;
                }
            }
            _ => {}
        }
        export_decl.visit_mut_children_with(self);
    }

    fn visit_mut_var_declarator(&mut self, var_decl: &mut VarDeclarator) {
        // Check if this is a step function assigned to a variable
        if let Some(init) = &var_decl.init {
            if let Pat::Ident(binding) = &var_decl.name {
                let name = binding.id.sym.to_string();

                let is_step_fn = match &**init {
                    Expr::Fn(_) | Expr::Arrow(_) => self.step_function_names.contains(&name),
                    _ => false,
                };

                if is_step_fn {
                    // Don't visit the initializer if it's a step function
                    return;
                }
            }
        }

        var_decl.visit_mut_children_with(self);
    }

    noop_visit_mut_type!();
}

// Comprehensive usage collector that tracks identifier usage (calls, not declarations)
struct ComprehensiveUsageCollector<'a> {
    used_identifiers: &'a mut HashSet<String>,
    step_function_names: &'a HashSet<String>,
    current_function: Option<String>,
}

impl<'a> VisitMut for ComprehensiveUsageCollector<'a> {
    fn visit_mut_module_item(&mut self, item: &mut ModuleItem) {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => {
                // Skip import declarations
                return;
            }
            ModuleItem::Stmt(Stmt::Decl(Decl::Fn(_))) => {
                // Handle function declarations specially to avoid marking them as "used" by declaration
                item.visit_mut_children_with(self);
            }
            ModuleItem::Stmt(Stmt::Decl(Decl::Var(_))) => {
                // Handle variable declarations specially
                item.visit_mut_children_with(self);
            }
            _ => {
                // Visit all other items
                item.visit_mut_children_with(self);
            }
        }
    }

    fn visit_mut_fn_decl(&mut self, fn_decl: &mut FnDecl) {
        let fn_name = fn_decl.ident.sym.to_string();
        let is_step_function = self.step_function_names.contains(&fn_name);

        if is_step_function {
            // Step functions have their bodies replaced, so don't analyze their original content
            return;
        }

        // Set current function context and visit the body
        let prev_function = self.current_function.clone();
        self.current_function = Some(fn_name.clone());

        // Visit the function content to find used identifiers (but don't mark the function name itself as used)
        if let Some(body) = &mut fn_decl.function.body {
            body.visit_mut_with(self);
        }

        self.current_function = prev_function;
    }

    fn visit_mut_call_expr(&mut self, call: &mut CallExpr) {
        // Track function calls specifically
        if let Callee::Expr(expr) = &call.callee {
            if let Expr::Ident(ident) = &**expr {
                let name = ident.sym.to_string();
                self.used_identifiers.insert(name);
            }
        }

        // Visit arguments
        call.visit_mut_children_with(self);
    }

    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        // Track identifier usage, but be careful about function names in declarations
        let name = ident.sym.to_string();

        // Don't track the function name itself when it's being declared
        if let Some(current_fn) = &self.current_function {
            if name == *current_fn {
                return; // Skip the function's own name in its declaration
            }
        }

        self.used_identifiers.insert(name);
    }

    fn visit_mut_export_decl(&mut self, export_decl: &mut ExportDecl) {
        match &mut export_decl.decl {
            Decl::Fn(fn_decl) => {
                let fn_name = fn_decl.ident.sym.to_string();
                if self.step_function_names.contains(&fn_name) {
                    // Step functions have their bodies replaced
                    return;
                }

                // For exported functions, visit their body
                self.visit_mut_fn_decl(fn_decl);
            }
            Decl::Var(var_decl) => {
                // For exported variables, visit their initializers
                for declarator in &mut var_decl.decls {
                    self.visit_mut_var_declarator(declarator);
                }
            }
            _ => {
                export_decl.visit_mut_children_with(self);
            }
        }
    }

    fn visit_mut_var_declarator(&mut self, var_decl: &mut VarDeclarator) {
        // Check if this is a step function assigned to a variable
        if let Some(init) = &var_decl.init {
            if let Pat::Ident(binding) = &var_decl.name {
                let name = binding.id.sym.to_string();

                let is_step_fn = match &**init {
                    Expr::Fn(_) | Expr::Arrow(_) => self.step_function_names.contains(&name),
                    _ => false,
                };

                if is_step_fn {
                    // Don't visit the initializer if it's a step function
                    return;
                }
            }
        }

        // Only visit the initializer, not the variable name pattern
        // This prevents marking the variable name itself as "used"
        if let Some(init) = &mut var_decl.init {
            init.visit_mut_with(self);
        }
    }

    noop_visit_mut_type!();
}

impl VisitMut for StepTransform {
    fn visit_mut_program(&mut self, program: &mut Program) {
        // First pass: collect step functions
        program.visit_mut_children_with(self);

        // Add necessary imports and registrations
        match program {
            Program::Module(module) => {
                let mut imports_to_add = Vec::new();

                match self.mode {
                    TransformMode::Workflow => {
                        // No imports needed for workflow mode
                    }
                    TransformMode::Step => {
                        if !self.registration_calls.is_empty() {
                            imports_to_add.push(self.create_register_import());
                        }
                    }
                    TransformMode::Client => {
                        // No imports needed for client mode since step functions are not transformed
                    }
                }

                // Add imports at the beginning
                for import in imports_to_add.into_iter().rev() {
                    module.body.insert(0, import);
                }

                // Add registration calls at the end for step mode
                if matches!(self.mode, TransformMode::Step) {
                    for call in self.registration_calls.drain(..) {
                        module.body.push(ModuleItem::Stmt(call));
                    }
                }

                // Note: workflowId assignments are now handled in visit_mut_module_items

                // Add metadata comment at the beginning of the file
                let metadata_comment = self.generate_metadata_comment();
                if !metadata_comment.is_empty() {
                    // Insert the metadata as a string literal expression statement
                    // This will appear as a comment-like string in the output
                    let insert_position = module
                        .body
                        .iter()
                        .position(|item| {
                            !matches!(item, ModuleItem::ModuleDecl(ModuleDecl::Import(_)))
                        })
                        .unwrap_or(0);

                    module.body.insert(
                        insert_position,
                        ModuleItem::Stmt(Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                span: DUMMY_SP,
                                value: metadata_comment.clone().into(),
                                raw: Some(metadata_comment.into()),
                            }))),
                        })),
                    );
                }
            }
            Program::Script(script) => {
                // For scripts, we need to convert to module if we have step or workflow functions
                if !self.step_function_names.is_empty() || !self.workflow_function_names.is_empty()
                {
                    let mut module_items = Vec::new();

                    match self.mode {
                        TransformMode::Workflow => {
                            // No imports needed for workflow mode
                        }
                        TransformMode::Step => {
                            if !self.registration_calls.is_empty() {
                                module_items.push(self.create_register_import());
                            }
                        }
                        TransformMode::Client => {
                            // No imports needed for workflow mode
                        }
                    }

                    // Convert script statements to module items
                    for stmt in &script.body {
                        module_items.push(ModuleItem::Stmt(stmt.clone()));
                    }

                    // Add registration calls for step mode
                    if matches!(self.mode, TransformMode::Step) {
                        for call in self.registration_calls.drain(..) {
                            module_items.push(ModuleItem::Stmt(call));
                        }
                    }

                    // Note: workflowId assignments are now handled in visit_mut_module_items

                    // Add metadata comment at the beginning of the module
                    let metadata_comment = self.generate_metadata_comment();
                    if !metadata_comment.is_empty() {
                        // Find position after imports
                        let insert_position = module_items
                            .iter()
                            .position(|item| {
                                !matches!(item, ModuleItem::ModuleDecl(ModuleDecl::Import(_)))
                            })
                            .unwrap_or(0);

                        module_items.insert(
                            insert_position,
                            ModuleItem::Stmt(Stmt::Expr(ExprStmt {
                                span: DUMMY_SP,
                                expr: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: metadata_comment.clone().into(),
                                    raw: Some(metadata_comment.into()),
                                }))),
                            })),
                        );
                    }

                    // Replace program with module
                    *program = Program::Module(Module {
                        span: script.span,
                        body: module_items,
                        shebang: script.shebang.clone(),
                    });
                }
            }
        }
    }

    fn visit_mut_function(&mut self, function: &mut Function) {
        let has_step_directive = self.has_use_step_directive(&function.body);
        let has_workflow_directive = self.has_use_workflow_directive(&function.body);

        // Set context for forbidden expression checking
        let old_in_step = self.in_step_function;
        let old_in_workflow = self.in_workflow_function;
        let old_in_module = self.in_module_level;

        if has_step_directive {
            self.in_step_function = true;
        }
        if has_workflow_directive {
            self.in_workflow_function = true;
        }
        self.in_module_level = false;

        // Visit children
        function.visit_mut_children_with(self);

        // Restore context
        self.in_step_function = old_in_step;
        self.in_workflow_function = old_in_workflow;
        self.in_module_level = old_in_module;
    }

    fn visit_mut_arrow_expr(&mut self, arrow: &mut ArrowExpr) {
        let has_step_directive = self.has_use_step_directive_arrow(&arrow.body);
        let has_workflow_directive = self.has_use_workflow_directive_arrow(&arrow.body);

        // Set context for forbidden expression checking
        let old_in_step = self.in_step_function;
        let old_in_workflow = self.in_workflow_function;
        let old_in_module = self.in_module_level;

        if has_step_directive {
            self.in_step_function = true;
        }
        if has_workflow_directive {
            self.in_workflow_function = true;
        }
        self.in_module_level = false;

        // Visit children
        arrow.visit_mut_children_with(self);

        // Restore context
        self.in_step_function = old_in_step;
        self.in_workflow_function = old_in_workflow;
        self.in_module_level = old_in_module;
    }

    // Add forbidden expression checks
    fn visit_mut_this_expr(&mut self, expr: &mut ThisExpr) {
        if self.in_step_function {
            emit_error(WorkflowErrorKind::ForbiddenExpression {
                span: expr.span,
                expr: "this",
                directive: "use step",
            });
        } else if self.in_workflow_function {
            emit_error(WorkflowErrorKind::ForbiddenExpression {
                span: expr.span,
                expr: "this",
                directive: "use workflow",
            });
        }
    }

    fn visit_mut_super(&mut self, sup: &mut Super) {
        if self.in_step_function {
            emit_error(WorkflowErrorKind::ForbiddenExpression {
                span: sup.span,
                expr: "super",
                directive: "use step",
            });
        } else if self.in_workflow_function {
            emit_error(WorkflowErrorKind::ForbiddenExpression {
                span: sup.span,
                expr: "super",
                directive: "use workflow",
            });
        }
    }

    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if ident.sym == *"arguments" {
            if self.in_step_function {
                emit_error(WorkflowErrorKind::ForbiddenExpression {
                    span: ident.span,
                    expr: "arguments",
                    directive: "use step",
                });
            } else if self.in_workflow_function {
                emit_error(WorkflowErrorKind::ForbiddenExpression {
                    span: ident.span,
                    expr: "arguments",
                    directive: "use workflow",
                });
            }
        }
    }

    // Track when we're in a callee position
    fn visit_mut_callee(&mut self, callee: &mut Callee) {
        let old_in_callee = self.in_callee;
        self.in_callee = true;
        callee.visit_mut_children_with(self);
        self.in_callee = old_in_callee;
    }

    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        // Check for file-level directives
        self.has_file_step_directive = self.check_module_directive(items);
        self.has_file_workflow_directive = self.check_module_workflow_directive(items);

        // Remove file-level directive if present
        if !items.is_empty() {
            if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = &items[0] {
                if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                    let should_remove = match self.mode {
                        TransformMode::Step => value == "use step",
                        TransformMode::Workflow => value == "use workflow",
                        TransformMode::Client => value == "use step" || value == "use workflow",
                    };
                    if should_remove {
                        items.remove(0);
                    }
                }
            }
        }

        // Process items and collect functions that need workflowId assignments
        let mut items_to_insert = Vec::new();

        for (i, item) in items.iter_mut().enumerate() {
            // Validate exports if we have a file-level directive
            if self.has_file_step_directive || self.has_file_workflow_directive {
                match item {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
                        match &export.decl {
                            Decl::Fn(fn_decl) => {
                                if !fn_decl.function.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: export.span,
                                        directive: if self.has_file_step_directive {
                                            "use step"
                                        } else {
                                            "use workflow"
                                        },
                                    });
                                }
                            }
                            Decl::Var(var_decl) => {
                                // Check if any of the variable declarations contain non-async functions
                                for decl in &var_decl.decls {
                                    if let Some(init) = &decl.init {
                                        match &**init {
                                            Expr::Fn(fn_expr) => {
                                                if !fn_expr.function.is_async {
                                                    emit_error(WorkflowErrorKind::InvalidExport {
                                                        span: export.span,
                                                        directive: if self.has_file_step_directive {
                                                            "use step"
                                                        } else {
                                                            "use workflow"
                                                        },
                                                    });
                                                }
                                            }
                                            Expr::Arrow(arrow_expr) => {
                                                if !arrow_expr.is_async {
                                                    emit_error(WorkflowErrorKind::InvalidExport {
                                                        span: export.span,
                                                        directive: if self.has_file_step_directive {
                                                            "use step"
                                                        } else {
                                                            "use workflow"
                                                        },
                                                    });
                                                }
                                            }
                                            Expr::Lit(_) => {
                                                // Literals are not allowed
                                                emit_error(WorkflowErrorKind::InvalidExport {
                                                    span: export.span,
                                                    directive: if self.has_file_step_directive {
                                                        "use step"
                                                    } else {
                                                        "use workflow"
                                                    },
                                                });
                                            }
                                            _ => {
                                                // Other expressions might be okay if they resolve to async functions
                                                // but we can't easily check that statically
                                            }
                                        }
                                    }
                                }
                            }
                            Decl::Class(_) => {
                                // Classes are not allowed
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: export.span,
                                    directive: if self.has_file_step_directive {
                                        "use step"
                                    } else {
                                        "use workflow"
                                    },
                                });
                            }
                            Decl::TsInterface(_)
                            | Decl::TsTypeAlias(_)
                            | Decl::TsEnum(_)
                            | Decl::TsModule(_) => {
                                // TypeScript declarations are okay
                            }
                            Decl::Using(_) => {
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: export.span,
                                    directive: if self.has_file_step_directive {
                                        "use step"
                                    } else {
                                        "use workflow"
                                    },
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                        if named.src.is_some() {
                            // Re-exports are not allowed
                            emit_error(WorkflowErrorKind::InvalidExport {
                                span: named.span,
                                directive: if self.has_file_step_directive {
                                    "use step"
                                } else {
                                    "use workflow"
                                },
                            });
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(default)) => {
                        match &default.decl {
                            DefaultDecl::Fn(fn_expr) => {
                                if !fn_expr.function.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: default.span,
                                        directive: if self.has_file_step_directive {
                                            "use step"
                                        } else {
                                            "use workflow"
                                        },
                                    });
                                }
                            }
                            DefaultDecl::Class(_) => {
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: default.span,
                                    directive: if self.has_file_step_directive {
                                        "use step"
                                    } else {
                                        "use workflow"
                                    },
                                });
                            }
                            DefaultDecl::TsInterfaceDecl(_) => {
                                // TypeScript interface is okay
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(expr)) => {
                        match &*expr.expr {
                            Expr::Fn(fn_expr) => {
                                if !fn_expr.function.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: expr.span,
                                        directive: if self.has_file_step_directive {
                                            "use step"
                                        } else {
                                            "use workflow"
                                        },
                                    });
                                }
                            }
                            Expr::Arrow(arrow_expr) => {
                                if !arrow_expr.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: expr.span,
                                        directive: if self.has_file_step_directive {
                                            "use step"
                                        } else {
                                            "use workflow"
                                        },
                                    });
                                }
                            }
                            _ => {
                                // Other default exports are not allowed
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: expr.span,
                                    directive: if self.has_file_step_directive {
                                        "use step"
                                    } else {
                                        "use workflow"
                                    },
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                        // export * from '...' is not allowed
                        emit_error(WorkflowErrorKind::InvalidExport {
                            span: export_all.span,
                            directive: if self.has_file_step_directive {
                                "use step"
                            } else {
                                "use workflow"
                            },
                        });
                    }
                    _ => {}
                }
            }

            item.visit_mut_with(self);

            // After visiting the item, check if we need to add a workflowId assignment
            if matches!(self.mode, TransformMode::Client) {
                match item {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                        if let Decl::Fn(fn_decl) = &export_decl.decl {
                            let fn_name = fn_decl.ident.sym.to_string();
                            if self.workflow_function_names.contains(&fn_name) {
                                items_to_insert.push((
                                    i + 1,
                                    ModuleItem::Stmt(self.create_workflow_id_assignment(
                                        &fn_name,
                                        fn_decl.function.span,
                                    )),
                                ));
                            }
                        } else if let Decl::Var(var_decl) = &export_decl.decl {
                            for declarator in &var_decl.decls {
                                if let Pat::Ident(binding) = &declarator.name {
                                    let name = binding.id.sym.to_string();
                                    if self.workflow_function_names.contains(&name) {
                                        if let Some(init) = &declarator.init {
                                            let span = match &**init {
                                                Expr::Fn(fn_expr) => fn_expr.function.span,
                                                Expr::Arrow(arrow_expr) => arrow_expr.span,
                                                _ => declarator.span,
                                            };
                                            items_to_insert.push((
                                                i + 1,
                                                ModuleItem::Stmt(
                                                    self.create_workflow_id_assignment(&name, span),
                                                ),
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(default_decl)) => {
                        if let DefaultDecl::Fn(fn_expr) = &default_decl.decl {
                            if let Some(ident) = &fn_expr.ident {
                                let fn_name = ident.sym.to_string();
                                if self.workflow_function_names.contains(&fn_name) {
                                    items_to_insert.push((
                                        i + 1,
                                        ModuleItem::Stmt(self.create_workflow_id_assignment(
                                            &fn_name,
                                            fn_expr.function.span,
                                        )),
                                    ));
                                }
                            } else {
                                // Default export without name, use "defaultWorkflow"
                                let fn_name = "defaultWorkflow";
                                if self.workflow_function_names.contains(fn_name) {
                                    items_to_insert.push((
                                        i + 1,
                                        ModuleItem::Stmt(self.create_workflow_id_assignment(
                                            fn_name,
                                            fn_expr.function.span,
                                        )),
                                    ));
                                }
                            }
                        }
                    }
                    ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                        let fn_name = fn_decl.ident.sym.to_string();
                        if self.workflow_function_names.contains(&fn_name) {
                            items_to_insert.push((
                                i + 1,
                                ModuleItem::Stmt(self.create_workflow_id_assignment(
                                    &fn_name,
                                    fn_decl.function.span,
                                )),
                            ));
                        }
                    }
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
                        for declarator in &var_decl.decls {
                            if let Pat::Ident(binding) = &declarator.name {
                                let name = binding.id.sym.to_string();
                                if self.workflow_function_names.contains(&name) {
                                    if let Some(init) = &declarator.init {
                                        let span = match &**init {
                                            Expr::Fn(fn_expr) => fn_expr.function.span,
                                            Expr::Arrow(arrow_expr) => arrow_expr.span,
                                            _ => declarator.span,
                                        };
                                        items_to_insert.push((
                                            i + 1,
                                            ModuleItem::Stmt(
                                                self.create_workflow_id_assignment(&name, span),
                                            ),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // Insert workflowId assignments in reverse order to maintain indices
        for (index, item) in items_to_insert.into_iter().rev() {
            items.insert(index, item);
        }

        // In workflow mode, add workflowId property to workflow functions
        if self.mode == TransformMode::Workflow && !self.workflow_exports_to_expand.is_empty() {
            // Process workflow functions to add workflowId property
            let workflow_functions: Vec<_> = self.workflow_exports_to_expand.drain(..).collect();

            for (fn_name, _, span) in workflow_functions {
                // Add workflowId assignment after the function declaration
                items.push(ModuleItem::Stmt(
                    self.create_workflow_id_assignment(&fn_name, span),
                ));
            }
        }

        // Step function marking is now handled inside the useStep() function
        // No need to add Object.defineProperty statements in the output

        // Clear the workflow_functions_needing_id since we've already processed them
        self.workflow_functions_needing_id.clear();

        // In workflow mode, mark all step functions with the STEP_FUNCTION_NAME_SYMBOL
        if self.mode == TransformMode::Workflow {
            let step_functions: Vec<_> = self.step_function_names.iter().cloned().collect();

            // Collect function marking statements first (to avoid borrow conflicts)
            let mut step_marking_statements = Vec::new();
            for item in items.iter() {
                match item {
                    ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                        let fn_name = fn_decl.ident.sym.to_string();
                        if step_functions.contains(&fn_name) {
                            step_marking_statements.push(
                                self.create_step_function_marking(&fn_name, fn_decl.function.span),
                            );
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                        if let Decl::Fn(fn_decl) = &export_decl.decl {
                            let fn_name = fn_decl.ident.sym.to_string();
                            if step_functions.contains(&fn_name) {
                                step_marking_statements.push(
                                    self.create_step_function_marking(
                                        &fn_name,
                                        fn_decl.function.span,
                                    ),
                                );
                            }
                        } else if let Decl::Var(var_decl) = &export_decl.decl {
                            // Handle exported variable declarations like `export const stepArrow = async () => {}`
                            for declarator in &var_decl.decls {
                                if let Pat::Ident(binding) = &declarator.name {
                                    let name = binding.id.sym.to_string();
                                    if step_functions.contains(&name) {
                                        if let Some(init) = &declarator.init {
                                            let span = match &**init {
                                                Expr::Fn(fn_expr) => fn_expr.function.span,
                                                Expr::Arrow(arrow_expr) => arrow_expr.span,
                                                _ => declarator.span,
                                            };
                                            step_marking_statements.push(
                                                self.create_step_function_marking(&name, span),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
                        // Handle non-exported variable declarations like `const stepArrow = async () => {}`
                        for declarator in &var_decl.decls {
                            if let Pat::Ident(binding) = &declarator.name {
                                let name = binding.id.sym.to_string();
                                if step_functions.contains(&name) {
                                    if let Some(init) = &declarator.init {
                                        let span = match &**init {
                                            Expr::Fn(fn_expr) => fn_expr.function.span,
                                            Expr::Arrow(arrow_expr) => arrow_expr.span,
                                            _ => declarator.span,
                                        };
                                        step_marking_statements.push(
                                            self.create_step_function_marking(&name, span),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }

            // Now add all the marking statements
            for stmt in step_marking_statements {
                items.push(ModuleItem::Stmt(stmt));
            }
        }

        // In workflow mode, convert step functions to const declarations
        // (Must be after visit_mut_children_with so step_function_names is populated)
        if self.mode == TransformMode::Workflow {
            let mut items_to_replace: Vec<(usize, ModuleItem)> = Vec::new();

            for (idx, item) in items.iter_mut().enumerate() {
                match item {
                    // Handle exported function declarations
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                        if let Decl::Fn(fn_decl) = &export_decl.decl {
                            let fn_name = fn_decl.ident.sym.to_string();
                            if self.step_function_names.contains(&fn_name) {
                                // This is a step function - convert to var declaration (for named functions)
                                let step_id =
                                    self.create_id(Some(&fn_name), fn_decl.function.span, false);
                                let initializer = self.create_step_initializer(&step_id);
                                // Preserve the original identifier's syntax context to avoid SWC renaming
                                let orig_ctxt = fn_decl.ident.ctxt;
                                export_decl.decl = Decl::Var(Box::new(VarDecl {
                                    span: fn_decl.function.span,
                                    ctxt: orig_ctxt,
                                    kind: VarDeclKind::Var,
                                    decls: vec![VarDeclarator {
                                        span: fn_decl.function.span,
                                        name: Pat::Ident(BindingIdent {
                                            id: Ident::new(
                                                fn_name.as_str().into(),
                                                fn_decl.ident.span,
                                                orig_ctxt,
                                            ),
                                            type_ann: None,
                                        }),
                                        init: Some(Box::new(initializer)),
                                        definite: false,
                                    }],
                                    declare: false,
                                }));
                            }
                        } else if let Decl::Var(var_decl) = &mut export_decl.decl {
                            // Handle exported variable declarations (arrow functions)
                            // Check if any declarators are step functions
                            let has_step_functions = var_decl.decls.iter().any(|declarator| {
                                if let Pat::Ident(binding) = &declarator.name {
                                    let name = binding.id.sym.to_string();
                                    self.step_function_names.contains(&name)
                                } else {
                                    false
                                }
                            });

                            if has_step_functions {
                                let mut new_var_decl = (**var_decl).clone();
                                // Preserve the original variable kind (let/const)
                                let original_kind = var_decl.kind;
                                // Process all step functions in this VarDecl
                                for declarator in &mut new_var_decl.decls {
                                    if let Pat::Ident(binding) = &declarator.name {
                                        let name = binding.id.sym.to_string();
                                        if self.step_function_names.contains(&name) {
                                            // This is an exported step function variable - convert to assignment
                                            let step_id =
                                                self.create_id(Some(&name), declarator.span, false);
                                            let initializer = self.create_step_initializer(&step_id);
                                            // Preserve the original identifier's syntax context to avoid SWC renaming
                                            let orig_ctxt = binding.id.ctxt;
                                            declarator.init = Some(Box::new(initializer));
                                            // Update the identifier's syntax context
                                            let new_ident = Ident::new(
                                                name.as_str().into(),
                                                binding.id.span,
                                                orig_ctxt,
                                            );
                                            if let Pat::Ident(ref mut new_binding) = declarator.name {
                                                new_binding.id = new_ident;
                                            }
                                        }
                                    }
                                }
                                new_var_decl.kind = original_kind;
                                export_decl.decl = Decl::Var(Box::new(new_var_decl));
                            }
                        }
                    }
                    // Handle non-exported function declarations
                    ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                        let fn_name = fn_decl.ident.sym.to_string();
                        if self.step_function_names.contains(&fn_name) {
                            // This is a non-exported step function - convert to var declaration (for named functions)
                            let step_id =
                                self.create_id(Some(&fn_name), fn_decl.function.span, false);
                            let initializer = self.create_step_initializer(&step_id);
                            // Preserve the original identifier's syntax context to avoid SWC renaming
                            let orig_ctxt = fn_decl.ident.ctxt;
                            let var_decl = Decl::Var(Box::new(VarDecl {
                                span: fn_decl.function.span,
                                ctxt: orig_ctxt,
                                kind: VarDeclKind::Var,
                                decls: vec![VarDeclarator {
                                    span: fn_decl.function.span,
                                    name: Pat::Ident(BindingIdent {
                                        id: Ident::new(
                                            fn_name.as_str().into(),
                                            fn_decl.ident.span,
                                            orig_ctxt,
                                        ),
                                        type_ann: None,
                                    }),
                                    init: Some(Box::new(initializer)),
                                    definite: false,
                                }],
                                declare: false,
                            }));

                            items_to_replace.push((idx, ModuleItem::Stmt(Stmt::Decl(var_decl))));
                        }
                    }
                    // Handle non-exported variable declarations (arrow functions)
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
                        // Check if any declarators are step functions
                        let has_step_functions = var_decl.decls.iter().any(|declarator| {
                            if let Pat::Ident(binding) = &declarator.name {
                                let name = binding.id.sym.to_string();
                                self.step_function_names.contains(&name)
                            } else {
                                false
                            }
                        });

                        if has_step_functions {
                            let mut new_var_decl = (**var_decl).clone();
                            // Preserve the original variable kind (let/const)
                            let original_kind = var_decl.kind;
                            // Process all step functions in this VarDecl
                            for declarator in &mut new_var_decl.decls {
                                if let Pat::Ident(binding) = &declarator.name {
                                    let name = binding.id.sym.to_string();
                                    if self.step_function_names.contains(&name) {
                                        // This is a non-exported step function variable - convert to assignment
                                        let step_id =
                                            self.create_id(Some(&name), declarator.span, false);
                                        let initializer = self.create_step_initializer(&step_id);
                                        declarator.init = Some(Box::new(initializer));
                                    }
                                }
                            }
                            new_var_decl.kind = original_kind;
                            items_to_replace.push((
                                idx,
                                ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(
                                    new_var_decl,
                                )))),
                            ));
                        }
                    }
                    _ => {}
                }
            }

            // Apply replacements in reverse order to maintain indices
            for (idx, new_item) in items_to_replace.iter().rev() {
                items[*idx] = new_item.clone();
            }
        }

        // Perform dead code elimination in workflow and client mode
        self.remove_dead_code(items);
    }

    fn visit_mut_fn_decl(&mut self, fn_decl: &mut FnDecl) {
        let fn_name = fn_decl.ident.sym.to_string();

        // Check for step directive first
        if self.has_step_directive(&fn_decl.function, false) {
            // Validate that it's async - emit error if not
            if !fn_decl.function.is_async {
                emit_error(WorkflowErrorKind::NonAsyncFunction {
                    span: fn_decl.function.span,
                    directive: "use step",
                });
            } else {
                // It's valid - proceed with transformation
                self.step_function_names.insert(fn_name.clone());

                match self.mode {
                    TransformMode::Step => {
                        self.remove_use_step_directive(&mut fn_decl.function.body);
                        self.create_registration_call(&fn_name, fn_decl.function.span);
                    }
                    TransformMode::Workflow => {
                        // For workflow mode, we need to replace the entire declaration
                        // This will be handled at a higher level
                    }
                    TransformMode::Client => {
                        // Step functions are completely removed in client mode
                        // This will be handled at a higher level
                    }
                }
            }
        } else if self.has_workflow_directive(&fn_decl.function, false) {
            // Validate that it's async - emit error if not
            if !fn_decl.function.is_async {
                emit_error(WorkflowErrorKind::NonAsyncFunction {
                    span: fn_decl.function.span,
                    directive: "use workflow",
                });
            } else {
                // It's valid - proceed with transformation
                self.workflow_function_names.insert(fn_name.clone());

                match self.mode {
                    TransformMode::Step => {
                        // Workflow functions are not processed in step mode
                    }
                    TransformMode::Workflow => {
                        // For workflow mode, we need to replace the entire declaration
                        // This will be handled at a higher level
                    }
                    TransformMode::Client => {
                        // Workflow functions are transformed in client mode
                        // This will be handled at a higher level
                    }
                }
            }
        }

        fn_decl.visit_mut_children_with(self);
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        match stmt {
            Stmt::Decl(Decl::Fn(fn_decl)) => {
                let fn_name = fn_decl.ident.sym.to_string();

                if self.should_transform_function(&fn_decl.function, false) {
                    if self.validate_async_function(&fn_decl.function, fn_decl.function.span) {
                        self.step_function_names.insert(fn_name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                self.create_registration_call(&fn_name, fn_decl.function.span);
                                stmt.visit_mut_children_with(self);
                            }
                            TransformMode::Workflow => {
                                // Keep the function declaration but replace its body with a proxy call
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                if let Some(body) = &mut fn_decl.function.body {
                                    let step_id = self.create_id(
                                        Some(&fn_name),
                                        fn_decl.function.span,
                                        false,
                                    );
                                    let mut proxy_call = self.create_step_proxy(&step_id);
                                    // Add function arguments to the proxy call
                                    if let Expr::Call(call) = &mut proxy_call {
                                        call.args = fn_decl
                                            .function
                                            .params
                                            .iter()
                                            .map(|param| {
                                                // Check if this is a rest parameter
                                                let is_rest = matches!(param.pat, Pat::Rest(_));
                                                ExprOrSpread {
                                                    spread: if is_rest {
                                                        Some(DUMMY_SP)
                                                    } else {
                                                        None
                                                    },
                                                    expr: Box::new(self.pat_to_expr(&param.pat)),
                                                }
                                            })
                                            .collect();
                                    }
                                    body.stmts = vec![Stmt::Return(ReturnStmt {
                                        span: DUMMY_SP,
                                        arg: Some(Box::new(proxy_call)),
                                    })];
                                }
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and keep the function as-is
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                stmt.visit_mut_children_with(self);
                            }
                        }
                    }
                } else if self.should_transform_workflow_function(&fn_decl.function, false) {
                    if self.validate_async_function(&fn_decl.function, fn_decl.function.span) {
                        self.workflow_function_names.insert(fn_name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                // Workflow functions are not processed in step mode
                                stmt.visit_mut_children_with(self);
                            }
                            TransformMode::Workflow => {
                                // In workflow mode, just remove the directive from workflow functions
                                self.remove_use_workflow_directive(&mut fn_decl.function.body);
                                stmt.visit_mut_children_with(self);
                            }
                            TransformMode::Client => {
                                // In client mode, replace workflow function body with error throw
                                self.remove_use_workflow_directive(&mut fn_decl.function.body);
                                if let Some(body) = &mut fn_decl.function.body {
                                    let error_msg = format!(
                                        "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                        fn_name, fn_name
                                    );
                                    let error_expr = Expr::New(NewExpr {
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        callee: Box::new(Expr::Ident(Ident::new(
                                            "Error".into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                        args: Some(vec![ExprOrSpread {
                                            spread: None,
                                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                                span: DUMMY_SP,
                                                value: error_msg.into(),
                                                raw: None,
                                            }))),
                                        }]),
                                        type_args: None,
                                    });
                                    body.stmts = vec![Stmt::Throw(ThrowStmt {
                                        span: DUMMY_SP,
                                        arg: Box::new(error_expr),
                                    })];
                                }
                                self.workflow_functions_needing_id
                                    .push((fn_name.clone(), fn_decl.function.span));
                                stmt.visit_mut_children_with(self);
                            }
                        }
                    }
                } else {
                    stmt.visit_mut_children_with(self);
                }
            }
            Stmt::Decl(Decl::Var(_)) => {
                // Handle variable declarations with function expressions
                stmt.visit_mut_children_with(self);
            }
            _ => {
                stmt.visit_mut_children_with(self);
            }
        }
    }

    fn visit_mut_export_decl(&mut self, export_decl: &mut ExportDecl) {
        match &mut export_decl.decl {
            Decl::Fn(fn_decl) => {
                let fn_name = fn_decl.ident.sym.to_string();

                // Check for step directive first
                if self.has_step_directive(&fn_decl.function, true) {
                    // Validate that it's async - emit error if not
                    if !fn_decl.function.is_async {
                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                            span: fn_decl.function.span,
                            directive: "use step",
                        });
                    } else {
                        // It's valid - proceed with transformation
                        self.step_function_names.insert(fn_name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                self.create_registration_call(&fn_name, fn_decl.function.span);
                                export_decl.visit_mut_children_with(self);
                            }
                            TransformMode::Workflow => {
                                // Collect for later conversion in visit_mut_module_items
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                let step_id =
                                    self.create_id(Some(&fn_name), fn_decl.function.span, false);
                                self.step_exports_to_convert.push((
                                    fn_name.clone(),
                                    step_id,
                                    fn_decl.function.span,
                                ));
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and keep the function as-is
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                export_decl.visit_mut_children_with(self);
                            }
                        }
                    }
                } else if self.has_workflow_directive(&fn_decl.function, true) {
                    // Validate that it's async - emit error if not
                    if !fn_decl.function.is_async {
                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                            span: fn_decl.function.span,
                            directive: "use workflow",
                        });
                    } else {
                        // It's valid - proceed with transformation
                        self.workflow_function_names.insert(fn_name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                // Workflow functions are not processed in step mode
                                export_decl.visit_mut_children_with(self);
                            }
                            TransformMode::Workflow => {
                                // In workflow mode, just remove the directive
                                self.remove_use_workflow_directive(&mut fn_decl.function.body);

                                // Mark this function for expansion into multiple exports
                                self.workflow_exports_to_expand.push((
                                    fn_name.clone(),
                                    Expr::Fn(FnExpr {
                                        ident: Some(fn_decl.ident.clone()),
                                        function: fn_decl.function.clone(),
                                    }),
                                    fn_decl.function.span,
                                ));

                                export_decl.visit_mut_children_with(self);
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and track for property addition
                                self.remove_use_workflow_directive(&mut fn_decl.function.body);
                                self.workflow_functions_needing_id
                                    .push((fn_name.clone(), fn_decl.function.span));
                                export_decl.visit_mut_children_with(self);
                            }
                        }
                    }
                } else {
                    export_decl.visit_mut_children_with(self);
                }
            }
            Decl::Var(var_decl) => {
                // Handle exported variable declarations with function expressions/arrow functions
                for decl in var_decl.decls.iter_mut() {
                    if let Some(init) = &mut decl.init {
                        if let Pat::Ident(binding) = &decl.name {
                            let name = binding.id.sym.to_string();

                            match &mut **init {
                                Expr::Fn(fn_expr) => {
                                    if self.should_transform_function(&fn_expr.function, true) {
                                        if self.validate_async_function(
                                            &fn_expr.function,
                                            fn_expr.function.span,
                                        ) {
                                            self.step_function_names.insert(name.clone());

                                            match self.mode {
                                                TransformMode::Step => {
                                                    self.remove_use_step_directive(
                                                        &mut fn_expr.function.body,
                                                    );
                                                    self.create_registration_call(
                                                        &name,
                                                        fn_expr.function.span,
                                                    );
                                                }
                                                TransformMode::Workflow => {
                                                    // Replace the function expression with an initializer call
                                                    self.remove_use_step_directive(
                                                        &mut fn_expr.function.body,
                                                    );
                                                    let step_id = self.create_id(
                                                        Some(&name),
                                                        fn_expr.function.span,
                                                        false,
                                                    );
                                                    // Replace the entire function expression with the initializer
                                                    *init =
                                                        Box::new(self.create_step_initializer(
                                                            &step_id,
                                                        ));
                                                }
                                                TransformMode::Client => {
                                                    // In client mode, just remove the directive and keep the function as-is
                                                    self.remove_use_step_directive(
                                                        &mut fn_expr.function.body,
                                                    );
                                                }
                                            }
                                        }
                                    } else if self
                                        .should_transform_workflow_function(&fn_expr.function, true)
                                    {
                                        if self.validate_async_function(
                                            &fn_expr.function,
                                            fn_expr.function.span,
                                        ) {
                                            self.workflow_function_names.insert(name.clone());

                                            match self.mode {
                                                TransformMode::Step => {
                                                    // Workflow functions are not processed in step mode
                                                }
                                                TransformMode::Workflow => {
                                                    // In workflow mode, just remove the directive
                                                    self.remove_use_workflow_directive(
                                                        &mut fn_expr.function.body,
                                                    );

                                                    // Mark this function for expansion
                                                    self.workflow_exports_to_expand.push((
                                                        name.clone(),
                                                        Expr::Fn(fn_expr.clone()),
                                                        fn_expr.function.span,
                                                    ));
                                                }
                                                TransformMode::Client => {
                                                    // Remove directive and track function for workflowId property
                                                    self.remove_use_workflow_directive(
                                                        &mut fn_expr.function.body,
                                                    );
                                                    self.workflow_functions_needing_id.push((
                                                        name.clone(),
                                                        fn_expr.function.span,
                                                    ));
                                                }
                                            }
                                        }
                                    }
                                }
                                Expr::Arrow(arrow_expr) => {
                                    // Check for step directive first
                                    if self.has_step_directive_arrow(arrow_expr, true) {
                                        // Validate that it's async - emit error if not
                                        if !arrow_expr.is_async {
                                            emit_error(WorkflowErrorKind::NonAsyncFunction {
                                                span: arrow_expr.span,
                                                directive: "use step",
                                            });
                                        } else {
                                            // It's valid - proceed with transformation
                                            self.step_function_names.insert(name.clone());

                                            match self.mode {
                                                TransformMode::Step => {
                                                    self.remove_use_step_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );
                                                    self.create_registration_call(
                                                        &name,
                                                        arrow_expr.span,
                                                    );
                                                }
                                                TransformMode::Workflow => {
                                                    // Replace the arrow function with an initializer call
                                                    self.remove_use_step_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );
                                                    let step_id = self.create_id(
                                                        Some(&name),
                                                        arrow_expr.span,
                                                        false,
                                                    );
                                                    // Replace the entire arrow function with the initializer
                                                    *init =
                                                        Box::new(self.create_step_initializer(
                                                            &step_id,
                                                        ));
                                                }
                                                TransformMode::Client => {
                                                    // In client mode, just remove the directive and keep the function as-is
                                                    self.remove_use_step_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );
                                                }
                                            }
                                        }
                                    } else if self.has_workflow_directive_arrow(arrow_expr, true) {
                                        // Validate that it's async - emit error if not
                                        if !arrow_expr.is_async {
                                            emit_error(WorkflowErrorKind::NonAsyncFunction {
                                                span: arrow_expr.span,
                                                directive: "use workflow",
                                            });
                                        } else {
                                            // It's valid - proceed with transformation
                                            self.workflow_function_names.insert(name.clone());

                                            match self.mode {
                                                TransformMode::Step => {
                                                    // Workflow functions are not processed in step mode
                                                }
                                                TransformMode::Workflow => {
                                                    // In workflow mode, just remove the directive
                                                    self.remove_use_workflow_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );

                                                    // Mark this function for expansion
                                                    self.workflow_exports_to_expand.push((
                                                        name.clone(),
                                                        Expr::Arrow(arrow_expr.clone()),
                                                        arrow_expr.span,
                                                    ));
                                                }
                                                TransformMode::Client => {
                                                    // Remove directive and track function for workflowId property
                                                    self.remove_use_workflow_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );
                                                    self.workflow_functions_needing_id
                                                        .push((name.clone(), arrow_expr.span));
                                                }
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                export_decl.visit_mut_children_with(self);
            }
            _ => {
                export_decl.visit_mut_children_with(self);
            }
        }
    }

    fn visit_mut_var_decl(&mut self, var_decl: &mut VarDecl) {
        // Handle variable declarations with function expressions
        for decl in var_decl.decls.iter_mut() {
            if let Some(init) = &mut decl.init {
                if let Pat::Ident(binding) = &decl.name {
                    let name = binding.id.sym.to_string();

                    match &mut **init {
                        Expr::Fn(fn_expr) => {
                            // Check for step directive first
                            if self.has_step_directive(&fn_expr.function, false) {
                                // Validate that it's async - emit error if not
                                if !fn_expr.function.is_async {
                                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                                        span: fn_expr.function.span,
                                        directive: "use step",
                                    });
                                } else {
                                    // It's valid - proceed with transformation
                                    self.step_function_names.insert(name.clone());

                                    match self.mode {
                                        TransformMode::Step => {
                                            self.remove_use_step_directive(
                                                &mut fn_expr.function.body,
                                            );
                                            self.create_registration_call(
                                                &name,
                                                fn_expr.function.span,
                                            );
                                        }
                                        TransformMode::Workflow => {
                                            // Keep the function expression but replace its body with a proxy call
                                            self.remove_use_step_directive(
                                                &mut fn_expr.function.body,
                                            );
                                            if let Some(body) = &mut fn_expr.function.body {
                                                let step_id = self.create_id(
                                                    Some(&name),
                                                    fn_expr.function.span,
                                                    false,
                                                );
                                                let mut proxy_call =
                                                    self.create_step_proxy(&step_id);
                                                // Add function arguments to the proxy call
                                                if let Expr::Call(call) = &mut proxy_call {
                                                    call.args = fn_expr
                                                        .function
                                                        .params
                                                        .iter()
                                                        .map(|param| {
                                                            // Check if this is a rest parameter
                                                            let is_rest =
                                                                matches!(param.pat, Pat::Rest(_));
                                                            ExprOrSpread {
                                                                spread: if is_rest {
                                                                    Some(DUMMY_SP)
                                                                } else {
                                                                    None
                                                                },
                                                                expr: Box::new(
                                                                    self.pat_to_expr(&param.pat),
                                                                ),
                                                            }
                                                        })
                                                        .collect();
                                                }
                                                body.stmts = vec![Stmt::Return(ReturnStmt {
                                                    span: DUMMY_SP,
                                                    arg: Some(Box::new(proxy_call)),
                                                })];
                                            }
                                        }
                                        TransformMode::Client => {
                                            // In client mode, just remove the directive and keep the function as-is
                                            self.remove_use_step_directive(
                                                &mut fn_expr.function.body,
                                            );
                                        }
                                    }
                                }
                            } else if self.has_workflow_directive(&fn_expr.function, false) {
                                // Validate that it's async - emit error if not
                                if !fn_expr.function.is_async {
                                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                                        span: fn_expr.function.span,
                                        directive: "use workflow",
                                    });
                                } else {
                                    // It's valid - proceed with transformation
                                    self.workflow_function_names.insert(name.clone());

                                    match self.mode {
                                        TransformMode::Step => {
                                            // Workflow functions are not processed in step mode
                                        }
                                        TransformMode::Workflow => {
                                            // In workflow mode, just remove the directive
                                            // Non-export workflow functions don't get transformed
                                            self.remove_use_workflow_directive(
                                                &mut fn_expr.function.body,
                                            );
                                        }
                                        TransformMode::Client => {
                                            // Replace workflow function body with error throw
                                            self.remove_use_workflow_directive(
                                                &mut fn_expr.function.body,
                                            );
                                            if let Some(body) = &mut fn_expr.function.body {
                                                let error_msg = format!(
                                                    "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                                    name, name
                                                );
                                                let error_expr = Expr::New(NewExpr {
                                                    span: DUMMY_SP,
                                                    ctxt: SyntaxContext::empty(),
                                                    callee: Box::new(Expr::Ident(Ident::new(
                                                        "Error".into(),
                                                        DUMMY_SP,
                                                        SyntaxContext::empty(),
                                                    ))),
                                                    args: Some(vec![ExprOrSpread {
                                                        spread: None,
                                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                                            span: DUMMY_SP,
                                                            value: error_msg.into(),
                                                            raw: None,
                                                        }))),
                                                    }]),
                                                    type_args: None,
                                                });
                                                body.stmts = vec![Stmt::Throw(ThrowStmt {
                                                    span: DUMMY_SP,
                                                    arg: Box::new(error_expr),
                                                })];
                                            }
                                            self.workflow_functions_needing_id
                                                .push((name.clone(), fn_expr.function.span));
                                        }
                                    }
                                }
                            }
                        }
                        Expr::Arrow(arrow_expr) => {
                            // Check for step directive first
                            if self.has_step_directive_arrow(arrow_expr, false) {
                                // Validate that it's async - emit error if not
                                if !arrow_expr.is_async {
                                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                                        span: arrow_expr.span,
                                        directive: "use step",
                                    });
                                } else {
                                    // It's valid - proceed with transformation
                                    self.step_function_names.insert(name.clone());

                                    match self.mode {
                                        TransformMode::Step => {
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                            self.create_registration_call(&name, arrow_expr.span);
                                        }
                                        TransformMode::Workflow => {
                                            // Keep the arrow function but replace its body with a proxy call
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                            let step_id =
                                                self.create_id(Some(&name), arrow_expr.span, false);
                                            let mut proxy_call = self.create_step_proxy(&step_id);
                                            // Add function arguments to the proxy call
                                            if let Expr::Call(call) = &mut proxy_call {
                                                call.args = arrow_expr
                                                    .params
                                                    .iter()
                                                    .map(|param| {
                                                        // Check if this is a rest parameter
                                                        let is_rest = matches!(param, Pat::Rest(_));
                                                        ExprOrSpread {
                                                            spread: if is_rest {
                                                                Some(DUMMY_SP)
                                                            } else {
                                                                None
                                                            },
                                                            expr: Box::new(self.pat_to_expr(param)),
                                                        }
                                                    })
                                                    .collect();
                                            }
                                            arrow_expr.body = Box::new(BlockStmtOrExpr::Expr(
                                                Box::new(proxy_call),
                                            ));
                                        }
                                        TransformMode::Client => {
                                            // In client mode, just remove the directive and keep the function as-is
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                        }
                                    }
                                }
                            } else if self.has_workflow_directive_arrow(arrow_expr, false) {
                                // Validate that it's async - emit error if not
                                if !arrow_expr.is_async {
                                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                                        span: arrow_expr.span,
                                        directive: "use workflow",
                                    });
                                } else {
                                    // It's valid - proceed with transformation
                                    self.workflow_function_names.insert(name.clone());

                                    match self.mode {
                                        TransformMode::Step => {
                                            // Workflow functions are not processed in step mode
                                        }
                                        TransformMode::Workflow => {
                                            // In workflow mode, just remove the directive
                                            // Non-export workflow functions don't get transformed
                                            self.remove_use_workflow_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                        }
                                        TransformMode::Client => {
                                            // Replace workflow function body with error throw
                                            self.remove_use_workflow_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                            let error_msg = format!(
                                                "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                                name, name
                                            );
                                            let error_expr = Expr::New(NewExpr {
                                                span: DUMMY_SP,
                                                ctxt: SyntaxContext::empty(),
                                                callee: Box::new(Expr::Ident(Ident::new(
                                                    "Error".into(),
                                                    DUMMY_SP,
                                                    SyntaxContext::empty(),
                                                ))),
                                                args: Some(vec![ExprOrSpread {
                                                    spread: None,
                                                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                                                        span: DUMMY_SP,
                                                        value: error_msg.into(),
                                                        raw: None,
                                                    }))),
                                                }]),
                                                type_args: None,
                                            });
                                            arrow_expr.body =
                                                Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                                                    span: DUMMY_SP,
                                                    ctxt: SyntaxContext::empty(),
                                                    stmts: vec![Stmt::Throw(ThrowStmt {
                                                        span: DUMMY_SP,
                                                        arg: Box::new(error_expr),
                                                    })],
                                                }));
                                            self.workflow_functions_needing_id
                                                .push((name.clone(), arrow_expr.span));
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        var_decl.visit_mut_children_with(self);
    }

    // Handle JSX attributes with function values
    fn visit_mut_jsx_attr(&mut self, attr: &mut JSXAttr) {
        // Track function names from JSX attributes
        if let (Some(JSXAttrValue::JSXExprContainer(_container)), JSXAttrName::Ident(_ident_name)) =
            (&attr.value, &attr.name)
        {
            // Store the attribute name for function naming
            // This would need to be added to the struct as a field
        }

        attr.visit_mut_children_with(self);
    }

    // Handle object properties with function values
    fn visit_mut_prop_or_spread(&mut self, prop: &mut PropOrSpread) {
        match prop {
            PropOrSpread::Prop(boxed_prop) => {
                match &mut **boxed_prop {
                    Prop::Method(method_prop) => {
                        // Handle object methods
                        let has_step = self.has_use_step_directive(&method_prop.function.body);
                        let has_workflow =
                            self.has_use_workflow_directive(&method_prop.function.body);

                        if has_step && !method_prop.function.is_async {
                            emit_error(WorkflowErrorKind::NonAsyncFunction {
                                span: method_prop.function.span,
                                directive: "use step",
                            });
                        } else if has_workflow && !method_prop.function.is_async {
                            emit_error(WorkflowErrorKind::NonAsyncFunction {
                                span: method_prop.function.span,
                                directive: "use workflow",
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }

        prop.visit_mut_children_with(self);
    }

    // Handle class methods
    fn visit_mut_class_method(&mut self, method: &mut ClassMethod) {
        if !method.is_static {
            // Instance methods can't be step/workflow functions
            let has_step = self.has_use_step_directive(&method.function.body);
            let has_workflow = self.has_use_workflow_directive(&method.function.body);

            if has_step {
                HANDLER.with(|handler| {
                    handler
                        .struct_span_err(
                            method.span,
                            "Instance methods cannot be marked with \"use step\". Only static methods, functions, and object methods are supported.",
                        )
                        .emit()
                });
            } else if has_workflow {
                HANDLER.with(|handler| {
                    handler
                        .struct_span_err(
                            method.span,
                            "Instance methods cannot be marked with \"use workflow\". Only static methods, functions, and object methods are supported.",
                        )
                        .emit()
                });
            }
        } else {
            // Static methods can be step/workflow functions
            method.visit_mut_children_with(self);
        }
    }

    // Handle assignment expressions
    fn visit_mut_assign_expr(&mut self, assign: &mut AssignExpr) {
        // Track function names from assignments like `foo = async () => {}`
        assign.visit_mut_children_with(self);
    }

    // Override visit_mut_expr to track closure variables
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        if !self.in_module_level && self.should_track_names {
            if let Ok(name) = Name::try_from(&*expr) {
                if self.in_callee {
                    // This is a callee, we need to track the actual value
                    // For now, just track the name
                }
                self.names.push(name);
            }
        }

        expr.visit_mut_children_with(self);
    }

    // Handle export default declarations
    fn visit_mut_export_default_decl(&mut self, decl: &mut ExportDefaultDecl) {
        match &mut decl.decl {
            DefaultDecl::Fn(fn_expr) => {
                let fn_name = fn_expr
                    .ident
                    .as_ref()
                    .map(|i| i.sym.to_string())
                    .unwrap_or_else(|| "default".to_string());

                if self.should_transform_workflow_function(&fn_expr.function, true) {
                    if self.validate_async_function(&fn_expr.function, fn_expr.function.span) {
                        self.workflow_function_names.insert(fn_name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                // Workflow functions are not processed in step mode
                            }
                            TransformMode::Workflow => {
                                // In workflow mode, just remove the directive
                                self.remove_use_workflow_directive(&mut fn_expr.function.body);

                                // We'll need to handle the expansion differently for default exports
                                // For now, just track it
                                let actual_name = format!(
                                    "$$default{}",
                                    if fn_name == "default" { "Workflow" } else { "" }
                                );
                                self.workflow_exports_to_expand.push((
                                    actual_name,
                                    Expr::Fn(fn_expr.clone()),
                                    fn_expr.function.span,
                                ));
                            }
                            TransformMode::Client => {
                                // In client mode, replace workflow function body with error throw
                                self.remove_use_workflow_directive(&mut fn_expr.function.body);
                                let actual_name = fn_expr
                                    .ident
                                    .as_ref()
                                    .map(|i| i.sym.to_string())
                                    .unwrap_or_else(|| "defaultWorkflow".to_string());
                                if let Some(body) = &mut fn_expr.function.body {
                                    let error_msg = format!(
                                        "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                        actual_name, actual_name
                                    );
                                    let error_expr = Expr::New(NewExpr {
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        callee: Box::new(Expr::Ident(Ident::new(
                                            "Error".into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                        args: Some(vec![ExprOrSpread {
                                            spread: None,
                                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                                span: DUMMY_SP,
                                                value: error_msg.into(),
                                                raw: None,
                                            }))),
                                        }]),
                                        type_args: None,
                                    });
                                    body.stmts = vec![Stmt::Throw(ThrowStmt {
                                        span: DUMMY_SP,
                                        arg: Box::new(error_expr),
                                    })];
                                }
                                self.workflow_functions_needing_id
                                    .push((actual_name, fn_expr.function.span));
                            }
                        }
                    }
                } else if self.should_transform_function(&fn_expr.function, true) {
                    if self.validate_async_function(&fn_expr.function, fn_expr.function.span) {
                        self.step_function_names.insert(fn_name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                self.remove_use_step_directive(&mut fn_expr.function.body);
                                self.create_registration_call(&fn_name, fn_expr.function.span);
                            }
                            TransformMode::Workflow => {
                                // Replace function body with step proxy
                                self.remove_use_step_directive(&mut fn_expr.function.body);
                                if let Some(body) = &mut fn_expr.function.body {
                                    let step_id = self.create_id(
                                        Some(&fn_name),
                                        fn_expr.function.span,
                                        false,
                                    );
                                    let mut proxy_call = self.create_step_proxy(&step_id);
                                    // Add function arguments to the proxy call
                                    if let Expr::Call(call) = &mut proxy_call {
                                        call.args = fn_expr
                                            .function
                                            .params
                                            .iter()
                                            .map(|param| {
                                                let is_rest = matches!(param.pat, Pat::Rest(_));
                                                ExprOrSpread {
                                                    spread: if is_rest {
                                                        Some(DUMMY_SP)
                                                    } else {
                                                        None
                                                    },
                                                    expr: Box::new(self.pat_to_expr(&param.pat)),
                                                }
                                            })
                                            .collect();
                                    }
                                    body.stmts = vec![Stmt::Return(ReturnStmt {
                                        span: DUMMY_SP,
                                        arg: Some(Box::new(proxy_call)),
                                    })];
                                }
                            }
                            TransformMode::Client => {
                                // Transform step function body to use step run call
                                self.remove_use_step_directive(&mut fn_expr.function.body);
                            }
                        }
                    }
                }

                decl.visit_mut_children_with(self);
            }
            _ => {
                decl.visit_mut_children_with(self);
            }
        }
    }

    fn visit_mut_module_decl(&mut self, decl: &mut ModuleDecl) {
        match decl {
            ModuleDecl::ExportDecl(export_decl) => {
                match &mut export_decl.decl {
                    Decl::Fn(fn_decl) => {
                        let fn_name = fn_decl.ident.sym.to_string();

                        if self.has_workflow_directive(&fn_decl.function, false) {
                            if !fn_decl.function.is_async {
                                emit_error(WorkflowErrorKind::NonAsyncFunction {
                                    span: fn_decl.function.span,
                                    directive: "use workflow",
                                });
                            } else {
                                self.workflow_function_names.insert(fn_name.clone());

                                match self.mode {
                                    TransformMode::Step => {
                                        // Workflow functions are not processed in step mode
                                    }
                                    TransformMode::Workflow => {
                                        // In workflow mode, just remove the directive
                                        self.remove_use_workflow_directive(
                                            &mut fn_decl.function.body,
                                        );
                                        // Track for workflowId assignment in workflow mode
                                        self.workflow_exports_to_expand.push((
                                            fn_name.clone(),
                                            Expr::Fn(FnExpr {
                                                ident: Some(fn_decl.ident.clone()),
                                                function: fn_decl.function.clone(),
                                            }),
                                            fn_decl.function.span,
                                        ));
                                    }
                                    TransformMode::Client => {
                                        // Replace workflow function body with error throw
                                        self.remove_use_workflow_directive(
                                            &mut fn_decl.function.body,
                                        );
                                        if let Some(body) = &mut fn_decl.function.body {
                                            let error_msg = format!(
                                                "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                                fn_name, fn_name
                                            );
                                            let error_expr = Expr::New(NewExpr {
                                                span: DUMMY_SP,
                                                ctxt: SyntaxContext::empty(),
                                                callee: Box::new(Expr::Ident(Ident::new(
                                                    "Error".into(),
                                                    DUMMY_SP,
                                                    SyntaxContext::empty(),
                                                ))),
                                                args: Some(vec![ExprOrSpread {
                                                    spread: None,
                                                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                                                        span: DUMMY_SP,
                                                        value: error_msg.into(),
                                                        raw: None,
                                                    }))),
                                                }]),
                                                type_args: None,
                                            });
                                            body.stmts = vec![Stmt::Throw(ThrowStmt {
                                                span: DUMMY_SP,
                                                arg: Box::new(error_expr),
                                            })];
                                        }
                                        self.workflow_functions_needing_id
                                            .push((fn_name.clone(), fn_decl.function.span));
                                    }
                                }
                            }
                        }
                        // Also handle step functions in exports
                        else if self.has_step_directive(&fn_decl.function, false) {
                            if !fn_decl.function.is_async {
                                emit_error(WorkflowErrorKind::NonAsyncFunction {
                                    span: fn_decl.function.span,
                                    directive: "use step",
                                });
                            } else {
                                self.step_function_names.insert(fn_name.clone());

                                match self.mode {
                                    TransformMode::Step => {
                                        self.remove_use_step_directive(&mut fn_decl.function.body);
                                        self.create_registration_call(
                                            &fn_name,
                                            fn_decl.function.span,
                                        );
                                    }
                                    TransformMode::Workflow => {
                                        // Keep the function declaration but replace its body with a proxy call
                                        self.remove_use_step_directive(&mut fn_decl.function.body);
                                        if let Some(body) = &mut fn_decl.function.body {
                                            let step_id = self.create_id(
                                                Some(&fn_name),
                                                fn_decl.function.span,
                                                false,
                                            );
                                            let mut proxy_call = self.create_step_proxy(&step_id);
                                            // Add function arguments to the proxy call
                                            if let Expr::Call(call) = &mut proxy_call {
                                                call.args = fn_decl
                                                    .function
                                                    .params
                                                    .iter()
                                                    .map(|param| {
                                                        // Check if this is a rest parameter
                                                        let is_rest =
                                                            matches!(param.pat, Pat::Rest(_));
                                                        ExprOrSpread {
                                                            spread: if is_rest {
                                                                Some(DUMMY_SP)
                                                            } else {
                                                                None
                                                            },
                                                            expr: Box::new(
                                                                self.pat_to_expr(&param.pat),
                                                            ),
                                                        }
                                                    })
                                                    .collect();
                                            }
                                            body.stmts = vec![Stmt::Return(ReturnStmt {
                                                span: DUMMY_SP,
                                                arg: Some(Box::new(proxy_call)),
                                            })];
                                        }
                                    }
                                    TransformMode::Client => {
                                        // In client mode, just remove the directive and keep the function as-is
                                        self.remove_use_step_directive(&mut fn_decl.function.body);
                                    }
                                }
                            }
                        }
                    }
                    Decl::Var(var_decl) => {
                        // Only handle client mode for exported variable declarations
                        // For other modes, let the normal processing handle it
                        if matches!(self.mode, TransformMode::Client) {
                            for decl_item in var_decl.decls.iter_mut() {
                                if let Some(init) = &mut decl_item.init {
                                    if let Pat::Ident(binding) = &decl_item.name {
                                        let name = binding.id.sym.to_string();

                                        match &mut **init {
                                            Expr::Arrow(arrow_expr) => {
                                                if self
                                                    .has_workflow_directive_arrow(arrow_expr, false)
                                                {
                                                    if !arrow_expr.is_async {
                                                        emit_error(
                                                            WorkflowErrorKind::NonAsyncFunction {
                                                                span: arrow_expr.span,
                                                                directive: "use workflow",
                                                            },
                                                        );
                                                    } else {
                                                        self.workflow_function_names
                                                            .insert(name.clone());

                                                        // Replace workflow function body with error throw
                                                        self.remove_use_workflow_directive_arrow(
                                                            &mut arrow_expr.body,
                                                        );
                                                        let error_msg = format!(
                                                            "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                                            name, name
                                                        );
                                                        let error_expr = Expr::New(NewExpr {
                                                            span: DUMMY_SP,
                                                            ctxt: SyntaxContext::empty(),
                                                            callee: Box::new(Expr::Ident(
                                                                Ident::new(
                                                                    "Error".into(),
                                                                    DUMMY_SP,
                                                                    SyntaxContext::empty(),
                                                                ),
                                                            )),
                                                            args: Some(vec![ExprOrSpread {
                                                                spread: None,
                                                                expr: Box::new(Expr::Lit(
                                                                    Lit::Str(Str {
                                                                        span: DUMMY_SP,
                                                                        value: error_msg.into(),
                                                                        raw: None,
                                                                    }),
                                                                )),
                                                            }]),
                                                            type_args: None,
                                                        });
                                                        arrow_expr.body = Box::new(
                                                            BlockStmtOrExpr::BlockStmt(BlockStmt {
                                                                span: DUMMY_SP,
                                                                ctxt: SyntaxContext::empty(),
                                                                stmts: vec![Stmt::Throw(
                                                                    ThrowStmt {
                                                                        span: DUMMY_SP,
                                                                        arg: Box::new(error_expr),
                                                                    },
                                                                )],
                                                            }),
                                                        );
                                                        self.workflow_functions_needing_id
                                                            .push((name.clone(), arrow_expr.span));
                                                    }
                                                }
                                            }
                                            Expr::Fn(fn_expr) => {
                                                if self.has_workflow_directive(
                                                    &fn_expr.function,
                                                    false,
                                                ) {
                                                    if !fn_expr.function.is_async {
                                                        emit_error(
                                                            WorkflowErrorKind::NonAsyncFunction {
                                                                span: fn_expr.function.span,
                                                                directive: "use workflow",
                                                            },
                                                        );
                                                    } else {
                                                        self.workflow_function_names
                                                            .insert(name.clone());

                                                        // Replace workflow function body with error throw
                                                        self.remove_use_workflow_directive(
                                                            &mut fn_expr.function.body,
                                                        );
                                                        if let Some(body) =
                                                            &mut fn_expr.function.body
                                                        {
                                                            let error_msg = format!(
                                                                "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                                                name, name
                                                            );
                                                            let error_expr = Expr::New(NewExpr {
                                                                span: DUMMY_SP,
                                                                ctxt: SyntaxContext::empty(),
                                                                callee: Box::new(Expr::Ident(
                                                                    Ident::new(
                                                                        "Error".into(),
                                                                        DUMMY_SP,
                                                                        SyntaxContext::empty(),
                                                                    ),
                                                                )),
                                                                args: Some(vec![ExprOrSpread {
                                                                    spread: None,
                                                                    expr: Box::new(Expr::Lit(
                                                                        Lit::Str(Str {
                                                                            span: DUMMY_SP,
                                                                            value: error_msg.into(),
                                                                            raw: None,
                                                                        }),
                                                                    )),
                                                                }]),
                                                                type_args: None,
                                                            });
                                                            body.stmts =
                                                                vec![Stmt::Throw(ThrowStmt {
                                                                    span: DUMMY_SP,
                                                                    arg: Box::new(error_expr),
                                                                })];
                                                        }
                                                        self.workflow_functions_needing_id.push((
                                                            name.clone(),
                                                            fn_expr.function.span,
                                                        ));
                                                    }
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        }
                        // For workflow and step modes, let normal processing handle variable declarations
                    }
                    _ => {}
                }
            }
            _ => {}
        }

        // Visit children for other cases
        decl.visit_mut_children_with(self);
    }

    noop_visit_mut_type!();
}
