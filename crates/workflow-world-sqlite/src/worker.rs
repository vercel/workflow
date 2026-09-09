use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;
use workflow_protocol::{QueueClaim, WorldError, WorldErrorKind};

use crate::{SqliteWorld, now_ms};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_DELAY_MS: u64 = 2_147_483_647;
const MAX_WORKER_CONCURRENCY: usize = 256;

/// Configuration for the loopback HTTP queue worker.
#[derive(Clone, Debug)]
pub struct QueueWorkerConfig {
    pub scope: String,
    pub queue_names: Vec<String>,
    pub flow_url: String,
    pub worker_id: String,
    pub lease_duration: Duration,
    pub poll_interval: Duration,
    pub retry_delay: Duration,
    pub request_timeout: Duration,
    /// Maximum number of messages delivered concurrently by this worker.
    pub concurrency: usize,
}

/// Delivery counters returned when a worker is stopped and joined.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct QueueWorkerReport {
    pub claims: u64,
    pub acknowledgements: u64,
    pub reschedules: u64,
    pub delivery_failures: u64,
    pub storage_failures: u64,
}

impl QueueWorkerReport {
    fn merge(&mut self, other: Self) {
        self.claims = self.claims.saturating_add(other.claims);
        self.acknowledgements = self.acknowledgements.saturating_add(other.acknowledgements);
        self.reschedules = self.reschedules.saturating_add(other.reschedules);
        self.delivery_failures = self
            .delivery_failures
            .saturating_add(other.delivery_failures);
        self.storage_failures = self.storage_failures.saturating_add(other.storage_failures);
    }
}

/// One background supervisor for an exact set of durable queue names.
// @lat: [[rust-portability#SQLite Local World#Queue]]
pub struct QueueWorker {
    control: Arc<WorkerControl>,
    threads: Vec<JoinHandle<Result<QueueWorkerReport, WorldError>>>,
}

impl QueueWorker {
    pub fn start(world: SqliteWorld, config: QueueWorkerConfig) -> Result<Self, WorldError> {
        let endpoint = LoopbackHttpEndpoint::parse(&config.flow_url)?;
        validate_config(&config)?;
        let control = Arc::new(WorkerControl::default());
        let mut threads = Vec::with_capacity(config.concurrency);
        for worker_index in 0..config.concurrency {
            let worker_world = world.clone();
            let worker_config = config.clone();
            let worker_endpoint = endpoint.clone();
            let worker_control = Arc::clone(&control);
            let thread_name = if config.concurrency == 1 {
                format!("workflow-queue-{}", config.worker_id)
            } else {
                format!("workflow-queue-{}-{worker_index}", config.worker_id)
            };
            match thread::Builder::new().name(thread_name).spawn(move || {
                run_worker(
                    &worker_world,
                    &worker_config,
                    &worker_endpoint,
                    &worker_control,
                )
            }) {
                Ok(thread) => threads.push(thread),
                Err(error) => {
                    control.stop();
                    for thread in threads {
                        let _ = thread.join();
                    }
                    return Err(WorldError::new(
                        WorldErrorKind::Storage,
                        format!("failed to start queue worker thread: {error}"),
                    ));
                }
            }
        }
        Ok(Self { control, threads })
    }

    pub fn stop(mut self) -> Result<QueueWorkerReport, WorldError> {
        self.request_stop();
        let mut aggregate = QueueWorkerReport::default();
        let mut first_error = None;
        for thread in self.threads.drain(..) {
            match thread.join() {
                Ok(Ok(report)) => aggregate.merge(report),
                Ok(Err(error)) => {
                    first_error.get_or_insert(error);
                }
                Err(_) => {
                    first_error.get_or_insert_with(|| {
                        WorldError::new(WorldErrorKind::Storage, "queue worker thread panicked")
                    });
                }
            }
        }
        first_error.map_or(Ok(aggregate), Err)
    }

    fn request_stop(&self) {
        self.control.stop();
    }
}

impl Drop for QueueWorker {
    fn drop(&mut self) {
        self.request_stop();
    }
}

#[derive(Default)]
struct WorkerControl {
    stopped: AtomicBool,
    wait_lock: Mutex<()>,
    wake: Condvar,
}

