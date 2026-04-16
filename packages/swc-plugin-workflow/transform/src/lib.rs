mod naming;

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use swc_core::{
    common::{errors::HANDLER, SyntaxContext, DUMMY_SP},
    ecma::{
        ast::*,
        visit::{noop_visit_mut_type, noop_visit_type, Visit, VisitMut, VisitMutWith, VisitWith},
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

/// Sanitize a string for use as part of a JavaScript identifier.
/// Replaces characters that are not valid in JS identifiers with `_`.
fn sanitize_ident_part(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '$' => ch,
            _ => '_',
        })
        .collect()
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
            if directive == "use step" {
                format!(
                    "Only functions can be exported from a \"{}\" file",
                    directive
                )
            } else {
                format!(
                    "Only async functions can be exported from a \"{}\" file",
                    directive
                )
            },
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

/// Check if an object literal has the expected keys for the `using` transformation env object.
/// The env object should have: { stack: [], error: void 0, hasError: false }
fn is_using_env_object(obj: &ObjectLit) -> bool {
    // We expect exactly 3 properties: stack, error, hasError
    if obj.props.len() != 3 {
        return false;
    }

    let mut has_stack = false;
    let mut has_error = false;
    let mut has_has_error = false;

    for prop in &obj.props {
        if let PropOrSpread::Prop(prop) = prop {
            if let Prop::KeyValue(kv) = &**prop {
                if let PropName::Ident(ident) = &kv.key {
                    match ident.sym.as_ref() {
                        "stack" => has_stack = true,
                        "error" => has_error = true,
                        "hasError" => has_has_error = true,
                        _ => {}
                    }
                }
            }
        }
    }

    has_stack && has_error && has_has_error
}

/// Check if a list of statements represents the TypeScript `using` transformation pattern.
/// When TypeScript transforms `using` declarations, it creates:
/// ```js
/// const env = { stack: [], error: void 0, hasError: false };
/// try { ... } catch (e) { ... } finally { ... }
/// ```
/// This function returns the try block's body if the pattern matches.
///
/// The pattern matching is strict to avoid false positives:
/// - First statement must be a const declaration with an object containing stack/error/hasError keys
/// - Second statement must be a try-catch-finally (all three parts required)
fn get_try_block_from_using_pattern(stmts: &[Stmt]) -> Option<&BlockStmt> {
    // Need at least 2 statements: env declaration and try statement
    if stmts.len() < 2 {
        return None;
    }

    // First statement should be a variable declaration (const env = { stack, error, hasError })
    let first_is_env_decl = match &stmts[0] {
        Stmt::Decl(Decl::Var(var_decl)) => {
            // Check if it's a single declarator with the expected env object
            var_decl.decls.len() == 1 && {
                if let Some(init) = &var_decl.decls[0].init {
                    if let Expr::Object(obj) = &**init {
                        is_using_env_object(obj)
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
        }
        _ => false,
    };

    if !first_is_env_decl {
        return None;
    }

    // Second statement should be a try statement with BOTH catch and finally clauses
    match &stmts[1] {
        Stmt::Try(try_stmt) => {
            // Must have both catch and finally blocks (characteristic of `using` pattern)
            if try_stmt.handler.is_some() && try_stmt.finalizer.is_some() {
                Some(&try_stmt.block)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Check if statements match the `using` pattern (for use in mutable contexts).
/// This is the same logic as get_try_block_from_using_pattern but returns a bool.
fn is_using_pattern(stmts: &[Stmt]) -> bool {
    get_try_block_from_using_pattern(stmts).is_some()
}

/// Helper to get a directive from the first statement of a block.
fn get_directive_from_block(block: &BlockStmt, directive: &str) -> bool {
    if let Some(first_stmt) = block.stmts.first() {
        if let Stmt::Expr(ExprStmt { expr, .. }) = first_stmt {
            if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                return value == directive;
            }
        }
    }
    false
}

/// Helper to get the first string literal from a block (for misspelling detection).
fn get_first_string_literal_from_block(
    block: &BlockStmt,
) -> Option<(&Str, swc_core::common::Span)> {
    if let Some(first_stmt) = block.stmts.first() {
        if let Stmt::Expr(ExprStmt { expr, span, .. }) = first_stmt {
            if let Expr::Lit(Lit::Str(s)) = &**expr {
                return Some((s, *span));
            }
        }
    }
    None
}

/// Helper to remove a directive from the first statement of a try block in a `using` pattern.
/// Only removes if the pattern is verified first.
fn remove_directive_from_using_pattern(stmts: &mut [Stmt], directive: &str) {
    // First verify this is actually the using pattern
    if !is_using_pattern(stmts) {
        return;
    }

    if stmts.len() >= 2 {
        if let Stmt::Try(try_stmt) = &mut stmts[1] {
            let block = &mut try_stmt.block;
            if !block.stmts.is_empty() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = &block.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == directive {
                            block.stmts.remove(0);
                        }
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum TransformMode {
    Step,
    Workflow,
    Client,
    /// Detection-only mode: walks the AST to find directives and serde
    /// patterns, populates the manifest, but does **not** transform any code.
    /// Used by the discover-entries plugin to validate regexp pre-scan results.
    Detect,
}

#[derive(Debug)]
pub struct StepTransform {
    mode: TransformMode,
    filename: String,
    // The module specifier used for ID generation (e.g., "point@0.0.1" or "./src/models/Point")
    // If None, falls back to using "./{filename}" format
    module_specifier: Option<String>,
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
    // Track step functions that need stepId property in client mode
    step_functions_needing_id: Vec<(String, swc_core::common::Span)>,
    // Track step function exports that need to be converted to const declarations in workflow mode
    step_exports_to_convert: Vec<(String, String, swc_core::common::Span)>, // (fn_name, step_id, span)
    // Track default exports that need to be replaced with expressions
    default_exports_to_replace: Vec<(String, Expr)>, // (export_name, replacement_expr)
    // Track default workflow exports that need const declarations in workflow mode
    default_workflow_exports: Vec<(String, Expr, swc_core::common::Span)>, // (const_name, expr, span)
    // Track default class exports that need const declarations so the class has an
    // accessible binding name at module scope for registration code (serde / step IIFEs).
    default_class_exports: Vec<(String, ClassExpr)>, // (const_name, class_expr)
    // Track all declared identifiers in module scope to avoid collisions
    declared_identifiers: HashSet<String>,
    // Track object property step functions for hoisting in step mode
    // (parent_var_name, prop_name, fn_expr, span, parent_workflow_name, was_arrow)
    object_property_step_functions:
        Vec<(String, String, FnExpr, swc_core::common::Span, String, bool)>,
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
    // Track the binding name when a class expression is assigned to a variable
    // e.g., for `var Bash = class _Bash {}`, this would be "Bash"
    // This is needed because the internal class name (_Bash) is not in scope at module level
    current_class_binding_name: Option<String>,
    // Track static method steps that need registration after the class declaration
    // (class_name, method_name, step_id, span)
    static_method_step_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track static method workflows that need workflowId assignment and registration
    // (class_name, method_name, workflow_id, span)
    static_method_workflow_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track static step methods to strip from class and assign as properties (workflow mode)
    // (class_name, method_name, step_id)
    static_step_methods_to_strip: Vec<(String, String, String)>,
    // Track instance method steps that need registration after the class declaration
    // (class_name, method_name, step_id, span)
    instance_method_step_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track instance step methods to strip from class and assign as properties (workflow mode)
    // (class_name, method_name, step_id)
    instance_step_methods_to_strip: Vec<(String, String, String)>,
    // Track instance getter steps that need registration after the class declaration (step mode)
    // (class_name, getter_name, step_id, span)
    instance_getter_step_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track instance getter steps to strip from class and define via Object.defineProperty (workflow mode)
    // (class_name, getter_name, step_id)
    instance_getter_steps_to_strip: Vec<(String, String, String)>,
    // Track static getter steps that need registration after the class declaration (step mode)
    // (class_name, getter_name, step_id, span)
    static_getter_step_registrations: Vec<(String, String, String, swc_core::common::Span)>,
    // Track static getter steps to strip from class and define via Object.defineProperty (workflow mode)
    // (class_name, getter_name, step_id)
    static_getter_steps_to_strip: Vec<(String, String, String)>,
    // Track getter step proxy variables that need hoisted var declarations (workflow mode, object literals)
    // (var_name, step_id)
    getter_workflow_proxy_hoists: Vec<(String, String)>,
    // Track classes that need serialization registration (for `this` serialization in static methods)
    // Set of class names that have static step/workflow methods
    classes_needing_serialization: HashSet<String>,
    // Track identifiers that are known to be WORKFLOW_SERIALIZE symbols
    // (local name -> "workflow-serialize" or "workflow-deserialize")
    serialization_symbol_identifiers: HashMap<String, String>,
    // Track identifiers that are bound to require() calls (CommonJS namespace pattern)
    // e.g., `const serde_1 = require("@workflow/serde")` -> {"serde_1"}
    require_namespace_identifiers: HashSet<String>,
    // Track class names for the manifest (preserved copy before drain)
    classes_for_manifest: HashSet<String>,
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

/// Collects all member names referenced within an AST subtree via
/// `this.foo`, `this.#foo`, or `obj.foo` (when `foo` is a known
/// TS-private name) patterns. Used after stripping `"use step"` methods
/// in workflow mode to determine which private class members are still
/// referenced by the remaining body, so unreferenced ones can be
/// dead-code-eliminated.
///
/// Handles both:
/// - JS native private members (`#field`, `#method()`) — stored with `#`
///   prefix to avoid collisions with TS private members of the same name
/// - TypeScript `private` members — stored without prefix; detected via
///   `this.foo` and also `obj.foo` when `foo` is a known TS-private name
///   (to handle same-class access patterns like `static compare(a, b) {
///   return a.x - b.x }`)
struct ClassMemberRefCollector {
    /// All member names referenced. JS native private names are prefixed
    /// with `#` (e.g. `"#foo"`), TS private names are unprefixed (`"foo"`).
    referenced: HashSet<String>,
    /// Known TS-private member names in the current class, so that `a.foo`
    /// accesses (not just `this.foo`) are recognized as references.
    ts_private_names: HashSet<String>,
}

impl ClassMemberRefCollector {
    fn new(ts_private_names: HashSet<String>) -> Self {
        Self {
            referenced: HashSet::new(),
            ts_private_names,
        }
    }

    /// Collects all member names transitively referenced by non-private
    /// (public) members of the class. Private members that are only
    /// referenced by other private members (which are themselves
    /// unreferenced) are NOT included, enabling cascading elimination.
    ///
    /// Algorithm: seed the referenced set from public members, then
    /// iteratively expand by adding references from surviving private
    /// members until the set stabilizes.
    fn collect_from_class_body(body: &[ClassMember]) -> HashSet<String> {
        // Build the set of known TS-private names for the collector
        let ts_private_names: HashSet<String> = body
            .iter()
            .filter_map(|m| match m {
                ClassMember::Method(m) if m.accessibility == Some(Accessibility::Private) => {
                    match &m.key {
                        PropName::Ident(i) => Some(i.sym.to_string()),
                        PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                        _ => None,
                    }
                }
                ClassMember::ClassProp(p) if p.accessibility == Some(Accessibility::Private) => {
                    match &p.key {
                        PropName::Ident(i) => Some(i.sym.to_string()),
                        PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                        _ => None,
                    }
                }
                _ => None,
            })
            .collect();

        // Phase 1: collect references from all non-private members
        let mut collector = Self::new(ts_private_names);
        for member in body {
            if !Self::is_private_member(member) {
                member.visit_with(&mut collector);
            }
        }

        // Phase 2: iteratively expand — if a private member is referenced,
        // its body may reference other private members
        loop {
            let prev_len = collector.referenced.len();
            for member in body {
                if let Some(name) = Self::private_member_name(member) {
                    if collector.referenced.contains(&name) {
                        // This private member survived; scan its body for
                        // references to other private members
                        Self::visit_member_body(member, &mut collector);
                    }
                }
            }
            if collector.referenced.len() == prev_len {
                break; // fixed point reached
            }
        }

        collector.referenced
    }

    /// Visit the body/initializer of a class member for reference collection.
    fn visit_member_body(member: &ClassMember, collector: &mut Self) {
        match member {
            ClassMember::PrivateMethod(m) => {
                if let Some(body) = &m.function.body {
                    body.visit_with(collector);
                }
            }
            ClassMember::PrivateProp(p) => {
                if let Some(value) = &p.value {
                    value.visit_with(collector);
                }
            }
            ClassMember::Method(m) => {
                if let Some(body) = &m.function.body {
                    body.visit_with(collector);
                }
            }
            ClassMember::ClassProp(p) => {
                if let Some(value) = &p.value {
                    value.visit_with(collector);
                }
            }
            _ => {}
        }
    }

    /// Returns true if the member is a private member (JS native or TS).
    fn is_private_member(member: &ClassMember) -> bool {
        matches!(
            member,
            ClassMember::PrivateMethod(_) | ClassMember::PrivateProp(_)
        ) || matches!(member, ClassMember::Method(m) if m.accessibility == Some(Accessibility::Private))
            || matches!(member, ClassMember::ClassProp(p) if p.accessibility == Some(Accessibility::Private))
    }

    /// Returns the canonical name of a private member. JS native private
    /// names are prefixed with `#` to avoid collisions with TS private
    /// members of the same name.
    fn private_member_name(member: &ClassMember) -> Option<String> {
        match member {
            ClassMember::PrivateMethod(m) => Some(format!("#{}", m.key.name)),
            ClassMember::PrivateProp(p) => Some(format!("#{}", p.key.name)),
            ClassMember::Method(m) if m.accessibility == Some(Accessibility::Private) => {
                match &m.key {
                    PropName::Ident(i) => Some(i.sym.to_string()),
                    PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                    _ => None,
                }
            }
            ClassMember::ClassProp(p) if p.accessibility == Some(Accessibility::Private) => {
                match &p.key {
                    PropName::Ident(i) => Some(i.sym.to_string()),
                    PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Removes unreferenced private class members from a class body.
    /// Call after stripping `"use step"` methods in workflow mode.
    fn retain_referenced_private_members(body: &mut Vec<ClassMember>) {
        let referenced = Self::collect_from_class_body(body);
        body.retain(|member| {
            if let Some(name) = Self::private_member_name(member) {
                referenced.contains(&name)
            } else {
                true
            }
        });
    }
}

impl Visit for ClassMemberRefCollector {
    noop_visit_type!();

    fn visit_member_expr(&mut self, expr: &MemberExpr) {
        match &expr.prop {
            // Native JS private: `this.#foo` — stored as `#foo`
            MemberProp::PrivateName(name) => {
                self.referenced.insert(format!("#{}", name.name));
            }
            // TS private or any ident member access. Track `this.foo` as
            // before, and also track `obj.foo` when `foo` is a known
            // TS-private member of the current class so same-class
            // accesses like `a.x` / `b.x` are not missed.
            MemberProp::Ident(ident) => {
                let name = ident.sym.to_string();
                if matches!(&*expr.obj, Expr::This(_)) || self.ts_private_names.contains(&name) {
                    self.referenced.insert(name);
                }
            }
            _ => {}
        }
        // Continue visiting children, including computed property expressions
        expr.visit_children_with(self);
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

    fn collect_from_function(
        function: &Function,
        module_imports: &HashSet<String>,
        module_declarations: &HashSet<String>,
    ) -> Vec<String> {
        let mut collector = Self::new();

        // Add module-level imports and declarations to local_vars so they're not considered closure vars
        collector.local_vars.extend(module_imports.iter().cloned());
        collector
            .local_vars
            .extend(module_declarations.iter().cloned());

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

    fn collect_from_arrow_expr(
        arrow: &ArrowExpr,
        module_imports: &HashSet<String>,
        module_declarations: &HashSet<String>,
    ) -> Vec<String> {
        let mut collector = Self::new();

        // Add module-level imports and declarations to local_vars so they're not considered closure vars
        collector.local_vars.extend(module_imports.iter().cloned());
        collector
            .local_vars
            .extend(module_declarations.iter().cloned());

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
                        // Walk into nested function bodies to find closure vars from the outer scope.
                        for param in &fn_decl.function.params {
                            self.collect_param_names(&param.pat);
                        }
                        if let Some(body) = &fn_decl.function.body {
                            self.collect_from_block_stmt(body);
                        }
                    }
                    Decl::Class(class_decl) => {
                        self.local_vars.insert(class_decl.ident.sym.to_string());
                        // Walk class body — reuse the same logic as Expr::Class
                        if let Some(super_class) = &class_decl.class.super_class {
                            self.collect_from_expr(super_class);
                        }
                        for member in &class_decl.class.body {
                            match member {
                                ClassMember::Method(method) => {
                                    for param in &method.function.params {
                                        self.collect_param_names(&param.pat);
                                    }
                                    if let Some(body) = &method.function.body {
                                        self.collect_from_block_stmt(body);
                                    }
                                }
                                ClassMember::ClassProp(prop) => {
                                    if let Some(value) = &prop.value {
                                        self.collect_from_expr(value);
                                    }
                                }
                                ClassMember::PrivateProp(prop) => {
                                    if let Some(value) = &prop.value {
                                        self.collect_from_expr(value);
                                    }
                                }
                                ClassMember::Constructor(ctor) => {
                                    for param in &ctor.params {
                                        match param {
                                            ParamOrTsParamProp::Param(p) => {
                                                self.collect_param_names(&p.pat);
                                            }
                                            ParamOrTsParamProp::TsParamProp(ts_param) => {
                                                match &ts_param.param {
                                                    TsParamPropParam::Ident(i) => {
                                                        self.local_vars
                                                            .insert(i.id.sym.to_string());
                                                    }
                                                    TsParamPropParam::Assign(a) => {
                                                        self.collect_declared_names(&a.left);
                                                        self.collect_from_expr(&a.right);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if let Some(body) = &ctor.body {
                                        self.collect_from_block_stmt(body);
                                    }
                                }
                                ClassMember::StaticBlock(block) => {
                                    self.collect_from_block_stmt(&block.body);
                                }
                                _ => {}
                            }
                        }
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
            Stmt::DoWhile(do_while) => {
                self.collect_from_stmt(&do_while.body);
                self.collect_from_expr(&do_while.test);
            }
            Stmt::Throw(throw_stmt) => {
                self.collect_from_expr(&throw_stmt.arg);
            }
            Stmt::Try(try_stmt) => {
                self.collect_from_block_stmt(&try_stmt.block);
                if let Some(catch_clause) = &try_stmt.handler {
                    // The catch parameter introduces a local binding
                    if let Some(param) = &catch_clause.param {
                        self.collect_declared_names(param);
                    }
                    self.collect_from_block_stmt(&catch_clause.body);
                }
                if let Some(finalizer) = &try_stmt.finalizer {
                    self.collect_from_block_stmt(finalizer);
                }
            }
            Stmt::Switch(switch_stmt) => {
                self.collect_from_expr(&switch_stmt.discriminant);
                for case in &switch_stmt.cases {
                    if let Some(test) = &case.test {
                        self.collect_from_expr(test);
                    }
                    for stmt in &case.cons {
                        self.collect_from_stmt(stmt);
                    }
                }
            }
            Stmt::ForIn(for_in) => {
                match &for_in.left {
                    ForHead::VarDecl(var_decl) => {
                        for declarator in &var_decl.decls {
                            self.collect_declared_names(&declarator.name);
                        }
                    }
                    ForHead::Pat(pat) => {
                        // Pattern used as assignment target (e.g., `for (x in obj)`)
                        if let Pat::Ident(ident) = &**pat {
                            self.collect_from_ident_binding(&ident.id);
                        }
                    }
                    _ => {}
                }
                self.collect_from_expr(&for_in.right);
                self.collect_from_stmt(&for_in.body);
            }
            Stmt::ForOf(for_of) => {
                match &for_of.left {
                    ForHead::VarDecl(var_decl) => {
                        for declarator in &var_decl.decls {
                            self.collect_declared_names(&declarator.name);
                        }
                    }
                    ForHead::Pat(pat) => {
                        if let Pat::Ident(ident) = &**pat {
                            self.collect_from_ident_binding(&ident.id);
                        }
                    }
                    _ => {}
                }
                self.collect_from_expr(&for_of.right);
                self.collect_from_stmt(&for_of.body);
            }
            Stmt::Labeled(labeled) => {
                self.collect_from_stmt(&labeled.body);
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
                                Prop::Shorthand(ident) => {
                                    // { foo } is shorthand for { foo: foo }
                                    let name = ident.sym.to_string();
                                    if !self.params.contains(&name)
                                        && !self.local_vars.contains(&name)
                                    {
                                        if !is_global_identifier(&name) {
                                            self.closure_vars.insert(name);
                                        }
                                    }
                                }
                                Prop::KeyValue(kv) => {
                                    // Check computed key expressions (e.g., { [expr]: value })
                                    if let PropName::Computed(computed) = &kv.key {
                                        self.collect_from_expr(&computed.expr);
                                    }
                                    self.collect_from_expr(&kv.value);
                                }
                                Prop::Assign(assign) => {
                                    // { key = default } — collect the default value expression
                                    self.collect_from_expr(&assign.value);
                                }
                                Prop::Method(method) => {
                                    // Walk into method bodies to find closure vars from the outer scope.
                                    for param in &method.function.params {
                                        self.collect_param_names(&param.pat);
                                    }
                                    if let Some(body) = &method.function.body {
                                        self.collect_from_block_stmt(body);
                                    }
                                }
                                Prop::Getter(getter) => {
                                    if let Some(body) = &getter.body {
                                        self.collect_from_block_stmt(body);
                                    }
                                }
                                Prop::Setter(setter) => {
                                    self.collect_declared_names(&setter.param);
                                    if let Some(body) = &setter.body {
                                        self.collect_from_block_stmt(body);
                                    }
                                }
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
            Expr::Arrow(arrow) => {
                // Walk into nested arrow bodies to find closure vars from the outer scope.
                // Add the arrow's own params to local_vars so they don't get captured.
                for param in &arrow.params {
                    self.collect_declared_names(param);
                }
                match &*arrow.body {
                    BlockStmtOrExpr::BlockStmt(block) => {
                        self.collect_from_block_stmt(block);
                    }
                    BlockStmtOrExpr::Expr(expr) => {
                        self.collect_from_expr(expr);
                    }
                }
            }
            Expr::Fn(fn_expr) => {
                // Walk into nested function bodies to find closure vars from the outer scope.
                // Add the function's own params and name to local_vars so they don't get captured.
                if let Some(ident) = &fn_expr.ident {
                    self.local_vars.insert(ident.sym.to_string());
                }
                for param in &fn_expr.function.params {
                    self.collect_param_names(&param.pat);
                }
                if let Some(body) = &fn_expr.function.body {
                    self.collect_from_block_stmt(body);
                }
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
            Expr::New(new_expr) => {
                self.collect_from_expr(&new_expr.callee);
                if let Some(args) = &new_expr.args {
                    for arg in args {
                        self.collect_from_expr(&arg.expr);
                    }
                }
            }
            Expr::Seq(seq) => {
                for expr in &seq.exprs {
                    self.collect_from_expr(expr);
                }
            }
            Expr::Yield(yield_expr) => {
                if let Some(arg) = &yield_expr.arg {
                    self.collect_from_expr(arg);
                }
            }
            Expr::OptChain(opt_chain) => match &*opt_chain.base {
                OptChainBase::Member(member) => {
                    self.collect_from_expr(&member.obj);
                }
                OptChainBase::Call(call) => {
                    self.collect_from_expr(&call.callee);
                    for arg in &call.args {
                        self.collect_from_expr(&arg.expr);
                    }
                }
            },
            Expr::Class(class_expr) => {
                // Walk into class body to find closure vars from the outer scope.
                if let Some(super_class) = &class_expr.class.super_class {
                    self.collect_from_expr(super_class);
                }
                for member in &class_expr.class.body {
                    match member {
                        ClassMember::Method(method) => {
                            for param in &method.function.params {
                                self.collect_param_names(&param.pat);
                            }
                            if let Some(body) = &method.function.body {
                                self.collect_from_block_stmt(body);
                            }
                        }
                        ClassMember::ClassProp(prop) => {
                            if let Some(value) = &prop.value {
                                self.collect_from_expr(value);
                            }
                        }
                        ClassMember::Constructor(ctor) => {
                            for param in &ctor.params {
                                match param {
                                    ParamOrTsParamProp::Param(p) => {
                                        self.collect_param_names(&p.pat);
                                    }
                                    ParamOrTsParamProp::TsParamProp(ts_param) => {
                                        match &ts_param.param {
                                            TsParamPropParam::Ident(i) => {
                                                self.local_vars.insert(i.id.sym.to_string());
                                            }
                                            TsParamPropParam::Assign(a) => {
                                                self.collect_declared_names(&a.left);
                                                self.collect_from_expr(&a.right);
                                            }
                                        }
                                    }
                                }
                            }
                            if let Some(body) = &ctor.body {
                                self.collect_from_block_stmt(body);
                            }
                        }
                        ClassMember::PrivateProp(prop) => {
                            if let Some(value) = &prop.value {
                                self.collect_from_expr(value);
                            }
                        }
                        ClassMember::StaticBlock(block) => {
                            self.collect_from_block_stmt(&block.body);
                        }
                        _ => {}
                    }
                }
            }
            // TypeScript expression wrappers — visit the inner expression
            Expr::TsAs(e) => self.collect_from_expr(&e.expr),
            Expr::TsNonNull(e) => self.collect_from_expr(&e.expr),
            Expr::TsTypeAssertion(e) => self.collect_from_expr(&e.expr),
            Expr::TsConstAssertion(e) => self.collect_from_expr(&e.expr),
            Expr::TsInstantiation(e) => self.collect_from_expr(&e.expr),
            Expr::TsSatisfies(e) => self.collect_from_expr(&e.expr),
            _ => {
                // Remaining variants that are safe to skip:
                // - Expr::This (keyword)
                // - Expr::Lit (literal values)
                // - Expr::SuperProp (super keyword)
                // - Expr::MetaProp (new.target, import.meta)
                // - Expr::PrivateName (#foo)
                // - Expr::Invalid (error recovery)
                // - Expr::JSX* (JSX — stripped before this plugin runs)
            }
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
            | "ReadableStream"
            | "WritableStream"
            | "TransformStream"
            | "Blob"
            | "File"
            | "FormData"
            | "AbortController"
            | "AbortSignal"
            | "EventTarget"
            | "Event"
            | "MessageChannel"
            | "MessagePort"
            | "Atomics"
            | "Proxy"
            | "Reflect"
            | "Intl"
            | "WebAssembly"
            | "queueMicrotask"
            | "structuredClone"
            | "atob"
            | "btoa"
            | "crypto"
            | "performance"
            | "navigator"
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
                    self.step_function_names.insert(fn_name.clone());

                    if !self.in_module_level {
                        match self.mode {
                            TransformMode::Step => {
                                // Clone the function and remove the directive before hoisting
                                let mut cloned_function = fn_decl.function.clone();
                                self.remove_use_step_directive(&mut cloned_function.body);

                                // Collect closure variables
                                let closure_vars = ClosureVariableCollector::collect_from_function(
                                    &cloned_function,
                                    &self.module_imports,
                                    &self.declared_identifiers,
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

                                // Keep the original function declaration with the directive stripped,
                                // so that direct (non-workflow) calls work with normal closure semantics.
                                // The hoisted copy (with __private_getClosureVars) is registered separately.
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                return;
                            }
                            TransformMode::Workflow => {
                                // Include parent workflow name in step ID
                                let step_fn_name =
                                    if let Some(parent) = &self.current_workflow_function_name {
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
                                let closure_vars = ClosureVariableCollector::collect_from_function(
                                    &fn_decl.function,
                                    &self.module_imports,
                                    &self.declared_identifiers,
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
                                // In client mode for nested step functions, just remove directive
                                // WITHOUT registering - the function will be undefined since the
                                // workflow body is replaced with throw Error
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                return;
                            }
                            TransformMode::Detect => {}
                        }
                    } else {
                        match self.mode {
                            TransformMode::Step => {
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                self.create_registration_call(&fn_name, fn_decl.function.span);
                                stmt.visit_mut_children_with(self);
                            }
                            TransformMode::Client => {
                                // In client mode, track for stepId assignment instead of registration
                                self.remove_use_step_directive(&mut fn_decl.function.body);
                                self.step_functions_needing_id
                                    .push((fn_name.clone(), fn_decl.function.span));
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
                            TransformMode::Detect => {}
                        }
                    }
                } else if self.should_transform_workflow_function(&fn_decl.function, false) {
                    self.workflow_function_names.insert(fn_name.clone());
                    let fn_span = fn_decl.function.span;

                    match self.mode {
                        TransformMode::Step => {
                            // First visit children to process nested step functions
                            // This must happen BEFORE replacing the body so nested steps are hoisted
                            stmt.visit_mut_children_with(self);

                            // After processing nested steps, re-extract fn_decl and replace workflow body with throw error
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
                            // In client mode, don't visit children - nested steps inside workflows
                            // are unreachable since the workflow body is replaced with throw error
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
                        }
                        TransformMode::Detect => {}
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
    pub fn new(mode: TransformMode, filename: String, module_specifier: Option<String>) -> Self {
        Self {
            mode,
            filename,
            module_specifier,
            has_file_step_directive: false,
            has_file_workflow_directive: false,
            step_function_names: HashSet::new(),
            workflow_function_names: HashSet::new(),
            workflow_export_to_const_name: HashMap::new(),
            registered_functions: HashSet::new(),
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
            step_functions_needing_id: Vec::new(),
            step_exports_to_convert: Vec::new(),
            default_exports_to_replace: Vec::new(),
            default_workflow_exports: Vec::new(),
            default_class_exports: Vec::new(),
            declared_identifiers: HashSet::new(),
            object_property_step_functions: Vec::new(),
            nested_step_functions: Vec::new(),
            anonymous_fn_counter: 0,
            object_property_workflow_conversions: Vec::new(),
            current_var_context: None,
            module_imports: HashSet::new(),
            current_class_name: None,
            current_class_binding_name: None,
            static_method_step_registrations: Vec::new(),
            static_method_workflow_registrations: Vec::new(),
            static_step_methods_to_strip: Vec::new(),
            instance_method_step_registrations: Vec::new(),
            instance_step_methods_to_strip: Vec::new(),
            instance_getter_step_registrations: Vec::new(),
            instance_getter_steps_to_strip: Vec::new(),
            static_getter_step_registrations: Vec::new(),
            static_getter_steps_to_strip: Vec::new(),
            getter_workflow_proxy_hoists: Vec::new(),
            classes_needing_serialization: HashSet::new(),
            serialization_symbol_identifiers: HashMap::new(),
            require_namespace_identifiers: HashSet::new(),
            classes_for_manifest: HashSet::new(),
        }
    }

    // Get the module path to use for ID generation.
    // Uses the module_specifier if provided, otherwise falls back to "./{filename}" format.
    fn get_module_path(&self) -> String {
        naming::get_module_path(self.module_specifier.as_deref(), &self.filename)
    }

    // Create an identifier by combining module path and function name or line number
    // with appropriate prefix based on function type
    fn create_id(
        &self,
        fn_name: Option<&str>,
        span: swc_core::common::Span,
        is_workflow: bool,
    ) -> String {
        match fn_name {
            Some(name) if name.starts_with("__builtin") => {
                // Special case for __builtin functions: use only the function name.
                // These are internal SDK functions that are referenced by name in the
                // workflow VM runtime (packages/core/src/workflow.ts), so they need
                // stable, version-independent IDs.
                name.to_string()
            }
            Some(name) => {
                let prefix = if is_workflow { "workflow" } else { "step" };
                naming::format_name(prefix, &self.get_module_path(), name)
            }
            None => {
                let prefix = if is_workflow { "workflow" } else { "step" };
                naming::format_name(prefix, &self.get_module_path(), span.lo.0)
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
    /// Inspect a single `VarDeclarator` for serialization-related bindings:
    /// - `Symbol.for('workflow-serialize')` / `Symbol.for('workflow-deserialize')` assignments
    /// - CommonJS namespace require: `const serde_1 = require("...")`
    /// - CommonJS destructured require: `const { WORKFLOW_SERIALIZE } = require("...")`
    fn track_serialization_bindings(&mut self, declarator: &VarDeclarator) {
        let Some(init) = &declarator.init else {
            return;
        };

        // Track const declarations that assign Symbol.for('workflow-serialize') or Symbol.for('workflow-deserialize')
        if let Pat::Ident(ident) = &declarator.name {
            if let Some(symbol_name) = self.extract_symbol_for_name(init) {
                if symbol_name == "workflow-serialize" || symbol_name == "workflow-deserialize" {
                    self.serialization_symbol_identifiers
                        .insert(ident.id.sym.to_string(), symbol_name);
                }
            }
            // Track CommonJS namespace require: const serde_1 = require("...")
            if self.is_require_call(init) {
                self.require_namespace_identifiers
                    .insert(ident.id.sym.to_string());
            }
        }

        // Track CommonJS destructured require:
        // const { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } = require("...")
        if let Pat::Object(obj_pat) = &declarator.name {
            if self.is_require_call(init) {
                for prop in &obj_pat.props {
                    match prop {
                        ObjectPatProp::Assign(assign) => {
                            // const { WORKFLOW_SERIALIZE } = require("...")
                            let name = assign.key.sym.to_string();
                            if name == "WORKFLOW_SERIALIZE" {
                                self.serialization_symbol_identifiers
                                    .insert(name, "workflow-serialize".to_string());
                            } else if name == "WORKFLOW_DESERIALIZE" {
                                self.serialization_symbol_identifiers
                                    .insert(name, "workflow-deserialize".to_string());
                            }
                        }
                        ObjectPatProp::KeyValue(kv) => {
                            // const { WORKFLOW_SERIALIZE: ws } = require("...")
                            let key_name = match &kv.key {
                                PropName::Ident(id) => Some(id.sym.to_string()),
                                PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                                _ => None,
                            };
                            if let Some(key) = key_name {
                                if let Pat::Ident(local) = &*kv.value {
                                    let local_name = local.id.sym.to_string();
                                    if key == "WORKFLOW_SERIALIZE" {
                                        self.serialization_symbol_identifiers
                                            .insert(local_name, "workflow-serialize".to_string());
                                    } else if key == "WORKFLOW_DESERIALIZE" {
                                        self.serialization_symbol_identifiers
                                            .insert(local_name, "workflow-deserialize".to_string());
                                    }
                                }
                            }
                        }
                        ObjectPatProp::Rest(_) => {}
                    }
                }
            }
        }
    }

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
                            self.track_serialization_bindings(declarator);
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
                                self.track_serialization_bindings(declarator);
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
                                    let local_name = named.local.sym.to_string();
                                    self.declared_identifiers.insert(local_name.clone());

                                    // Track imports of WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE
                                    // These can be imported from '@workflow/serde' or re-exported
                                    let imported_name = named
                                        .imported
                                        .as_ref()
                                        .map(|i| match i {
                                            ModuleExportName::Ident(id) => id.sym.to_string(),
                                            ModuleExportName::Str(s) => {
                                                s.value.to_string_lossy().to_string()
                                            }
                                        })
                                        .unwrap_or_else(|| local_name.clone());

                                    if imported_name == "WORKFLOW_SERIALIZE" {
                                        self.serialization_symbol_identifiers
                                            .insert(local_name, "workflow-serialize".to_string());
                                    } else if imported_name == "WORKFLOW_DESERIALIZE" {
                                        self.serialization_symbol_identifiers
                                            .insert(local_name, "workflow-deserialize".to_string());
                                    }
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
        naming::format_name(prefix, &self.get_module_path(), &fn_name)
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
                                    // Remove the directive first
                                    self.remove_use_step_directive_arrow(&mut arrow_expr.body);

                                    // Convert arrow to function expression for hoisting
                                    // (preserves `this` binding when called with .call()/.apply())
                                    let fn_from_arrow = FnExpr {
                                        ident: None,
                                        function: Box::new(Function {
                                            params: arrow_expr
                                                .params
                                                .iter()
                                                .map(|pat| Param {
                                                    span: DUMMY_SP,
                                                    decorators: vec![],
                                                    pat: pat.clone(),
                                                })
                                                .collect(),
                                            decorators: vec![],
                                            span: arrow_expr.span,
                                            ctxt: SyntaxContext::empty(),
                                            body: Some(match &*arrow_expr.body {
                                                BlockStmtOrExpr::BlockStmt(block) => block.clone(),
                                                BlockStmtOrExpr::Expr(expr) => BlockStmt {
                                                    span: DUMMY_SP,
                                                    ctxt: SyntaxContext::empty(),
                                                    stmts: vec![Stmt::Return(ReturnStmt {
                                                        span: DUMMY_SP,
                                                        arg: Some(expr.clone()),
                                                    })],
                                                },
                                            }),
                                            is_generator: arrow_expr.is_generator,
                                            is_async: arrow_expr.is_async,
                                            type_params: None,
                                            return_type: arrow_expr.return_type.clone(),
                                        }),
                                    };

                                    let span = arrow_expr.span;

                                    // Track this as an object property step function (after removing directive)
                                    self.object_property_step_functions.push((
                                        parent_var_name.to_string(),
                                        prop_key.clone(),
                                        fn_from_arrow,
                                        span,
                                        self.current_workflow_function_name
                                            .clone()
                                            .unwrap_or_default(),
                                        true, // was_arrow
                                    ));

                                    let _ = arrow_expr; // Drop the mutable reference

                                    self.apply_object_property_transformation(
                                        kv_prop,
                                        parent_var_name,
                                        &prop_key,
                                        span,
                                    );
                                }
                                Expr::Fn(fn_expr) => {
                                    // Remove the directive first
                                    self.remove_use_step_directive(&mut fn_expr.function.body);

                                    let span = fn_expr.function.span;

                                    // Track this as an object property step function (after removing directive)
                                    // Keep as FnExpr to preserve `this` binding
                                    self.object_property_step_functions.push((
                                        parent_var_name.to_string(),
                                        prop_key.clone(),
                                        fn_expr.clone(),
                                        span,
                                        self.current_workflow_function_name
                                            .clone()
                                            .unwrap_or_default(),
                                        false, // was_arrow
                                    ));

                                    let _ = fn_expr; // Drop the mutable reference

                                    self.apply_object_property_transformation(
                                        kv_prop,
                                        parent_var_name,
                                        &prop_key,
                                        span,
                                    );
                                }
                                _ => {}
                            }
                        } else {
                            // Not a direct step function - check for nested objects or call expressions
                            match &mut *kv_prop.value {
                                Expr::Object(nested_obj) => {
                                    // Recursively process nested objects with compound path
                                    let compound_path = format!("{}/{}", parent_var_name, prop_key);
                                    self.process_object_properties_for_step_functions(
                                        nested_obj,
                                        &compound_path,
                                    );
                                }
                                Expr::Call(call_expr) => {
                                    // Check arguments for object literals containing step functions
                                    for arg in &mut call_expr.args {
                                        if let Expr::Object(nested_obj) = &mut *arg.expr {
                                            let compound_path =
                                                format!("{}/{}", parent_var_name, prop_key);
                                            self.process_object_properties_for_step_functions(
                                                nested_obj,
                                                &compound_path,
                                            );
                                        }
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
                            // Remove the directive first
                            self.remove_use_step_directive(&mut method_prop.function.body);

                            // Convert method to function expression for hoisting
                            // (preserves `this` binding when called with .call()/.apply())
                            let fn_from_method = FnExpr {
                                ident: None,
                                function: method_prop.function.clone(),
                            };

                            let span = method_prop.function.span;

                            // Track this as an object property step function
                            self.object_property_step_functions.push((
                                parent_var_name.to_string(),
                                prop_key.clone(),
                                fn_from_method,
                                span,
                                self.current_workflow_function_name
                                    .clone()
                                    .unwrap_or_default(),
                                false, // was_arrow (methods are not arrows)
                            ));

                            // Now handle the transformation based on mode
                            match self.mode {
                                TransformMode::Step => {
                                    // Keep the original method with the directive stripped,
                                    // so that direct (non-workflow) calls work with normal closure semantics.
                                    // The hoisted copy (with __private_getClosureVars) is registered separately.
                                    self.remove_use_step_directive(&mut method_prop.function.body);
                                    // Track for metadata generation
                                    let step_id = self.create_object_property_id(
                                        parent_var_name,
                                        &prop_key,
                                        false,
                                        self.current_workflow_function_name.as_deref(),
                                    );
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
                                    // In client mode, replace method with key-value property referencing the hoisted variable
                                    // (same as step mode) so the stepId property is accessible
                                    let safe_parent_name = parent_var_name.replace('/', "$");
                                    let hoist_var_name = if let Some(ref workflow_name) =
                                        self.current_workflow_function_name
                                    {
                                        format!(
                                            "{}${}${}",
                                            workflow_name, safe_parent_name, prop_key
                                        )
                                    } else {
                                        format!("{}${}", safe_parent_name, prop_key)
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
                                TransformMode::Detect => {}
                            }
                        }
                    }
                    Prop::Getter(getter_prop) => {
                        // Handle object getters like: get bar() { "use step"; ... }
                        let prop_key = match &getter_prop.key {
                            PropName::Ident(ident) => ident.sym.to_string(),
                            PropName::Str(s) => s.value.to_string_lossy().to_string(),
                            _ => continue, // Skip complex keys
                        };

                        let has_step =
                            self.has_use_step_directive(&getter_prop.body.as_ref().cloned());
                        let has_workflow =
                            self.has_use_workflow_directive(&getter_prop.body.as_ref().cloned());

                        if has_workflow {
                            HANDLER.with(|handler| {
                                handler
                                    .struct_span_err(
                                        getter_prop.span,
                                        "Getters cannot be marked with \"use workflow\". Only static methods, functions, and object methods are supported.",
                                    )
                                    .emit()
                            });
                        } else if has_step {
                            // Getters don't need async validation (they can't be async syntactically)

                            // Remove the directive from the getter body
                            let mut body_as_option = getter_prop.body.clone();
                            self.remove_use_step_directive(&mut body_as_option);

                            let span = getter_prop.span;

                            // Create an async function expression wrapping the getter body
                            // for hoisting and step registration
                            let fn_from_getter = FnExpr {
                                ident: None,
                                function: Box::new(Function {
                                    params: vec![],
                                    decorators: vec![],
                                    span: DUMMY_SP,
                                    ctxt: SyntaxContext::empty(),
                                    body: body_as_option.clone(),
                                    is_generator: false,
                                    is_async: true,
                                    type_params: None,
                                    return_type: None,
                                }),
                            };

                            // Track as object property step function for hoisting
                            self.object_property_step_functions.push((
                                parent_var_name.to_string(),
                                prop_key.clone(),
                                fn_from_getter,
                                span,
                                self.current_workflow_function_name
                                    .clone()
                                    .unwrap_or_default(),
                                false, // was_arrow (getters are not arrows)
                            ));

                            match self.mode {
                                TransformMode::Step => {
                                    // Strip directive from original getter, keep the getter in place
                                    getter_prop.body = body_as_option;

                                    // Track for metadata
                                    let step_id = self.create_object_property_id(
                                        parent_var_name,
                                        &prop_key,
                                        false,
                                        self.current_workflow_function_name.as_deref(),
                                    );
                                    self.object_property_workflow_conversions.push((
                                        parent_var_name.to_string(),
                                        prop_key,
                                        step_id,
                                    ));
                                }
                                TransformMode::Workflow => {
                                    // Replace getter body with a call to the hoisted step proxy
                                    let step_id = self.create_object_property_id(
                                        parent_var_name,
                                        &prop_key,
                                        false,
                                        self.current_workflow_function_name.as_deref(),
                                    );

                                    let safe_parent_name = sanitize_ident_part(parent_var_name);
                                    let safe_prop_key = sanitize_ident_part(&prop_key);
                                    let var_name = if let Some(ref workflow_name) =
                                        self.current_workflow_function_name
                                    {
                                        let safe_wf = sanitize_ident_part(workflow_name);
                                        format!(
                                            "__step_{}${}${}",
                                            safe_wf, safe_parent_name, safe_prop_key
                                        )
                                    } else {
                                        format!("__step_{}${}", safe_parent_name, safe_prop_key)
                                    };

                                    // Track for hoisting
                                    self.getter_workflow_proxy_hoists
                                        .push((var_name.clone(), step_id.clone()));

                                    // Replace getter body: return __step_var();
                                    getter_prop.body = Some(BlockStmt {
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        stmts: vec![Stmt::Return(ReturnStmt {
                                            span: DUMMY_SP,
                                            arg: Some(Box::new(Expr::Call(CallExpr {
                                                span: DUMMY_SP,
                                                ctxt: SyntaxContext::empty(),
                                                callee: Callee::Expr(Box::new(Expr::Ident(
                                                    Ident::new(
                                                        var_name.into(),
                                                        DUMMY_SP,
                                                        SyntaxContext::empty(),
                                                    ),
                                                ))),
                                                args: vec![],
                                                type_args: None,
                                            }))),
                                        })],
                                    });

                                    self.object_property_workflow_conversions.push((
                                        parent_var_name.to_string(),
                                        prop_key,
                                        step_id,
                                    ));
                                }
                                TransformMode::Client => {
                                    // Strip directive from original getter
                                    getter_prop.body = body_as_option;

                                    // Track for metadata
                                    let step_id = self.create_object_property_id(
                                        parent_var_name,
                                        &prop_key,
                                        false,
                                        self.current_workflow_function_name.as_deref(),
                                    );
                                    self.object_property_workflow_conversions.push((
                                        parent_var_name.to_string(),
                                        prop_key,
                                        step_id,
                                    ));
                                }
                                TransformMode::Detect => {}
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
                // Keep the original value (directive already stripped by caller),
                // so that direct (non-workflow) calls work with normal closure semantics.
                // The hoisted copy (with __private_getClosureVars) is registered separately.
                // Track for metadata generation
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
                // In client mode, replace with reference to hoisted variable
                // (same as step mode) so the stepId property is accessible
                let safe_parent_name = parent_var_name.replace('/', "$");
                let hoist_var_name =
                    if let Some(ref workflow_name) = self.current_workflow_function_name {
                        format!("{}${}${}", workflow_name, safe_parent_name, prop_key)
                    } else {
                        format!("{}${}", safe_parent_name, prop_key)
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
            TransformMode::Detect => {}
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

            // Check for directive inside TypeScript `using` transformation pattern
            if let Some(try_block) = get_try_block_from_using_pattern(&body.stmts) {
                if get_directive_from_block(try_block, "use step") {
                    return true;
                }
                // Also check for misspellings inside the using pattern's try block
                if let Some((str_lit, span)) = get_first_string_literal_from_block(try_block) {
                    let value = str_lit.value.to_string_lossy().to_string();
                    if detect_similar_strings(&value, "use step") {
                        emit_error(WorkflowErrorKind::MisspelledDirective {
                            span,
                            directive: value,
                            expected: "use step",
                        });
                    }
                }
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

            // Check for directive inside TypeScript `using` transformation pattern
            if let Some(try_block) = get_try_block_from_using_pattern(&body.stmts) {
                if get_directive_from_block(try_block, "use workflow") {
                    return true;
                }
                // Also check for misspellings inside the using pattern's try block
                if let Some((str_lit, span)) = get_first_string_literal_from_block(try_block) {
                    let value = str_lit.value.to_string_lossy().to_string();
                    if detect_similar_strings(&value, "use workflow") {
                        emit_error(WorkflowErrorKind::MisspelledDirective {
                            span,
                            directive: value,
                            expected: "use workflow",
                        });
                    }
                }
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
                // First try to remove from the top level
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use step" {
                            body.stmts.remove(0);
                            return;
                        }
                    }
                }
                // Also try to remove from inside the `using` pattern's try block
                remove_directive_from_using_pattern(&mut body.stmts, "use step");
            }
        }
    }

    // Remove "use workflow" directive from function body
    fn remove_use_workflow_directive(&self, body: &mut Option<BlockStmt>) {
        if let Some(body) = body {
            if !body.stmts.is_empty() {
                // First try to remove from the top level
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use workflow" {
                            body.stmts.remove(0);
                            return;
                        }
                    }
                }
                // Also try to remove from inside the `using` pattern's try block
                remove_directive_from_using_pattern(&mut body.stmts, "use workflow");
            }
        }
    }

    // Check if an arrow function has the "use step" directive
    fn has_use_step_directive_arrow(&self, body: &BlockStmtOrExpr) -> bool {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            // Check for direct directive
            if let Some(first_stmt) = body.stmts.first() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = first_stmt {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        return value == "use step";
                    }
                }
            }
            // Check for directive inside TypeScript `using` transformation pattern
            if let Some(try_block) = get_try_block_from_using_pattern(&body.stmts) {
                if get_directive_from_block(try_block, "use step") {
                    return true;
                }
                // Also check for misspellings inside the using pattern's try block
                if let Some((str_lit, span)) = get_first_string_literal_from_block(try_block) {
                    let value = str_lit.value.to_string_lossy().to_string();
                    if detect_similar_strings(&value, "use step") {
                        emit_error(WorkflowErrorKind::MisspelledDirective {
                            span,
                            directive: value,
                            expected: "use step",
                        });
                    }
                }
            }
        }
        false
    }

    // Check if an arrow function has the "use workflow" directive
    fn has_use_workflow_directive_arrow(&self, body: &BlockStmtOrExpr) -> bool {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            // Check for direct directive
            if let Some(first_stmt) = body.stmts.first() {
                if let Stmt::Expr(ExprStmt { expr, .. }) = first_stmt {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        return value == "use workflow";
                    }
                }
            }
            // Check for directive inside TypeScript `using` transformation pattern
            if let Some(try_block) = get_try_block_from_using_pattern(&body.stmts) {
                if get_directive_from_block(try_block, "use workflow") {
                    return true;
                }
                // Also check for misspellings inside the using pattern's try block
                if let Some((str_lit, span)) = get_first_string_literal_from_block(try_block) {
                    let value = str_lit.value.to_string_lossy().to_string();
                    if detect_similar_strings(&value, "use workflow") {
                        emit_error(WorkflowErrorKind::MisspelledDirective {
                            span,
                            directive: value,
                            expected: "use workflow",
                        });
                    }
                }
            }
        }
        false
    }

    /// Extract the symbol name from a `Symbol.for('...')` expression
    /// Returns Some("workflow-serialize") or Some("workflow-deserialize") if it matches, None otherwise
    fn extract_symbol_for_name(&self, expr: &Expr) -> Option<String> {
        // Pattern: Symbol.for('...')
        if let Expr::Call(call) = expr {
            if let Callee::Expr(callee) = &call.callee {
                if let Expr::Member(member) = &**callee {
                    // Check: obj is `Symbol`
                    if let Expr::Ident(obj) = &*member.obj {
                        if obj.sym.as_str() == "Symbol" {
                            // Check: prop is `for`
                            if let MemberProp::Ident(prop) = &member.prop {
                                if prop.sym.as_str() == "for" {
                                    // Extract the first argument string
                                    if let Some(arg) = call.args.first() {
                                        if let Expr::Lit(Lit::Str(s)) = &*arg.expr {
                                            return Some(s.value.to_string_lossy().to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Check if an expression is a `require('...')` or `require("...")` call.
    /// Returns true only when the callee is `require` with exactly one string literal argument.
    fn is_require_call(&self, expr: &Expr) -> bool {
        if let Expr::Call(call) = expr {
            if let Callee::Expr(callee) = &call.callee {
                if let Expr::Ident(ident) = &**callee {
                    if ident.sym.as_str() == "require" && call.args.len() == 1 {
                        // Ensure the single argument is a string literal
                        if let Expr::Lit(Lit::Str(_)) = &*call.args[0].expr {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Check if an expression represents a workflow serialization symbol.
    /// Supports multiple patterns:
    /// 1. Direct: `Symbol.for('workflow-serialize')` or `Symbol.for('workflow-deserialize')`
    /// 2. Identifier reference to an imported symbol: `WORKFLOW_SERIALIZE` (imported from '@workflow/serde')
    /// 3. Identifier reference to a local const: `const MY_SYM = Symbol.for('workflow-serialize')`
    /// 4. Member expression on a require() namespace: `serde_1.WORKFLOW_SERIALIZE`
    fn is_workflow_serialization_symbol(&self, expr: &Expr, symbol_name: &str) -> bool {
        // Pattern 1: Direct Symbol.for('workflow-serialize') or Symbol.for('workflow-deserialize')
        if let Some(extracted_name) = self.extract_symbol_for_name(expr) {
            return extracted_name == symbol_name;
        }

        // Pattern 2 & 3: Identifier reference to a known serialization symbol
        if let Expr::Ident(ident) = expr {
            if let Some(known_symbol) = self
                .serialization_symbol_identifiers
                .get(&ident.sym.to_string())
            {
                return known_symbol == symbol_name;
            }
        }

        // Pattern 4: Member expression on a require() namespace binding
        // e.g., serde_1.WORKFLOW_SERIALIZE where serde_1 = require("@workflow/serde")
        if let Expr::Member(member) = expr {
            if let Expr::Ident(obj) = &*member.obj {
                if self
                    .require_namespace_identifiers
                    .contains(&obj.sym.to_string())
                {
                    if let MemberProp::Ident(prop) = &member.prop {
                        let prop_name = prop.sym.as_str();
                        if prop_name == "WORKFLOW_SERIALIZE" {
                            return symbol_name == "workflow-serialize";
                        } else if prop_name == "WORKFLOW_DESERIALIZE" {
                            return symbol_name == "workflow-deserialize";
                        }
                    }
                }
            }
        }

        false
    }

    /// Check if a class has custom serialization methods (both WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE)
    fn has_custom_serialization_methods(&self, class: &Class) -> bool {
        let mut has_serialize = false;
        let mut has_deserialize = false;

        for member in &class.body {
            if let ClassMember::Method(method) = member {
                if method.is_static {
                    // Check for computed property name with Symbol.for(...) or identifier reference
                    if let PropName::Computed(computed) = &method.key {
                        if self
                            .is_workflow_serialization_symbol(&computed.expr, "workflow-serialize")
                        {
                            has_serialize = true;
                        } else if self.is_workflow_serialization_symbol(
                            &computed.expr,
                            "workflow-deserialize",
                        ) {
                            has_deserialize = true;
                        }
                    }
                }
            }
        }

        has_serialize && has_deserialize
    }

    /// Returns `true` if the class has any methods with `"use step"` or `"use workflow"`
    /// directives, or has custom serialization methods (WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE).
    /// Used to determine whether an anonymous default class export needs a binding name rewrite.
    fn class_needs_binding_rewrite(&self, class: &Class) -> bool {
        if self.has_custom_serialization_methods(class) {
            return true;
        }
        class.body.iter().any(|member| {
            if let ClassMember::Method(method) = member {
                return self.has_use_step_directive(&method.function.body)
                    || self.has_use_workflow_directive(&method.function.body);
            }
            false
        })
    }

    // Remove "use step" directive from arrow function body
    fn remove_use_step_directive_arrow(&self, body: &mut BlockStmtOrExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            if !body.stmts.is_empty() {
                // First try to remove from the top level
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use step" {
                            body.stmts.remove(0);
                            return;
                        }
                    }
                }
                // Also try to remove from inside the `using` pattern's try block
                remove_directive_from_using_pattern(&mut body.stmts, "use step");
            }
        }
    }

    // Remove "use workflow" directive from arrow function body
    fn remove_use_workflow_directive_arrow(&self, body: &mut BlockStmtOrExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = body {
            if !body.stmts.is_empty() {
                // First try to remove from the top level
                if let Stmt::Expr(ExprStmt { expr, .. }) = &body.stmts[0] {
                    if let Expr::Lit(Lit::Str(Str { value, .. })) = &**expr {
                        if value == "use workflow" {
                            body.stmts.remove(0);
                            return;
                        }
                    }
                }
                // Also try to remove from inside the `using` pattern's try block
                remove_directive_from_using_pattern(&mut body.stmts, "use workflow");
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

    // Create an inline class serialization registration statement.
    // Instead of importing registerSerializationClass from "workflow/internal/class-serialization",
    // we inline the registration logic as a self-contained IIFE that has zero module dependencies.
    // This is critical for 3rd-party packages that define serializable classes but don't depend
    // on the "workflow" package directly.
    //
    // Generates:
    //   (function(__wf_cls, __wf_id) {
    //     var __wf_sym = Symbol.for("workflow-class-registry");
    //     var __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    //     __wf_reg.set(__wf_id, __wf_cls);
    //     Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
    //   })(ClassName, "class//module_path//ClassName");
    fn create_class_serialization_registration(&self, class_name: &str) -> Stmt {
        let class_id = naming::format_name("class", &self.get_module_path(), class_name);

        // Helper to create an identifier
        let ident =
            |name: &str| -> Ident { Ident::new(name.into(), DUMMY_SP, SyntaxContext::empty()) };

        // Helper to create an identifier expression
        let ident_expr = |name: &str| -> Box<Expr> { Box::new(Expr::Ident(ident(name))) };

        // var __wf_sym = Symbol.for("workflow-class-registry");
        let sym_decl = VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: ident("__wf_sym"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("Symbol"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "for".into(),
                    }),
                }))),
                args: vec![ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: "workflow-class-registry".into(),
                        raw: None,
                    }))),
                }],
                type_args: None,
            }))),
            definite: false,
        };

        // var __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        let global_sym_access = Box::new(Expr::Member(MemberExpr {
            span: DUMMY_SP,
            obj: ident_expr("globalThis"),
            prop: MemberProp::Computed(ComputedPropName {
                span: DUMMY_SP,
                expr: ident_expr("__wf_sym"),
            }),
        }));

        let reg_decl = VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: ident("__wf_reg"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Bin(BinExpr {
                span: DUMMY_SP,
                op: BinaryOp::LogicalOr,
                left: global_sym_access.clone(),
                right: Box::new(Expr::Paren(ParenExpr {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Assign(AssignExpr {
                        span: DUMMY_SP,
                        op: AssignOp::Assign,
                        left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: ident_expr("globalThis"),
                            prop: MemberProp::Computed(ComputedPropName {
                                span: DUMMY_SP,
                                expr: ident_expr("__wf_sym"),
                            }),
                        })),
                        right: Box::new(Expr::New(NewExpr {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            callee: ident_expr("Map"),
                            args: Some(vec![]),
                            type_args: None,
                        })),
                    })),
                })),
            }))),
            definite: false,
        };

        // __wf_reg.set(__wf_id, __wf_cls);
        let set_call = Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("__wf_reg"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "set".into(),
                    }),
                }))),
                args: vec![
                    ExprOrSpread {
                        spread: None,
                        expr: ident_expr("__wf_id"),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: ident_expr("__wf_cls"),
                    },
                ],
                type_args: None,
            })),
        });

        // Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
        let define_property_call = Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("Object"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "defineProperty".into(),
                    }),
                }))),
                args: vec![
                    ExprOrSpread {
                        spread: None,
                        expr: ident_expr("__wf_cls"),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: "classId".into(),
                            raw: None,
                        }))),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Object(ObjectLit {
                            span: DUMMY_SP,
                            props: vec![
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName {
                                        span: DUMMY_SP,
                                        sym: "value".into(),
                                    }),
                                    value: ident_expr("__wf_id"),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName {
                                        span: DUMMY_SP,
                                        sym: "writable".into(),
                                    }),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: false,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName {
                                        span: DUMMY_SP,
                                        sym: "enumerable".into(),
                                    }),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: false,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName {
                                        span: DUMMY_SP,
                                        sym: "configurable".into(),
                                    }),
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
        });

        // The function body: var decls + set + defineProperty
        let function_body = BlockStmt {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            stmts: vec![
                // var __wf_sym = ..., __wf_reg = ...;
                Stmt::Decl(Decl::Var(Box::new(VarDecl {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    kind: VarDeclKind::Var,
                    declare: false,
                    decls: vec![sym_decl, reg_decl],
                }))),
                set_call,
                define_property_call,
            ],
        };

        // The IIFE: (function(__wf_cls, __wf_id) { ... })(ClassName, /* generated class ID string */);
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Fn(FnExpr {
                        ident: None,
                        function: Box::new(Function {
                            params: vec![
                                Param {
                                    span: DUMMY_SP,
                                    decorators: vec![],
                                    pat: Pat::Ident(BindingIdent {
                                        id: ident("__wf_cls"),
                                        type_ann: None,
                                    }),
                                },
                                Param {
                                    span: DUMMY_SP,
                                    decorators: vec![],
                                    pat: Pat::Ident(BindingIdent {
                                        id: ident("__wf_id"),
                                        type_ann: None,
                                    }),
                                },
                            ],
                            decorators: vec![],
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            body: Some(function_body),
                            is_generator: false,
                            is_async: false,
                            type_params: None,
                            return_type: None,
                        }),
                    })),
                }))),
                args: vec![
                    // First argument: ClassName
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Ident(ident(class_name))),
                    },
                    // Second argument: class ID string
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: class_id.into(),
                            raw: None,
                        }))),
                    },
                ],
                type_args: None,
            })),
        })
    }

    // Create an inline step function registration statement (step mode).
    // Instead of importing registerStepFunction from "workflow/internal/private",
    // we inline the registration logic as a self-contained IIFE that has zero module dependencies.
    // This is critical for 3rd-party packages that define step functions but don't depend
    // on the "workflow" package directly.
    //
    // Generates:
    //   (function(__wf_fn, __wf_id) {
    //     var __wf_sym = Symbol.for("@workflow/core//registeredSteps"),
    //         __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    //     __wf_reg.set(__wf_id, __wf_fn);
    //     __wf_fn.stepId = __wf_id;
    //   })(fnRef, "step//module_path//fnName");
    fn create_inline_step_registration(&self, step_id: &str, fn_ref: Expr, fn_name: &str) -> Stmt {
        // Helper to create an identifier
        let ident =
            |name: &str| -> Ident { Ident::new(name.into(), DUMMY_SP, SyntaxContext::empty()) };

        // Helper to create an identifier expression
        let ident_expr = |name: &str| -> Box<Expr> { Box::new(Expr::Ident(ident(name))) };

        // var __wf_sym = Symbol.for("@workflow/core//registeredSteps"),
        //     __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
        let sym_decl = VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: ident("__wf_sym"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("Symbol"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "for".into(),
                    }),
                }))),
                args: vec![ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: "@workflow/core//registeredSteps".into(),
                        raw: None,
                    }))),
                }],
                type_args: None,
            }))),
            definite: false,
        };

        let global_sym_access = Box::new(Expr::Member(MemberExpr {
            span: DUMMY_SP,
            obj: ident_expr("globalThis"),
            prop: MemberProp::Computed(ComputedPropName {
                span: DUMMY_SP,
                expr: ident_expr("__wf_sym"),
            }),
        }));

        let reg_decl = VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: ident("__wf_reg"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Bin(BinExpr {
                span: DUMMY_SP,
                op: BinaryOp::LogicalOr,
                left: global_sym_access.clone(),
                right: Box::new(Expr::Paren(ParenExpr {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Assign(AssignExpr {
                        span: DUMMY_SP,
                        op: AssignOp::Assign,
                        left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: ident_expr("globalThis"),
                            prop: MemberProp::Computed(ComputedPropName {
                                span: DUMMY_SP,
                                expr: ident_expr("__wf_sym"),
                            }),
                        })),
                        right: Box::new(Expr::New(NewExpr {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            callee: ident_expr("Map"),
                            args: Some(vec![]),
                            type_args: None,
                        })),
                    })),
                })),
            }))),
            definite: false,
        };

        // __wf_reg.set(__wf_id, __wf_fn);
        let set_call = Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("__wf_reg"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "set".into(),
                    }),
                }))),
                args: vec![
                    ExprOrSpread {
                        spread: None,
                        expr: ident_expr("__wf_id"),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: ident_expr("__wf_fn"),
                    },
                ],
                type_args: None,
            })),
        });

        // __wf_fn.stepId = __wf_id;
        let step_id_assignment = Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Assign(AssignExpr {
                span: DUMMY_SP,
                op: AssignOp::Assign,
                left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("__wf_fn"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "stepId".into(),
                    }),
                })),
                right: ident_expr("__wf_id"),
            })),
        });

        // Object.defineProperty(__wf_fn, "name", { value: "originalName", configurable: true })
        // This preserves the original function name in stack traces even after bundler minification.
        let define_name = Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("Object"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "defineProperty".into(),
                    }),
                }))),
                args: vec![
                    ExprOrSpread {
                        spread: None,
                        expr: ident_expr("__wf_fn"),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: "name".into(),
                            raw: None,
                        }))),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Object(ObjectLit {
                            span: DUMMY_SP,
                            props: vec![
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName {
                                        span: DUMMY_SP,
                                        sym: "value".into(),
                                    }),
                                    value: Box::new(Expr::Lit(Lit::Str(Str {
                                        span: DUMMY_SP,
                                        value: fn_name.into(),
                                        raw: None,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName {
                                        span: DUMMY_SP,
                                        sym: "configurable".into(),
                                    }),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: true,
                                    }))),
                                }))),
                            ],
                        })),
                    },
                ],
                type_args: None,
            })),
        });

        // The function body: var decls + set + stepId assignment + name preservation
        let function_body = BlockStmt {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            stmts: vec![
                Stmt::Decl(Decl::Var(Box::new(VarDecl {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    kind: VarDeclKind::Var,
                    declare: false,
                    decls: vec![sym_decl, reg_decl],
                }))),
                set_call,
                step_id_assignment,
                define_name,
            ],
        };

        // The IIFE: (function(__wf_fn, __wf_id) { ... })(fnRef, "step_id");
        Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Fn(FnExpr {
                        ident: None,
                        function: Box::new(Function {
                            params: vec![
                                Param {
                                    span: DUMMY_SP,
                                    decorators: vec![],
                                    pat: Pat::Ident(BindingIdent {
                                        id: ident("__wf_fn"),
                                        type_ann: None,
                                    }),
                                },
                                Param {
                                    span: DUMMY_SP,
                                    decorators: vec![],
                                    pat: Pat::Ident(BindingIdent {
                                        id: ident("__wf_id"),
                                        type_ann: None,
                                    }),
                                },
                            ],
                            decorators: vec![],
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            body: Some(function_body),
                            is_generator: false,
                            is_async: false,
                            type_params: None,
                            return_type: None,
                        }),
                    })),
                }))),
                args: vec![
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(fn_ref),
                    },
                    ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: step_id.into(),
                            raw: None,
                        }))),
                    },
                ],
                type_args: None,
            })),
        })
    }

    // Create an inline closure variable access expression (step mode).
    // Instead of importing __private_getClosureVars from "workflow/internal/private",
    // we inline the access as a self-contained IIFE that reads from the global
    // AsyncLocalStorage context.
    //
    // Generates:
    //   (function() {
    //     var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")],
    //         __wf_store = __wf_ctx && __wf_ctx.getStore();
    //     if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
    //     return __wf_store.closureVars || {};
    //   })()
    fn create_inline_get_closure_vars(&self) -> Expr {
        let ident =
            |name: &str| -> Ident { Ident::new(name.into(), DUMMY_SP, SyntaxContext::empty()) };
        let ident_expr = |name: &str| -> Box<Expr> { Box::new(Expr::Ident(ident(name))) };

        // var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")]
        let ctx_decl = VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: ident("__wf_ctx"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Member(MemberExpr {
                span: DUMMY_SP,
                obj: ident_expr("globalThis"),
                prop: MemberProp::Computed(ComputedPropName {
                    span: DUMMY_SP,
                    expr: Box::new(Expr::Call(CallExpr {
                        span: DUMMY_SP,
                        ctxt: SyntaxContext::empty(),
                        callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: ident_expr("Symbol"),
                            prop: MemberProp::Ident(IdentName {
                                span: DUMMY_SP,
                                sym: "for".into(),
                            }),
                        }))),
                        args: vec![ExprOrSpread {
                            spread: None,
                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                span: DUMMY_SP,
                                value: "WORKFLOW_STEP_CONTEXT_STORAGE".into(),
                                raw: None,
                            }))),
                        }],
                        type_args: None,
                    })),
                }),
            }))),
            definite: false,
        };

        // __wf_store = __wf_ctx && __wf_ctx.getStore()
        let store_decl = VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: ident("__wf_store"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Bin(BinExpr {
                span: DUMMY_SP,
                op: BinaryOp::LogicalAnd,
                left: ident_expr("__wf_ctx"),
                right: Box::new(Expr::Call(CallExpr {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                        span: DUMMY_SP,
                        obj: ident_expr("__wf_ctx"),
                        prop: MemberProp::Ident(IdentName {
                            span: DUMMY_SP,
                            sym: "getStore".into(),
                        }),
                    }))),
                    args: vec![],
                    type_args: None,
                })),
            }))),
            definite: false,
        };

        // if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        // return __wf_store.closureVars || {};
        let throw_if_missing = Stmt::If(IfStmt {
            span: DUMMY_SP,
            test: Box::new(Expr::Unary(UnaryExpr {
                span: DUMMY_SP,
                op: UnaryOp::Bang,
                arg: ident_expr("__wf_store"),
            })),
            cons: Box::new(Stmt::Throw(ThrowStmt {
                span: DUMMY_SP,
                arg: Box::new(Expr::New(NewExpr {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    callee: ident_expr("Error"),
                    args: Some(vec![ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: "Closure variables can only be accessed inside a step function"
                                .into(),
                            raw: None,
                        }))),
                    }]),
                    type_args: None,
                })),
            })),
            alt: None,
        });

        let return_stmt = Stmt::Return(ReturnStmt {
            span: DUMMY_SP,
            arg: Some(Box::new(Expr::Bin(BinExpr {
                span: DUMMY_SP,
                op: BinaryOp::LogicalOr,
                left: Box::new(Expr::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: ident_expr("__wf_store"),
                    prop: MemberProp::Ident(IdentName {
                        span: DUMMY_SP,
                        sym: "closureVars".into(),
                    }),
                })),
                right: Box::new(Expr::Object(ObjectLit {
                    span: DUMMY_SP,
                    props: vec![],
                })),
            }))),
        });

        let function_body = BlockStmt {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            stmts: vec![
                Stmt::Decl(Decl::Var(Box::new(VarDecl {
                    span: DUMMY_SP,
                    ctxt: SyntaxContext::empty(),
                    kind: VarDeclKind::Var,
                    declare: false,
                    decls: vec![ctx_decl, store_decl],
                }))),
                throw_if_missing,
                return_stmt,
            ],
        };

        // (function() { ... })()
        Expr::Call(CallExpr {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: Box::new(Expr::Fn(FnExpr {
                    ident: None,
                    function: Box::new(Function {
                        params: vec![],
                        decorators: vec![],
                        span: DUMMY_SP,
                        ctxt: SyntaxContext::empty(),
                        body: Some(function_body),
                        is_generator: false,
                        is_async: false,
                        type_params: None,
                        return_type: None,
                    }),
                })),
            }))),
            args: vec![],
            type_args: None,
        })
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

    // Create the appropriate step registration statement based on mode:
    // - Step mode: inline IIFE registration
    // - Client mode: stepId property assignment
    fn create_step_registration_stmt(&self, fn_name: &str, span: swc_core::common::Span) -> Stmt {
        let step_id = self.create_id(Some(fn_name), span, false);
        match self.mode {
            TransformMode::Step => {
                let fn_ref =
                    Expr::Ident(Ident::new(fn_name.into(), DUMMY_SP, SyntaxContext::empty()));
                self.create_inline_step_registration(&step_id, fn_ref, fn_name)
            }
            _ => self.create_step_id_assignment_with_id(fn_name, &step_id),
        }
    }

    // Create a statement that adds stepId property to a function with a pre-computed step_id (client mode)
    // Creates: functionName.stepId = "stepId"
    fn create_step_id_assignment_with_id(&self, fn_name: &str, step_id: &str) -> Stmt {
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
                    prop: MemberProp::Ident(IdentName::new("stepId".into(), DUMMY_SP)),
                })),
                right: Box::new(Expr::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: step_id.into(),
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

    // Record a step function for inline registration after its declaration.
    // In step mode, the inline IIFE registration will be inserted right after
    // the function declaration in visit_mut_module_items.
    fn create_registration_call(&mut self, name: &str, span: swc_core::common::Span) {
        // Only register each function once
        if !self.registered_functions.contains(name) {
            self.registered_functions.insert(name.to_string());
            self.step_functions_needing_id
                .push((name.to_string(), span));
        }
    }

    // Check if a function should be treated as a step function
    fn should_transform_function(&self, function: &Function, is_exported: bool) -> bool {
        let has_directive = self.has_use_step_directive(&function.body);

        // Function has explicit directive OR file has directive and function is exported
        // Note: async is no longer required for step functions
        has_directive || (self.has_file_step_directive && is_exported)
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
            analyze_step_function_bodies: self.mode == TransformMode::Client,
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

        // Build classes metadata
        if !self.classes_for_manifest.is_empty() {
            let mut sorted_classes: Vec<_> = self.classes_for_manifest.iter().collect();
            sorted_classes.sort();

            let module_path = self.get_module_path();
            let class_entries: Vec<String> = sorted_classes
                .into_iter()
                .map(|class_name| {
                    let class_id = naming::format_name("class", &module_path, class_name);
                    format!("\"{}\":{{\"classId\":\"{}\"}}", class_name, class_id)
                })
                .collect();

            metadata.insert("classes", format!("{{{}}}", class_entries.join(",")));
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
        if metadata.contains_key("classes") {
            parts.push(format!(
                "\"classes\":{{\"{}\":{}}}",
                relative_filename, metadata["classes"]
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
    analyze_step_function_bodies: bool,
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

        if is_step_function && !self.analyze_step_function_bodies {
            // In workflow mode, step functions are replaced with proxies, so their
            // original bodies should not keep imports or local helpers alive.
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
                if self.step_function_names.contains(&fn_name) && !self.analyze_step_function_bodies
                {
                    // In workflow mode, step functions have their bodies replaced.
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

                if is_step_fn && !self.analyze_step_function_bodies {
                    // In workflow mode, step function initializers are replaced.
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

        // Preserve class names for manifest before they get drained during registration
        self.classes_for_manifest = self.classes_needing_serialization.clone();

        // Add necessary imports and registrations
        match program {
            Program::Module(module) => {
                // All registrations are now inlined (no imports needed).

                // Add hoisted object property functions and registration calls at the end for step mode or client mode
                if matches!(self.mode, TransformMode::Step | TransformMode::Client) {
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

                                // Create destructuring statement using inline IIFE:
                                // const { var1, var2 } = (function() { ... })();
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
                                            init: Some(Box::new(
                                                self.create_inline_get_closure_vars(),
                                            )),
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

                        // Create a registration call or stepId assignment with parent workflow name in the step ID
                        let step_fn_name = if parent_workflow_name.is_empty() {
                            fn_name.clone()
                        } else {
                            format!("{}/{}", parent_workflow_name, fn_name)
                        };
                        let step_id = self.create_id(Some(&step_fn_name), span, false);

                        // Insert registration right after the hoisted declaration
                        let registration_stmt = if self.mode == TransformMode::Client {
                            self.create_step_id_assignment_with_id(&hoisted_name, &step_id)
                        } else {
                            let fn_ref = Expr::Ident(Ident::new(
                                hoisted_name.clone().into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            ));
                            self.create_inline_step_registration(&step_id, fn_ref, &hoisted_name)
                        };
                        module
                            .body
                            .insert(current_insert_pos, ModuleItem::Stmt(registration_stmt));
                        current_insert_pos += 1;
                    }

                    // Then process object property step functions (they typically appear later)
                    // Collect hoisting information before the loop
                    let hoisting_info: Vec<_> = self
                        .object_property_step_functions
                        .iter()
                        .map(
                            |(parent_var, prop_name, fn_expr, _span, workflow_name, _was_arrow)| {
                                // Replace slashes with $ in parent_var to create valid JS identifier
                                let safe_parent_var = parent_var.replace('/', "$");
                                let hoist_var_name = if !workflow_name.is_empty() {
                                    format!("{}${}${}", workflow_name, safe_parent_var, prop_name)
                                } else {
                                    format!("{}${}", safe_parent_var, prop_name)
                                };
                                let wf_name = if workflow_name.is_empty() {
                                    None
                                } else {
                                    Some(workflow_name.as_str())
                                };
                                let step_id = self.create_object_property_id(
                                    parent_var, prop_name, false, wf_name,
                                );
                                (hoist_var_name, fn_expr.clone(), step_id, parent_var.clone())
                            },
                        )
                        .collect();

                    // Now drain and process
                    self.object_property_step_functions.drain(..);

                    for (hoist_var_name, fn_expr, step_id, _parent_var) in hoisting_info {
                        // Create a var declaration for the hoisted function
                        // Using function expression (not arrow) to preserve `this` binding
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
                                    init: Some(Box::new(Expr::Fn(fn_expr))),
                                    definite: false,
                                }],
                                declare: false,
                            }))));

                        // Insert at current position and increment for next iteration
                        module.body.insert(current_insert_pos, hoisted_decl);
                        current_insert_pos += 1;

                        // Insert registration right after the hoisted declaration
                        let registration_stmt = if self.mode == TransformMode::Client {
                            self.create_step_id_assignment_with_id(&hoist_var_name, &step_id)
                        } else {
                            let fn_ref = Expr::Ident(Ident::new(
                                hoist_var_name.clone().into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            ));
                            self.create_inline_step_registration(&step_id, fn_ref, &hoist_var_name)
                        };
                        module
                            .body
                            .insert(current_insert_pos, ModuleItem::Stmt(registration_stmt));
                        current_insert_pos += 1;
                    }

                    // Add static method step registrations (inline IIFE)
                    let static_step_regs: Vec<_> =
                        self.static_method_step_registrations.drain(..).collect();
                    for (class_name, method_name, step_id, _span) in static_step_regs {
                        let fn_ref = Expr::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: Box::new(Expr::Ident(Ident::new(
                                class_name.into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            ))),
                            prop: MemberProp::Ident(IdentName::new(
                                method_name.clone().into(),
                                DUMMY_SP,
                            )),
                        });
                        let registration_call =
                            self.create_inline_step_registration(&step_id, fn_ref, &method_name);
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }

                    // Add instance method step registrations (inline IIFE)
                    // For instance methods, we register ClassName.prototype["methodName"]
                    let instance_step_regs: Vec<_> =
                        self.instance_method_step_registrations.drain(..).collect();
                    for (class_name, method_name, step_id, _span) in instance_step_regs {
                        let fn_ref = Expr::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: Box::new(Expr::Member(MemberExpr {
                                span: DUMMY_SP,
                                obj: Box::new(Expr::Ident(Ident::new(
                                    class_name.into(),
                                    DUMMY_SP,
                                    SyntaxContext::empty(),
                                ))),
                                prop: MemberProp::Ident(IdentName::new(
                                    "prototype".into(),
                                    DUMMY_SP,
                                )),
                            })),
                            prop: MemberProp::Computed(ComputedPropName {
                                span: DUMMY_SP,
                                expr: Box::new(Expr::Lit(Lit::Str(Str {
                                    span: DUMMY_SP,
                                    value: method_name.clone().into(),
                                    raw: None,
                                }))),
                            }),
                        });
                        let registration_call =
                            self.create_inline_step_registration(&step_id, fn_ref, &method_name);
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }

                    // Add instance getter step registrations
                    // For getters, we register Object.getOwnPropertyDescriptor(ClassName.prototype, "getterName").get
                    // using an inline IIFE (same pattern as other step registrations)
                    for (class_name, getter_name, step_id, _span) in {
                        let regs: Vec<_> =
                            self.instance_getter_step_registrations.drain(..).collect();
                        regs
                    }
                    .into_iter()
                    {
                        // Build: Object.getOwnPropertyDescriptor(ClassName.prototype, "getterName").get
                        let getter_ref = Expr::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: Box::new(Expr::Call(CallExpr {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                    span: DUMMY_SP,
                                    obj: Box::new(Expr::Ident(Ident::new(
                                        "Object".into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    ))),
                                    prop: MemberProp::Ident(IdentName::new(
                                        "getOwnPropertyDescriptor".into(),
                                        DUMMY_SP,
                                    )),
                                }))),
                                args: vec![
                                    // First arg: ClassName.prototype
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
                                                "prototype".into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                    },
                                    // Second arg: "getterName"
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: getter_name.clone().into(),
                                            raw: None,
                                        }))),
                                    },
                                ],
                                type_args: None,
                            })),
                            prop: MemberProp::Ident(IdentName::new("get".into(), DUMMY_SP)),
                        });

                        let registration_call = self.create_inline_step_registration(
                            &step_id,
                            getter_ref,
                            &getter_name,
                        );
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }

                    // Add static getter step registrations
                    // For static getters, we register Object.getOwnPropertyDescriptor(ClassName, "getterName").get
                    for (class_name, getter_name, step_id, _span) in {
                        let regs: Vec<_> =
                            self.static_getter_step_registrations.drain(..).collect();
                        regs
                    }
                    .into_iter()
                    {
                        // Build: Object.getOwnPropertyDescriptor(ClassName, "getterName").get
                        let getter_ref = Expr::Member(MemberExpr {
                            span: DUMMY_SP,
                            obj: Box::new(Expr::Call(CallExpr {
                                span: DUMMY_SP,
                                ctxt: SyntaxContext::empty(),
                                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                    span: DUMMY_SP,
                                    obj: Box::new(Expr::Ident(Ident::new(
                                        "Object".into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    ))),
                                    prop: MemberProp::Ident(IdentName::new(
                                        "getOwnPropertyDescriptor".into(),
                                        DUMMY_SP,
                                    )),
                                }))),
                                args: vec![
                                    // First arg: ClassName (not .prototype for static)
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Ident(Ident::new(
                                            class_name.clone().into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                    },
                                    // Second arg: "getterName"
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: getter_name.clone().into(),
                                            raw: None,
                                        }))),
                                    },
                                ],
                                type_args: None,
                            })),
                            prop: MemberProp::Ident(IdentName::new("get".into(), DUMMY_SP)),
                        });

                        let registration_call = self.create_inline_step_registration(
                            &step_id,
                            getter_ref,
                            &getter_name,
                        );
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }

                    // Add class serialization registrations for step mode
                    // Uses inlined IIFE registration (no import needed)
                    // Sort for deterministic output ordering
                    let mut sorted_classes: Vec<_> =
                        self.classes_needing_serialization.drain().collect();
                    sorted_classes.sort();
                    for class_name in sorted_classes {
                        let registration_call =
                            self.create_class_serialization_registration(&class_name);
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }
                }

                // Hoist getter workflow proxy vars for object literal getters (workflow mode)
                // These must be inserted before the code that references them
                if matches!(self.mode, TransformMode::Workflow)
                    && !self.getter_workflow_proxy_hoists.is_empty()
                {
                    let insert_pos = module
                        .body
                        .iter()
                        .position(|item| {
                            !matches!(item, ModuleItem::ModuleDecl(ModuleDecl::Import(_)))
                        })
                        .unwrap_or(0);

                    let mut offset = 0;
                    let proxy_hoists: Vec<_> =
                        self.getter_workflow_proxy_hoists.drain(..).collect();
                    for (var_name, step_id) in proxy_hoists {
                        let step_proxy = self.create_step_initializer(&step_id);
                        let var_decl = ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            kind: VarDeclKind::Var,
                            declare: false,
                            decls: vec![VarDeclarator {
                                span: DUMMY_SP,
                                name: Pat::Ident(BindingIdent {
                                    id: Ident::new(
                                        var_name.into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    ),
                                    type_ann: None,
                                }),
                                init: Some(Box::new(step_proxy)),
                                definite: false,
                            }],
                        }))));
                        module.body.insert(insert_pos + offset, var_decl);
                        offset += 1;
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

                    // Add instance step method property assignments (workflow mode)
                    // These methods were stripped from the class and need to be assigned as prototype properties
                    for (class_name, method_name, step_id) in
                        self.instance_step_methods_to_strip.drain(..)
                    {
                        // Create: ClassName.prototype.methodName = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id")
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

                        // Create: ClassName.prototype.methodName = proxy_expr
                        let assignment = Stmt::Expr(ExprStmt {
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
                                                "prototype".into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                        prop: MemberProp::Computed(ComputedPropName {
                                            span: DUMMY_SP,
                                            expr: Box::new(Expr::Lit(Lit::Str(Str {
                                                span: DUMMY_SP,
                                                value: method_name.into(),
                                                raw: None,
                                            }))),
                                        }),
                                    },
                                )),
                                op: AssignOp::Assign,
                                right: Box::new(proxy_expr),
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(assignment));
                    }

                    // Add instance getter step definitions (workflow mode)
                    // These getters were stripped from the class and need to be redefined via Object.defineProperty
                    let getter_strips: Vec<_> =
                        self.instance_getter_steps_to_strip.drain(..).collect();
                    for (class_name, getter_name, step_id) in getter_strips {
                        // Sanitize names for use in JS identifier
                        let safe_getter = sanitize_ident_part(&getter_name);
                        let var_name = format!(
                            "__step_{}${}",
                            sanitize_ident_part(&class_name),
                            safe_getter
                        );

                        // Create: var __step_ClassName$getterName = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id")
                        let step_proxy = self.create_step_initializer(&step_id);
                        let var_decl = Stmt::Decl(Decl::Var(Box::new(VarDecl {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            kind: VarDeclKind::Var,
                            declare: false,
                            decls: vec![VarDeclarator {
                                span: DUMMY_SP,
                                name: Pat::Ident(BindingIdent {
                                    id: Ident::new(
                                        var_name.clone().into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    ),
                                    type_ann: None,
                                }),
                                init: Some(Box::new(step_proxy)),
                                definite: false,
                            }],
                        })));
                        module.body.push(ModuleItem::Stmt(var_decl));

                        // Create: Object.defineProperty(ClassName.prototype, "getterName", {
                        //   get() { return __step_ClassName$getterName.call(this); },
                        //   configurable: true,
                        //   enumerable: false
                        // })
                        let getter_body = BlockStmt {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            stmts: vec![Stmt::Return(ReturnStmt {
                                span: DUMMY_SP,
                                arg: Some(Box::new(Expr::Call(CallExpr {
                                    span: DUMMY_SP,
                                    ctxt: SyntaxContext::empty(),
                                    callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                        span: DUMMY_SP,
                                        obj: Box::new(Expr::Ident(Ident::new(
                                            var_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                        prop: MemberProp::Ident(IdentName::new(
                                            "call".into(),
                                            DUMMY_SP,
                                        )),
                                    }))),
                                    args: vec![ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::This(ThisExpr { span: DUMMY_SP })),
                                    }],
                                    type_args: None,
                                }))),
                            })],
                        };

                        let descriptor = Expr::Object(ObjectLit {
                            span: DUMMY_SP,
                            props: vec![
                                // get() { return __step_var.call(this); }
                                PropOrSpread::Prop(Box::new(Prop::Method(MethodProp {
                                    key: PropName::Ident(IdentName::new("get".into(), DUMMY_SP)),
                                    function: Box::new(Function {
                                        params: vec![],
                                        decorators: vec![],
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        body: Some(getter_body),
                                        is_generator: false,
                                        is_async: false,
                                        type_params: None,
                                        return_type: None,
                                    }),
                                }))),
                                // configurable: true
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new(
                                        "configurable".into(),
                                        DUMMY_SP,
                                    )),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: true,
                                    }))),
                                }))),
                                // enumerable: false
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
                            ],
                        });

                        let define_property_call = Stmt::Expr(ExprStmt {
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
                                    prop: MemberProp::Ident(IdentName::new(
                                        "defineProperty".into(),
                                        DUMMY_SP,
                                    )),
                                }))),
                                args: vec![
                                    // ClassName.prototype
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
                                                "prototype".into(),
                                                DUMMY_SP,
                                            )),
                                        })),
                                    },
                                    // "getterName"
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: getter_name.into(),
                                            raw: None,
                                        }))),
                                    },
                                    // { get() { ... }, configurable: true, enumerable: false }
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(descriptor),
                                    },
                                ],
                                type_args: None,
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(define_property_call));
                    }

                    // Add static getter step definitions (workflow mode)
                    // Same as instance getters but targets ClassName instead of ClassName.prototype
                    let static_getter_strips: Vec<_> =
                        self.static_getter_steps_to_strip.drain(..).collect();
                    for (class_name, getter_name, step_id) in static_getter_strips {
                        let safe_getter = sanitize_ident_part(&getter_name);
                        let var_name = format!(
                            "__step_{}${}",
                            sanitize_ident_part(&class_name),
                            safe_getter
                        );

                        let step_proxy = self.create_step_initializer(&step_id);
                        let var_decl = Stmt::Decl(Decl::Var(Box::new(VarDecl {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            kind: VarDeclKind::Var,
                            declare: false,
                            decls: vec![VarDeclarator {
                                span: DUMMY_SP,
                                name: Pat::Ident(BindingIdent {
                                    id: Ident::new(
                                        var_name.clone().into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    ),
                                    type_ann: None,
                                }),
                                init: Some(Box::new(step_proxy)),
                                definite: false,
                            }],
                        })));
                        module.body.push(ModuleItem::Stmt(var_decl));

                        // Object.defineProperty(ClassName, "getterName", { get() { return __step_var(); }, ... })
                        // Note: static getters don't need .call(this), just invoke directly
                        let getter_body = BlockStmt {
                            span: DUMMY_SP,
                            ctxt: SyntaxContext::empty(),
                            stmts: vec![Stmt::Return(ReturnStmt {
                                span: DUMMY_SP,
                                arg: Some(Box::new(Expr::Call(CallExpr {
                                    span: DUMMY_SP,
                                    ctxt: SyntaxContext::empty(),
                                    callee: Callee::Expr(Box::new(Expr::Ident(Ident::new(
                                        var_name.into(),
                                        DUMMY_SP,
                                        SyntaxContext::empty(),
                                    )))),
                                    args: vec![],
                                    type_args: None,
                                }))),
                            })],
                        };

                        let descriptor = Expr::Object(ObjectLit {
                            span: DUMMY_SP,
                            props: vec![
                                PropOrSpread::Prop(Box::new(Prop::Method(MethodProp {
                                    key: PropName::Ident(IdentName::new("get".into(), DUMMY_SP)),
                                    function: Box::new(Function {
                                        params: vec![],
                                        decorators: vec![],
                                        span: DUMMY_SP,
                                        ctxt: SyntaxContext::empty(),
                                        body: Some(getter_body),
                                        is_generator: false,
                                        is_async: false,
                                        type_params: None,
                                        return_type: None,
                                    }),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new(
                                        "configurable".into(),
                                        DUMMY_SP,
                                    )),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span: DUMMY_SP,
                                        value: true,
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
                            ],
                        });

                        let define_property_call = Stmt::Expr(ExprStmt {
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
                                    prop: MemberProp::Ident(IdentName::new(
                                        "defineProperty".into(),
                                        DUMMY_SP,
                                    )),
                                }))),
                                args: vec![
                                    // ClassName (not .prototype for static)
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Ident(Ident::new(
                                            class_name.into(),
                                            DUMMY_SP,
                                            SyntaxContext::empty(),
                                        ))),
                                    },
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                                            span: DUMMY_SP,
                                            value: getter_name.into(),
                                            raw: None,
                                        }))),
                                    },
                                    ExprOrSpread {
                                        spread: None,
                                        expr: Box::new(descriptor),
                                    },
                                ],
                                type_args: None,
                            })),
                        });
                        module.body.push(ModuleItem::Stmt(define_property_call));
                    }

                    // Add class serialization registrations for workflow mode
                    // This is now the same as step mode - using registerSerializationClass()
                    // which sets both classId and registers in the globalThis Map
                    // Sort for deterministic output ordering
                    let mut sorted_classes: Vec<_> =
                        self.classes_needing_serialization.drain().collect();
                    sorted_classes.sort();
                    for class_name in sorted_classes {
                        let registration_call =
                            self.create_class_serialization_registration(&class_name);
                        module.body.push(ModuleItem::Stmt(registration_call));
                    }
                }

                // Add class serialization registrations for client mode
                // In client mode, we need classes to be registered so that serialization works
                // when passing class instances to start(workflow)
                if matches!(self.mode, TransformMode::Client) {
                    let mut sorted_classes: Vec<_> =
                        self.classes_needing_serialization.drain().collect();
                    sorted_classes.sort();
                    for class_name in sorted_classes {
                        let registration_call =
                            self.create_class_serialization_registration(&class_name);
                        module.body.push(ModuleItem::Stmt(registration_call));
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

                    // All registrations are now inlined (no imports needed).

                    // Convert script statements to module items
                    for stmt in &script.body {
                        module_items.push(ModuleItem::Stmt(stmt.clone()));
                    }

                    // Add class serialization registrations for client mode (Script case)
                    if matches!(self.mode, TransformMode::Client) {
                        let mut sorted_classes: Vec<_> =
                            self.classes_needing_serialization.drain().collect();
                        sorted_classes.sort();
                        for class_name in sorted_classes {
                            let registration_call =
                                self.create_class_serialization_registration(&class_name);
                            module_items.push(ModuleItem::Stmt(registration_call));
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
                        TransformMode::Detect => false,
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
            // Validate exports for file-level step directives.
            // Step files allow sync or async function exports but reject
            // non-function exports (constants, classes, re-exports) which
            // can pull Node-only code into the workflow/client bundles.
            if self.has_file_step_directive {
                match item {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
                        match &export.decl {
                            Decl::Fn(_) => {
                                // Sync or async function declarations are allowed
                            }
                            Decl::Var(var_decl) => {
                                for decl in &var_decl.decls {
                                    match &decl.init {
                                        Some(init) => match &**init {
                                            Expr::Fn(_) | Expr::Arrow(_) => {
                                                // Function/arrow expressions are allowed
                                            }
                                            _ => {
                                                emit_error(WorkflowErrorKind::InvalidExport {
                                                    span: export.span,
                                                    directive: "use step",
                                                });
                                            }
                                        },
                                        None => {
                                            // Uninitialized exports are not functions
                                            emit_error(WorkflowErrorKind::InvalidExport {
                                                span: export.span,
                                                directive: "use step",
                                            });
                                        }
                                    }
                                }
                            }
                            Decl::TsInterface(_)
                            | Decl::TsTypeAlias(_)
                            | Decl::TsEnum(_)
                            | Decl::TsModule(_) => {
                                // TypeScript declarations are okay
                            }
                            _ => {
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: export.span,
                                    directive: "use step",
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                        // Re-exports (`export { x } from '...'`) are not allowed.
                        // Local named exports (`export { x }`) are also rejected
                        // because we cannot statically verify the binding is a function.
                        if named.src.is_some() || !named.specifiers.is_empty() {
                            emit_error(WorkflowErrorKind::InvalidExport {
                                span: named.span,
                                directive: "use step",
                            });
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(default)) => {
                        match &default.decl {
                            DefaultDecl::Fn(_) => {
                                // Sync or async function declarations are allowed
                            }
                            DefaultDecl::TsInterfaceDecl(_) => {
                                // TypeScript interface is okay
                            }
                            _ => {
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: default.span,
                                    directive: "use step",
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(expr)) => {
                        match &*expr.expr {
                            Expr::Fn(_) | Expr::Arrow(_) => {
                                // Function/arrow expressions are allowed
                            }
                            _ => {
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: expr.span,
                                    directive: "use step",
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                        emit_error(WorkflowErrorKind::InvalidExport {
                            span: export_all.span,
                            directive: "use step",
                        });
                    }
                    _ => {}
                }
            }

            // Validate exports for file-level workflow directives.
            // Workflow files require exported functions to be async.
            if self.has_file_workflow_directive {
                match item {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
                        match &export.decl {
                            Decl::Fn(fn_decl) => {
                                if !fn_decl.function.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: export.span,
                                        directive: "use workflow",
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
                                                        directive: "use workflow",
                                                    });
                                                }
                                            }
                                            Expr::Arrow(arrow_expr) => {
                                                if !arrow_expr.is_async {
                                                    emit_error(WorkflowErrorKind::InvalidExport {
                                                        span: export.span,
                                                        directive: "use workflow",
                                                    });
                                                }
                                            }
                                            Expr::Lit(_) => {
                                                // Literals are not allowed
                                                emit_error(WorkflowErrorKind::InvalidExport {
                                                    span: export.span,
                                                    directive: "use workflow",
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
                                    directive: "use workflow",
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
                                    directive: "use workflow",
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                        if named.src.is_some() {
                            // Re-exports are not allowed
                            emit_error(WorkflowErrorKind::InvalidExport {
                                span: named.span,
                                directive: "use workflow",
                            });
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(default)) => {
                        match &default.decl {
                            DefaultDecl::Fn(fn_expr) => {
                                if !fn_expr.function.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: default.span,
                                        directive: "use workflow",
                                    });
                                }
                            }
                            DefaultDecl::Class(_) => {
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: default.span,
                                    directive: "use workflow",
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
                                        directive: "use workflow",
                                    });
                                }
                            }
                            Expr::Arrow(arrow_expr) => {
                                if !arrow_expr.is_async {
                                    emit_error(WorkflowErrorKind::InvalidExport {
                                        span: expr.span,
                                        directive: "use workflow",
                                    });
                                }
                            }
                            _ => {
                                // Other default exports are not allowed
                                emit_error(WorkflowErrorKind::InvalidExport {
                                    span: expr.span,
                                    directive: "use workflow",
                                });
                            }
                        }
                    }
                    ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                        // export * from '...' is not allowed
                        emit_error(WorkflowErrorKind::InvalidExport {
                            span: export_all.span,
                            directive: "use workflow",
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

        // A module can only have one default export, so default workflow exports and
        // default class exports are mutually exclusive.
        debug_assert!(
            self.default_workflow_exports.is_empty() || self.default_class_exports.is_empty(),
            "both default_workflow_exports and default_class_exports are populated"
        );

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

        // Handle default class exports that need a binding name.
        // Rewrites `export default class { ... }` to:
        //   const __DefaultClass = class __DefaultClass { ... };
        //   export default __DefaultClass;
        if !self.default_class_exports.is_empty() {
            let class_exports: Vec<_> = self.default_class_exports.drain(..).collect();
            // A module can only have one default export, so at most one rewrite is queued.
            debug_assert!(
                class_exports.len() <= 1,
                "expected at most one default class export rewrite, got {}",
                class_exports.len()
            );

            // Find the original export default position
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

                for (const_name, class_expr) in class_exports {
                    // Insert: const __DefaultClass = class __DefaultClass { ... };
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
                                init: Some(Box::new(Expr::Class(class_expr))),
                                definite: false,
                            }],
                        })))),
                    );

                    // Insert: export default __DefaultClass;
                    items.insert(
                        pos + 1,
                        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(ExportDefaultExpr {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Ident(Ident::new(
                                const_name.into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            ))),
                        })),
                    );
                }
            }
        }

        // Clear the workflow_functions_needing_id since we've already processed them
        self.workflow_functions_needing_id.clear();

        // In step mode and client mode, add inline registrations right after
        // each step function declaration. Step mode uses an IIFE that registers
        // in a global Map; client mode uses a simple stepId property assignment.
        if matches!(self.mode, TransformMode::Step | TransformMode::Client)
            && !self.step_functions_needing_id.is_empty()
        {
            let step_functions: Vec<_> = self.step_functions_needing_id.drain(..).collect();
            let mut items_to_insert: Vec<(usize, ModuleItem)> = Vec::new();

            for (i, item) in items.iter().enumerate() {
                match item {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                        // Exported step functions
                        match &export_decl.decl {
                            Decl::Fn(fn_decl) => {
                                let fn_name = fn_decl.ident.sym.to_string();
                                if step_functions.iter().any(|(name, _)| name == &fn_name) {
                                    items_to_insert.push((
                                        i + 1,
                                        ModuleItem::Stmt(self.create_step_registration_stmt(
                                            &fn_name,
                                            fn_decl.function.span,
                                        )),
                                    ));
                                }
                            }
                            Decl::Var(var_decl) => {
                                for declarator in &var_decl.decls {
                                    if let Pat::Ident(binding) = &declarator.name {
                                        let name = binding.id.sym.to_string();
                                        if step_functions.iter().any(|(n, _)| n == &name) {
                                            if let Some(init) = &declarator.init {
                                                let span = match &**init {
                                                    Expr::Fn(fn_expr) => fn_expr.function.span,
                                                    Expr::Arrow(arrow_expr) => arrow_expr.span,
                                                    _ => declarator.span,
                                                };
                                                items_to_insert.push((
                                                    i + 1,
                                                    ModuleItem::Stmt(
                                                        self.create_step_registration_stmt(
                                                            &name, span,
                                                        ),
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
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(default_decl)) => {
                        // Default exported step function
                        if let DefaultDecl::Fn(fn_expr) = &default_decl.decl {
                            if let Some(ident) = &fn_expr.ident {
                                let fn_name = ident.sym.to_string();
                                if step_functions.iter().any(|(name, _)| name == &fn_name) {
                                    items_to_insert.push((
                                        i + 1,
                                        ModuleItem::Stmt(self.create_step_registration_stmt(
                                            &fn_name,
                                            fn_expr.function.span,
                                        )),
                                    ));
                                }
                            }
                        }
                    }
                    ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                        // Non-exported function declaration
                        let fn_name = fn_decl.ident.sym.to_string();
                        if step_functions.iter().any(|(name, _)| name == &fn_name) {
                            items_to_insert.push((
                                i + 1,
                                ModuleItem::Stmt(self.create_step_registration_stmt(
                                    &fn_name,
                                    fn_decl.function.span,
                                )),
                            ));
                        }
                    }
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
                        // Non-exported variable declaration
                        for declarator in &var_decl.decls {
                            if let Pat::Ident(binding) = &declarator.name {
                                let name = binding.id.sym.to_string();
                                if step_functions.iter().any(|(n, _)| n == &name) {
                                    if let Some(init) = &declarator.init {
                                        let span = match &**init {
                                            Expr::Fn(fn_expr) => fn_expr.function.span,
                                            Expr::Arrow(arrow_expr) => arrow_expr.span,
                                            _ => declarator.span,
                                        };
                                        items_to_insert.push((
                                            i + 1,
                                            ModuleItem::Stmt(
                                                self.create_step_registration_stmt(&name, span),
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

            // Insert items in reverse order to maintain correct indices
            items_to_insert.sort_by(|a, b| b.0.cmp(&a.0));
            for (pos, item) in items_to_insert {
                items.insert(pos, item);
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
            // It's valid - proceed with transformation
            self.step_function_names.insert(fn_name.clone());

            match self.mode {
                TransformMode::Step => {
                    self.remove_use_step_directive(&mut fn_decl.function.body);
                    self.create_registration_call(&fn_name, fn_decl.function.span);
                }
                TransformMode::Client => {
                    self.remove_use_step_directive(&mut fn_decl.function.body);
                    // Only set stepId for module-level step functions in client mode
                    // Nested step functions are unreachable (their containing function
                    // bodies are not hoisted to module level)
                    if self.in_module_level {
                        self.step_functions_needing_id
                            .push((fn_name.clone(), fn_decl.function.span));
                    }
                }
                TransformMode::Workflow => {
                    // For workflow mode, we need to replace the entire declaration
                    // This will be handled at a higher level
                }
                TransformMode::Detect => {}
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
                    TransformMode::Detect => {}
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
                    // It's valid - proceed with transformation
                    self.step_function_names.insert(fn_name.clone());

                    match self.mode {
                        TransformMode::Step => {
                            self.remove_use_step_directive(&mut fn_decl.function.body);
                            self.create_registration_call(&fn_name, fn_decl.function.span);
                            export_decl.visit_mut_children_with(self);
                        }
                        TransformMode::Client => {
                            self.remove_use_step_directive(&mut fn_decl.function.body);
                            self.step_functions_needing_id
                                .push((fn_name.clone(), fn_decl.function.span));
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
                        TransformMode::Detect => {}
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
                                // In client mode, don't visit children - nested steps inside workflows
                                // are unreachable since the workflow body is replaced with throw error
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
                            TransformMode::Detect => {}
                        }
                    }
                    // Visit children for workflow functions in Step and Workflow modes
                    // (Client mode already handled above - no children to visit)
                    if !matches!(self.mode, TransformMode::Client) || !is_workflow_function {
                        export_decl.visit_mut_children_with(self);
                    }

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
                                            TransformMode::Client => {
                                                self.remove_use_step_directive(
                                                    &mut fn_expr.function.body,
                                                );
                                                self.step_functions_needing_id
                                                    .push((name.clone(), fn_expr.function.span));
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
                                            TransformMode::Detect => {}
                                        }
                                    } else if self
                                        .should_transform_workflow_function(&fn_expr.function, true)
                                    {
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
                                                    body.stmts = vec![Stmt::Throw(ThrowStmt {
                                                        span: DUMMY_SP,
                                                        arg: Box::new(error_expr),
                                                    })];
                                                }

                                                self.workflow_functions_needing_id
                                                    .push((name.clone(), fn_expr.function.span));
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
                                                }

                                                self.workflow_functions_needing_id
                                                    .push((name.clone(), fn_expr.function.span));
                                            }
                                            TransformMode::Detect => {}
                                        }
                                    }
                                }
                                Expr::Arrow(arrow_expr) => {
                                    // Check for step directive first
                                    if self.has_step_directive_arrow(arrow_expr, true) {
                                        // Validate that it's async - emit error if not
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
                                            TransformMode::Client => {
                                                self.remove_use_step_directive_arrow(
                                                    &mut arrow_expr.body,
                                                );
                                                self.step_functions_needing_id
                                                    .push((name.clone(), arrow_expr.span));
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
                                            TransformMode::Detect => {}
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
                                                TransformMode::Detect => {}
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
                                // It's valid - proceed with transformation
                                self.step_function_names.insert(name.clone());

                                match self.mode {
                                    TransformMode::Step => {
                                        self.remove_use_step_directive(&mut fn_expr.function.body);
                                        self.create_registration_call(&name, fn_expr.function.span);
                                    }
                                    TransformMode::Client => {
                                        self.remove_use_step_directive(&mut fn_expr.function.body);
                                        // Only set stepId for module-level step functions
                                        if self.in_module_level {
                                            self.step_functions_needing_id
                                                .push((name.clone(), fn_expr.function.span));
                                        }
                                    }
                                    TransformMode::Workflow => {
                                        // Keep the function expression but replace its body with a proxy call
                                        self.remove_use_step_directive(&mut fn_expr.function.body);
                                        if let Some(body) = &mut fn_expr.function.body {
                                            let step_id = self.create_id(
                                                Some(&name),
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
                                    TransformMode::Detect => {}
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
                                        TransformMode::Detect => {}
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
                                            let closure_vars =
                                                ClosureVariableCollector::collect_from_arrow_expr(
                                                    &cloned_arrow,
                                                    &self.module_imports,
                                                    &self.declared_identifiers,
                                                );

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

                                            // Keep the original arrow with the directive stripped,
                                            // so that direct (non-workflow) calls work with normal closure semantics.
                                            // The hoisted copy (with __private_getClosureVars) is registered separately.
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
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
                                            let closure_vars =
                                                ClosureVariableCollector::collect_from_arrow_expr(
                                                    &arrow_expr,
                                                    &self.module_imports,
                                                    &self.declared_identifiers,
                                                );
                                            *init = Box::new(self.create_step_proxy_reference(
                                                &step_id,
                                                &closure_vars,
                                            ));
                                        }
                                        TransformMode::Client => {
                                            // In client mode for nested step functions, just remove directive
                                            // WITHOUT registering - the function will be undefined since it's
                                            // locally scoped within another function
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                        }
                                        TransformMode::Detect => {}
                                    }
                                } else {
                                    // At module level - handle normally
                                    match self.mode {
                                        TransformMode::Step => {
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                            self.create_registration_call(&name, arrow_expr.span);
                                        }
                                        TransformMode::Client => {
                                            self.remove_use_step_directive_arrow(
                                                &mut arrow_expr.body,
                                            );
                                            self.step_functions_needing_id
                                                .push((name.clone(), arrow_expr.span));
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
                                        TransformMode::Detect => {}
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
                                        TransformMode::Detect => {}
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
                        Expr::Class(_) => {
                            // Track the binding name for class expressions like:
                            // var Bash = class _Bash {}
                            // The binding name (Bash) is what's accessible at module scope,
                            // not the internal class name (_Bash)
                            // We set the binding name here; it will be used when visit_mut_class_expr
                            // is called during visit_mut_children_with below
                            self.current_class_binding_name = Some(name.clone());
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
                        let has_workflow =
                            self.has_use_workflow_directive(&method_prop.function.body);

                        if has_workflow && !method_prop.function.is_async {
                            emit_error(WorkflowErrorKind::NonAsyncFunction {
                                span: method_prop.function.span,
                                directive: "use workflow",
                            });
                        }
                    }
                    // Note: Prop::Getter validation is handled in process_object_properties_for_step_functions
                    // to avoid emitting duplicate errors when the visitor recurses into the same node.
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

        // Check if class has custom serialization methods (WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE)
        if self.has_custom_serialization_methods(&class_decl.class) {
            self.classes_needing_serialization
                .insert(class_name.clone());
        }

        // Visit the class body (this populates static_step_methods_to_strip)
        class_decl.class.visit_mut_with(self);

        // In workflow mode, remove static and instance step methods from the class body
        if matches!(self.mode, TransformMode::Workflow) {
            let static_methods_to_strip: Vec<_> = self
                .static_step_methods_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &class_name)
                .map(|(_, mn, _)| mn.clone())
                .collect();

            let instance_methods_to_strip: Vec<_> = self
                .instance_step_methods_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &class_name)
                .map(|(_, mn, _)| mn.clone())
                .collect();

            let instance_getters_to_strip: Vec<_> = self
                .instance_getter_steps_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &class_name)
                .map(|(_, gn, _)| gn.clone())
                .collect();

            let static_getters_to_strip: Vec<_> = self
                .static_getter_steps_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &class_name)
                .map(|(_, gn, _)| gn.clone())
                .collect();

            if !static_methods_to_strip.is_empty()
                || !instance_methods_to_strip.is_empty()
                || !instance_getters_to_strip.is_empty()
                || !static_getters_to_strip.is_empty()
            {
                class_decl.class.body.retain(|member| {
                    if let ClassMember::Method(method) = member {
                        // Handle both identifier and string keys for method names
                        let method_name = match &method.key {
                            PropName::Ident(ident) => Some(ident.sym.to_string()),
                            PropName::Str(s) => Some(s.value.to_string_lossy().to_string()),
                            _ => None,
                        };

                        if let Some(method_name) = method_name {
                            // Check getters separately (they have MethodKind::Getter)
                            if matches!(method.kind, MethodKind::Getter) {
                                if method.is_static {
                                    return !static_getters_to_strip.contains(&method_name);
                                } else {
                                    return !instance_getters_to_strip.contains(&method_name);
                                }
                            }
                            if method.is_static {
                                return !static_methods_to_strip.contains(&method_name);
                            } else {
                                return !instance_methods_to_strip.contains(&method_name);
                            }
                        }
                    }
                    true
                });

                // After stripping "use step" methods, eliminate private class
                // members (both JS native `#field`/`#method()` and TypeScript
                // `private field`/`private method()`) that are no longer
                // referenced by any remaining member.
                ClassMemberRefCollector::retain_referenced_private_members(
                    &mut class_decl.class.body,
                );
            }
        }

        // Restore previous class name
        self.current_class_name = old_class_name;
    }

    // Handle class expressions to track class name for static methods
    fn visit_mut_class_expr(&mut self, class_expr: &mut ClassExpr) {
        // Get the binding name set by visit_mut_var_decl (e.g., "Foo" from `var Foo = class { ... }`)
        let binding_name = self.current_class_binding_name.take();

        // Get the internal class expression name (e.g. `_Foo` from `class _Foo { ... }`)
        let expr_ident_name = class_expr
            .ident
            .as_ref()
            .map(|i| i.sym.to_string())
            .unwrap_or_else(|| "AnonymousClass".to_string());

        // Compute the tracked class name: prefer the binding name (e.g. `Foo`
        // from `var Foo = class _Foo {}`) over the internal class expression
        // name (`_Foo`). The internal name is only scoped inside the class body
        // and is not accessible at module level, so all generated code emitted
        // outside the class — method step registrations, class serialization
        // IIFEs, and method-stripping filters — must use the binding name.
        // Without this, generated code like
        // `registerStepFunction("...", _Foo.prototype["method"])` would
        // produce a ReferenceError at runtime.
        let tracked_class_name = binding_name
            .clone()
            .unwrap_or_else(|| expr_ident_name.clone());

        let old_class_name = self.current_class_name.take();
        self.current_class_name = Some(tracked_class_name.clone());

        // Check if class has custom serialization methods (WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE)
        let has_serde = self.has_custom_serialization_methods(&class_expr.class);
        if has_serde {
            self.classes_needing_serialization
                .insert(tracked_class_name.clone());
        }

        // esbuild emits anonymous class expressions for classes that don't
        // self-reference (e.g. `var Foo = class { ... }`). Downstream bundlers
        // (like Nitro's Rollup bundler) rely on the class expression name for
        // serialization class registration. Without a name, the class `.name`
        // property is empty and lookups can fail at runtime. Re-insert the
        // binding name so the output becomes `var Foo = class Foo { ... }` —
        // behaviorally equivalent for typical class usage and preserves the
        // identifier through subsequent bundling passes.
        if has_serde && class_expr.ident.is_none() {
            if let Some(ref name) = binding_name {
                class_expr.ident = Some(Ident::new(
                    name.clone().into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ));
            }
        }

        // Visit the class body (this populates static_step_methods_to_strip)
        class_expr.class.visit_mut_with(self);

        // In workflow mode, remove static and instance step methods from the class body
        if matches!(self.mode, TransformMode::Workflow) {
            let static_methods_to_strip: Vec<_> = self
                .static_step_methods_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &tracked_class_name)
                .map(|(_, mn, _)| mn.clone())
                .collect();

            let instance_methods_to_strip: Vec<_> = self
                .instance_step_methods_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &tracked_class_name)
                .map(|(_, mn, _)| mn.clone())
                .collect();

            let instance_getters_to_strip: Vec<_> = self
                .instance_getter_steps_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &tracked_class_name)
                .map(|(_, gn, _)| gn.clone())
                .collect();

            let static_getters_to_strip: Vec<_> = self
                .static_getter_steps_to_strip
                .iter()
                .filter(|(cn, _, _)| cn == &tracked_class_name)
                .map(|(_, gn, _)| gn.clone())
                .collect();

            if !static_methods_to_strip.is_empty()
                || !instance_methods_to_strip.is_empty()
                || !instance_getters_to_strip.is_empty()
                || !static_getters_to_strip.is_empty()
            {
                class_expr.class.body.retain(|member| {
                    if let ClassMember::Method(method) = member {
                        if let PropName::Ident(ident) = &method.key {
                            let method_name = ident.sym.to_string();
                            if matches!(method.kind, MethodKind::Getter) {
                                if method.is_static {
                                    return !static_getters_to_strip.contains(&method_name);
                                } else {
                                    return !instance_getters_to_strip.contains(&method_name);
                                }
                            }
                            if method.is_static {
                                return !static_methods_to_strip.contains(&method_name);
                            } else {
                                return !instance_methods_to_strip.contains(&method_name);
                            }
                        }
                    }
                    true
                });

                // Dead-code-eliminate unreferenced private members
                ClassMemberRefCollector::retain_referenced_private_members(
                    &mut class_expr.class.body,
                );
            }
        }

        // Restore previous class name
        self.current_class_name = old_class_name;
    }

    // Handle class methods
    fn visit_mut_class_method(&mut self, method: &mut ClassMethod) {
        // Handle getter methods (separate from regular methods since getters can't be async)
        if matches!(method.kind, MethodKind::Getter) {
            let has_step = self.has_use_step_directive(&method.function.body);
            let has_workflow = self.has_use_workflow_directive(&method.function.body);

            if has_workflow {
                HANDLER.with(|handler| {
                    handler
                        .struct_span_err(
                            method.span,
                            "Getters cannot be marked with \"use workflow\". Only static methods, functions, and object methods are supported.",
                        )
                        .emit()
                });
            } else if has_step {
                // Getters don't need async validation (they can't be async syntactically,
                // but the step runtime handles them as async)

                // Get getter name
                let getter_name = match &method.key {
                    PropName::Ident(ident) => ident.sym.to_string(),
                    PropName::Str(s) => s.value.to_string_lossy().to_string(),
                    _ => {
                        // Complex key - skip
                        method.visit_mut_children_with(self);
                        return;
                    }
                };

                // Get class name
                let class_name = match &self.current_class_name {
                    Some(name) => name.clone(),
                    None => {
                        method.visit_mut_children_with(self);
                        return;
                    }
                };

                // Use . separator for static, # for instance (same as regular methods)
                let separator = if method.is_static { "." } else { "#" };
                let full_name = format!("{}{}{}", class_name, separator, getter_name);
                let hoisted_parent_name = format!("{}${}", class_name, getter_name);

                self.step_function_names.insert(full_name.clone());
                if !method.is_static {
                    self.classes_needing_serialization
                        .insert(class_name.clone());
                }

                let step_id = self.create_id(Some(&full_name), method.function.span, false);

                match self.mode {
                    TransformMode::Step => {
                        self.remove_use_step_directive(&mut method.function.body);

                        // Track for registration after class
                        // (will use Object.getOwnPropertyDescriptor on prototype or class)
                        if method.is_static {
                            self.static_getter_step_registrations.push((
                                class_name.clone(),
                                getter_name.clone(),
                                step_id,
                                method.function.span,
                            ));
                        } else {
                            self.instance_getter_step_registrations.push((
                                class_name.clone(),
                                getter_name.clone(),
                                step_id,
                                method.function.span,
                            ));
                        }

                        let old_parent = self.current_parent_function_name.clone();
                        self.current_parent_function_name = Some(hoisted_parent_name);
                        method.visit_mut_children_with(self);
                        self.current_parent_function_name = old_parent;
                    }
                    TransformMode::Workflow => {
                        self.remove_use_step_directive(&mut method.function.body);

                        // Track to be stripped and replaced with Object.defineProperty
                        if method.is_static {
                            self.static_getter_steps_to_strip.push((
                                class_name.clone(),
                                getter_name.clone(),
                                step_id,
                            ));
                        } else {
                            self.instance_getter_steps_to_strip.push((
                                class_name.clone(),
                                getter_name.clone(),
                                step_id,
                            ));
                        }
                    }
                    TransformMode::Client => {
                        self.remove_use_step_directive(&mut method.function.body);

                        let old_parent = self.current_parent_function_name.clone();
                        self.current_parent_function_name = Some(hoisted_parent_name);
                        method.visit_mut_children_with(self);
                        self.current_parent_function_name = old_parent;
                    }
                    TransformMode::Detect => {}
                }
            } else {
                method.visit_mut_children_with(self);
            }
            return;
        }

        if !method.is_static {
            // Instance methods can have "use step" (but not "use workflow")
            let has_step = self.has_use_step_directive(&method.function.body);
            let has_workflow = self.has_use_workflow_directive(&method.function.body);

            if has_workflow {
                // Workflows on instance methods don't make sense (workflows are entry points)
                HANDLER.with(|handler| {
                    handler
                        .struct_span_err(
                            method.span,
                            "Instance methods cannot be marked with \"use workflow\". Only static methods, functions, and object methods are supported.",
                        )
                        .emit()
                });
            } else if has_step {
                // Instance methods with "use step" are supported

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

                // Generate full qualified name using # for instance methods: ClassName#methodName
                let full_name = format!("{}#{}", class_name, method_name);

                // For nested step hoisting, use $ instead of # to produce valid JS identifiers
                let hoisted_parent_name = format!("{}${}", class_name, method_name);

                self.step_function_names.insert(full_name.clone());

                // Track class for serialization (needed for `this` serialization)
                self.classes_needing_serialization
                    .insert(class_name.clone());

                // Generate step ID
                let step_id = self.create_id(Some(&full_name), method.function.span, false);

                match self.mode {
                    TransformMode::Step => {
                        // Remove directive
                        self.remove_use_step_directive(&mut method.function.body);

                        // Track for registration after class (will use prototype)
                        self.instance_method_step_registrations.push((
                            class_name.clone(),
                            method_name.clone(),
                            step_id,
                            method.function.span,
                        ));

                        // Set current_parent_function_name for nested step hoisting
                        // This prevents self-referential aliases like `const helper = helper;`
                        // Use $ instead of # to produce valid JS identifiers
                        let old_parent = self.current_parent_function_name.clone();
                        self.current_parent_function_name = Some(hoisted_parent_name.clone());

                        // Visit children to process nested step functions
                        method.visit_mut_children_with(self);

                        // Restore parent function name
                        self.current_parent_function_name = old_parent;
                    }
                    TransformMode::Workflow => {
                        // Remove directive for consistency with other modes
                        self.remove_use_step_directive(&mut method.function.body);

                        // Track this method to be stripped from the class and assigned as a property
                        self.instance_step_methods_to_strip.push((
                            class_name.clone(),
                            method_name.clone(),
                            step_id,
                        ));
                        // Note: No need to visit children in Workflow mode since the method body
                        // will be stripped and replaced with a proxy call
                    }
                    TransformMode::Client => {
                        // Just remove directive, keep the function body
                        self.remove_use_step_directive(&mut method.function.body);

                        // Set current_parent_function_name for nested step hoisting
                        // Use $ instead of # to produce valid JS identifiers
                        let old_parent = self.current_parent_function_name.clone();
                        self.current_parent_function_name = Some(hoisted_parent_name.clone());

                        // Visit children to process nested step functions
                        method.visit_mut_children_with(self);

                        // Restore parent function name
                        self.current_parent_function_name = old_parent;
                    }
                    TransformMode::Detect => {}
                }
            } else {
                method.visit_mut_children_with(self);
            }
        } else {
            // Static methods can be step/workflow functions
            let has_step = self.has_use_step_directive(&method.function.body);
            let has_workflow = self.has_use_workflow_directive(&method.function.body);

            if has_step || has_workflow {
                // Validate async only for workflow functions (step functions may be sync)
                if has_workflow && !method.function.is_async {
                    emit_error(WorkflowErrorKind::NonAsyncFunction {
                        span: method.function.span,
                        directive: "use workflow",
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

                            // Visit children to process nested step functions
                            method.visit_mut_children_with(self);
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
                            // Note: No need to visit children in Workflow mode since the method body
                            // will be stripped and replaced with a proxy call
                        }
                        TransformMode::Client => {
                            // Just remove directive, keep the function body
                            self.remove_use_step_directive(&mut method.function.body);

                            // Visit children to process nested step functions
                            method.visit_mut_children_with(self);
                        }
                        TransformMode::Detect => {}
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

                            // Visit children to process nested step functions
                            method.visit_mut_children_with(self);
                        }
                        TransformMode::Step | TransformMode::Client => {
                            // Remove directive and replace body with error
                            // No need to visit children since the body is replaced
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
                        TransformMode::Detect => {}
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
                    if !self.in_module_level {
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
                                    &self.declared_identifiers,
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

                                // Keep the original function with the directive stripped,
                                // so that direct (non-workflow) calls work with normal closure semantics.
                                // The hoisted copy (with __private_getClosureVars) is registered separately.
                                self.remove_use_step_directive(&mut fn_expr.function.body);
                                return; // Don't visit children since we already processed
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
                                    &self.declared_identifiers,
                                );
                                *expr = self.create_step_proxy_reference(&step_id, &closure_vars);
                                return; // Don't visit children since we replaced the expr
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and keep the function
                                self.remove_use_step_directive(&mut fn_expr.function.body);
                            }
                            TransformMode::Detect => {}
                        }
                    }
                }
            }
            Expr::Arrow(arrow_expr) => {
                if self.has_step_directive_arrow(arrow_expr, false) {
                    if !self.in_module_level {
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
                                        &self.declared_identifiers,
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

                                // Keep the original arrow with the directive stripped,
                                // so that direct (non-workflow) calls work with normal closure semantics.
                                // The hoisted copy (with __private_getClosureVars) is registered separately.
                                self.remove_use_step_directive_arrow(&mut arrow_expr.body);
                                return; // Don't visit children since we already processed
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
                                        &self.declared_identifiers,
                                    );
                                *expr = self.create_step_proxy_reference(&step_id, &closure_vars);
                                return; // Don't visit children since we replaced the expr
                            }
                            TransformMode::Client => {
                                // In client mode, just remove the directive and keep the function
                                self.remove_use_step_directive_arrow(&mut arrow_expr.body);
                            }
                            TransformMode::Detect => {}
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
                        TransformMode::Detect => {}
                    }
                } else if self.should_transform_function(&fn_expr.function, true) {
                    self.step_function_names.insert(fn_name.clone());

                    match self.mode {
                        TransformMode::Step => {
                            self.remove_use_step_directive(&mut fn_expr.function.body);
                            self.create_registration_call(&fn_name, fn_expr.function.span);
                        }
                        TransformMode::Client => {
                            self.remove_use_step_directive(&mut fn_expr.function.body);
                            self.step_functions_needing_id
                                .push((fn_name.clone(), fn_expr.function.span));
                        }
                        TransformMode::Workflow => {
                            // Replace function body with step proxy
                            self.remove_use_step_directive(&mut fn_expr.function.body);
                            if let Some(body) = &mut fn_expr.function.body {
                                let step_id =
                                    self.create_id(Some(&fn_name), fn_expr.function.span, false);
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
                                                spread: if is_rest { Some(DUMMY_SP) } else { None },
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
                        TransformMode::Detect => {}
                    }
                }

                decl.visit_mut_children_with(self);
            }
            DefaultDecl::Class(class_expr) => {
                // Handle `export default class { ... }` and `export default class Foo { ... }`
                // When the class has serde methods or step methods, we need a binding name
                // accessible at module scope for registration code. Named class exports
                // already have their ident in scope; for anonymous class exports, generate
                // a unique name and defer rewriting to visit_mut_module_items.
                let needs_rewrite = class_expr.ident.is_none()
                    && self.class_needs_binding_rewrite(&class_expr.class);

                // Set the binding name before visiting children.
                // Save const_name for use after visiting (current_class_binding_name
                // will be consumed by visit_mut_class_expr).
                let saved_const_name = if needs_rewrite {
                    let const_name = self.generate_unique_name("__DefaultClass");
                    self.current_class_binding_name = Some(const_name.clone());
                    Some(const_name)
                } else {
                    if let Some(ident) = &class_expr.ident {
                        self.current_class_binding_name = Some(ident.sym.to_string());
                    }
                    None
                };

                // Visit the class body so serde/step transforms run
                decl.visit_mut_children_with(self);

                // After visiting, defer the rewrite for anonymous classes
                if let Some(const_name) = saved_const_name {
                    if let DefaultDecl::Class(class_expr) = &decl.decl {
                        self.default_class_exports
                            .push((const_name, class_expr.clone()));
                    }
                }
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
                        TransformMode::Detect => {}
                    }
                } else if self.should_transform_function(&fn_expr.function, true) {
                    // Handle step functions
                    self.step_function_names.insert("default".to_string());
                    // Similar logic for steps...
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
                            TransformMode::Detect => {}
                        }
                    }
                } else if self.has_step_directive_arrow(arrow_expr, true) {
                    // Handle step arrow functions
                    self.step_function_names.insert("default".to_string());
                    // Similar logic for steps...
                }
            }
            // Note: `export default (class { ... })` with parentheses is parsed by SWC
            // as Expr::Paren(ParenExpr { expr: Class(...) }), NOT as Expr::Class directly.
            // The declaration form `export default class { ... }` is handled in
            // visit_mut_export_default_decl above. The parenthesized expression form is
            // rare enough that we don't handle it here.
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
                                            // Generate a unique name
                                            let generated_name = format!(
                                                "_anonymousStep{}",
                                                self.anonymous_fn_counter
                                            );
                                            self.anonymous_fn_counter += 1;
                                            self.step_function_names.insert(generated_name.clone());

                                            match self.mode {
                                                TransformMode::Step => {
                                                    // Hoist to module scope
                                                    let mut cloned_arrow = arrow_expr.clone();
                                                    self.remove_use_step_directive_arrow(
                                                        &mut cloned_arrow.body,
                                                    );

                                                    // Collect closure variables
                                                    let closure_vars = ClosureVariableCollector::collect_from_arrow_expr(&cloned_arrow, &self.module_imports, &self.declared_identifiers);

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
                                                                        ctxt: SyntaxContext::empty(
                                                                        ),
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
                                                        generated_name.clone(),
                                                        fn_expr,
                                                        arrow_expr.span,
                                                        closure_vars,
                                                        true, // Was an arrow function
                                                        self.current_workflow_function_name
                                                            .clone()
                                                            .unwrap_or_default(),
                                                    ));

                                                    // Keep the original arrow with the directive stripped
                                                    self.remove_use_step_directive_arrow(
                                                        &mut arrow_expr.body,
                                                    );
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
                                                    let closure_vars = ClosureVariableCollector::collect_from_arrow_expr(&arrow_expr, &self.module_imports, &self.declared_identifiers);
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
                                                TransformMode::Detect => {}
                                            }
                                        }
                                    }
                                    Expr::Fn(fn_expr) => {
                                        if self.has_step_directive(&fn_expr.function, false) {
                                            // Generate a unique name
                                            let generated_name = format!(
                                                "_anonymousStep{}",
                                                self.anonymous_fn_counter
                                            );
                                            self.anonymous_fn_counter += 1;
                                            self.step_function_names.insert(generated_name.clone());

                                            match self.mode {
                                                TransformMode::Step => {
                                                    // Hoist to module scope
                                                    let mut cloned_fn = fn_expr.clone();
                                                    self.remove_use_step_directive(
                                                        &mut cloned_fn.function.body,
                                                    );

                                                    // Collect closure variables
                                                    let closure_vars = ClosureVariableCollector::collect_from_function(&*cloned_fn.function, &self.module_imports, &self.declared_identifiers);

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

                                                    // Keep the original function with the directive stripped
                                                    self.remove_use_step_directive(
                                                        &mut fn_expr.function.body,
                                                    );
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
                                                    let closure_vars = ClosureVariableCollector::collect_from_function(&fn_expr.function, &self.module_imports, &self.declared_identifiers);
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
                                                TransformMode::Detect => {}
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
                                    // Generate a unique name
                                    let generated_name =
                                        format!("_anonymousStep{}", self.anonymous_fn_counter);
                                    self.anonymous_fn_counter += 1;
                                    self.step_function_names.insert(generated_name.clone());

                                    match self.mode {
                                        TransformMode::Step => {
                                            // Convert method to function and hoist
                                            let mut cloned_function = method_prop.function.clone();
                                            self.remove_use_step_directive(
                                                &mut cloned_function.body,
                                            );

                                            // Collect closure variables
                                            let closure_vars =
                                                ClosureVariableCollector::collect_from_function(
                                                    &cloned_function,
                                                    &self.module_imports,
                                                    &self.declared_identifiers,
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

                                            // Keep the original method with the directive stripped
                                            self.remove_use_step_directive(
                                                &mut method_prop.function.body,
                                            );
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
                                                    &self.declared_identifiers,
                                                );

                                            // Replace method with property pointing to proxy
                                            *boxed_prop = Box::new(Prop::KeyValue(KeyValueProp {
                                                key: method_prop.key.clone(),
                                                value: Box::new(self.create_step_proxy_reference(
                                                    &step_id,
                                                    &closure_vars,
                                                )),
                                            }));
                                        }
                                        TransformMode::Client => {
                                            // Just remove directive
                                            self.remove_use_step_directive(
                                                &mut method_prop.function.body,
                                            );
                                        }
                                        TransformMode::Detect => {}
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
