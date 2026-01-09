mod naming;

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
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
    // Map from export name to actual const name for default exports (e.g., "default" -> "__default")
    workflow_export_to_const_name: std::collections::HashMap<String, String>,
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
    // Track the current workflow function name (for nested step naming)
    current_workflow_function_name: Option<String>,
    // Track the current parent function name (for all functions, not just workflows)
    current_parent_function_name: Option<String>,
    // Track workflow functions that need to be expanded into multiple exports
    workflow_exports_to_expand: Vec<(String, Expr, swc_core::common::Span)>,
    // Track workflow functions that need workflowId property in client mode
    workflow_functions_needing_id: Vec<(String, swc_core::common::Span)>,
    // Track step function exports that need to be converted to const declarations in workflow mode
    step_exports_to_convert: Vec<(String, String, swc_core::common::Span)>, // (fn_name, step_id, span)
    // Track default exports that need to be replaced with expressions
    default_exports_to_replace: Vec<(String, Expr)>, // (export_name, replacement_expr)
    // Track default workflow exports that need const declarations in workflow mode
    default_workflow_exports: Vec<(String, Expr, swc_core::common::Span)>, // (const_name, expr, span)
    // Track all declared identifiers in module scope to avoid collisions
    declared_identifiers: HashSet<String>,
    // Track object property step functions for hoisting in step mode
    // (parent_var_name, prop_name, arrow_expr, span, parent_workflow_name)
    object_property_step_functions:
        Vec<(String, String, ArrowExpr, swc_core::common::Span, String)>,
    // Track nested step functions inside workflow functions for hoisting in step mode
    // (fn_name, fn_expr, span, closure_vars, was_arrow, parent_workflow_name)
    nested_step_functions: Vec<(
        String,
        FnExpr,
        swc_core::common::Span,
        Vec<String>,
        bool,
        String,
    )>,
    // Counter for anonymous function names
    #[allow(dead_code)]
    anonymous_fn_counter: usize,
    // Track object properties that need to be converted to initializer calls in workflow mode
    // (parent_var_name, prop_name, step_id)
    object_property_workflow_conversions: Vec<(String, String, String)>,
    // Current context: variable name being processed when visiting object properties
    #[allow(dead_code)]
    current_var_context: Option<String>,
    // Track module-level imports to exclude from closure variables
    module_imports: HashSet<String>,
    // Track the current class name for static method transformations
    current_class_name: Option<String>,
    // Track static method steps that need registration after the class declaration
    // (class_name, method_name, step_id, span)
    static_method_step_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track static method workflows that need workflowId assignment and registration
    // (class_name, method_name, workflow_id, span)
    static_method_workflow_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track static step methods to strip from class and assign as properties (workflow mode)
    // (class_name, method_name, step_id)
    static_step_methods_to_strip: Vec<(String, String, String)>,
    // Track classes that need serialization registration (for `this` serialization in static methods)
    // Set of class names that have static step/workflow methods
    classes_needing_serialization: HashSet<String>,
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

// Visitor to collect closure variables from a nested step function
struct ClosureVariableCollector {
    closure_vars: HashSet<String>,
    local_vars: HashSet<String>,
    params: HashSet<String>,
}

impl ClosureVariableCollector {
    fn new() -> Self {
        Self {
            closure_vars: HashSet::new(),
            local_vars: HashSet::new(),
            params: HashSet::new(),
        }
    }

    fn collect_from_function(function: &Function, module_imports: &HashSet<String>) -> Vec<String> {
        let mut collector = Self::new();

        // Add module-level imports to local_vars so they're not considered closure vars
        collector.local_vars.extend(module_imports.iter().cloned());

        // Collect parameters
        for param in &function.params {
            collector.collect_param_names(&param.pat);
        }

        // Visit function body to collect references and declarations
        if let Some(body) = &function.body {
            collector.collect_from_block_stmt(body);
        }

        // Return closure vars sorted for deterministic output
        let mut vars: Vec<String> = collector.closure_vars.into_iter().collect();
        vars.sort();
        vars
    }

    fn collect_from_arrow_expr(arrow: &ArrowExpr, module_imports: &HashSet<String>) -> Vec<String> {
        let mut collector = Self::new();

        // Add module-level imports to local_vars so they're not considered closure vars
        collector.local_vars.extend(module_imports.iter().cloned());

        // Collect parameters
        for param in &arrow.params {
            collector.collect_param_names(param);
        }

        // Visit arrow body
        match &*arrow.body {
            BlockStmtOrExpr::BlockStmt(block) => {
                collector.collect_from_block_stmt(block);
            }
            BlockStmtOrExpr::Expr(expr) => {
                collector.collect_from_expr(expr);
            }
        }

        // Return closure vars sorted for deterministic output
        let mut vars: Vec<String> = collector.closure_vars.into_iter().collect();
        vars.sort();
        vars
    }

    fn collect_param_names(&mut self, pat: &Pat) {
        match pat {
            Pat::Ident(ident) => {
                self.params.insert(ident.id.sym.to_string());
            }
            Pat::Array(array) => {
                for elem in array.elems.iter().flatten() {
                    self.collect_param_names(elem);
                }
            }
            Pat::Object(obj) => {
                for prop in &obj.props {
                    match prop {
                        ObjectPatProp::KeyValue(kv) => {
                            self.collect_param_names(&kv.value);
                        }
                        ObjectPatProp::Assign(assign) => {
                            self.params.insert(assign.key.id.sym.to_string());
                        }
                        ObjectPatProp::Rest(rest) => {
                            self.collect_param_names(&rest.arg);
                        }
                    }
                }
            }
            Pat::Rest(rest) => {
                self.collect_param_names(&rest.arg);
            }
            Pat::Assign(assign) => {
                self.collect_param_names(&assign.left);
            }
            _ => {}
        }
    }

    fn collect_from_block_stmt(&mut self, block: &BlockStmt) {
        for stmt in &block.stmts {
            self.collect_from_stmt(stmt);
        }
    }

    fn collect_from_stmt(&mut self, stmt: &Stmt) {
        match stmt {
            Stmt::Decl(decl) => {
                match decl {
                    Decl::Var(var_decl) => {
                        for declarator in &var_decl.decls {
                            // Collect the declared variable names
                            self.collect_declared_names(&declarator.name);
                            // Then collect references in the initializer
                            if let Some(init) = &declarator.init {
                                self.collect_from_expr(init);
                            }
                        }
                    }
                    Decl::Fn(fn_decl) => {
                        self.local_vars.insert(fn_decl.ident.sym.to_string());
                        // Don't visit nested function bodies for closure detection
                    }
                    _ => {}
                }
            }
            Stmt::Expr(expr_stmt) => {
                self.collect_from_expr(&expr_stmt.expr);
            }
            Stmt::If(if_stmt) => {
                self.collect_from_expr(&if_stmt.test);
                self.collect_from_stmt(&if_stmt.cons);
                if let Some(alt) = &if_stmt.alt {
                    self.collect_from_stmt(alt);
                }
            }
            Stmt::Return(ret_stmt) => {
                if let Some(arg) = &ret_stmt.arg {
                    self.collect_from_expr(arg);
                }
            }
            Stmt::Block(block) => {
                self.collect_from_block_stmt(block);
            }
            Stmt::For(for_stmt) => {
                if let Some(init) = &for_stmt.init {
                    match init {
                        VarDeclOrExpr::VarDecl(var_decl) => {
                            for declarator in &var_decl.decls {
                                self.collect_declared_names(&declarator.name);
                                if let Some(init) = &declarator.init {
                                    self.collect_from_expr(init);
                                }
                            }
                        }
                        VarDeclOrExpr::Expr(expr) => {
                            self.collect_from_expr(expr);
                        }
                    }
                }
                if let Some(test) = &for_stmt.test {
                    self.collect_from_expr(test);
                }
                if let Some(update) = &for_stmt.update {
                    self.collect_from_expr(update);
                }
                self.collect_from_stmt(&for_stmt.body);
            }
            Stmt::While(while_stmt) => {
                self.collect_from_expr(&while_stmt.test);
                self.collect_from_stmt(&while_stmt.body);
            }
            _ => {}
        }
    }

    fn collect_declared_names(&mut self, pat: &Pat) {
        match pat {
            Pat::Ident(ident) => {
                self.local_vars.insert(ident.id.sym.to_string());
            }
            Pat::Array(array) => {
                for elem in array.elems.iter().flatten() {
                    self.collect_declared_names(elem);
                }
            }
            Pat::Object(obj) => {
                for prop in &obj.props {
                    match prop {
                        ObjectPatProp::KeyValue(kv) => {
                            self.collect_declared_names(&kv.value);
                        }
                        ObjectPatProp::Assign(assign) => {
                            self.local_vars.insert(assign.key.id.sym.to_string());
                        }
                        ObjectPatProp::Rest(rest) => {
                            self.collect_declared_names(&rest.arg);
                        }
                    }
                }
            }
            Pat::Rest(rest) => {
                self.collect_declared_names(&rest.arg);
            }
            Pat::Assign(assign) => {
                self.collect_declared_names(&assign.left);
            }
            _ => {}
        }
    }