impl WorkerControl {
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn wait(&self, duration: Duration) {
        let guard = self
            .wait_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = self
            .wake
            .wait_timeout_while(guard, duration, |_| !self.is_stopped());
    }

    fn stop(&self) {
        let _guard = self
            .wait_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stopped.store(true, Ordering::Release);
        self.wake.notify_all();
    }
}

struct LeaseHeartbeat {
    control: Arc<WorkerControl>,
    thread: Option<JoinHandle<u64>>,
}

impl LeaseHeartbeat {
    fn start(
        world: SqliteWorld,
        lease_token: String,
        lease_duration: Duration,
    ) -> Result<Self, WorldError> {
        let control = Arc::new(WorkerControl::default());
        let heartbeat_control = Arc::clone(&control);
        let interval = (lease_duration / 3).max(Duration::from_nanos(1));
        let lease_duration_ms = duration_ms_i64(lease_duration, "lease duration")?;
        let thread = thread::Builder::new()
            .name("workflow-queue-lease".to_owned())
            .spawn(move || {
                let mut failures = 0_u64;
                loop {
                    heartbeat_control.wait(interval);
                    if heartbeat_control.is_stopped() {
                        return failures;
                    }
                    let result = now_ms().and_then(|now_ms| {
                        world
                            .renew_queue_message(&lease_token, now_ms, lease_duration_ms)
                            .map(|_| ())
                    });
                    if let Err(error) = result {
                        failures = failures.saturating_add(1);
                        if error.kind() == WorldErrorKind::QueueClaimLost {
                            return failures;
                        }
                    }
                }
            })
            .map_err(|error| {
                WorldError::new(
                    WorldErrorKind::Storage,
                    format!("failed to start queue lease heartbeat thread: {error}"),
                )
            })?;
        Ok(Self {
            control,
            thread: Some(thread),
        })
    }

    fn stop(mut self) -> Result<u64, WorldError> {
        self.request_stop();
        let Some(thread) = self.thread.take() else {
            return Ok(0);
        };
        thread.join().map_err(|_| {
            WorldError::new(
                WorldErrorKind::Storage,
                "queue lease heartbeat thread panicked",
            )
        })
    }

    fn request_stop(&self) {
        self.control.stop();
    }
}

impl Drop for LeaseHeartbeat {
    fn drop(&mut self) {
        self.request_stop();
    }
}

fn validate_config(config: &QueueWorkerConfig) -> Result<(), WorldError> {
    if config.scope.is_empty()
        || config.queue_names.is_empty()
        || config.queue_names.iter().any(String::is_empty)
        || config.worker_id.is_empty()
    {
        return Err(WorldError::invalid_request(
            "queue worker scope, queue names, and worker ID must not be empty",
        ));
    }
    if config.lease_duration.is_zero()
        || config.poll_interval.is_zero()
        || config.request_timeout.is_zero()
    {
        return Err(WorldError::invalid_request(
            "queue worker lease, poll, and request timeouts must be greater than zero",
        ));
    }
    if !(1..=MAX_WORKER_CONCURRENCY).contains(&config.concurrency) {
        return Err(WorldError::invalid_request(format!(
            "queue worker concurrency must be between 1 and {MAX_WORKER_CONCURRENCY}"
        )));
    }
    Ok(())
}

