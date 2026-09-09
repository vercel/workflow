use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use pyo3::IntoPyObjectExt;
use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;
use pyo3::types::{
    PyBool, PyByteArray, PyByteArrayMethods, PyBytes, PyBytesMethods, PyDict, PyDictMethods,
    PyFloat, PyInt, PyList, PyListMethods, PyString,
};
use serde_json::{Value, json};
use workflow_protocol::{
    ContextValue, CreateEventResult, MAX_SAFE_CONTEXT_INTEGER, MIN_SAFE_CONTEXT_INTEGER,
    RunCreatedEventData, RunStartedRequest, StoredEvent, WorkflowRun, WorldError, WorldSnapshot,
};
use workflow_world_sqlite::{SqliteWorld, sqlite_library_version};

const ERROR_MARKER: &str = "WORKFLOW_NATIVE_ERROR:";
const MAX_CONTEXT_DEPTH: usize = 128;

create_exception!(_native, NativeWorkflowError, PyException);

#[pyclass(module = "workflow_python_native_probe._native")]
struct NativeSqliteWorld {
    path: PathBuf,
    closed: Arc<AtomicBool>,
}

#[pyclass(module = "workflow_python_native_probe._native")]
#[derive(Default)]
struct NativeTypeTagSentinel;

#[pymethods]
impl NativeTypeTagSentinel {
    #[new]
    const fn new() -> Self {
        Self
    }
}

#[pymethods]
impl NativeSqliteWorld {
    #[new]
    fn new(path: String) -> Self {
        Self {
            path: PathBuf::from(path),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    fn migrate(&self, py: Python<'_>) -> PyResult<()> {
        self.ensure_open()?;
        let path = self.path.clone();
        py.detach(move || compute_safely(|| SqliteWorld::new(path).migrate()))
    }

    #[allow(clippy::too_many_arguments)]
    fn create_resilient_run_started(
        &self,
        py: Python<'_>,
        run_id: String,
        spec_version: u32,
        deployment_id: String,
        workflow_name: String,
        input: Vec<u8>,
        execution_context: Option<Bound<'_, PyAny>>,
        attributes_json: Option<String>,
        allow_reserved_attributes: bool,
        encryption_public_key: Option<String>,
    ) -> PyResult<String> {
        self.ensure_open()?;
        let execution_context = execution_context
            .as_ref()
            .map(context_from_python)
            .transpose()
            .map_err(|error| {
                native_error(
                    "invalid_request",
                    format!("executionContext is not portable: {error}"),
                )
            })?;
        let attributes = attributes_json
            .as_deref()
            .map(serde_json::from_str::<BTreeMap<String, String>>)
            .transpose()
            .map_err(|_| native_error("invalid_request", "attributes are not valid JSON"))?;
        let path = self.path.clone();
        let request = RunStartedRequest {
            run_id,
            spec_version,
            event_data: RunCreatedEventData {
                deployment_id,
                workflow_name,
                input,
                execution_context,
                attributes,
                allow_reserved_attributes,
                encryption_public_key,
            },
        };
        py.detach(move || {
            compute_safely(|| {
                let world = SqliteWorld::new(path);
                let result = world.create_resilient_run_started(&request)?;
                let snapshot = world.snapshot(&request.run_id)?;
                project_operation(&world, &result, &snapshot)
            })
        })
    }

    fn snapshot_contract(&self, py: Python<'_>, run_id: String) -> PyResult<String> {
        self.ensure_open()?;
        let path = self.path.clone();
        py.detach(move || {
            compute_safely(|| {
                let snapshot = SqliteWorld::new(path).snapshot(&run_id)?;
                serde_json::to_string(&json!({
                    "run": project_run(&snapshot.run),
                    "events": snapshot.events.iter().map(project_event).collect::<Vec<_>>(),
                }))
                .map_err(|error| WorldError::persisted_data(error.to_string()))
            })
        })
    }

    fn close(&self) -> bool {
        !self.closed.swap(true, Ordering::AcqRel)
    }
}

impl NativeSqliteWorld {
    fn ensure_open(&self) -> PyResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(native_error("closed", "SQLite World handle is closed"));
        }
        Ok(())
    }
}

#[pyfunction]
fn native_info() -> String {
    json!({
        "adapterProtocolVersion": 1,
        "crateVersion": env!("CARGO_PKG_VERSION"),
        "pythonAbi": "abi3-py39",
        "sqliteVersion": sqlite_library_version(),
    })
    .to_string()
}

#[pyfunction]
fn round_trip_context(py: Python<'_>, value: &Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    let context = context_from_python(value).map_err(|error| {
        native_error(
            "invalid_request",
            format!("executionContext is not portable: {error}"),
        )
    })?;
    context_to_python(py, &context)
}

#[pyfunction]
fn native_delay_probe(py: Python<'_>, milliseconds: u64) -> PyResult<()> {
    py.detach(move || {
        compute_safely(|| {
            std::thread::sleep(Duration::from_millis(milliseconds));
            Ok(())
        })
    })
}