    fn collect_from_expr(&mut self, expr: &Expr) {
        match expr {
            Expr::Ident(ident) => {
                let name = ident.sym.to_string();
                // Only add as closure var if it's not a parameter or local var
                if !self.params.contains(&name) && !self.local_vars.contains(&name) {
                    // Filter out known globals
                    if !is_global_identifier(&name) {
                        self.closure_vars.insert(name);
                    }
                }
            }
            Expr::Call(call) => {
                if let Callee::Expr(callee) = &call.callee {
                    self.collect_from_expr(callee);
                }
                for arg in &call.args {
                    self.collect_from_expr(&arg.expr);
                }
            }
            Expr::Member(member) => {
                self.collect_from_expr(&member.obj);
            }
            Expr::Bin(bin) => {
                self.collect_from_expr(&bin.left);
                self.collect_from_expr(&bin.right);
            }
            Expr::Unary(unary) => {
                self.collect_from_expr(&unary.arg);
            }
            Expr::Cond(cond) => {
                self.collect_from_expr(&cond.test);
                self.collect_from_expr(&cond.cons);
                self.collect_from_expr(&cond.alt);
            }
            Expr::Array(array) => {
                for elem in array.elems.iter().flatten() {
                    self.collect_from_expr(&elem.expr);
                }
            }
            Expr::Object(obj) => {
                for prop in &obj.props {
                    match prop {
                        PropOrSpread::Prop(prop) => {
                            match &**prop {
                                Prop::KeyValue(kv) => {
                                    self.collect_from_expr(&kv.value);
                                }
                                Prop::Method(_method) => {
                                    // Don't visit nested method bodies
                                }
                                _ => {}
                            }
                        }
                        PropOrSpread::Spread(spread) => {
                            self.collect_from_expr(&spread.expr);
                        }
                    }
                }
            }
            Expr::Paren(paren) => {
                self.collect_from_expr(&paren.expr);
            }
            Expr::Tpl(tpl) => {
                for expr in &tpl.exprs {
                    self.collect_from_expr(expr);
                }
            }
            Expr::TaggedTpl(tagged) => {
                self.collect_from_expr(&tagged.tag);
                for expr in &tagged.tpl.exprs {
                    self.collect_from_expr(expr);
                }
            }
            Expr::Arrow(_arrow) => {
                // Don't visit nested arrow function bodies for closure detection
            }
            Expr::Fn(_) => {
                // Don't visit nested function bodies for closure detection
            }
            Expr::Assign(assign) => {
                self.collect_from_expr(&assign.right);
                // Also check the left side for references (e.g., obj.prop = value)
                match &assign.left {
                    AssignTarget::Simple(simple) => {
                        match simple {
                            SimpleAssignTarget::Ident(ident) => {
                                // This is an assignment to a variable, check if it's a closure var
                                self.collect_from_ident_binding(&ident.id);
                            }
                            SimpleAssignTarget::Member(member) => {
                                self.collect_from_expr(&member.obj);
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            Expr::Update(update) => {
                self.collect_from_expr(&update.arg);
            }
            Expr::Await(await_expr) => {
                self.collect_from_expr(&await_expr.arg);
            }
            _ => {}
        }
    }

    fn collect_from_ident_binding(&mut self, ident: &Ident) {
        let name = ident.sym.to_string();
        if !self.params.contains(&name) && !self.local_vars.contains(&name) {
            if !is_global_identifier(&name) {
                self.closure_vars.insert(name);
            }
        }
    }
}

fn is_global_identifier(name: &str) -> bool {
    matches!(
        name,
        "console"
            | "process"
            | "global"
            | "globalThis"
            | "window"
            | "document"
            | "Array"
            | "Object"
            | "String"
            | "Number"
            | "Boolean"
            | "Date"
            | "Math"
            | "JSON"
            | "Promise"
            | "Symbol"
            | "Error"
            | "TypeError"
            | "ReferenceError"
            | "SyntaxError"
            | "RegExp"
            | "Map"
            | "Set"
            | "WeakMap"
            | "WeakSet"
            | "parseInt"
            | "parseFloat"
            | "isNaN"
            | "isFinite"
            | "encodeURI"
            | "decodeURI"
            | "encodeURIComponent"
            | "decodeURIComponent"
            | "undefined"
            | "null"
            | "true"
            | "false"
            | "NaN"
            | "Infinity"
            | "setTimeout"
            | "setInterval"
            | "clearTimeout"
            | "clearInterval"
            | "fetch"
            | "Response"
            | "Request"
            | "Headers"
            | "URL"
            | "URLSearchParams"
            | "TextEncoder"
            | "TextDecoder"
            | "Buffer"
            | "Uint8Array"
            | "Int8Array"
            | "Uint16Array"
            | "Int16Array"
            | "Uint32Array"
            | "Int32Array"
            | "Float32Array"
            | "Float64Array"
            | "BigInt"
            | "BigInt64Array"
            | "BigUint64Array"
            | "DataView"
            | "ArrayBuffer"
            | "SharedArrayBuffer"
            | "Atomics"
            | "Proxy"
            | "Reflect"
            | "Intl"
            | "WebAssembly"
            | "require"
            | "module"
            | "exports"
            | "__dirname"
            | "__filename"
    )
}

// Visitor to normalize the SyntaxContext of closure variables in a function body.
// This ensures that identifiers in the body match the ones we create in the
// closure destructuring pattern (which use SyntaxContext::empty()).
struct ClosureVariableNormalizer {
    closure_vars: HashSet<String>,
}

impl ClosureVariableNormalizer {
    fn new(closure_vars: &[String]) -> Self {
        Self {
            closure_vars: closure_vars.iter().cloned().collect(),
        }
    }

    fn normalize_function_body(closure_vars: &[String], body: &mut BlockStmt) {
        let mut normalizer = Self::new(closure_vars);
        body.visit_mut_with(&mut normalizer);
    }
}

impl VisitMut for ClosureVariableNormalizer {
    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if self.closure_vars.contains(&ident.sym.to_string()) {
            // Replace with a new identifier that has SyntaxContext::empty()
            // This ensures it matches the destructuring pattern we create
            *ident = Ident::new(ident.sym.clone(), ident.span, SyntaxContext::empty());
        }
    }

    // Don't descend into nested functions - their closure vars are handled separately
    fn visit_mut_function(&mut self, _: &mut Function) {}
    fn visit_mut_arrow_expr(&mut self, _: &mut ArrowExpr) {}

    noop_visit_mut_type!();
}

impl StepTransform {
    fn process_stmt(&mut self, stmt: &mut Stmt) {
        match stmt {
            Stmt::Decl(Decl::Fn(fn_decl)) => {
                let fn_name = fn_decl.ident.sym.to_string();
                #[cfg(debug_assertions)]
                eprintln!(
                    "process_stmt fn {} has_step={} async={} in_workflow={} in_module={}",
                    fn_name,
                    self.has_use_step_directive(&fn_decl.function.body),
                    fn_decl.function.is_async,
                    self.in_workflow_function,
                    self.in_module_level
                );

                if self.should_transform_function(&fn_decl.function, false) {
                    if self.validate_async_function(&fn_decl.function, fn_decl.function.span) {
                        self.step_function_names.insert(fn_name.clone());

                        if !self.in_module_level {
                            match self.mode {
                                TransformMode::Step => {
                                    // Clone the function and remove the directive before hoisting
                                    let mut cloned_function = fn_decl.function.clone();
                                    self.remove_use_step_directive(&mut cloned_function.body);

                                    // Collect closure variables
                                    let closure_vars =
                                        ClosureVariableCollector::collect_from_function(
                                            &cloned_function,
                                            &self.module_imports,
                                        );

                                    let fn_expr = FnExpr {
                                        ident: Some(fn_decl.ident.clone()),
                                        function: cloned_function,
                                    };
                                    self.nested_step_functions.push((
                                        fn_name.clone(),
                                        fn_expr,
                                        fn_decl.function.span,
                                        closure_vars,
                                        false, // Regular function, not arrow
                                        self.current_parent_function_name
                                            .clone()
                                            .unwrap_or_default(),
                                    ));

                                    // Replace with const declaration referencing the hoisted function
                                    let hoisted_name =
                                        if let Some(parent) = &self.current_parent_function_name {
                                            if !parent.is_empty() {
                                                format!("{}${}", parent, fn_name)
                                            } else {
                                                fn_name.clone()
                                            }
                                        } else {
                                            fn_name.clone()
                                        };

                                    let var_decl = Decl::Var(Box::new(VarDecl {
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        kind: VarDeclKind::Const,
                                        decls: vec![VarDeclarator {
                                            span: DUMMY_SP,
                                            name: Pat::Ident(BindingIdent {
                                                id: Ident::new(
                                                    fn_name.clone().into(),
                                                    DUMMY_SP,
                                                    SyntaxContext::empty(),
                                                ),
                                                type_ann: None,
                                            }),
                                            init: Some(Box::new(Expr::Ident(Ident::new(
                                                hoisted_name.into(),
                                                DUMMY_SP,
                                                SyntaxContext::empty(),
                                            )))),
                                            definite: false,
                                        }],
                                        declare: false,
                                    }));
                                    *stmt = Stmt::Decl(var_decl);
                                    return;
                                }
                                TransformMode::Workflow => {
                                    // Include parent workflow name in step ID
                                    let step_fn_name = if let Some(parent) =
                                        &self.current_workflow_function_name
                                    {
                                        format!("{}/{}", parent, fn_name)
                                    } else {
                                        fn_name.clone()
                                    };
                                    let step_id = self.create_id(
                                        Some(&step_fn_name),
                                        fn_decl.function.span,
                                        false,
                                    );

                                    // Collect closure variables
                                    let closure_vars =
                                        ClosureVariableCollector::collect_from_function(
                                            &fn_decl.function,
                                            &self.module_imports,
                                        );
                                    let proxy_ref =
                                        self.create_step_proxy_reference(&step_id, &closure_vars);

                                    let var_decl = Decl::Var(Box::new(VarDecl {
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        kind: VarDeclKind::Var,
                                        decls: vec![VarDeclarator {
                                            span: DUMMY_SP,
                                            name: Pat::Ident(BindingIdent {
                                                id: Ident::new(
                                                    fn_name.into(),
                                                    DUMMY_SP,
                                                    SyntaxContext::empty(),
                                                ),
                                                type_ann: None,
                                            }),
                                            init: Some(Box::new(proxy_ref)),
                                            definite: false,
                                        }],
                                        declare: false,
                                    }));

                                    *stmt = Stmt::Decl(var_decl);
                                    return;
                                }
                                TransformMode::Client => {
                                    // In client mode, just remove the directive and keep the function
                                    self.remove_use_step_directive(&mut fn_decl.function.body);
                                    return;
                                }
                            }
                        } else {
                            match self.mode {
                                TransformMode::Step => {
                                    self.remove_use_step_directive(&mut fn_decl.function.body);
                                    self.create_registration_call(&fn_name, fn_decl.function.span);
                                    stmt.visit_mut_children_with(self);
                                }
                                TransformMode::Workflow => {
                                    self.remove_use_step_directive(&mut fn_decl.function.body);
                                    if let Some(body) = &mut fn_decl.function.body {
                                        let step_id = self.create_id(
                                            Some(&fn_name),
                                            fn_decl.function.span,
                                            false,
                                        );
                                        let mut proxy_call = self.create_step_proxy(&step_id);
                                        if let Expr::Call(call) = &mut proxy_call {
                                            call.args = fn_decl
                                                .function
                                                .params
                                                .iter()
                                                .map(|param| ExprOrSpread {
                                                    spread: if matches!(param.pat, Pat::Rest(_)) {
                                                        Some(DUMMY_SP)
                                                    } else {
                                                        None
                                                    },
                                                    expr: Box::new(self.pat_to_expr(&param.pat)),
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
                                    self.remove_use_step_directive(&mut fn_decl.function.body);
                                    stmt.visit_mut_children_with(self);
                                }
                            }
                        }
                    }
                } else if self.should_transform_workflow_function(&fn_decl.function, false) {
                    if self.validate_async_function(&fn_decl.function, fn_decl.function.span) {
                        self.workflow_function_names.insert(fn_name.clone());
                        let fn_span = fn_decl.function.span;

                        match self.mode {
                            TransformMode::Step => {
                                // First visit children to process nested step functions
                                stmt.visit_mut_children_with(self);

                                // After step hoisting, re-extract fn_decl and replace workflow body with throw error
                                if let Stmt::Decl(Decl::Fn(fn_decl)) = stmt {
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
                                }
                                self.workflow_functions_needing_id
                                    .push((fn_name.clone(), fn_span));
                            }
                            TransformMode::Workflow => {
                                self.remove_use_workflow_directive(&mut fn_decl.function.body);
                                stmt.visit_mut_children_with(self);
                            }
                            TransformMode::Client => {
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
                                    .push((fn_name.clone(), fn_span));
                                stmt.visit_mut_children_with(self);
                            }
                        }
                    }
                } else {
                    stmt.visit_mut_children_with(self);
                }
            }
            Stmt::Decl(Decl::Var(var_decl)) => {
                // Check if any declarators contain arrow functions with object literal bodies
                for declarator in &mut var_decl.decls {
                    if let Some(init) = &mut declarator.init {
                        if let Pat::Ident(binding) = &declarator.name {
                            let name = binding.id.sym.to_string();

                            // Check if the initializer is an arrow function with object literal body
                            if let Expr::Arrow(arrow_expr) = &mut **init {
                                match &mut *arrow_expr.body {
                                    BlockStmtOrExpr::Expr(expr) => {
                                        // Handle both direct object literals and parenthesized ones
                                        let obj_lit_mut = match &mut **expr {
                                            Expr::Object(obj) => Some(obj),
                                            Expr::Paren(paren) => {
                                                if let Expr::Object(obj) = &mut *paren.expr {
                                                    Some(obj)
                                                } else {
                                                    None
                                                }
                                            }
                                            _ => None,
                                        };

                                        if let Some(obj_lit) = obj_lit_mut {
                                            self.process_object_properties_for_step_functions(
                                                obj_lit, &name,
                                            );
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                stmt.visit_mut_children_with(self);
            }
            _ => {
                stmt.visit_mut_children_with(self);
            }
        }
    }
    pub fn new(mode: TransformMode, filename: String) -> Self {
        Self {
            mode,
            filename,
            has_file_step_directive: false,
            has_file_workflow_directive: false,
            step_function_names: HashSet::new(),
            workflow_function_names: HashSet::new(),
            workflow_export_to_const_name: HashMap::new(),
            registered_functions: HashSet::new(),
            registration_calls: Vec::new(),
            names: Vec::new(),
            should_track_names: false,
            in_module_level: true,
            in_callee: false,
            in_step_function: false,
            in_workflow_function: false,
            current_workflow_function_name: None,
            current_parent_function_name: None,
            workflow_exports_to_expand: Vec::new(),
            workflow_functions_needing_id: Vec::new(),
            step_exports_to_convert: Vec::new(),
            default_exports_to_replace: Vec::new(),
            default_workflow_exports: Vec::new(),
            declared_identifiers: HashSet::new(),
            object_property_step_functions: Vec::new(),
            nested_step_functions: Vec::new(),
            anonymous_fn_counter: 0,
            object_property_workflow_conversions: Vec::new(),
            current_var_context: None,
            module_imports: HashSet::new(),
            current_class_name: None,
            static_method_step_registrations: Vec::new(),
            static_method_workflow_registrations: Vec::new(),
            static_step_methods_to_strip: Vec::new(),
            classes_needing_serialization: HashSet::new(),
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

    // Generate a unique identifier that doesn't conflict with existing declarations
    fn generate_unique_name(&self, base_name: &str) -> String {
        let mut name = base_name.to_string();
        let mut counter = 0;

        while self.declared_identifiers.contains(&name) {
            counter += 1;
            name = format!("{}${}", base_name, counter);
        }

        name
    }

    // Collect all declared identifiers in the module to avoid naming collisions
    fn collect_declared_identifiers(&mut self, items: &[ModuleItem]) {
        for item in items {
            match item {
                ModuleItem::Stmt(Stmt::Decl(decl)) => match decl {
                    Decl::Fn(fn_decl) => {
                        self.declared_identifiers
                            .insert(fn_decl.ident.sym.to_string());
                    }
                    Decl::Var(var_decl) => {
                        for declarator in &var_decl.decls {
                            self.collect_idents_from_pat(&declarator.name);
                        }
                    }
                    Decl::Class(class_decl) => {
                        self.declared_identifiers
                            .insert(class_decl.ident.sym.to_string());
                    }
                    _ => {}
                },
                ModuleItem::ModuleDecl(module_decl) => match module_decl {
                    ModuleDecl::ExportDecl(export_decl) => match &export_decl.decl {
                        Decl::Fn(fn_decl) => {
                            self.declared_identifiers
                                .insert(fn_decl.ident.sym.to_string());
                        }
                        Decl::Var(var_decl) => {
                            for declarator in &var_decl.decls {
                                self.collect_idents_from_pat(&declarator.name);
                            }
                        }
                        Decl::Class(class_decl) => {
                            self.declared_identifiers
                                .insert(class_decl.ident.sym.to_string());
                        }
                        _ => {}
                    },
                    ModuleDecl::ExportDefaultDecl(default_decl) => match &default_decl.decl {
                        DefaultDecl::Fn(fn_expr) => {
                            if let Some(ident) = &fn_expr.ident {
                                self.declared_identifiers.insert(ident.sym.to_string());
                            }
                        }
                        DefaultDecl::Class(class_expr) => {
                            if let Some(ident) = &class_expr.ident {
                                self.declared_identifiers.insert(ident.sym.to_string());
                            }
                        }
                        _ => {}
                    },
                    ModuleDecl::Import(import_decl) => {
                        for specifier in &import_decl.specifiers {
                            match specifier {
                                ImportSpecifier::Named(named) => {
                                    self.declared_identifiers
                                        .insert(named.local.sym.to_string());
                                }
                                ImportSpecifier::Default(default) => {
                                    self.declared_identifiers
                                        .insert(default.local.sym.to_string());
                                }
                                ImportSpecifier::Namespace(namespace) => {
                                    self.declared_identifiers
                                        .insert(namespace.local.sym.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }

    // Helper to collect identifiers from patterns (for destructuring, etc.)
    fn collect_idents_from_pat(&mut self, pat: &Pat) {
        match pat {
            Pat::Ident(ident) => {
                self.declared_identifiers.insert(ident.id.sym.to_string());
            }
            Pat::Array(array_pat) => {
                for elem in &array_pat.elems {
                    if let Some(elem) = elem {
                        self.collect_idents_from_pat(elem);
                    }
                }
            }
            Pat::Object(obj_pat) => {
                for prop in &obj_pat.props {
                    match prop {
                        ObjectPatProp::KeyValue(kv) => {
                            self.collect_idents_from_pat(&kv.value);
                        }
                        ObjectPatProp::Assign(assign) => {
                            self.declared_identifiers.insert(assign.key.sym.to_string());
                        }
                        ObjectPatProp::Rest(rest) => {
                            self.collect_idents_from_pat(&rest.arg);
                        }
                    }
                }
            }
            Pat::Rest(rest_pat) => {
                self.collect_idents_from_pat(&rest_pat.arg);
            }
            Pat::Assign(assign_pat) => {
                self.collect_idents_from_pat(&assign_pat.left);
            }
            _ => {}
        }
    }

    // Create an identifier for an object property step function
    // Used for functions defined as object properties, e.g., tool({ execute: async () => {...} })
    fn create_object_property_id(
        &self,
        parent_var_name: &str,
        prop_name: &str,
        is_workflow: bool,
        workflow_name: Option<&str>,
    ) -> String {
        let fn_name = if let Some(wf_name) = workflow_name {
            format!("{}/{}/{}", wf_name, parent_var_name, prop_name)
        } else {
            format!("{}/{}", parent_var_name, prop_name)
        };
        let prefix = if is_workflow { "workflow" } else { "step" };
        naming::format_name(prefix, &self.filename, &fn_name)
    }

    // Process object properties for step functions
    fn process_object_properties_for_step_functions(
        &mut self,
        obj_lit: &mut ObjectLit,
        parent_var_name: &str,
    ) {
        for prop in &mut obj_lit.props {
            if let PropOrSpread::Prop(boxed_prop) = prop {
                match &mut **boxed_prop {
                    Prop::KeyValue(kv_prop) => {
                        // Get the property key first
                        let prop_key = match &kv_prop.key {
                            PropName::Ident(ident) => ident.sym.to_string(),
                            PropName::Str(s) => s.value.to_string_lossy().to_string(),
                            _ => continue, // Skip complex keys
                        };

                        // Check if we should transform this property
                        let should_transform = match &*kv_prop.value {
                            Expr::Arrow(arrow_expr) => {
                                self.has_use_step_directive_arrow(&arrow_expr.body)
                            }
                            Expr::Fn(fn_expr) => {
                                self.has_use_step_directive(&fn_expr.function.body)
                            }
                            _ => false,
                        };

                        if should_transform {
                            // Process the transformation
                            match &mut *kv_prop.value {
                                Expr::Arrow(arrow_expr) => {
                                    if !arrow_expr.is_async {
                                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                                            span: arrow_expr.span,
                                            directive: "use step",
                                        });
                                    } else {
                                        // Remove the directive first
                                        self.remove_use_step_directive_arrow(&mut arrow_expr.body);

                                        // Track this as an object property step function (after removing directive)
                                        self.object_property_step_functions.push((
                                            parent_var_name.to_string(),
                                            prop_key.clone(),
                                            arrow_expr.clone(),
                                            arrow_expr.span,
                                            self.current_workflow_function_name
                                                .clone()
                                                .unwrap_or_default(),
                                        ));

                                        let span = arrow_expr.span;
                                        let _ = arrow_expr; // Drop the mutable reference

                                        self.apply_object_property_transformation(
                                            kv_prop,
                                            parent_var_name,
                                            &prop_key,
                                            span,
                                        );
                                    }
                                }
                                Expr::Fn(fn_expr) => {
                                    if !fn_expr.function.is_async {
                                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                                            span: fn_expr.function.span,
                                            directive: "use step",
                                        });
                                    } else {
                                        // Remove the directive first
                                        self.remove_use_step_directive(&mut fn_expr.function.body);

                                        // Convert to arrow expression for hoisting (as arrow functions are simpler to work with)
                                        let arrow_params: Vec<Pat> = fn_expr
                                            .function
                                            .params
                                            .iter()
                                            .map(|param| param.pat.clone())
                                            .collect();

                                        let arrow_from_fn = ArrowExpr {
                                            span: fn_expr.function.span,
                                            ctxt: SyntaxContext::empty(),
                                            is_async: fn_expr.function.is_async,
                                            is_generator: fn_expr.function.is_generator,
                                            params: arrow_params,
                                            body: Box::new(BlockStmtOrExpr::BlockStmt(
                                                fn_expr
                                                    .function
                                                    .body
                                                    .as_ref()
                                                    .cloned()
                                                    .unwrap_or_else(|| BlockStmt {
                                                        span: DUMMY_SP,
                                                        ctxt: SyntaxContext::empty(),
                                                        stmts: vec![],
                                                    }),
                                            )),
                                            type_params: None,
                                            return_type: fn_expr.function.return_type.clone(),
                                        };

                                        let span = fn_expr.function.span;

                                        // Track this as an object property step function (after removing directive)
                                        self.object_property_step_functions.push((
                                            parent_var_name.to_string(),
                                            prop_key.clone(),
                                            arrow_from_fn,
                                            span,
                                            self.current_workflow_function_name
                                                .clone()
                                                .unwrap_or_default(),
                                        ));

                                        let _ = fn_expr; // Drop the mutable reference

                                        self.apply_object_property_transformation(
                                            kv_prop,
                                            parent_var_name,
                                            &prop_key,
                                            span,
                                        );
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Prop::Method(method_prop) => {
                        // Handle object methods like: execute() { "use step"; ... }
                        let prop_key = match &method_prop.key {
                            PropName::Ident(ident) => ident.sym.to_string(),
                            PropName::Str(s) => s.value.to_string_lossy().to_string(),
                            _ => continue, // Skip complex keys
                        };

                        if self.has_use_step_directive(&method_prop.function.body) {
                            if !method_prop.function.is_async {
                                emit_error(WorkflowErrorKind::NonAsyncFunction {
                                    span: method_prop.function.span,
                                    directive: "use step",
                                });
                            } else {
                                // Remove the directive first
                                self.remove_use_step_directive(&mut method_prop.function.body);

                                // Convert method to arrow expression for hoisting
                                let arrow_params: Vec<Pat> = method_prop
                                    .function
                                    .params
                                    .iter()
                                    .map(|param| param.pat.clone())
                                    .collect();

                                let arrow_from_method = ArrowExpr {
                                    span: method_prop.function.span,
                                    ctxt: SyntaxContext::empty(),
                                    is_async: method_prop.function.is_async,
                                    is_generator: method_prop.function.is_generator,
                                    params: arrow_params,
                                    body: Box::new(BlockStmtOrExpr::BlockStmt(
                                        method_prop.function.body.as_ref().cloned().unwrap_or_else(
                                            || BlockStmt {
                                                span: DUMMY_SP,
                                                ctxt: SyntaxContext::empty(),
                                                stmts: vec![],
                                            },
                                        ),
                                    )),
                                    type_params: None,
                                    return_type: method_prop.function.return_type.clone(),
                                };

                                let span = method_prop.function.span;

                                // Track this as an object property step function
                                self.object_property_step_functions.push((
                                    parent_var_name.to_string(),
                                    prop_key.clone(),
                                    arrow_from_method,
                                    span,
                                    self.current_workflow_function_name
                                        .clone()
                                        .unwrap_or_default(),
                                ));

                                // Now handle the transformation based on mode
                                match self.mode {
                                    TransformMode::Step => {
                                        // In step mode, replace method with key-value property referencing the hoisted variable
                                        let hoist_var_name = if let Some(ref workflow_name) =
                                            self.current_workflow_function_name
                                        {
                                            format!(
                                                "{}${}${}",
                                                workflow_name, parent_var_name, prop_key
                                            )
                                        } else {
                                            format!("{}${}", parent_var_name, prop_key)
                                        };
                                        let step_id = self.create_object_property_id(
                                            parent_var_name,
                                            &prop_key,
                                            false,
                                            self.current_workflow_function_name.as_deref(),
                                        );
                                        // Replace the method with a key-value property referencing the hoisted function
                                        *boxed_prop = Box::new(Prop::KeyValue(KeyValueProp {
                                            key: method_prop.key.clone(),
                                            value: Box::new(Expr::Ident(Ident::new(
                                                hoist_var_name.into(),
                                                DUMMY_SP,
                                                SyntaxContext::empty(),
                                            ))),
                                        }));
                                        self.object_property_workflow_conversions.push((
                                            parent_var_name.to_string(),
                                            prop_key,
                                            step_id,
                                        ));
                                    }
                                    TransformMode::Workflow => {
                                        // In workflow mode, convert method to key-value property with initializer call
                                        let step_id = self.create_object_property_id(
                                            parent_var_name,
                                            &prop_key,
                                            false,
                                            self.current_workflow_function_name.as_deref(),
                                        );
                                        *boxed_prop = Box::new(Prop::KeyValue(KeyValueProp {
                                            key: method_prop.key.clone(),
                                            value: Box::new(self.create_step_initializer(&step_id)),
                                        }));
                                        self.object_property_workflow_conversions.push((
                                            parent_var_name.to_string(),
                                            prop_key,
                                            step_id,
                                        ));
                                    }
                                    TransformMode::Client => {
                                        // In client mode, just remove the directive (already done above)
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

    // Helper to apply transformation to object property based on mode
    fn apply_object_property_transformation(
        &mut self,
        kv_prop: &mut KeyValueProp,
        parent_var_name: &str,
        prop_key: &str,
        _span: swc_core::common::Span,
    ) {
        let step_id = self.create_object_property_id(
            parent_var_name,
            prop_key,
            false,
            self.current_workflow_function_name.as_deref(),
        );

        match self.mode {
            TransformMode::Step => {
                // In step mode, replace with reference to hoisted variable
                let hoist_var_name =
                    if let Some(ref workflow_name) = self.current_workflow_function_name {
                        format!("{}${}${}", workflow_name, parent_var_name, prop_key)
                    } else {
                        format!("{}${}", parent_var_name, prop_key)
                    };
                *kv_prop.value = Expr::Ident(Ident::new(
                    hoist_var_name.into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ));
                // Track for metadata
                self.object_property_workflow_conversions.push((
                    parent_var_name.to_string(),
                    prop_key.to_string(),
                    step_id,
                ));
            }
            TransformMode::Workflow => {
                // Replace with initializer call
                *kv_prop.value = self.create_step_initializer(&step_id);
                self.object_property_workflow_conversions.push((
                    parent_var_name.to_string(),
                    prop_key.to_string(),
                    step_id,
                ));
            }
            TransformMode::Client => {
                // In client mode, just remove the directive
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
                                    directive: value.to_string_lossy().to_string(),
                                    location: DirectiveLocation::FunctionBody,
                                });
                            }
                            return true;
                        } else if detect_similar_strings(
                            &value.to_string_lossy().to_string(),
                            "use step",
                        ) {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *stmt_span,
                                directive: value.to_string_lossy().to_string(),
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
                        #[cfg(debug_assertions)]
                        eprintln!("directive candidate: {:?}", value);
                        if value == "use workflow" {
                            if !is_first_meaningful {
                                emit_error(WorkflowErrorKind::MisplacedDirective {
                                    span: *stmt_span,
                                    directive: value.to_string_lossy().to_string(),
                                    location: DirectiveLocation::FunctionBody,
                                });
                            }
                            return true;
                        } else if detect_similar_strings(
                            &value.to_string_lossy().to_string(),
                            "use workflow",
                        ) {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *stmt_span,
                                directive: value.to_string_lossy().to_string(),
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
                                    directive: value.to_string_lossy().to_string(),
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
                                    directive: value.to_string_lossy().to_string(),
                                    location: DirectiveLocation::Module,
                                });
                            }
                        } else if detect_similar_strings(
                            &value.to_string_lossy().to_string(),
                            "use step",
                        ) {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *span,
                                directive: value.to_string_lossy().to_string(),
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
                                    directive: value.to_string_lossy().to_string(),
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
                                    directive: value.to_string_lossy().to_string(),
                                    location: DirectiveLocation::Module,
                                });
                            }
                        } else if detect_similar_strings(
                            &value.to_string_lossy().to_string(),
                            "use workflow",
                        ) {
                            emit_error(WorkflowErrorKind::MisspelledDirective {
                                span: *span,
                                directive: value.to_string_lossy().to_string(),
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

    // Convert a FnExpr back to ArrowExpr (for hoisting arrow functions)
    fn convert_fn_expr_to_arrow(&self, fn_expr: &FnExpr) -> ArrowExpr {
        let body = if let Some(block) = &fn_expr.function.body {
            // Check if body is a single return statement - can be simplified to expression
            if block.stmts.len() == 1 {
                if let Stmt::Return(ret) = &block.stmts[0] {
                    if let Some(arg) = &ret.arg {
                        // Single return statement - use expression body
                        Box::new(BlockStmtOrExpr::Expr(arg.clone()))
                    } else {
                        // return with no value - keep as block
                        Box::new(BlockStmtOrExpr::BlockStmt(block.clone()))
                    }
                } else {
                    Box::new(BlockStmtOrExpr::BlockStmt(block.clone()))
                }
            } else {
                Box::new(BlockStmtOrExpr::BlockStmt(block.clone()))
            }
        } else {
            Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                stmts: vec![],
            }))
        };

        ArrowExpr {
            span: fn_expr.function.span,
            ctxt: SyntaxContext::empty(),
            params: fn_expr
                .function
                .params
                .iter()
                .map(|p| p.pat.clone())
                .collect(),
            body,
            is_async: fn_expr.function.is_async,
            is_generator: fn_expr.function.is_generator,
            type_params: fn_expr.function.type_params.clone(),
            return_type: fn_expr.function.return_type.clone(),
        }
    }

    // Generate the import for registerStepFunction and __private_getClosureVars (step mode)
    fn create_private_imports(
        &self,
        include_register: bool,
        include_closure_vars: bool,
    ) -> ModuleItem {
        let mut specifiers = vec![];

        if include_closure_vars {
            specifiers.push(ImportSpecifier::Named(ImportNamedSpecifier {
                span: DUMMY_SP,
                local: Ident::new(
                    "__private_getClosureVars".into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ),
                imported: None,
                is_type_only: false,
            }));
        }

        if include_register {
            specifiers.push(ImportSpecifier::Named(ImportNamedSpecifier {
                span: DUMMY_SP,
                local: Ident::new(
                    "registerStepFunction".into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ),
                imported: None,
                is_type_only: false,
            }));
        }

        ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
            span: DUMMY_SP,
            specifiers,
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

    // Generate the import for registerSerializationClass from a Node.js-free module (workflow mode)
    // This is separate from create_private_imports to avoid pulling in Node.js dependencies
    // (like async_hooks) in workflow bundles.
    fn create_class_serialization_import(&self) -> ModuleItem {
        ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
            span: DUMMY_SP,
            specifiers: vec![ImportSpecifier::Named(ImportNamedSpecifier {
                span: DUMMY_SP,
                local: Ident::new(
                    "registerSerializationClass".into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ),
                imported: None,
                is_type_only: false,
            })],
            src: Box::new(Str {
                span: DUMMY_SP,
                value: "workflow/internal/class-serialization".into(),
                raw: None,
            }),
            type_only: false,
            with: None,
            phase: ImportPhase::Evaluation,
        }))
    }

    // Create a proxy reference: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id", closure_fn) (workflow mode)
    fn create_step_proxy_reference(&self, step_id: &str, closure_vars: &[String]) -> Expr {
        let mut args = vec![ExprOrSpread {
            spread: None,
            expr: Box::new(Expr::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: step_id.into(),
                raw: None,
            }))),
        }];

        // If there are closure variables, add them as a second argument
        if !closure_vars.is_empty() {
            // Create arrow function: () => ({ var1, var2 })
            let closure_obj = Expr::Object(ObjectLit {
                span: DUMMY_SP,
                props: closure_vars
                    .iter()
                    .map(|var_name| {
                        PropOrSpread::Prop(Box::new(Prop::Shorthand(Ident::new(
                            var_name.clone().into(),
                            DUMMY_SP,
                            SyntaxContext::empty(),
                        ))))
                    })
                    .collect(),
            });

            let closure_fn = Expr::Arrow(ArrowExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                params: vec![],
                body: Box::new(BlockStmtOrExpr::Expr(Box::new(closure_obj))),
                is_async: false,
                is_generator: false,
                type_params: None,
                return_type: None,
            });

            args.push(ExprOrSpread {
                spread: None,
                expr: Box::new(closure_fn),
            });
        }

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
            args,
            type_args: None,
        })
    }

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
        // For workflow ID generation, normalize auto-generated __default variants to "default"
        // Only do this if the name was auto-generated for an anonymous default export,
        // not if the user explicitly named their function "__default"
        let id_name = if (fn_name == "__default" || fn_name.starts_with("__default$"))
            && self
                .workflow_export_to_const_name
                .get("default")
                .map_or(false, |const_name| const_name == fn_name)
        {
            "default"
        } else {
            fn_name
        };
        let workflow_id = self.create_id(Some(id_name), span, true);

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

    // Create a workflow registration call for workflow mode:
    // globalThis.__private_workflows.set("workflowId", functionName);
    fn create_workflow_registration(&self, fn_name: &str, span: swc_core::common::Span) -> Stmt {
        // Generate the workflow ID (same logic as create_workflow_id_assignment)
        let id_name = if (fn_name == "__default" || fn_name.starts_with("__default$"))
            && self
                .workflow_export_to_const_name
                .get("default")
                .map_or(false, |const_name| const_name == fn_name)
        {
            "default"
        } else {
            fn_name
        };
        let workflow_id = self.create_id(Some(id_name), span, true);

        // Create: globalThis.__private_workflows.set("workflowId", functionName)
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: Box::new(Expr::Member(MemberExpr {
                        span: DUMMY_SP,
                        obj: Box::new(Expr::Ident(Ident::new(
                            "globalThis".into(),
                            DUMMY_SP,
                            SyntaxContext::empty(),
                        ))),
                        prop: MemberProp::Ident(IdentName::new(
                            "__private_workflows".into(),
                            DUMMY_SP,
                        )),
                    })),
                    prop: MemberProp::Ident(IdentName::new("set".into(), DUMMY_SP)),
                }))),
                args: vec![
                    // First argument: workflow ID
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: workflow_id.into(),
                            raw: None,
                        }))),
                    },
                    // Second argument: function reference
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Ident(Ident::new(
                            fn_name.into(),
                            DUMMY_SP,
                            SyntaxContext::empty(),
                        ))),
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
                    // Remove empty statements
                    ModuleItem::Stmt(Stmt::Empty(_)) => true,
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
        let from_file = self.has_file_workflow_directive && is_exported;
        let from_body = self.has_use_workflow_directive(&function.body);
        #[cfg(debug_assertions)]
        eprintln!(
            "has_workflow_directive -> file={}, body={}",
            from_file, from_body
        );
        from_file || from_body
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

        // Build steps metadata (including object properties)
        if !self.step_function_names.is_empty()
            || !self.object_property_workflow_conversions.is_empty()
        {
            let mut steps_entries: Vec<String> = self
                .step_function_names
                .iter()
                .map(|fn_name| {
                    let step_id = self.create_id(Some(fn_name), DUMMY_SP, false);
                    format!("\"{}\":{{\"stepId\":\"{}\"}}", fn_name, step_id)
                })
                .collect();

            // Add object property step functions to metadata
            for (parent_var, prop_name, step_id) in &self.object_property_workflow_conversions {
                let key = format!("{}/{}", parent_var, prop_name);
                steps_entries.push(format!("\"{}\":{{\"stepId\":\"{}\"}}", key, step_id));
            }

            if !steps_entries.is_empty() {
                steps_entries.sort();
                metadata.insert("steps", format!("{{{}}}", steps_entries.join(",")));
            }
        }

        // Build workflows metadata
        if !self.workflow_function_names.is_empty() {
            // Sort function names for deterministic ordering
            let mut sorted_workflow_names: Vec<_> = self.workflow_function_names.iter().collect();
            sorted_workflow_names.sort();

            let workflow_entries: Vec<String> = sorted_workflow_names
                .into_iter()
                .map(|fn_name| {
                    let fn_name_str: &str = fn_name;
                    // Look up the actual const/function name for this export
                    let actual_name = self
                        .workflow_export_to_const_name
                        .get(fn_name_str)
                        .map(|s| s.as_str())
                        .unwrap_or(fn_name_str);
                    // For auto-generated __default names (anonymous default exports),
                    // normalize to "default" for the workflow ID
                    let id_name = if (actual_name == "__default"
                        || actual_name.starts_with("__default$"))
                        && fn_name_str == "default"
                    {
                        "default"
                    } else {
                        actual_name
                    };
                    let workflow_id = self.create_id(Some(id_name), DUMMY_SP, true);
                    format!("\"{}\":{{\"workflowId\":\"{}\"}}", fn_name_str, workflow_id)
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

        // Visit function parameters (which can contain default values that use other identifiers)
        for param in &mut fn_decl.function.params {
            param.visit_mut_with(self);
        }

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
                        // In workflow mode, we just assign ClassName.classId = "..."
                        // No imports needed - the property assignment happens without any function call
                    }
                    TransformMode::Step => {
                        // Check what needs to be imported
                        let needs_register_import = !self.registration_calls.is_empty()
                            || !self.object_property_step_functions.is_empty()
                            || !self.nested_step_functions.is_empty()
                            || !self.static_method_step_registrations.is_empty();

                        // Check if any nested steps have closure variables
                        let needs_closure_import = self
                            .nested_step_functions
                            .iter()
                            .any(|(_, _, _, closure_vars, _, _)| !closure_vars.is_empty());

                        // Check if we need to register classes for serialization
                        let needs_class_serialization =
                            !self.classes_needing_serialization.is_empty();

                        if needs_register_import || needs_closure_import {
                            imports_to_add.push(self.create_private_imports(
                                needs_register_import,
                                needs_closure_import,
                            ));
                        }

                        // Add separate import for class serialization
                        if needs_class_serialization {
                            imports_to_add.push(self.create_class_serialization_import());
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

                // Add hoisted object property functions and registration calls at the end for step mode
                if matches!(self.mode, TransformMode::Step) {
                    // Calculate insertion position once before any hoisting
                    let initial_insert_pos = module
                        .body
                        .iter()
                        .position(|item| {
                            !matches!(item, ModuleItem::ModuleDecl(ModuleDecl::Import(_)))
                        })
                        .unwrap_or(0);
                    let mut current_insert_pos = initial_insert_pos;

                    // Process nested step functions FIRST (they typically appear earlier in source)
                    let nested_functions: Vec<_> = self.nested_step_functions.drain(..).collect();

                    for (
                        fn_name,
                        mut fn_expr,
                        span,
                        closure_vars,
                        was_arrow,
                        parent_workflow_name,
                    ) in nested_functions
                    {
                        // Generate hoisted name including parent workflow function name
                        let hoisted_name = if parent_workflow_name.is_empty() {
                            fn_name.clone()
                        } else {
                            format!("{}${}", parent_workflow_name, fn_name)
                        };
                        // If there are closure variables, add destructuring as first statement
                        if !closure_vars.is_empty() {
                            if let Some(body) = &mut fn_expr.function.body {
                                // First, normalize the SyntaxContext of closure variable references in the body
                                // This ensures they match the identifiers we create in the destructuring pattern
                                ClosureVariableNormalizer::normalize_function_body(
                                    &closure_vars,
                                    body,
                                );

                                // Create destructuring statement: const { var1, var2 } = __private_getClosureVars();
                                let closure_destructure =
                                    Stmt::Decl(Decl::Var(Box::new(VarDecl {
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        kind: VarDeclKind::Const,
                                        decls: vec![VarDeclarator {
                                            span: DUMMY_SP,
                                            name: Pat::Object(ObjectPat {
                                                span: DUMMY_SP,
                                                props: closure_vars
                                                    .iter()
                                                    .map(|var_name| {
                                                        ObjectPatProp::Assign(AssignPatProp {
                                                            span: DUMMY_SP,
                                                            key: BindingIdent {
                                                                id: Ident::new(
                                                                    var_name.clone().into(),
                                                                    DUMMY_SP,
                                                                    SyntaxContext::empty(),
                                                                ),
                                                                type_ann: None,
                                                            },
                                                            value: None,
                                                        })
                                                    })
                                                    .collect(),
                                                optional: false,
                                                type_ann: None,
                                            }),
                                            init: Some(Box::new(Expr::Call(CallExpr {
                                                span: DUMMY_SP,
                                                ctxt: SyntaxContext::empty(),
                                                callee: Callee::Expr(Box::new(Expr::Ident(
                                                    Ident::new(
                                                        "__private_getClosureVars".into(),
                                                        DUMMY_SP,
                                                        SyntaxContext::empty(),
                                                    ),
                                                ))),
                                                args: vec![],
                                                type_args: None,
                                            }))),
                                            definite: false,
                                        }],
                                        declare: false,
                                    })));

                                // Prepend to function body
                                body.stmts.insert(0, closure_destructure);
                            }
                        }

                        // Create the appropriate hoisted declaration based on original function type
                        let hoisted_decl = if was_arrow {
                            // Convert back to arrow function: var name = async () => { ... };
                            let arrow_expr = self.convert_fn_expr_to_arrow(&fn_expr);
                            ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                kind: VarDeclKind::Var,
                                decls: vec![VarDeclarator {
                                    span: DUMMY_SP,
                                    name: Pat::Ident(BindingIdent {
                                        id: Ident::new(
                                            hoisted_name.clone().into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ),
                                        type_ann: None,
                                    }),
                                    init: Some(Box::new(Expr::Arrow(arrow_expr))),
                                    definite: false,
                                }],
                                declare: false,
                            }))))
                        } else {
                            // Keep as function declaration: async function name() { ... }
                            ModuleItem::Stmt(Stmt::Decl(Decl::Fn(FnDecl {
                                ident: Ident::new(
                                    hoisted_name.clone().into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                ),
                                function: fn_expr.function,
                                declare: false,
                            })))
                        };

                        // Insert at current position and increment for next iteration
                        module.body.insert(current_insert_pos, hoisted_decl);
                        current_insert_pos += 1;

                        // Create a registration call with parent workflow name in the step ID
                        let step_fn_name = if parent_workflow_name.is_empty() {
                            fn_name.clone()
                        } else {
                            format!("{}/{}", parent_workflow_name, fn_name)
                        };
                        let step_id = self.create_id(Some(&step_fn_name), span, false);
                        let registration_call = Stmt::Expr(ExprStmt {
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
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: step_id.into(),
                                            raw: None,
                                        }))),
                                    },
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Ident(Ident::new(
                                            hoisted_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                    },
                                ],
                                type_args: None,
                            })),
                        });

                        self.registration_calls.push(registration_call);
                    }

                    // Then process object property step functions (they typically appear later)
                    // Collect hoisting information before the loop
                    let hoisting_info: Vec<_> = self
                        .object_property_step_functions
                        .iter()
                        .map(
                            |(parent_var, prop_name, arrow_expr, _span, workflow_name)| {
                                let hoist_var_name = if !workflow_name.is_empty() {
                                    format!("{}${}${}", workflow_name, parent_var, prop_name)
                                } else {
                                    format!("{}${}", parent_var, prop_name)
                                };
                                let wf_name = if workflow_name.is_empty() {
                                    None
                                } else {
                                    Some(workflow_name.as_str())
                                };
                                let step_id = self.create_object_property_id(
                                    parent_var, prop_name, false, wf_name,
                                );
                                (
                                    hoist_var_name,
                                    arrow_expr.clone(),
                                    step_id,
                                    parent_var.clone(),
                                )
                            },
                        )
                        .collect();

                    // Now drain and process
                    self.object_property_step_functions.drain(..);

                    for (hoist_var_name, arrow_expr, step_id, _parent_var) in hoisting_info {
                        // Create a const declaration for the hoisted function
                        let hoisted_decl =
                            ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                kind: VarDeclKind::Var,
                                decls: vec![VarDeclarator {
                                    span: DUMMY_SP,
                                    name: Pat::Ident(BindingIdent {
                                        id: Ident::new(
                                            hoist_var_name.clone().into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ),
                                        type_ann: None,
                                    }),
                                    init: Some(Box::new(Expr::Arrow(arrow_expr))),
                                    definite: false,
                                }],
                                declare: false,
                            }))));

                        // Insert at current position and increment for next iteration
                        module.body.insert(current_insert_pos, hoisted_decl);
                        current_insert_pos += 1;

                        // Create a registration call
                        let registration_call = Stmt::Expr(ExprStmt {
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
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: step_id.into(),
                                            raw: None,
                                        }))),
                                    },
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Ident(Ident::new(
                                            hoist_var_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                    },
                                ],
                                type_args: None,
                            })),
                        });

                        self.registration_calls.push(registration_call);
                    }

                    for call in self.registration_calls.drain(..) {
                        module.body.push(ModuleItem::Stmt(call));
                    }

                    // Add static method step registrations
                    for (class_name, method_name, step_id, _span) in
                        self.static_method_step_registrations.drain(..)
                    {
                        let registration_call = Stmt::Expr(ExprStmt {
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
                                    // Second argument: ClassName.methodName
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Member(MemberExpr {
                                            span: DUMMY_SP,
                                            obj: Box::new(Expr::Ident(Ident::new(
                                                class_name.into(),
                                                DUMMY_SP,
                                                SyntaxContext::empty(),
                                            ))),
                                            prop: MemberProp::Ident(IdentName::new(
                                                method_name.into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                    },
                                ],
                                type_args: None,
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }

                    // Add class serialization registrations for step mode
                    // In step mode, we need:
                    // 1. registerSerializationClass(classId, ClassName) - for deserialization
                    // 2. ClassName.classId = "..." - for serialization (though not typically needed in step mode)
                    for class_name in self.classes_needing_serialization.drain() {
                        // Generate class ID: class//filename//ClassName
                        let class_id =
                            naming::format_name("class", &self.filename, &class_name);

                        // Create: registerSerializationClass("class//...", ClassName)
                        let registration_call = Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Call(CallExpr {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                callee: Callee::Expr(Box::new(Expr::Ident(Ident::new(
                                    "registerSerializationClass".into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                )))),
                                args: vec![
                                    // First argument: class ID
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: class_id.into(),
                                            raw: None,
                                        }))),
                                    },
                                    // Second argument: ClassName
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Ident(Ident::new(
                                            class_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                    },
                                ],
                                type_args: None,
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }
                }

                // Add static step method property assignments (workflow mode)
                // These methods were stripped from the class and need to be assigned as properties
                if matches!(self.mode, TransformMode::Workflow) {
                    for (class_name, method_name, step_id) in
                        self.static_step_methods_to_strip.drain(..)
                    {
                        // Create: ClassName.methodName = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id")
                        let proxy_expr = Expr::Call(CallExpr {
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
                                            prop: MemberProp::Ident(IdentName::new(
                                                "for".into(),
                                                DUMMY_SP,
                                            )),
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
                        });

                        let assignment = Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Assign(AssignExpr {
                                span: DUMMY_SP,
                                left: AssignTarget::Simple(SimpleAssignTarget::Member(
                                    MemberExpr {
                                        span: DUMMY_SP,
                                        obj: Box::new(Expr::Ident(Ident::new(
                                            class_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                        prop: MemberProp::Ident(IdentName::new(
                                            method_name.into(),
                                            DUMMY_SP,
                                        )),
                                    },
                                )),
                                op: AssignOp::Assign,
                                right: Box::new(proxy_expr),
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(assignment));
                    }

                    // Add classId property assignments for class serialization in workflow mode
                    // This allows class constructors to be serialized when used as `this` in static method calls
                    // In workflow mode, we just set ClassName.classId = "class//..." (no import needed)
                    for class_name in self.classes_needing_serialization.drain() {
                        // Generate class ID: class//filename//ClassName
                        let class_id =
                            naming::format_name("class", &self.filename, &class_name);

                        // Create: ClassName.classId = "class//filename//ClassName"
                        let class_id_assignment = Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Assign(AssignExpr {
                                span: DUMMY_SP,
                                op: AssignOp::Assign,
                                left: AssignTarget::Simple(SimpleAssignTarget::Member(
                                    MemberExpr {
                                        span: DUMMY_SP,
                                        obj: Box::new(Expr::Ident(Ident::new(
                                            class_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                        prop: MemberProp::Ident(IdentName::new(
                                            "classId".into(),
                                            DUMMY_SP,
                                        )),
                                    },
                                )),
                                right: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: class_id.into(),
                                    raw: None,
                                }))),
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(class_id_assignment));
                    }
                }

                // Add static method workflow registrations (workflowId and __private_workflows.set)
                if matches!(self.mode, TransformMode::Workflow) {
                    for (class_name, method_name, workflow_id, _span) in
                        self.static_method_workflow_registrations.drain(..)
                    {
                        // Add ClassName.methodName.workflowId = "workflow_id"
                        let workflow_id_assignment = Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Assign(AssignExpr {
                                span: DUMMY_SP,
                                left: AssignTarget::Simple(SimpleAssignTarget::Member(
                                    MemberExpr {
                                        span: DUMMY_SP,
                                        obj: Box::new(Expr::Member(MemberExpr {
                                            span: DUMMY_SP,
                                            obj: Box::new(Expr::Ident(Ident::new(
                                                class_name.clone().into(),
                                                DUMMY_SP,
                                                SyntaxContext::empty(),
                                            ))),
                                            prop: MemberProp::Ident(IdentName::new(
                                                method_name.clone().into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                        prop: MemberProp::Ident(IdentName::new(
                                            "workflowId".into(),
                                            DUMMY_SP,
                                        )),
                                    },
                                )),
                                op: AssignOp::Assign,
                                right: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: workflow_id.clone().into(),
                                    raw: None,
                                }))),
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(workflow_id_assignment));

                        // Add globalThis.__private_workflows.set("workflow_id", ClassName.methodName)
                        let workflows_set_call = Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Call(CallExpr {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                    span: DUMMY_SP,
                                    obj: Box::new(Expr::Member(MemberExpr {
                                        span: DUMMY_SP,
                                        obj: Box::new(Expr::Ident(Ident::new(
                                            "globalThis".into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                        prop: MemberProp::Ident(IdentName::new(
                                            "__private_workflows".into(),
                                            DUMMY_SP,
                                        )),
                                    })),
                                    prop: MemberProp::Ident(IdentName::new("set".into(), DUMMY_SP)),
                                }))),
                                args: vec![
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: workflow_id.into(),
                                            raw: None,
                                        }))),
                                    },
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Member(MemberExpr {
                                            span: DUMMY_SP,
                                            obj: Box::new(Expr::Ident(Ident::new(
                                                class_name.into(),
                                                DUMMY_SP,
                                                SyntaxContext::empty(),
                                            ))),
                                            prop: MemberProp::Ident(IdentName::new(
                                                method_name.into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                    },
                                ],
                                type_args: None,
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(workflows_set_call));
                    }
                } else if matches!(self.mode, TransformMode::Step | TransformMode::Client) {
                    // For step/client mode, just add the workflowId assignment
                    for (class_name, method_name, workflow_id, _span) in
                        self.static_method_workflow_registrations.drain(..)
                    {
                        let workflow_id_assignment = Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Assign(AssignExpr {
                                span: DUMMY_SP,
                                left: AssignTarget::Simple(SimpleAssignTarget::Member(
                                    MemberExpr {
                                        span: DUMMY_SP,
                                        obj: Box::new(Expr::Member(MemberExpr {
                                            span: DUMMY_SP,
                                            obj: Box::new(Expr::Ident(Ident::new(
                                                class_name.into(),
                                                DUMMY_SP,
                                                SyntaxContext::empty(),
                                            ))),
                                            prop: MemberProp::Ident(IdentName::new(
                                                method_name.into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                        prop: MemberProp::Ident(IdentName::new(
                                            "workflowId".into(),
                                            DUMMY_SP,
                                        )),
                                    },
                                )),
                                op: AssignOp::Assign,
                                right: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: workflow_id.into(),
                                    raw: None,
                                }))),
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(workflow_id_assignment));
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
                            let needs_class_serialization =
                                !self.classes_needing_serialization.is_empty();
                            if !self.registration_calls.is_empty() {
                                module_items.push(self.create_private_imports(
                                    true,
                                    false,
                                ));
                            }
                            if needs_class_serialization {
                                module_items.push(self.create_class_serialization_import());
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
        let old_workflow_name = self.current_workflow_function_name.clone();
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
        self.current_workflow_function_name = old_workflow_name;
        self.in_module_level = old_in_module;
    }

    fn visit_mut_arrow_expr(&mut self, arrow: &mut ArrowExpr) {
        let has_step_directive = self.has_use_step_directive_arrow(&arrow.body);
        let has_workflow_directive = self.has_use_workflow_directive_arrow(&arrow.body);

        // Set context for forbidden expression checking
        let old_in_step = self.in_step_function;
        let old_in_workflow = self.in_workflow_function;
        let old_workflow_name = self.current_workflow_function_name.clone();
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
        self.current_workflow_function_name = old_workflow_name;
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
        // Collect all declared identifiers to avoid naming collisions
        self.collect_declared_identifiers(items);

        // Collect module-level imports first
        for item in items.iter() {
            if let ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) = item {
                for specifier in &import_decl.specifiers {
                    match specifier {
                        ImportSpecifier::Named(named) => {
                            self.module_imports.insert(named.local.sym.to_string());
                        }
                        ImportSpecifier::Default(default) => {
                            self.module_imports.insert(default.local.sym.to_string());
                        }
                        ImportSpecifier::Namespace(namespace) => {
                            self.module_imports.insert(namespace.local.sym.to_string());
                        }
                    }
                }
            }
        }

        // Check for file-level directives
        self.has_file_step_directive = self.check_module_directive(items);
        self.has_file_workflow_directive = self.check_module_workflow_directive(items);

        // Remove file-level directive if present
        if !items.is_empty() {
            if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = &items[0] {
                if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                    let should_remove = match self.mode {
                        TransformMode::Step => value == "use step" || value == "use workflow",
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
            // Add workflowId directly after the function declaration for all modes
            // In workflow mode, also add registration to __private_workflows map
            match item {
                ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                    // Directly exported function/variable declaration
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
                            // In workflow mode, also register the workflow function
                            if self.mode == TransformMode::Workflow {
                                items_to_insert.push((
                                    i + 1,
                                    ModuleItem::Stmt(self.create_workflow_registration(
                                        &fn_name,
                                        fn_decl.function.span,
                                    )),
                                ));
                            }
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
                                        // In workflow mode, also register the workflow function
                                        if self.mode == TransformMode::Workflow {
                                            items_to_insert.push((
                                                i + 1,
                                                ModuleItem::Stmt(
                                                    self.create_workflow_registration(&name, span),
                                                ),
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(default_decl)) => {
                    // Default exports
                    if let DefaultDecl::Fn(fn_expr) = &default_decl.decl {
                        // Check if this is a workflow function by checking for "default" key
                        if self.workflow_function_names.contains("default") {
                            // Only add workflowId for named default exports
                            // Anonymous ones are handled by default_workflow_exports
                            if let Some(ident) = &fn_expr.ident {
                                // Named default export: use the function name
                                let fn_name = ident.sym.to_string();
                                items_to_insert.push((
                                    i + 1,
                                    ModuleItem::Stmt(self.create_workflow_id_assignment(
                                        &fn_name,
                                        fn_expr.function.span,
                                    )),
                                ));
                                // In workflow mode, also register the workflow function
                                if self.mode == TransformMode::Workflow {
                                    items_to_insert.push((
                                        i + 1,
                                        ModuleItem::Stmt(self.create_workflow_registration(
                                            &fn_name,
                                            fn_expr.function.span,
                                        )),
                                    ));
                                }
                            }
                            // Anonymous default exports will have workflowId added by default_workflow_exports processing
                        }
                    }
                }
                ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                    // Non-exported function declaration
                    let fn_name = fn_decl.ident.sym.to_string();
                    if self.workflow_function_names.contains(&fn_name) {
                        items_to_insert.push((
                            i + 1,
                            ModuleItem::Stmt(
                                self.create_workflow_id_assignment(&fn_name, fn_decl.function.span),
                            ),
                        ));
                        // In workflow mode, also register the workflow function
                        if self.mode == TransformMode::Workflow {
                            items_to_insert.push((
                                i + 1,
                                ModuleItem::Stmt(
                                    self.create_workflow_registration(
                                        &fn_name,
                                        fn_decl.function.span,
                                    ),
                                ),
                            ));
                        }
                    }
                }
                ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
                    // Non-exported variable declaration
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
                                    // In workflow mode, also register the workflow function
                                    if self.mode == TransformMode::Workflow {
                                        items_to_insert.push((
                                            i + 1,
                                            ModuleItem::Stmt(
                                                self.create_workflow_registration(&name, span),
                                            ),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // Insert workflowId assignments in reverse order to maintain indices
        for (index, item) in items_to_insert.into_iter().rev() {
            items.insert(index, item);
        }

        // Clear workflow_exports_to_expand since workflowId is now added inline
        self.workflow_exports_to_expand.clear();

        // Handle default workflow exports (all modes)
        // We need to: 1) find the export default position, 2) replace it with const declaration,
        // 3) add workflowId assignment, 4) add export default at the end
        if !self.default_workflow_exports.is_empty() {
            let default_workflows: Vec<_> = self.default_workflow_exports.drain(..).collect();
            let default_exports: Vec<_> = self.default_exports_to_replace.drain(..).collect();

            // Find and remove the original export default, note its position
            let mut export_position = None;
            for (i, item) in items.iter().enumerate() {
                match item {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_))
                    | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_)) => {
                        export_position = Some(i);
                        break;
                    }
                    _ => {}
                }
            }

            if let Some(pos) = export_position {
                // Remove the original export default
                items.remove(pos);

                // Insert in correct order: const, workflowId, export default
                for (const_name, fn_expr, span) in default_workflows {
                    // Insert const declaration at the original export position
                    items.insert(
                        pos,
                        ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            kind: VarDeclKind::Const,
                            declare: false,
                            decls: vec![VarDeclarator {
                                span: DUMMY_SP,
                                name: Pat::Ident(BindingIdent {
                                    id: Ident::new(
                                        const_name.clone().into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    ),
                                    type_ann: None,
                                }),
                                init: Some(Box::new(fn_expr)),
                                definite: false,
                            }],
                        })))),
                    );

                    // Insert workflowId assignment after const
                    items.insert(
                        pos + 1,
                        ModuleItem::Stmt(self.create_workflow_id_assignment(&const_name, span)),
                    );

                    // In workflow mode, also insert registration after workflowId
                    let export_pos = if self.mode == TransformMode::Workflow {
                        items.insert(
                            pos + 2,
                            ModuleItem::Stmt(self.create_workflow_registration(&const_name, span)),
                        );
                        pos + 3
                    } else {
                        pos + 2
                    };

                    // Insert export default at the end (after workflowId and optional registration)
                    for (_export_name, replacement_expr) in &default_exports {
                        items.insert(
                            export_pos,
                            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(
                                ExportDefaultExpr {
                                    span: DUMMY_SP,
                                    expr: Box::new(replacement_expr.clone()),
                                },
                            )),
                        );
                    }
                }
            }
        } else {
            // Handle cases where default exports need to be converted but no const declaration
            let default_exports: Vec<_> = self.default_exports_to_replace.drain(..).collect();
            for (export_name, replacement_expr) in default_exports {
                for item in items.iter_mut() {
                    match item {
                        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(export_default)) => {
                            if export_name == "default" {
                                *item = ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(
                                    ExportDefaultExpr {
                                        span: export_default.span,
                                        expr: Box::new(replacement_expr.clone()),
                                    },
                                ));
                                break;
                            }
                        }
                        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(export_default)) => {
                            if export_name == "default" {
                                *item = ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(
                                    ExportDefaultExpr {
                                        span: export_default.span,
                                        expr: Box::new(replacement_expr.clone()),
                                    },
                                ));
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        // Clear the workflow_functions_needing_id since we've already processed them
        self.workflow_functions_needing_id.clear();

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
                                            let initializer =
                                                self.create_step_initializer(&step_id);
                                            // Preserve the original identifier's syntax context to avoid SWC renaming
                                            let orig_ctxt = binding.id.ctxt;
                                            declarator.init = Some(Box::new(initializer));
                                            // Update the identifier's syntax context
                                            let new_ident = Ident::new(
                                                name.as_str().into(),
                                                binding.id.span,
                                                orig_ctxt,
                                            );
                                            if let Pat::Ident(ref mut new_binding) = declarator.name
                                            {
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
                                ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(new_var_decl)))),
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

        // Track parent function name for nested step hoisting
        let old_parent_name = self.current_parent_function_name.clone();
        self.current_parent_function_name = Some(fn_name);

        fn_decl.visit_mut_children_with(self);

        // Restore parent function name
        self.current_parent_function_name = old_parent_name;
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        self.process_stmt(stmt);
    }

    fn visit_mut_block_stmt(&mut self, block: &mut BlockStmt) {
        for stmt in block.stmts.iter_mut() {
            self.process_stmt(stmt);
        }
    }

    fn visit_mut_export_decl(&mut self, export_decl: &mut ExportDecl) {
        // Check if this is a workflow function first, to set in_workflow_function flag
        let is_workflow_function = if let Decl::Fn(fn_decl) = &export_decl.decl {
            let fn_name = fn_decl.ident.sym.to_string();
            self.workflow_function_names.contains(&fn_name)
                || self.has_workflow_directive(&fn_decl.function, true)
        } else {
            false
        };

        #[cfg(debug_assertions)]
        if let Decl::Fn(fn_decl) = &export_decl.decl {
            eprintln!(
                "export fn {} workflow? {} (mode={:?})",
                fn_decl.ident.sym, is_workflow_function, self.mode
            );
        }

        let old_in_workflow = self.in_workflow_function;
        let old_workflow_name = self.current_workflow_function_name.clone();
        if is_workflow_function {
            self.in_workflow_function = true;
            // Get the function name for context tracking
            if let Decl::Fn(fn_decl) = &export_decl.decl {
                self.current_workflow_function_name = Some(fn_decl.ident.sym.to_string());
            }
        }

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
                } else if is_workflow_function {
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
                                // Workflow functions need step hoisting first, then transformation
                                // Store fn_name for later use after visiting children
                            }
                            TransformMode::Workflow => {
                                // Just remove the directive - workflowId is added inline in visit_mut_module_items
                                self.remove_use_workflow_directive(&mut fn_decl.function.body);
                            }
                            TransformMode::Client => {
                                // Only replace with throw if function has inline directive
                                // Functions with only file-level directive keep original body
                                let has_inline_directive =
                                    self.has_use_workflow_directive(&fn_decl.function.body);

                                self.remove_use_workflow_directive(&mut fn_decl.function.body);

                                if has_inline_directive {
                                    // Replace with error throw for inline workflow directives
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
                                }

                                self.workflow_functions_needing_id
                                    .push((fn_name.clone(), fn_decl.function.span));
                            }
                        }
                    }
                    // Visit children for workflow functions OUTSIDE the match to avoid borrow issues
                    export_decl.visit_mut_children_with(self);

                    // After visiting, process the function again for cleanup and Step mode transformation
                    if let Decl::Fn(fn_decl) = &mut export_decl.decl {
                        let fn_name = fn_decl.ident.sym.to_string();

                        // Remove empty statements from the function body (left by nested step hoisting)
                        // and filter out var declarations with Invalid expressions
                        if let Some(body) = &mut fn_decl.function.body {
                            // Remove empty statements
                            body.stmts.retain(|stmt| !matches!(stmt, Stmt::Empty(_)));

                            // Clean up var declarations with Invalid expressions
                            for stmt in body.stmts.iter_mut() {
                                if let Stmt::Decl(Decl::Var(var_decl)) = stmt {
                                    var_decl.decls.retain(|decl| {
                                        !matches!(decl.init.as_deref(), Some(Expr::Invalid(_)))
                                    });
                                }
                            }

                            // Remove empty var declarations
                            body.stmts.retain(|stmt| {
                                !matches!(stmt, Stmt::Decl(Decl::Var(var_decl)) if var_decl.decls.is_empty())
                            });
                        }

                        // In Step mode, transform workflow function AFTER step hoisting
                        if matches!(self.mode, TransformMode::Step) {
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
                                                    *init = Box::new(
                                                        self.create_step_initializer(&step_id),
                                                    );
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
                                                    // In step mode, transform workflow function expression with throw error
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
                                                        body.stmts = vec![Stmt::Throw(ThrowStmt {
                                                            span: DUMMY_SP,
                                                            arg: Box::new(error_expr),
                                                        })];
                                                    }

                                                    self.workflow_functions_needing_id.push((
                                                        name.clone(),
                                                        fn_expr.function.span,
                                                    ));
                                                }
                                                TransformMode::Workflow => {
                                                    // Just remove the directive - workflowId is added inline in visit_mut_module_items
                                                    self.remove_use_workflow_directive(
                                                        &mut fn_expr.function.body,
                                                    );
                                                }
                                                TransformMode::Client => {
                                                    // Only replace with throw if function has inline directive
                                                    let has_inline_directive = self
                                                        .has_use_workflow_directive(
                                                            &fn_expr.function.body,
                                                        );

                                                    self.remove_use_workflow_directive(
                                                        &mut fn_expr.function.body,
                                                    );

                                                    if has_inline_directive {
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
                                                    }

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
                                                    *init = Box::new(
                                                        self.create_step_initializer(&step_id),
                                                    );
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
                                                    // In step mode, transform workflow arrow function with throw error
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
                                                            expr: Box::new(Expr::Lit(Lit::Str(
                                                                Str {
                                                                    span: DUMMY_SP,
                                                                    value: error_msg.into(),
                                                                    raw: None,
                                                                },
                                                            ))),
                                                        }]),
                                                        type_args: None,
                                                    });
                                                    arrow_expr.body = Box::new(
                                                        BlockStmtOrExpr::BlockStmt(BlockStmt {
                                                            span: DUMMY_SP,
                                                            ctxt: SyntaxContext::empty(),
                                                            stmts: vec![Stmt::Throw(ThrowStmt {
                                                                span: DUMMY_SP,
                                                                arg: Box::new(error_expr),
                                                            })],
                                                        }),
                                                    );

                                                    self.workflow_functions_needing_id
                                                        .push((name.clone(), arrow_expr.span));
                                                }
                                                TransformMode::Workflow => {
                                                    // Just remove the directive - workflowId is added inline in visit_mut_module_items
                                                    self.remove_use_workflow_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );
                                                }
                                                TransformMode::Client => {
                                                    // Only replace with throw if function has inline directive
                                                    let has_inline_directive = self
                                                        .has_workflow_directive_arrow(
                                                            arrow_expr, false,
                                                        );

                                                    self.remove_use_workflow_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );

                                                    if has_inline_directive {
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
                                                    }

                                                    self.workflow_functions_needing_id
                                                        .push((name.clone(), arrow_expr.span));
                                                }
                                            }
                                        }
                                    }
                                }
                                Expr::Object(obj_lit) => {
                                    // Check for arrow functions in object properties with step directives
                                    self.process_object_properties_for_step_functions(
                                        obj_lit, &name,
                                    );
                                }
                                Expr::Call(call_expr) => {
                                    // Check arguments for object literals containing step functions
                                    for arg in &mut call_expr.args {
                                        if let Expr::Object(obj_lit) = &mut *arg.expr {
                                            self.process_object_properties_for_step_functions(
                                                obj_lit, &name,
                                            );
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

        // Remove workflow directive after processing children (for Decl::Var cases)
        // Decl::Fn is handled case-by-case above based on mode and nested steps
        if is_workflow_function {
            match &mut export_decl.decl {
                Decl::Var(var_decl) => {
                    // Handle arrow functions and function expressions in var declarations
                    for declarator in var_decl.decls.iter_mut() {
                        if let Some(init) = &mut declarator.init {
                            match &mut **init {
                                Expr::Arrow(arrow_expr) => {
                                    // For arrow functions, always remove directive (they can't have nested steps in the same way)
                                    self.remove_use_workflow_directive_arrow(&mut arrow_expr.body);
                                }
                                Expr::Fn(fn_expr) => {
                                    // For function expressions, always remove directive
                                    self.remove_use_workflow_directive(&mut fn_expr.function.body);
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // Restore in_workflow_function flag
        self.in_workflow_function = old_in_workflow;
        self.current_workflow_function_name = old_workflow_name;
    }

    fn visit_mut_var_decl(&mut self, var_decl: &mut VarDecl) {
        // Handle variable declarations with function expressions
        for decl in var_decl.decls.iter_mut() {
            if let Some(init) = &mut decl.init {
                if let Pat::Ident(binding) = &decl.name {
                    let name = binding.id.sym.to_string();

                    match &mut **init {
                        Expr::Fn(fn_expr) => {
                            let has_step = self.has_step_directive(&fn_expr.function, false);
                            let has_workflow =
                                self.has_workflow_directive(&fn_expr.function, false);

                            // Check for step directive first
                            if has_step {
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
                            } else if has_workflow {
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
                                            // In step mode, transform workflow function with throw error
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
                            } else {
                                // Regular function expression (not step/workflow) - track parent context for nested steps
                                let old_parent = self.current_parent_function_name.clone();
                                let old_in_module = self.in_module_level;
                                self.current_parent_function_name = Some(name.clone());
                                self.in_module_level = false;
                                fn_expr.visit_mut_children_with(self);
                                self.current_parent_function_name = old_parent;
                                self.in_module_level = old_in_module;
                                // Continue to next declarator (don't return early)
                            }
                        }
                        Expr::Arrow(arrow_expr) => {
                            let has_step = self.has_step_directive_arrow(arrow_expr, false);
                            let has_workflow = self.has_workflow_directive_arrow(arrow_expr, false);

                            // Check for step directive first
                            if has_step {
                                // Validate that it's async - emit error if not
                                if !arrow_expr.is_async {
                                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                                        span: arrow_expr.span,
                                        directive: "use step",
                                    });
                                } else {
                                    // It's valid - proceed with transformation
                                    self.step_function_names.insert(name.clone());

                                    // Check if we're inside any function (nested), not just workflow functions
                                    if !self.in_module_level {
                                        match self.mode {
                                            TransformMode::Step => {
                                                // Hoist arrow function to module scope
                                                let mut cloned_arrow = arrow_expr.clone();
                                                self.remove_use_step_directive_arrow(
                                                    &mut cloned_arrow.body,
                                                );

                                                // Collect closure variables before conversion
                                                let closure_vars = ClosureVariableCollector::collect_from_arrow_expr(&cloned_arrow, &self.module_imports);

                                                // Create a function expression from the arrow function
                                                // (We need to convert it to a regular function for hoisting)
                                                let fn_expr = FnExpr {
                                                    ident: Some(Ident::new(
                                                        name.clone().into(),
                                                        DUMMY_SP,
                                                        SyntaxContext::empty(),
                                                    )),
                                                    function: Box::new(Function {
                                                        params: cloned_arrow
                                                            .params
                                                            .iter()
                                                            .map(|pat| Param {
                                                                span: DUMMY_SP,
                                                                decorators: vec![],
                                                                pat: pat.clone(),
                                                            })
                                                            .collect(),
                                                        decorators: vec![],
                                                        span: cloned_arrow.span,
                                                        ctxt: SyntaxContext::empty(),
                                                        body: match *cloned_arrow.body {
                                                            BlockStmtOrExpr::BlockStmt(block) => {
                                                                Some(block)
                                                            }
                                                            BlockStmtOrExpr::Expr(expr) => {
                                                                Some(BlockStmt {
                                                                    span: DUMMY_SP,
                                                                    ctxt: SyntaxContext::empty(),
                                                                    stmts: vec![Stmt::Return(
                                                                        ReturnStmt {
                                                                            span: DUMMY_SP,
                                                                            arg: Some(expr),
                                                                        },
                                                                    )],
                                                                })
                                                            }
                                                        },
                                                        is_generator: false,
                                                        is_async: cloned_arrow.is_async,
                                                        type_params: cloned_arrow
                                                            .type_params
                                                            .clone(),
                                                        return_type: cloned_arrow
                                                            .return_type
                                                            .clone(),
                                                    }),
                                                };

                                                self.nested_step_functions.push((
                                                    name.clone(),
                                                    fn_expr,
                                                    arrow_expr.span,
                                                    closure_vars,
                                                    true, // Was an arrow function
                                                    self.current_parent_function_name
                                                        .clone()
                                                        .unwrap_or_default(),
                                                ));

                                                // Replace with identifier reference to the hoisted function
                                                let hoisted_name = if let Some(parent) =
                                                    &self.current_parent_function_name
                                                {
                                                    if !parent.is_empty() {
                                                        format!("{}${}", parent, name)
                                                    } else {
                                                        name
                                                    }
                                                } else {
                                                    name
                                                };
                                                *init = Box::new(Expr::Ident(Ident::new(
                                                    hoisted_name.into(),
                                                    DUMMY_SP,
                                                    SyntaxContext::empty(),
                                                )));
                                            }
                                            TransformMode::Workflow => {
                                                // Replace with proxy reference (not a function call)
                                                // Include parent workflow name in step ID
                                                let step_fn_name = if let Some(parent) =
                                                    &self.current_workflow_function_name
                                                {
                                                    format!("{}/{}", parent, name)
                                                } else {
                                                    name.clone()
                                                };
                                                let step_id = self.create_id(
                                                    Some(&step_fn_name),
                                                    arrow_expr.span,
                                                    false,
                                                );

                                                // Collect closure variables
                                                let closure_vars = ClosureVariableCollector::collect_from_arrow_expr(&arrow_expr, &self.module_imports);
                                                *init = Box::new(self.create_step_proxy_reference(
                                                    &step_id,
                                                    &closure_vars,
                                                ));
                                            }
                                            TransformMode::Client => {
                                                // In client mode, just remove the directive and keep the function
                                                self.remove_use_step_directive_arrow(
                                                    &mut arrow_expr.body,
                                                );
                                            }
                                        }
                                    } else {
                                        // At module level - handle normally
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
                                                // Keep the arrow function but replace its body with a proxy call
                                                self.remove_use_step_directive_arrow(
                                                    &mut arrow_expr.body,
                                                );
                                                let step_id = self.create_id(
                                                    Some(&name),
                                                    arrow_expr.span,
                                                    false,
                                                );
                                                let mut proxy_call =
                                                    self.create_step_proxy(&step_id);
                                                // Add function arguments to the proxy call
                                                if let Expr::Call(call) = &mut proxy_call {
                                                    call.args = arrow_expr
                                                        .params
                                                        .iter()
                                                        .map(|param| {
                                                            // Check if this is a rest parameter
                                                            let is_rest =
                                                                matches!(param, Pat::Rest(_));
                                                            ExprOrSpread {
                                                                spread: if is_rest {
                                                                    Some(DUMMY_SP)
                                                                } else {
                                                                    None
                                                                },
                                                                expr: Box::new(
                                                                    self.pat_to_expr(param),
                                                                ),
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
                                }
                            } else if has_workflow {
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
                                            // In step mode, transform workflow arrow function with throw error
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
                            } else {
                                // Regular arrow function (not step/workflow) - track parent context for nested steps
                                let old_parent = self.current_parent_function_name.clone();
                                let old_in_module = self.in_module_level;
                                self.current_parent_function_name = Some(name.clone());
                                self.in_module_level = false;
                                arrow_expr.visit_mut_children_with(self);
                                self.current_parent_function_name = old_parent;
                                self.in_module_level = old_in_module;
                                // Continue to next declarator (don't return early)
                            }
                        }
                        Expr::Object(obj_lit) => {
                            // Check for arrow functions in object properties with step directives
                            self.process_object_properties_for_step_functions(obj_lit, &name);
                        }
                        Expr::Call(call_expr) => {
                            // Check arguments for object literals containing step functions
                            for arg in &mut call_expr.args {
                                if let Expr::Object(obj_lit) = &mut *arg.expr {
                                    self.process_object_properties_for_step_functions(
                                        obj_lit, &name,
                                    );
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

    // Handle class declarations to track class name for static methods
    fn visit_mut_class_decl(&mut self, class_decl: &mut ClassDecl) {
        let class_name = class_decl.ident.sym.to_string();
        let old_class_name = self.current_class_name.take();
        self.current_class_name = Some(class_name.clone());

        // Visit the class body (this populates static_step_methods_to_strip)
        class_decl.class.visit_mut_with(self);

        // In workflow mode, remove static step methods from the class body
        if matches!(self.mode, TransformMode::Workflow) {
            let methods_to_strip: Vec<_> = self
                .static_step_methods_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &class_name)
                .map(|(_, mn, _)| mn.clone())
                .collect();

            if !methods_to_strip.is_empty() {
                class_decl.class.body.retain(|member| {
                    if let ClassMember::Method(method) = member {
                        if method.is_static {
                            if let PropName::Ident(ident) = &method.key {
                                let method_name = ident.sym.to_string();
                                return !methods_to_strip.contains(&method_name);
                            }
                        }
                    }
                    true
                });
            }
        }

        // Restore previous class name
        self.current_class_name = old_class_name;
    }

    // Handle class expressions to track class name for static methods
    fn visit_mut_class_expr(&mut self, class_expr: &mut ClassExpr) {
        let class_name = class_expr
            .ident
            .as_ref()
            .map(|i| i.sym.to_string())
            .unwrap_or_else(|| "AnonymousClass".to_string());
        let old_class_name = self.current_class_name.take();
        self.current_class_name = Some(class_name.clone());

        // Visit the class body (this populates static_step_methods_to_strip)
        class_expr.class.visit_mut_with(self);

        // In workflow mode, remove static step methods from the class body
        if matches!(self.mode, TransformMode::Workflow) {
            let methods_to_strip: Vec<_> = self
                .static_step_methods_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &class_name)
                .map(|(_, mn, _)| mn.clone())
                .collect();

            if !methods_to_strip.is_empty() {
                class_expr.class.body.retain(|member| {
                    if let ClassMember::Method(method) = member {
                        if method.is_static {
                            if let PropName::Ident(ident) = &method.key {
                                let method_name = ident.sym.to_string();
                                return !methods_to_strip.contains(&method_name);
                            }
                        }
                    }
                    true
                });
            }
        }

        // Restore previous class name
        self.current_class_name = old_class_name;
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
            let has_step = self.has_use_step_directive(&method.function.body);
            let has_workflow = self.has_use_workflow_directive(&method.function.body);

            if has_step || has_workflow {
                // Validate async
                if !method.function.is_async {
                    let directive = if has_step { "use step" } else { "use workflow" };
                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                        span: method.function.span,
                        directive,
                    });
                    return;
                }

                // Get method name
                let method_name = match &method.key {
                    PropName::Ident(ident) => ident.sym.to_string(),
                    PropName::Str(s) => s.value.to_string_lossy().to_string(),
                    _ => {
                        // Complex key - skip
                        method.visit_mut_children_with(self);
                        return;
                    }
                };

                // Get class name (must be set by visit_mut_class)
                let class_name = match &self.current_class_name {
                    Some(name) => name.clone(),
                    None => {
                        // No class context - shouldn't happen, but fall back
                        method.visit_mut_children_with(self);
                        return;
                    }
                };

                // Generate full qualified name: ClassName.methodName
                let full_name = format!("{}.{}", class_name, method_name);

                if has_step {
                    self.step_function_names.insert(full_name.clone());

                    // Track class for serialization (needed for `this` serialization in static method calls)
                    self.classes_needing_serialization
                        .insert(class_name.clone());

                    match self.mode {
                        TransformMode::Step => {
                            // Remove directive
                            self.remove_use_step_directive(&mut method.function.body);

                            // Generate step ID
                            let step_id =
                                self.create_id(Some(&full_name), method.function.span, false);

                            // Track for registration after class
                            self.static_method_step_registrations.push((
                                class_name.clone(),
                                method_name.clone(),
                                step_id,
                                method.function.span,
                            ));
                        }
                        TransformMode::Workflow => {
                            // Remove directive for consistency with other modes
                            self.remove_use_step_directive(&mut method.function.body);

                            // Generate step ID
                            let step_id =
                                self.create_id(Some(&full_name), method.function.span, false);

                            // Track this method to be stripped from the class and assigned as a property
                            self.static_step_methods_to_strip.push((
                                class_name.clone(),
                                method_name.clone(),
                                step_id,
                            ));
                        }
                        TransformMode::Client => {
                            // Just remove directive, keep the function body
                            self.remove_use_step_directive(&mut method.function.body);
                        }
                    }
                } else if has_workflow {
                    self.workflow_function_names.insert(full_name.clone());

                    match self.mode {
                        TransformMode::Workflow => {
                            // Remove directive
                            self.remove_use_workflow_directive(&mut method.function.body);

                            // Generate workflow ID
                            let workflow_id =
                                self.create_id(Some(&full_name), method.function.span, true);

                            // Track for registration after class
                            self.static_method_workflow_registrations.push((
                                class_name.clone(),
                                method_name.clone(),
                                workflow_id,
                                method.function.span,
                            ));
                        }
                        TransformMode::Step | TransformMode::Client => {
                            // Remove directive and replace body with error
                            self.remove_use_workflow_directive(&mut method.function.body);

                            // Generate workflow ID
                            let workflow_id =
                                self.create_id(Some(&full_name), method.function.span, true);

                            // Replace body with error throw
                            method.function.body = Some(BlockStmt {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                stmts: vec![Stmt::Throw(ThrowStmt {
                                    span: DUMMY_SP,
                                    arg: Box::new(Expr::New(NewExpr {
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
                                                value: format!(
                                                    "You attempted to execute workflow {} function directly. To start a workflow, use start(workflow) from workflow/api",
                                                    full_name
                                                ).into(),
                                                raw: None,
                                            }))),
                                        }]),
                                        type_args: None,
                                    })),
                                })],
                            });

                            // Track for workflowId assignment
                            self.static_method_workflow_registrations.push((
                                class_name.clone(),
                                method_name.clone(),
                                workflow_id,
                                method.function.span,
                            ));
                        }
                    }
                }
            } else {
                method.visit_mut_children_with(self);
            }
        }
    }

    // Handle assignment expressions
    fn visit_mut_assign_expr(&mut self, assign: &mut AssignExpr) {
        // Track function names from assignments like `foo = async () => {}`
        assign.visit_mut_children_with(self);
    }

    // Override visit_mut_expr to track closure variables and handle step functions
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        // Track closure variables first
        if !self.in_module_level && self.should_track_names {
            if let Ok(name) = Name::try_from(&*expr) {
                if self.in_callee {
                    // This is a callee, we need to track the actual value
                    // For now, just track the name
                }
                self.names.push(name);
            }
        }

        // Handle step functions that appear in expressions (e.g., return statements)
        // but are not in var declarators (those are handled in visit_mut_var_decl)
        match expr {
            Expr::Fn(fn_expr) => {
                if self.has_step_directive(&fn_expr.function, false) {
                    if !fn_expr.function.is_async {
                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                            span: fn_expr.function.span,
                            directive: "use step",
                        });
                    } else if !self.in_module_level {
                        // Nested step function in an expression (e.g., return statement)
                        let name = fn_expr
                            .ident
                            .as_ref()
                            .map(|i| i.sym.to_string())
                            .unwrap_or_else(|| {
                                // Generate a name for anonymous functions
                                let name = format!("_anonymousStep{}", self.anonymous_fn_counter);
                                self.anonymous_fn_counter += 1;
                                name
                            });

                        if fn_expr.ident.is_some() {
                            // Only increment if we didn't use it above
                            // (the closure above already incremented)
                        }

                        self.step_function_names.insert(name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                // Hoist to module scope
                                let mut cloned_function = fn_expr.function.clone();
                                self.remove_use_step_directive(&mut cloned_function.body);

                                let closure_vars = ClosureVariableCollector::collect_from_function(
                                    &cloned_function,
                                    &self.module_imports,
                                );

                                let hoisted_fn_expr = FnExpr {
                                    ident: Some(Ident::new(
                                        name.clone().into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )),
                                    function: cloned_function,
                                };

                                self.nested_step_functions.push((
                                    name.clone(),
                                    hoisted_fn_expr,
                                    fn_expr.function.span,
                                    closure_vars,
                                    false, // Not an arrow function
                                    self.current_parent_function_name
                                        .clone()
                                        .unwrap_or_default(),
                                ));

                                // Replace with identifier reference
                                let hoisted_name =
                                    if let Some(parent) = &self.current_parent_function_name {
                                        if !parent.is_empty() {
                                            format!("{}${}", parent, name)
                                        } else {
                                            name
                                        }
                                    } else {
                                        name
                                    };
                                *expr = Expr::Ident(Ident::new(
                                    hoisted_name.into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                ));
                                return; // Don't visit children since we replaced the expr
                            }
                            TransformMode::Workflow => {
                                // Replace with proxy reference
                                // Use current_parent_function_name to match step mode's ID generation
                                let step_fn_name =
                                    if let Some(parent) = &self.current_parent_function_name {
                                        if !parent.is_empty() {
                                            format!("{}/{}", parent, name)
                                        } else {
                                            name.clone()
                                        }
                                    } else {
                                        name.clone()
                                    };
                                let step_id = self.create_id(
                                    Some(&step_fn_name),
                                    fn_expr.function.span,
                                    false,
                                );

                                let closure_vars = ClosureVariableCollector::collect_from_function(
                                    &fn_expr.function,
                                    &self.module_imports,
                                );
                                *expr = self.create_step_proxy_reference(&step_id, &closure_vars);
                                return; // Don't visit children since we replaced the expr
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and keep the function
                                self.remove_use_step_directive(&mut fn_expr.function.body);
                            }
                        }
                    }
                }
            }
            Expr::Arrow(arrow_expr) => {
                if self.has_step_directive_arrow(arrow_expr, false) {
                    if !arrow_expr.is_async {
                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                            span: arrow_expr.span,
                            directive: "use step",
                        });
                    } else if !self.in_module_level {
                        // Nested step arrow function in an expression (e.g., return statement)
                        let name = format!("_anonymousStep{}", self.anonymous_fn_counter);
                        self.anonymous_fn_counter += 1;
                        self.step_function_names.insert(name.clone());

                        match self.mode {
                            TransformMode::Step => {
                                // Hoist to module scope
                                let mut cloned_arrow = arrow_expr.clone();
                                self.remove_use_step_directive_arrow(&mut cloned_arrow.body);

                                let closure_vars =
                                    ClosureVariableCollector::collect_from_arrow_expr(
                                        &cloned_arrow,
                                        &self.module_imports,
                                    );

                                // Convert to function expression for hoisting
                                let fn_expr = FnExpr {
                                    ident: Some(Ident::new(
                                        name.clone().into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )),
                                    function: Box::new(Function {
                                        params: cloned_arrow
                                            .params
                                            .iter()
                                            .map(|pat| Param {
                                                span: DUMMY_SP,
                                                decorators: vec![],
                                                pat: pat.clone(),
                                            })
                                            .collect(),
                                        decorators: vec![],
                                        span: cloned_arrow.span,
                                        ctxt: SyntaxContext::empty(),
                                        body: match *cloned_arrow.body {
                                            BlockStmtOrExpr::BlockStmt(block) => Some(block),
                                            BlockStmtOrExpr::Expr(expr) => Some(BlockStmt {
                                                span: DUMMY_SP,
                                                ctxt: SyntaxContext::empty(),
                                                stmts: vec![Stmt::Return(ReturnStmt {
                                                    span: DUMMY_SP,
                                                    arg: Some(expr),
                                                })],
                                            }),
                                        },
                                        is_generator: false,
                                        is_async: cloned_arrow.is_async,
                                        type_params: cloned_arrow.type_params.clone(),
                                        return_type: cloned_arrow.return_type.clone(),
                                    }),
                                };

                                self.nested_step_functions.push((
                                    name.clone(),
                                    fn_expr,
                                    arrow_expr.span,
                                    closure_vars,
                                    true, // Was an arrow function
                                    self.current_parent_function_name
                                        .clone()
                                        .unwrap_or_default(),
                                ));

                                // Replace with identifier reference
                                let hoisted_name =
                                    if let Some(parent) = &self.current_parent_function_name {
                                        if !parent.is_empty() {
                                            format!("{}${}", parent, name)
                                        } else {
                                            name
                                        }
                                    } else {
                                        name
                                    };
                                *expr = Expr::Ident(Ident::new(
                                    hoisted_name.into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                ));
                                return; // Don't visit children since we replaced the expr
                            }
                            TransformMode::Workflow => {
                                // Replace with proxy reference
                                // Use current_parent_function_name to match step mode's ID generation
                                let step_fn_name =
                                    if let Some(parent) = &self.current_parent_function_name {
                                        if !parent.is_empty() {
                                            format!("{}/{}", parent, name)
                                        } else {
                                            name.clone()
                                        }
                                    } else {
                                        name.clone()
                                    };
                                let step_id =
                                    self.create_id(Some(&step_fn_name), arrow_expr.span, false);

                                let closure_vars =
                                    ClosureVariableCollector::collect_from_arrow_expr(
                                        arrow_expr,
                                        &self.module_imports,
                                    );
                                *expr = self.create_step_proxy_reference(&step_id, &closure_vars);
                                return; // Don't visit children since we replaced the expr
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and keep the function
                                self.remove_use_step_directive_arrow(&mut arrow_expr.body);
                            }
                        }
                    }
                }
            }
            _ => {}
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
                        // For ALL default exports, track mapping from "default" to actual const name
                        let const_name = if fn_name == "default" {
                            // Anonymous: generate unique name
                            let unique_name = self.generate_unique_name("__default");
                            self.workflow_export_to_const_name
                                .insert("default".to_string(), unique_name.clone());
                            unique_name
                        } else {
                            // Named: use the function name
                            self.workflow_export_to_const_name
                                .insert("default".to_string(), fn_name.clone());
                            fn_name.clone()
                        };

                        // Always use "default" as the metadata key for default exports
                        self.workflow_function_names.insert("default".to_string());

                        match self.mode {
                            TransformMode::Step | TransformMode::Client => {
                                // In step/client mode, replace workflow function body with error throw
                                self.remove_use_workflow_directive(&mut fn_expr.function.body);

                                let error_msg = format!(
                                    "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                    const_name, const_name
                                );
                                if let Some(body) = &mut fn_expr.function.body {
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

                                // For anonymous functions, convert to const declaration so we can assign workflowId
                                if fn_name == "default" {
                                    // Track for const declaration and workflowId assignment
                                    self.default_workflow_exports.push((
                                        const_name.clone(),
                                        Expr::Fn(fn_expr.clone()),
                                        fn_expr.function.span,
                                    ));

                                    // Track for replacement with identifier
                                    self.default_exports_to_replace.push((
                                        fn_name.clone(),
                                        Expr::Ident(Ident::new(
                                            const_name.clone().into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        )),
                                    ));
                                    // workflowId assignment is handled by default_workflow_exports processing
                                } else {
                                    // Named function can be referenced directly, just add workflowId
                                    self.workflow_functions_needing_id
                                        .push((const_name.clone(), fn_expr.function.span));
                                }
                            }
                            TransformMode::Workflow => {
                                // Remove the directive - workflowId for named default exports is handled inline
                                self.remove_use_workflow_directive(&mut fn_expr.function.body);

                                if fn_name == "default" {
                                    // Anonymous default export: convert to const declaration
                                    // Track for const declaration and workflowId assignment
                                    self.default_workflow_exports.push((
                                        const_name.clone(),
                                        Expr::Fn(fn_expr.clone()),
                                        fn_expr.function.span,
                                    ));

                                    // Track for replacement with identifier
                                    self.default_exports_to_replace.push((
                                        fn_name.clone(),
                                        Expr::Ident(Ident::new(
                                            const_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        )),
                                    ));
                                }
                                // Named default exports: workflowId is added inline in visit_mut_module_items
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

    // Handle export default expressions (anonymous functions and arrow functions)
    fn visit_mut_export_default_expr(&mut self, expr: &mut ExportDefaultExpr) {
        match &mut *expr.expr {
            Expr::Fn(fn_expr) => {
                // Anonymous function: export default async function() { ... }
                if self.should_transform_workflow_function(&fn_expr.function, true) {
                    if self.validate_async_function(&fn_expr.function, fn_expr.function.span) {
                        // Generate unique name first so we can use it in workflow_function_names
                        let unique_name = self.generate_unique_name("__default");
                        // For function expression default exports, track mapping from "default" to actual const name
                        self.workflow_export_to_const_name
                            .insert("default".to_string(), unique_name.clone());

                        // Always use "default" as the metadata key for default exports
                        self.workflow_function_names.insert("default".to_string());

                        match self.mode {
                            TransformMode::Step | TransformMode::Client => {
                                // In step/client mode, replace workflow function body with error throw
                                self.remove_use_workflow_directive(&mut fn_expr.function.body);
                                let error_msg = format!(
                                    "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                    unique_name, unique_name
                                );
                                if let Some(body) = &mut fn_expr.function.body {
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

                                // Track for const declaration and workflowId assignment
                                self.default_workflow_exports.push((
                                    unique_name.clone(),
                                    Expr::Fn(fn_expr.clone()),
                                    fn_expr.function.span,
                                ));

                                // Track for replacement with identifier
                                self.default_exports_to_replace.push((
                                    "default".to_string(),
                                    Expr::Ident(Ident::new(
                                        unique_name.into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )),
                                ));
                            }
                            TransformMode::Workflow => {
                                // In workflow mode, convert to const declaration
                                self.remove_use_workflow_directive(&mut fn_expr.function.body);

                                // Track for const declaration and workflowId assignment
                                self.default_workflow_exports.push((
                                    unique_name.clone(),
                                    Expr::Fn(fn_expr.clone()),
                                    fn_expr.function.span,
                                ));

                                // Track for replacement with identifier
                                self.default_exports_to_replace.push((
                                    "default".to_string(),
                                    Expr::Ident(Ident::new(
                                        unique_name.into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )),
                                ));
                            }
                        }
                    }
                } else if self.should_transform_function(&fn_expr.function, true) {
                    // Handle step functions
                    if self.validate_async_function(&fn_expr.function, fn_expr.function.span) {
                        self.step_function_names.insert("default".to_string());
                        // Similar logic for steps...
                    }
                }
            }
            Expr::Arrow(arrow_expr) => {
                // Arrow function: export default async () => { ... }
                if self.has_workflow_directive_arrow(arrow_expr, true) {
                    if !arrow_expr.is_async {
                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                            span: arrow_expr.span,
                            directive: "use workflow",
                        });
                    } else {
                        // For arrow function default exports, generate unique name and track mapping
                        let unique_name = self.generate_unique_name("__default");
                        self.workflow_export_to_const_name
                            .insert("default".to_string(), unique_name.clone());

                        // Always use "default" as the metadata key for default exports
                        self.workflow_function_names.insert("default".to_string());

                        match self.mode {
                            TransformMode::Step | TransformMode::Client => {
                                // In step/client mode, replace arrow body with throw error
                                self.remove_use_workflow_directive_arrow(&mut arrow_expr.body);
                                let error_msg = format!(
                                    "You attempted to execute workflow {} function directly. To start a workflow, use start({}) from workflow/api",
                                    unique_name, unique_name
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
                                // Replace arrow body with block containing throw statement
                                arrow_expr.body = Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                                    span: DUMMY_SP,
                                    ctxt: SyntaxContext::empty(),
                                    stmts: vec![Stmt::Throw(ThrowStmt {
                                        span: DUMMY_SP,
                                        arg: Box::new(error_expr),
                                    })],
                                }));

                                // Track for const declaration and workflowId assignment
                                self.default_workflow_exports.push((
                                    unique_name.clone(),
                                    Expr::Arrow(arrow_expr.clone()),
                                    arrow_expr.span,
                                ));

                                // Track for replacement with identifier
                                self.default_exports_to_replace.push((
                                    "default".to_string(),
                                    Expr::Ident(Ident::new(
                                        unique_name.into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )),
                                ));
                            }
                            TransformMode::Workflow => {
                                // In workflow mode, convert to const declaration
                                self.remove_use_workflow_directive_arrow(&mut arrow_expr.body);

                                // Track for const declaration and workflowId assignment
                                self.default_workflow_exports.push((
                                    unique_name.clone(),
                                    Expr::Arrow(arrow_expr.clone()),
                                    arrow_expr.span,
                                ));

                                // Track for replacement with identifier
                                self.default_exports_to_replace.push((
                                    "default".to_string(),
                                    Expr::Ident(Ident::new(
                                        unique_name.into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )),
                                ));
                            }
                        }
                    }
                } else if self.has_step_directive_arrow(arrow_expr, true) {
                    // Handle step arrow functions
                    if !arrow_expr.is_async {
                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                            span: arrow_expr.span,
                            directive: "use step",
                        });
                    } else {
                        self.step_function_names.insert("default".to_string());
                        // Similar logic for steps...
                    }
                }
            }
            _ => {}
        }

        expr.visit_mut_children_with(self);
    }

    fn visit_mut_module_decl(&mut self, decl: &mut ModuleDecl) {
        // ExportDecl is fully handled by visit_mut_export_decl, so just delegate
        // to default visitor which will call visit_mut_export_decl
        match decl {
            ModuleDecl::ExportDecl(_) => {
                decl.visit_mut_children_with(self);
            }
            _ => {
                decl.visit_mut_children_with(self);
            }
        }
    }

    fn visit_mut_object_lit(&mut self, obj_lit: &mut ObjectLit) {
        // When inside a workflow function, check each property for step functions
        if self.in_workflow_function {
            for prop in &mut obj_lit.props {
                if let PropOrSpread::Prop(boxed_prop) = prop {
                    // Get the property key first for naming
                    let prop_key = match &**boxed_prop {
                        Prop::KeyValue(kv) => match &kv.key {
                            PropName::Ident(ident) => Some(ident.sym.to_string()),
                            PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                            _ => None,
                        },
                        Prop::Method(m) => match &m.key {
                            PropName::Ident(ident) => Some(ident.sym.to_string()),
                            PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                            _ => None,
                        },
                        _ => None,
                    };

                    match &mut **boxed_prop {
                        Prop::KeyValue(kv_prop) => {
                            if let Some(_prop_name) = &prop_key {
                                match &mut *kv_prop.value {
                                    Expr::Arrow(arrow_expr) => {
                                        if self.has_step_directive_arrow(arrow_expr, false) {
                                            if !arrow_expr.is_async {
                                                emit_error(WorkflowErrorKind::NonAsyncFunction {
                                                    span: arrow_expr.span,
                                                    directive: "use step",
                                                });
                                            } else {
                                                // Generate a unique name
                                                let generated_name = format!(
                                                    "_anonymousStep{}",
                                                    self.anonymous_fn_counter
                                                );
                                                self.anonymous_fn_counter += 1;
                                                self.step_function_names
                                                    .insert(generated_name.clone());

                                                match self.mode {
                                                    TransformMode::Step => {
                                                        // Hoist to module scope
                                                        let mut cloned_arrow = arrow_expr.clone();
                                                        self.remove_use_step_directive_arrow(
                                                            &mut cloned_arrow.body,
                                                        );

                                                        // Collect closure variables
                                                        let closure_vars = ClosureVariableCollector::collect_from_arrow_expr(&cloned_arrow, &self.module_imports);

                                                        // Convert to function expression
                                                        let fn_expr = FnExpr {
                                                            ident: Some(Ident::new(
                                                                generated_name.clone().into(),
                                                                DUMMY_SP,
                                                                SyntaxContext::empty(),
                                                            )),
                                                            function: Box::new(Function {
                                                                params: cloned_arrow
                                                                    .params
                                                                    .iter()
                                                                    .map(|pat| Param {
                                                                        span: DUMMY_SP,
                                                                        decorators: vec![],
                                                                        pat: pat.clone(),
                                                                    })
                                                                    .collect(),
                                                                decorators: vec![],
                                                                span: cloned_arrow.span,
                                                                ctxt: SyntaxContext::empty(),
                                                                body: match *cloned_arrow.body {
                                                                    BlockStmtOrExpr::BlockStmt(
                                                                        block,
                                                                    ) => Some(block),
                                                                    BlockStmtOrExpr::Expr(expr) => {
                                                                        Some(BlockStmt {
                                                                            span: DUMMY_SP,
                                                                            ctxt:
                                                                                SyntaxContext::empty(
                                                                                ),
                                                                            stmts: vec![
                                                                                Stmt::Return(
                                                                                    ReturnStmt {
                                                                                        span:
                                                                                            DUMMY_SP,
                                                                                        arg: Some(
                                                                                            expr,
                                                                                        ),
                                                                                    },
                                                                                ),
                                                                            ],
                                                                        })
                                                                    }
                                                                },
                                                                is_generator: false,
                                                                is_async: cloned_arrow.is_async,
                                                                type_params: cloned_arrow
                                                                    .type_params
                                                                    .clone(),
                                                                return_type: cloned_arrow
                                                                    .return_type
                                                                    .clone(),
                                                            }),
                                                        };

                                                        self.nested_step_functions.push((
                                                            generated_name.clone(),
                                                            fn_expr,
                                                            arrow_expr.span,
                                                            closure_vars,
                                                            true, // Was an arrow function
                                                            self.current_workflow_function_name
                                                                .clone()
                                                                .unwrap_or_default(),
                                                        ));

                                                        // Replace with identifier reference
                                                        *kv_prop.value = Expr::Ident(Ident::new(
                                                            generated_name.into(),
                                                            DUMMY_SP,
                                                            SyntaxContext::empty(),
                                                        ));
                                                    }
                                                    TransformMode::Workflow => {
                                                        // Replace with step proxy reference
                                                        self.remove_use_step_directive_arrow(
                                                            &mut arrow_expr.body,
                                                        );
                                                        // Include parent workflow name in step ID
                                                        let step_fn_name = if let Some(parent) =
                                                            &self.current_workflow_function_name
                                                        {
                                                            format!("{}/{}", parent, generated_name)
                                                        } else {
                                                            generated_name.clone()
                                                        };
                                                        let step_id = self.create_id(
                                                            Some(&step_fn_name),
                                                            arrow_expr.span,
                                                            false,
                                                        );

                                                        // Collect closure variables
                                                        let closure_vars = ClosureVariableCollector::collect_from_arrow_expr(&arrow_expr, &self.module_imports);
                                                        *kv_prop.value = self
                                                            .create_step_proxy_reference(
                                                                &step_id,
                                                                &closure_vars,
                                                            );
                                                    }
                                                    TransformMode::Client => {
                                                        // Just remove directive
                                                        self.remove_use_step_directive_arrow(
                                                            &mut arrow_expr.body,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    Expr::Fn(fn_expr) => {
                                        if self.has_step_directive(&fn_expr.function, false) {
                                            if !fn_expr.function.is_async {
                                                emit_error(WorkflowErrorKind::NonAsyncFunction {
                                                    span: fn_expr.function.span,
                                                    directive: "use step",
                                                });
                                            } else {
                                                // Generate a unique name
                                                let generated_name = format!(
                                                    "_anonymousStep{}",
                                                    self.anonymous_fn_counter
                                                );
                                                self.anonymous_fn_counter += 1;
                                                self.step_function_names
                                                    .insert(generated_name.clone());

                                                match self.mode {
                                                    TransformMode::Step => {
                                                        // Hoist to module scope
                                                        let mut cloned_fn = fn_expr.clone();
                                                        self.remove_use_step_directive(
                                                            &mut cloned_fn.function.body,
                                                        );

                                                        // Collect closure variables
                                                        let closure_vars = ClosureVariableCollector::collect_from_function(&*cloned_fn.function, &self.module_imports);

                                                        let hoisted_fn_expr = FnExpr {
                                                            ident: Some(Ident::new(
                                                                generated_name.clone().into(),
                                                                DUMMY_SP,
                                                                SyntaxContext::empty(),
                                                            )),
                                                            function: cloned_fn.function,
                                                        };

                                                        self.nested_step_functions.push((
                                                            generated_name.clone(),
                                                            hoisted_fn_expr,
                                                            fn_expr.function.span,
                                                            closure_vars,
                                                            false, // Was a function expression
                                                            self.current_workflow_function_name
                                                                .clone()
                                                                .unwrap_or_default(),
                                                        ));

                                                        // Replace with identifier reference
                                                        *kv_prop.value = Expr::Ident(Ident::new(
                                                            generated_name.into(),
                                                            DUMMY_SP,
                                                            SyntaxContext::empty(),
                                                        ));
                                                    }
                                                    TransformMode::Workflow => {
                                                        // Replace with step proxy reference
                                                        self.remove_use_step_directive(
                                                            &mut fn_expr.function.body,
                                                        );
                                                        // Include parent workflow name in step ID
                                                        let step_fn_name = if let Some(parent) =
                                                            &self.current_workflow_function_name
                                                        {
                                                            format!("{}/{}", parent, generated_name)
                                                        } else {
                                                            generated_name.clone()
                                                        };
                                                        let step_id = self.create_id(
                                                            Some(&step_fn_name),
                                                            fn_expr.function.span,
                                                            false,
                                                        );

                                                        // Collect closure variables
                                                        let closure_vars = ClosureVariableCollector::collect_from_function(&fn_expr.function, &self.module_imports);
                                                        *kv_prop.value = self
                                                            .create_step_proxy_reference(
                                                                &step_id,
                                                                &closure_vars,
                                                            );
                                                    }
                                                    TransformMode::Client => {
                                                        // Just remove directive
                                                        self.remove_use_step_directive(
                                                            &mut fn_expr.function.body,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Prop::Method(method_prop) => {
                            if let Some(_prop_name) = &prop_key {
                                if self.has_step_directive(&method_prop.function, false) {
                                    if !method_prop.function.is_async {
                                        emit_error(WorkflowErrorKind::NonAsyncFunction {
                                            span: method_prop.function.span,
                                            directive: "use step",
                                        });
                                    } else {
                                        // Generate a unique name
                                        let generated_name =
                                            format!("_anonymousStep{}", self.anonymous_fn_counter);
                                        self.anonymous_fn_counter += 1;
                                        self.step_function_names.insert(generated_name.clone());

                                        match self.mode {
                                            TransformMode::Step => {
                                                // Convert method to function and hoist
                                                let mut cloned_function =
                                                    method_prop.function.clone();
                                                self.remove_use_step_directive(
                                                    &mut cloned_function.body,
                                                );

                                                // Collect closure variables
                                                let closure_vars =
                                                    ClosureVariableCollector::collect_from_function(
                                                        &cloned_function,
                                                        &self.module_imports,
                                                    );

                                                let fn_expr = FnExpr {
                                                    ident: Some(Ident::new(
                                                        generated_name.clone().into(),
                                                        DUMMY_SP,
                                                        SyntaxContext::empty(),
                                                    )),
                                                    function: cloned_function,
                                                };

                                                self.nested_step_functions.push((
                                                    generated_name.clone(),
                                                    fn_expr,
                                                    method_prop.function.span,
                                                    closure_vars,
                                                    false, // Was a method
                                                    self.current_workflow_function_name
                                                        .clone()
                                                        .unwrap_or_default(),
                                                ));

                                                // Replace method with property pointing to identifier
                                                *boxed_prop =
                                                    Box::new(Prop::KeyValue(KeyValueProp {
                                                        key: method_prop.key.clone(),
                                                        value: Box::new(Expr::Ident(Ident::new(
                                                            generated_name.into(),
                                                            DUMMY_SP,
                                                            SyntaxContext::empty(),
                                                        ))),
                                                    }));
                                            }
                                            TransformMode::Workflow => {
                                                // Replace with step proxy reference
                                                self.remove_use_step_directive(
                                                    &mut method_prop.function.body,
                                                );
                                                // Include parent workflow name in step ID
                                                let step_fn_name = if let Some(parent) =
                                                    &self.current_workflow_function_name
                                                {
                                                    format!("{}/{}", parent, generated_name)
                                                } else {
                                                    generated_name.clone()
                                                };
                                                let step_id = self.create_id(
                                                    Some(&step_fn_name),
                                                    method_prop.function.span,
                                                    false,
                                                );

                                                // Collect closure variables
                                                let closure_vars =
                                                    ClosureVariableCollector::collect_from_function(
                                                        &method_prop.function,
                                                        &self.module_imports,
                                                    );

                                                // Replace method with property pointing to proxy
                                                *boxed_prop =
                                                    Box::new(Prop::KeyValue(KeyValueProp {
                                                        key: method_prop.key.clone(),
                                                        value: Box::new(
                                                            self.create_step_proxy_reference(
                                                                &step_id,
                                                                &closure_vars,
                                                            ),
                                                        ),
                                                    }));
                                            }
                                            TransformMode::Client => {
                                                // Just remove directive
                                                self.remove_use_step_directive(
                                                    &mut method_prop.function.body,
                                                );
                                            }
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

        // Always continue visiting children
        obj_lit.visit_mut_children_with(self);
    }

    noop_visit_mut_type!();
}