fn run_worker(
    world: &SqliteWorld,
    config: &QueueWorkerConfig,
    endpoint: &LoopbackHttpEndpoint,
    control: &WorkerControl,
) -> Result<QueueWorkerReport, WorldError> {
    let mut report = QueueWorkerReport::default();
    let mut next_queue = 0_usize;
    while !control.is_stopped() {
        let claimed_at_ms = now_ms()?;
        let lease_duration_ms = duration_ms_i64(config.lease_duration, "lease duration")?;
        let mut claim = None;
        let mut storage_failed = false;
        for offset in 0..config.queue_names.len() {
            let queue_index = (next_queue + offset) % config.queue_names.len();
            match world.claim_queue_message(
                &config.scope,
                &config.queue_names[queue_index],
                &config.worker_id,
                claimed_at_ms,
                lease_duration_ms,
            ) {
                Ok(Some(candidate)) => {
                    claim = Some(candidate);
                    next_queue = (queue_index + 1) % config.queue_names.len();
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    report.storage_failures += 1;
                    storage_failed = true;
                    break;
                }
            }
        }
        if storage_failed {
            control.wait(config.poll_interval);
            continue;
        }
        let Some(claim) = claim else {
            control.wait(config.poll_interval);
            continue;
        };
        report.claims += 1;

        let heartbeat = LeaseHeartbeat::start(
            world.clone(),
            claim.lease_token.clone(),
            config.lease_duration,
        )?;
        let outcome = endpoint.deliver(&claim, config.request_timeout);
        match heartbeat.stop() {
            Ok(failures) => {
                report.storage_failures = report.storage_failures.saturating_add(failures);
            }
            Err(_) => report.storage_failures = report.storage_failures.saturating_add(1),
        }
        // A stop request prevents the next claim, but this lease is already
        // owned. Settle it before joining so a successful handler response is
        // not turned into a spurious redelivery during graceful shutdown.
        let completed_at_ms = now_ms()?;
        let response_received = outcome
            .as_ref()
            .map_or_else(|failure| failure.response_received, |_| true);
        if response_received
            && world
                .record_queue_delivery_response(
                    &claim.lease_token,
                    claim.delivery_attempt,
                    completed_at_ms,
                )
                .is_err()
        {
            // Do not settle a response whose attempt could not be persisted.
            // The lease will expire and retry the same handler-visible attempt.
            report.storage_failures = report.storage_failures.saturating_add(1);
            continue;
        }
        let result = match outcome {
            Ok(DeliveryOutcome::Acknowledge) => world
                .acknowledge_queue_message(&claim.lease_token, completed_at_ms)
                .map(|_| report.acknowledgements += 1),
            Ok(DeliveryOutcome::Reschedule(delay)) => {
                let delay_ms = duration_ms_i64(delay, "callback delay")?;
                let available_at_ms = completed_at_ms.checked_add(delay_ms).ok_or_else(|| {
                    WorldError::invalid_request("callback delay exceeds the timestamp range")
                })?;
                world
                    .reschedule_queue_message(&claim.lease_token, completed_at_ms, available_at_ms)
                    .map(|_| report.reschedules += 1)
            }
            Err(_) => {
                report.delivery_failures += 1;
                let retry_delay_ms = duration_ms_i64(config.retry_delay, "retry delay")?;
                let available_at_ms =
                    completed_at_ms.checked_add(retry_delay_ms).ok_or_else(|| {
                        WorldError::invalid_request("retry delay exceeds the timestamp range")
                    })?;
                world
                    .reschedule_queue_message(&claim.lease_token, completed_at_ms, available_at_ms)
                    .map(|_| report.reschedules += 1)
            }
        };
        if result.is_err() {
            report.storage_failures += 1;
        }
    }
    Ok(report)
}

fn duration_ms_i64(duration: Duration, label: &str) -> Result<i64, WorldError> {
    i64::try_from(duration.as_millis())
        .map_err(|_| WorldError::invalid_request(format!("queue worker {label} is too large")))
}

enum DeliveryOutcome {
    Acknowledge,
    Reschedule(Duration),
}

struct DeliveryFailure {
    response_received: bool,
}

impl DeliveryFailure {
    const fn before_response() -> Self {
        Self {
            response_received: false,
        }
    }
}

#[derive(Clone, Debug)]
struct LoopbackHttpEndpoint {
    authority: String,
    addresses: Vec<SocketAddr>,
    path_and_query: String,
}