#[pyfunction]
fn native_panic_probe(py: Python<'_>) -> PyResult<()> {
    py.detach(|| compute_safely(|| panic!("intentional native task panic probe")))
}

fn project_operation(
    world: &SqliteWorld,
    result: &CreateEventResult,
    snapshot: &WorldSnapshot,
) -> Result<String, WorldError> {
    let event = result.event.as_ref().map(project_event);
    let preload = result.preload.as_ref().ok_or_else(|| {
        WorldError::persisted_data("resilient start did not return its requested preload")
    })?;
    let cursor = preload
        .cursor
        .as_deref()
        .ok_or_else(|| WorldError::persisted_data("resilient start returned no cursor"))?;
    let continuation_count = world
        .list_events_after_cursor(&result.run.run_id, cursor, 100)?
        .events
        .len();

    serde_json::to_string(&json!({
        "run": project_run(&result.run),
        "result": {
            "event": event,
            "preloadedSlots": preload.events.iter().map(|event| event.slot).collect::<Vec<_>>(),
            "preloadedEvents": preload.events.iter().map(project_event).collect::<Vec<_>>(),
            "cursorPresent": preload.cursor.is_some(),
            "continuationCount": continuation_count,
            "hasMore": preload.has_more,
        },
        "events": snapshot.events.iter().map(project_event).collect::<Vec<_>>(),
    }))
    .map_err(|error| WorldError::persisted_data(error.to_string()))
}

fn project_run(run: &WorkflowRun) -> Value {
    json!({
        "runId": run.run_id,
        "status": run.status,
        "deploymentId": run.deployment_id,
        "workflowName": run.workflow_name,
        "specVersion": run.spec_version,
        "input": { "$bytes": STANDARD.encode(&run.input) },
        "executionContext": run.execution_context,
        "attributes": run.attributes,
        "encryptionPublicKey": run.encryption_public_key,
        "startedAtPresent": run.started_at_ms.is_some(),
    })
}

fn project_event(event: &StoredEvent) -> Value {
    let mut projection = json!({
        "slot": event.slot,
        "eventType": event.event_type,
        "specVersion": event.spec_version,
        "eventDataPresent": event.event_data.is_some(),
    });
    if let Some(data) = &event.event_data {
        let mut event_data = json!({
            "deploymentId": data.deployment_id,
            "workflowName": data.workflow_name,
            "input": { "$bytes": STANDARD.encode(&data.input) },
        });
        if let Some(execution_context) = &data.execution_context {
            event_data["executionContext"] =
                serde_json::to_value(execution_context).expect("context value serializes");
        }
        if let Some(attributes) = &data.attributes {
            event_data["attributes"] = json!(attributes);
        }
        if data.allow_reserved_attributes {
            event_data["allowReservedAttributes"] = json!(true);
        }
        if let Some(encryption_public_key) = &data.encryption_public_key {
            event_data["encryptionPublicKey"] = json!(encryption_public_key);
        }
        projection["eventData"] = event_data;
    }
    projection
}

fn context_from_python(value: &Bound<'_, PyAny>) -> PyResult<ContextValue> {
    context_from_python_at_depth(value, &mut Vec::new(), 0)
}

fn context_from_python_at_depth(
    value: &Bound<'_, PyAny>,
    stack: &mut Vec<*mut pyo3::ffi::PyObject>,
    depth: usize,
) -> PyResult<ContextValue> {
    if depth > MAX_CONTEXT_DEPTH {
        return Err(context_conversion_error(format!(
            "nesting exceeds {MAX_CONTEXT_DEPTH} levels"
        )));
    }
    if value.is_none() {
        return Ok(ContextValue::Null);
    }
    if value.is_exact_instance_of::<PyBool>() {
        return value.extract().map(ContextValue::Bool);
    }
    if value.is_exact_instance_of::<PyInt>() {
        let integer = value
            .extract::<i64>()
            .map_err(|_| context_conversion_error("integer exceeds the interoperable range"))?;
        if !(MIN_SAFE_CONTEXT_INTEGER..=MAX_SAFE_CONTEXT_INTEGER).contains(&integer) {
            return Err(context_conversion_error(
                "integer exceeds JavaScript's safe integer range",
            ));
        }
        return Ok(ContextValue::Integer(integer));
    }
    if value.is_exact_instance_of::<PyFloat>() {
        let number = value.extract::<f64>()?;
        if !number.is_finite() {
            return Err(context_conversion_error(
                "floating-point values must be finite",
            ));
        }
        return Ok(ContextValue::Float(number));
    }
    if value.is_exact_instance_of::<PyString>() {
        return value.extract().map(ContextValue::String);
    }
    if value.is_exact_instance_of::<PyBytes>() {
        return Ok(ContextValue::Bytes(
            value.cast::<PyBytes>()?.as_bytes().to_vec(),
        ));
    }
    if value.is_exact_instance_of::<PyByteArray>() {
        let byte_array = value.cast::<PyByteArray>()?;
        // SAFETY: the slice is copied immediately without invoking Python.
        return Ok(ContextValue::Bytes(
            unsafe { byte_array.as_bytes() }.to_vec(),
        ));
    }
    if value.is_exact_instance_of::<PyList>() {
        return with_python_container(value, stack, |stack| {
            let list = value.cast::<PyList>()?;
            let mut values = Vec::with_capacity(list.len());
            for item in list.iter() {
                values.push(context_from_python_at_depth(&item, stack, depth + 1)?);
            }
            Ok(ContextValue::Array(values))
        });
    }
    if value.is_exact_instance_of::<PyDict>() {
        return with_python_container(value, stack, |stack| {
            let dictionary = value.cast::<PyDict>()?;
            let mut values = BTreeMap::new();
            for (key, item) in dictionary.iter() {
                if !key.is_exact_instance_of::<PyString>() {
                    return Err(context_conversion_error("dictionary keys must be strings"));
                }
                values.insert(
                    key.extract::<String>()?,
                    context_from_python_at_depth(&item, stack, depth + 1)?,
                );
            }
            Ok(ContextValue::Object(values))
        });
    }
    Err(context_conversion_error(
        "only None, bool, safe int, finite float, str, bytes, bytearray, list, and dict are supported",
    ))
}

