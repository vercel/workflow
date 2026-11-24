//! The places where the swc_core API differs between the two builds of this
//! transform: `swc_workflow` (swc_core 49, for `@swc/core` 1.15) and
//! `swc_workflow_swc116` (the `swc-116` feature, for `@swc/core` 1.16 and later).
//! Everything else in `lib.rs` compiles against both unchanged.
//!
//! swc_core 77 gave function bodies their own node, `FunctionBody` (no syntax
//! context), in place of `BlockStmt`; renamed `BlockStmtOrExpr` to
//! `ArrowFunctionBody`, whose block variant is now `FunctionBody`; moved a
//! getter's and setter's body, parameter and annotations into a `Function`;
//! and added `Function::this_param`.
use swc_core::{
    common::{Span, SyntaxContext},
    ecma::{
        ast::*,
        visit::{Visit, VisitMut, VisitMutWith, VisitWith},
    },
};

/// The body of a function or a block-bodied arrow.
#[cfg(not(feature = "swc-116"))]
pub type FnBody = BlockStmt;
#[cfg(feature = "swc-116")]
pub type FnBody = FunctionBody;

/// An arrow function's body: a block or an expression.
#[cfg(not(feature = "swc-116"))]
pub type ArrowBody = BlockStmtOrExpr;
#[cfg(feature = "swc-116")]
pub type ArrowBody = ArrowFunctionBody;

/// A function body. `ctxt` is kept on the 1.15 build, whose `BlockStmt`
/// carries one; swc_core 77 moved it off function bodies.
#[cfg(not(feature = "swc-116"))]
pub fn fn_body(span: Span, ctxt: SyntaxContext, stmts: Vec<Stmt>) -> FnBody {
    BlockStmt { span, ctxt, stmts }
}
#[cfg(feature = "swc-116")]
pub fn fn_body(span: Span, _ctxt: SyntaxContext, stmts: Vec<Stmt>) -> FnBody {
    FunctionBody { span, stmts }
}

/// A getter's body, `get x() { <body> }`.
#[cfg(not(feature = "swc-116"))]
pub fn getter_body(getter: &GetterProp) -> &Option<FnBody> {
    &getter.body
}
#[cfg(feature = "swc-116")]
pub fn getter_body(getter: &GetterProp) -> &Option<FnBody> {
    &getter.function.body
}
#[cfg(not(feature = "swc-116"))]
pub fn getter_body_mut(getter: &mut GetterProp) -> &mut Option<FnBody> {
    &mut getter.body
}
#[cfg(feature = "swc-116")]
pub fn getter_body_mut(getter: &mut GetterProp) -> &mut Option<FnBody> {
    &mut getter.function.body
}

/// A setter's body, `set x(v) { <body> }`.
#[cfg(not(feature = "swc-116"))]
pub fn setter_body(setter: &SetterProp) -> &Option<FnBody> {
    &setter.body
}
#[cfg(feature = "swc-116")]
pub fn setter_body(setter: &SetterProp) -> &Option<FnBody> {
    &setter.function.body
}

/// A setter's parameter, `set x(<param>) {}`. swc_core 77 keeps it in the
/// setter's `Function::params`, which the parser always fills with one.
#[cfg(not(feature = "swc-116"))]
pub fn setter_param(setter: &SetterProp) -> Option<&Pat> {
    Some(&setter.param)
}
#[cfg(feature = "swc-116")]
pub fn setter_param(setter: &SetterProp) -> Option<&Pat> {
    setter.function.params.first().map(|param| &param.pat)
}

// swc_core 77 wraps an object-literal getter's and setter's parts in a
// `Function`, so its default traversal runs a visitor's function hooks on
// them, which swc_core 49's never did: a getter or setter is not a
// function boundary to the visitors here (`StepTransform` would leave the
// module level, `ClosureVariableNormalizer` would stop descending). Every
// visitor with a function hook walks getters and setters through these,
// which visit the same parts in the same order as swc_core 49.

#[cfg(not(feature = "swc-116"))]
pub fn visit_getter_children<V: Visit + ?Sized>(getter: &GetterProp, v: &mut V) {
    getter.visit_children_with(v);
}
#[cfg(feature = "swc-116")]
pub fn visit_getter_children<V: Visit + ?Sized>(getter: &GetterProp, v: &mut V) {
    getter.key.visit_with(v);
    getter.function.return_type.visit_with(v);
    getter.function.body.visit_with(v);
}