impl LoopbackHttpEndpoint {
    fn parse(url: &str) -> Result<Self, WorldError> {
        if url
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
        {
            return Err(WorldError::invalid_request("invalid queue worker flow URL"));
        }
        let remainder = url.strip_prefix("http://").ok_or_else(|| {
            WorldError::invalid_request(
                "queue worker prototype requires an explicit http:// loopback flow URL",
            )
        })?;
        let (authority, path) = remainder
            .split_once('/')
            .map_or((remainder, "/"), |(authority, _)| {
                (authority, &remainder[authority.len()..])
            });
        if authority.is_empty() || authority.contains('@') || url.contains('#') {
            return Err(WorldError::invalid_request("invalid queue worker flow URL"));
        }
        let socket_authority = socket_authority(authority)?;
        let addresses = socket_authority
            .to_socket_addrs()
            .map_err(|error| {
                WorldError::invalid_request(format!(
                    "could not resolve queue worker flow URL: {error}"
                ))
            })?
            .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|address| !address.ip().is_loopback()) {
            return Err(WorldError::invalid_request(
                "queue worker prototype only delivers to loopback addresses",
            ));
        }
        Ok(Self {
            authority: authority.to_owned(),
            addresses,
            path_and_query: path.to_owned(),
        })
    }

    fn deliver(
        &self,
        claim: &QueueClaim,
        timeout: Duration,
    ) -> Result<DeliveryOutcome, DeliveryFailure> {
        validate_header_value(&claim.queue_name).map_err(|_| DeliveryFailure::before_response())?;
        validate_header_value(&claim.message_id).map_err(|_| DeliveryFailure::before_response())?;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(DeliveryFailure::before_response)?;
        let mut stream =
            connect(&self.addresses, deadline).map_err(|_| DeliveryFailure::before_response())?;
        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nx-vqs-queue-name: {}\r\nx-vqs-message-id: {}\r\nx-vqs-message-attempt: {}\r\n\r\n",
            self.path_and_query,
            self.authority,
            claim.body.len(),
            claim.queue_name,
            claim.message_id,
            claim.delivery_attempt,
        );
        write_all_before_deadline(&mut stream, request.as_bytes(), deadline)
            .map_err(|_| DeliveryFailure::before_response())?;
        write_all_before_deadline(&mut stream, &claim.body, deadline)
            .map_err(|_| DeliveryFailure::before_response())?;
        stream
            .set_write_timeout(Some(
                remaining_before(deadline).map_err(|_| DeliveryFailure::before_response())?,
            ))
            .and_then(|()| stream.flush())
            .map_err(|_| DeliveryFailure::before_response())?;

        let response = read_response(&mut stream, deadline)?;
        parse_response(&response).map_err(|_| DeliveryFailure {
            response_received: response_headers_received(&response),
        })
    }
}

fn socket_authority(authority: &str) -> Result<String, WorldError> {
    if authority.starts_with('[') {
        let closing_bracket = authority.find(']').ok_or_else(|| {
            WorldError::invalid_request("invalid bracketed IPv6 queue worker flow URL")
        })?;
        let suffix = &authority[closing_bracket + 1..];
        return match suffix {
            "" => Ok(format!("{authority}:80")),
            value if value.starts_with(':') && value.len() > 1 => Ok(authority.to_owned()),
            _ => Err(WorldError::invalid_request(
                "invalid bracketed IPv6 queue worker flow URL",
            )),
        };
    }
    if authority.matches(':').count() > 1 {
        return Err(WorldError::invalid_request(
            "IPv6 queue worker flow URLs must use brackets",
        ));
    }
    Ok(if authority.contains(':') {
        authority.to_owned()
    } else {
        format!("{authority}:80")
    })
}

fn validate_header_value(value: &str) -> Result<(), String> {
    if value
        .chars()
        .any(|character| character == '\r' || character == '\n')
    {
        return Err("queue callback metadata contains an invalid header value".to_owned());
    }
    Ok(())
}

fn remaining_before(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("queue callback request timed out".to_owned());
    }
    Ok(remaining)
}

fn write_all_before_deadline(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    while !bytes.is_empty() {
        stream
            .set_write_timeout(Some(remaining_before(deadline)?))
            .map_err(|error| error.to_string())?;
        match stream.write(bytes) {
            Ok(0) => return Err("queue callback connection closed while writing".to_owned()),
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn response_headers_received(response: &[u8]) -> bool {
    response.windows(4).any(|window| window == b"\r\n\r\n")
}

fn read_response(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, DeliveryFailure> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        stream
            .set_read_timeout(Some(remaining_before(deadline).map_err(|_| {
                DeliveryFailure {
                    response_received: response_headers_received(&response),
                }
            })?))
            .map_err(|_| DeliveryFailure {
                response_received: response_headers_received(&response),
            })?;
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(response),
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.len() > MAX_RESPONSE_BYTES {
                    return Err(DeliveryFailure {
                        response_received: response_headers_received(&response),
                    });
                }
            }
            Err(_) => {
                return Err(DeliveryFailure {
                    response_received: response_headers_received(&response),
                });
            }
        }
    }
}