fn with_python_container<T>(
    value: &Bound<'_, PyAny>,
    stack: &mut Vec<*mut pyo3::ffi::PyObject>,
    operation: impl FnOnce(&mut Vec<*mut pyo3::ffi::PyObject>) -> PyResult<T>,
) -> PyResult<T> {
    let identity = value.as_ptr();
    if stack.contains(&identity) {
        return Err(context_conversion_error(
            "cyclic references are not supported",
        ));
    }
    stack.push(identity);
    let result = operation(stack);
    stack.pop();
    result
}

fn context_to_python(py: Python<'_>, value: &ContextValue) -> PyResult<Py<PyAny>> {
    match value {
        ContextValue::Null => Ok(py.None()),
        ContextValue::Bool(value) => value.into_py_any(py),
        ContextValue::Integer(value) => value.into_py_any(py),
        ContextValue::Float(value) => value.into_py_any(py),
        ContextValue::String(value) => value.into_py_any(py),
        ContextValue::Bytes(value) => Ok(PyBytes::new(py, value).into_any().unbind()),
        ContextValue::Array(values) => {
            let values = values
                .iter()
                .map(|value| context_to_python(py, value))
                .collect::<PyResult<Vec<_>>>()?;
            Ok(PyList::new(py, values)?.into_any().unbind())
        }
        ContextValue::Object(values) => {
            let dictionary = PyDict::new(py);
            for (key, value) in values {
                dictionary.set_item(key, context_to_python(py, value)?)?;
            }
            Ok(dictionary.into_any().unbind())
        }
    }
}

fn context_conversion_error(message: impl Into<String>) -> PyErr {
    pyo3::exceptions::PyValueError::new_err(message.into())
}

fn native_error(kind: &str, message: impl Into<String>) -> PyErr {
    native_error_envelope(kind, message, false, json!({}))
}

fn native_error_envelope(
    kind: &str,
    message: impl Into<String>,
    retryable: bool,
    details: Value,
) -> PyErr {
    let envelope = json!({
        "code": kind,
        "kind": kind,
        "message": message.into(),
        "retryable": retryable,
        "details": details,
    });
    NativeWorkflowError::new_err(format!("{ERROR_MARKER}{envelope}"))
}

fn compute_safely<T>(operation: impl FnOnce() -> Result<T, WorldError>) -> PyResult<T> {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(world_error(error)),
        Err(payload) => {
            let message = if let Some(message) = payload.downcast_ref::<&str>() {
                (*message).to_owned()
            } else if let Some(message) = payload.downcast_ref::<String>() {
                message.clone()
            } else {
                "Rust task panicked with a non-string payload".to_owned()
            };
            std::mem::forget(payload);
            Err(native_error("panic", message))
        }
    }
}

fn world_error(error: WorldError) -> PyErr {
    let kind = serde_json::to_value(error.kind())
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    native_error_envelope(
        &kind,
        error.message(),
        error.retryable(),
        error.details().clone(),
    )
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<NativeSqliteWorld>()?;
    module.add_class::<NativeTypeTagSentinel>()?;
    module.add_function(wrap_pyfunction!(native_info, module)?)?;
    module.add_function(wrap_pyfunction!(round_trip_context, module)?)?;
    module.add_function(wrap_pyfunction!(native_delay_probe, module)?)?;
    module.add_function(wrap_pyfunction!(native_panic_probe, module)?)?;
    module.add(
        "NativeWorkflowError",
        module.py().get_type::<NativeWorkflowError>(),
    )?;
    Ok(())
}