#[cfg(not(feature = "swc-116"))]
pub fn visit_setter_children<V: Visit + ?Sized>(setter: &SetterProp, v: &mut V) {
    setter.visit_children_with(v);
}
#[cfg(feature = "swc-116")]
pub fn visit_setter_children<V: Visit + ?Sized>(setter: &SetterProp, v: &mut V) {
    setter.key.visit_with(v);
    setter.function.this_param.visit_with(v);
    for param in &setter.function.params {
        param.pat.visit_with(v);
    }
    setter.function.body.visit_with(v);
}

#[cfg(not(feature = "swc-116"))]
pub fn visit_mut_getter_children<V: VisitMut + ?Sized>(getter: &mut GetterProp, v: &mut V) {
    getter.visit_mut_children_with(v);
}
#[cfg(feature = "swc-116")]
pub fn visit_mut_getter_children<V: VisitMut + ?Sized>(getter: &mut GetterProp, v: &mut V) {
    getter.key.visit_mut_with(v);
    getter.function.return_type.visit_mut_with(v);
    getter.function.body.visit_mut_with(v);
}

#[cfg(not(feature = "swc-116"))]
pub fn visit_mut_setter_children<V: VisitMut + ?Sized>(setter: &mut SetterProp, v: &mut V) {
    setter.visit_mut_children_with(v);
}
#[cfg(feature = "swc-116")]
pub fn visit_mut_setter_children<V: VisitMut + ?Sized>(setter: &mut SetterProp, v: &mut V) {
    setter.key.visit_mut_with(v);
    setter.function.this_param.visit_mut_with(v);
    for param in &mut setter.function.params {
        param.pat.visit_mut_with(v);
    }
    setter.function.body.visit_mut_with(v);
}

#[cfg(test)]
mod tests {
    use super::*;
    use swc_core::common::DUMMY_SP;

    fn ident_pat(name: &str) -> Pat {
        Pat::Ident(BindingIdent::from(Ident::new_no_ctxt(
            name.into(),
            DUMMY_SP,
        )))
    }

    #[cfg(not(feature = "swc-116"))]
    fn setter(param: Option<Pat>, body: Option<FnBody>) -> SetterProp {
        SetterProp {
            param: Box::new(param.unwrap_or_else(|| ident_pat("v"))),
            body,
            ..Default::default()
        }
    }
    #[cfg(feature = "swc-116")]
    fn setter(param: Option<Pat>, body: Option<FnBody>) -> SetterProp {
        SetterProp {
            function: Box::new(Function {
                params: param
                    .into_iter()
                    .map(|pat| Param {
                        span: DUMMY_SP,
                        decorators: vec![],
                        pat,
                    })
                    .collect(),
                body,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn setter_param_reads_the_parameter() {
        let setter = setter(Some(ident_pat("value")), None);
        let Some(Pat::Ident(param)) = setter_param(&setter) else {
            panic!("expected an identifier parameter");
        };
        assert_eq!(&*param.id.sym, "value");
    }

    /// swc_core 77 keeps the parameter in a list, which only a hand-built
    /// AST leaves empty; that must read as no parameter, not panic.
    #[cfg(feature = "swc-116")]
    #[test]
    fn setter_param_is_none_without_a_parameter() {
        assert!(setter_param(&setter(None, None)).is_none());
    }

    #[test]
    fn setter_and_getter_bodies_round_trip() {
        let body = fn_body(DUMMY_SP, SyntaxContext::empty(), vec![]);
        assert!(setter_body(&setter(None, Some(body.clone()))).is_some());
        let mut getter = GetterProp::default();
        assert!(getter_body(&getter).is_none());
        *getter_body_mut(&mut getter) = Some(body);
        assert!(getter_body(&getter).is_some());
    }
}

/// A statement list that is either a block or a function body.
pub trait Stmts {
    fn stmts(&self) -> &Vec<Stmt>;
}
impl Stmts for BlockStmt {
    fn stmts(&self) -> &Vec<Stmt> {
        &self.stmts
    }
}
#[cfg(feature = "swc-116")]
impl Stmts for FunctionBody {
    fn stmts(&self) -> &Vec<Stmt> {
        &self.stmts
    }
}