fn connect(addresses: &[SocketAddr], deadline: Instant) -> Result<TcpStream, String> {
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(address, remaining_before(deadline)?) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.map_or_else(
        || "queue callback URL resolved to no addresses".to_owned(),
        |error| error.to_string(),
    ))
}

fn parse_response(response: &[u8]) -> Result<DeliveryOutcome, String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "queue callback returned malformed HTTP headers".to_owned())?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| "queue callback returned non-UTF-8 HTTP headers".to_owned())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "queue callback returned a malformed status line".to_owned())?;
    if !(200..300).contains(&status) {
        return Err(format!("queue callback returned HTTP {status}"));
    }
    let raw_body = &response[header_end + 4..];
    let body = if headers.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
        })
    }) {
        decode_chunked_body(raw_body)?
    } else {
        raw_body.to_vec()
    };
    if body.is_empty() {
        return Ok(DeliveryOutcome::Acknowledge);
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(DeliveryOutcome::Acknowledge),
    };
    let Some(seconds) = parsed.get("timeoutSeconds").and_then(Value::as_f64) else {
        return Ok(DeliveryOutcome::Acknowledge);
    };
    if !seconds.is_finite() || seconds < 0.0 {
        return Ok(DeliveryOutcome::Acknowledge);
    }
    let millis = (seconds * 1000.0).ceil().min(MAX_DELAY_MS as f64) as u64;
    Ok(DeliveryOutcome::Reschedule(Duration::from_millis(millis)))
}

fn decode_chunked_body(mut encoded: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    loop {
        let line_end = encoded
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "queue callback returned malformed chunk framing".to_owned())?;
        let size_text = std::str::from_utf8(&encoded[..line_end])
            .map_err(|_| "queue callback returned a non-UTF-8 chunk size".to_owned())?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or_default(), 16)
            .map_err(|_| "queue callback returned an invalid chunk size".to_owned())?;
        encoded = &encoded[line_end + 2..];
        if size == 0 {
            return Ok(decoded);
        }
        if size > encoded.len() || encoded.get(size..size + 2) != Some(b"\r\n") {
            return Err("queue callback returned a truncated HTTP chunk".to_owned());
        }
        decoded.extend_from_slice(&encoded[..size]);
        if decoded.len() > MAX_RESPONSE_BYTES {
            return Err("queue callback response exceeded 64 KiB".to_owned());
        }
        encoded = &encoded[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, TcpListener};
    use std::sync::mpsc;

    use tempfile::tempdir;
    use workflow_protocol::QueueMessageRequest;

    use super::*;

    fn worker_config(flow_url: String, concurrency: usize) -> QueueWorkerConfig {
        QueueWorkerConfig {
            scope: "local-js".to_owned(),
            queue_names: vec!["__wkf_workflow_test".to_owned()],
            flow_url,
            worker_id: "test-worker".to_owned(),
            lease_duration: Duration::from_millis(600),
            poll_interval: Duration::from_millis(5),
            retry_delay: Duration::from_millis(10),
            request_timeout: Duration::from_secs(3),
            concurrency,
        }
    }

    fn enqueue(world: &SqliteWorld, message_id: &str) {
        world
            .enqueue_queue_message(&QueueMessageRequest {
                message_id: message_id.to_owned(),
                scope: "local-js".to_owned(),
                queue_name: "__wkf_workflow_test".to_owned(),
                idempotency_key: format!("idempotency-{message_id}"),
                body: br#"{"runId":"wrun_test"}"#.to_vec(),
                available_at_ms: 0,
            })
            .expect("queue message should be enqueued");
    }

    fn read_request(stream: &mut TcpStream) -> u32 {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("test server timeout should be configured");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        let (header_end, content_length, delivery_attempt) = loop {
            let read = stream
                .read(&mut buffer)
                .expect("request should be readable");
            assert!(read > 0, "request ended before its headers");
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..header_end])
                    .expect("request headers should be UTF-8");
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                    })
                    .expect("request should carry content-length");
                let delivery_attempt = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            name.eq_ignore_ascii_case("x-vqs-message-attempt")
                                .then(|| value.trim().parse::<u32>().ok())
                                .flatten()
                        })
                    })
                    .expect("request should carry a delivery attempt");
                break (header_end + 4, content_length, delivery_attempt);
            }
        };
        while request.len() < header_end + content_length {
            let read = stream.read(&mut buffer).expect("body should be readable");
            assert!(read > 0, "request ended before its body");
            request.extend_from_slice(&buffer[..read]);
        }
        delivery_attempt
    }

    fn accept_before(listener: &TcpListener, deadline: Instant) -> TcpStream {
        listener
            .set_nonblocking(true)
            .expect("test server should become nonblocking");
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    panic!("request did not reach the test server before its deadline");
                }
                Err(error) => panic!("test server could not accept a request: {error}"),
            }
        }
    }

    fn acknowledge(stream: &mut TcpStream) {
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .expect("test response should be writable");
    }

    #[test]
    fn validates_bounded_worker_concurrency() {
        assert!(validate_config(&worker_config("http://127.0.0.1:1/flow".to_owned(), 1,)).is_ok());
        assert!(
            validate_config(&worker_config(
                "http://127.0.0.1:1/flow".to_owned(),
                MAX_WORKER_CONCURRENCY,
            ))
            .is_ok()
        );
        assert!(validate_config(&worker_config("http://127.0.0.1:1/flow".to_owned(), 0,)).is_err());
        assert!(
            validate_config(&worker_config(
                "http://127.0.0.1:1/flow".to_owned(),
                MAX_WORKER_CONCURRENCY + 1,
            ))
            .is_err()
        );
    }

    #[test]
    fn delivers_up_to_the_configured_concurrency_and_aggregates_reports() {
        let directory = tempdir().expect("temporary directory should be created");
        let world = SqliteWorld::new(directory.path().join("world.sqlite"));
        world.migrate().expect("migration should succeed");
        enqueue(&world, "msg_concurrent_1");
        enqueue(&world, "msg_concurrent_2");

        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener.local_addr().expect("test server address");
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            // Hold the first response until a second connection arrives. A
            // single delivery loop cannot satisfy this rendezvous.
            let mut first = accept_before(&listener, deadline);
            let mut second = accept_before(&listener, deadline);
            read_request(&mut first);
            read_request(&mut second);
            acknowledge(&mut first);
            acknowledge(&mut second);
        });

        let worker = QueueWorker::start(
            world.clone(),
            worker_config(format!("http://{address}/flow"), 2),
        )
        .expect("worker should start");
        let server_result = server.join();
        let report = worker.stop().expect("worker should stop cleanly");

        server_result.expect("both concurrent deliveries should reach the server");
        assert_eq!(
            report,
            QueueWorkerReport {
                claims: 2,
                acknowledgements: 2,
                ..QueueWorkerReport::default()
            }
        );
        assert_eq!(
            world
                .queue_message_count("local-js")
                .expect("queue count should be readable"),
            0
        );
    }

    #[test]
    fn transport_failures_do_not_advance_the_handler_delivery_attempt() {
        let directory = tempdir().expect("temporary directory should be created");
        let world = SqliteWorld::new(directory.path().join("world.sqlite"));
        world.migrate().expect("migration should succeed");
        enqueue(&world, "msg_transport_attempt");

        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener.local_addr().expect("test server address");
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut attempts = Vec::new();
            for delivery in 0..4 {
                let mut stream = accept_before(&listener, deadline);
                attempts.push(read_request(&mut stream));
                if delivery == 3 {
                    acknowledge(&mut stream);
                }
                // Dropping the first three sockets before response headers
                // simulates connect/write/read transport failures after the
                // request reached the server process but not the handler.
            }
            attempts
        });

        let worker = QueueWorker::start(
            world.clone(),
            worker_config(format!("http://{address}/flow"), 1),
        )
        .expect("worker should start");
        let attempts = server.join().expect("test server should complete");
        let report = worker.stop().expect("worker should stop cleanly");

        assert_eq!(attempts, [1, 1, 1, 1]);
        assert_eq!(report.claims, 4);
        assert_eq!(report.delivery_failures, 3);
        assert_eq!(report.acknowledgements, 1);
        assert_eq!(
            world
                .queue_message_count("local-js")
                .expect("queue count should be readable"),
            0
        );
    }

    #[test]
    fn renews_a_lease_while_a_delivery_is_in_flight() {
        let directory = tempdir().expect("temporary directory should be created");
        let world = SqliteWorld::new(directory.path().join("world.sqlite"));
        world.migrate().expect("migration should succeed");
        enqueue(&world, "msg_slow_delivery");

        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener.local_addr().expect("test server address");
        let (accepted_tx, accepted_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut stream = accept_before(&listener, Instant::now() + Duration::from_secs(2));
            read_request(&mut stream);
            accepted_tx
                .send(())
                .expect("test should observe the accepted request");
            release_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("test should release the response");
            acknowledge(&mut stream);
        });

        let config = worker_config(format!("http://{address}/flow"), 1);
        let worker =
            QueueWorker::start(world.clone(), config.clone()).expect("worker should start");
        accepted_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("delivery should reach the test server");
        thread::sleep(Duration::from_millis(900));

        let competing_claim = world
            .claim_queue_message(
                "local-js",
                "__wkf_workflow_test",
                "competing-worker",
                now_ms().expect("current time should be available"),
                duration_ms_i64(config.lease_duration, "lease duration")
                    .expect("lease duration should fit"),
            )
            .expect("competing claim should be readable");
        release_tx
            .send(())
            .expect("slow response should be released");
        let report = worker.stop().expect("worker should stop cleanly");
        let server_result = server.join();

        server_result.expect("slow delivery server should complete");
        assert!(
            competing_claim.is_none(),
            "the heartbeat must retain ownership beyond the original lease"
        );
        assert_eq!(
            report,
            QueueWorkerReport {
                claims: 1,
                acknowledgements: 1,
                ..QueueWorkerReport::default()
            }
        );
        assert_eq!(
            world
                .queue_message_count("local-js")
                .expect("queue count should be readable"),
            0
        );
    }

    #[test]
    fn rejects_non_loopback_and_https_urls() {
        assert!(LoopbackHttpEndpoint::parse("https://127.0.0.1/flow").is_err());
        assert!(LoopbackHttpEndpoint::parse("http://192.0.2.1/flow").is_err());
    }

    #[test]
    fn parses_callback_outcomes() {
        assert!(matches!(
            parse_response(b"HTTP/1.1 204 No Content\r\n\r\n"),
            Ok(DeliveryOutcome::Acknowledge)
        ));
        assert!(matches!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nContent-Length: 23\r\n\r\n{\"timeoutSeconds\":0.01}"
            ),
            Ok(DeliveryOutcome::Reschedule(delay)) if delay == Duration::from_millis(10)
        ));
        assert!(parse_response(b"HTTP/1.1 500 Nope\r\n\r\n").is_err());
        assert!(matches!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n18\r\n{\"timeoutSeconds\":0.025}\r\n0\r\n\r\n"
            ),
            Ok(DeliveryOutcome::Reschedule(delay)) if delay == Duration::from_millis(25)
        ));
    }

    #[test]
    fn only_resolves_loopback_addresses() {
        let endpoint =
            LoopbackHttpEndpoint::parse("http://localhost:12345/flow?x=1").expect("loopback URL");
        assert!(endpoint.addresses.iter().all(|address| matches!(
            address.ip(),
            IpAddr::V4(_) | IpAddr::V6(_)
        ) && address.ip().is_loopback()));
        assert_eq!(endpoint.path_and_query, "/flow?x=1");
    }

    #[test]
    fn supplies_the_default_port_for_bracketed_ipv6() {
        let endpoint = LoopbackHttpEndpoint::parse("http://[::1]/flow").expect("IPv6 loopback URL");
        assert!(
            endpoint
                .addresses
                .iter()
                .all(|address| address.ip().is_loopback() && address.port() == 80)
        );
        assert_eq!(endpoint.authority, "[::1]");
    }

    #[test]
    fn rejects_an_expired_request_deadline() {
        assert!(remaining_before(Instant::now()).is_err());
    }
}
