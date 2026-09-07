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

/// Configuration for the Phase 1 loopback HTTP queue worker.
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

/// One background supervisor for an exact set of durable queue names.
///
/// This Phase 1 worker intentionally has concurrency one. It proves that
/// callback execution happens after a SQLite claim transaction commits and
/// that lifecycle ownership can live below a language binding. A bounded async
/// delivery pool remains a later performance/topology decision.
// @lat: [[rust-portability#SQLite Local World#Queue]]
pub struct QueueWorker {
    control: Arc<WorkerControl>,
    thread: Option<JoinHandle<Result<QueueWorkerReport, WorldError>>>,
}

impl QueueWorker {
    pub fn start(world: SqliteWorld, config: QueueWorkerConfig) -> Result<Self, WorldError> {
        let endpoint = LoopbackHttpEndpoint::parse(&config.flow_url)?;
        validate_config(&config)?;
        let control = Arc::new(WorkerControl::default());
        let worker_control = Arc::clone(&control);
        let thread = thread::Builder::new()
            .name(format!("workflow-queue-{}", config.worker_id))
            .spawn(move || run_worker(&world, &config, &endpoint, &worker_control))
            .map_err(|error| {
                WorldError::new(
                    WorldErrorKind::Storage,
                    format!("failed to start queue worker thread: {error}"),
                )
            })?;
        Ok(Self {
            control,
            thread: Some(thread),
        })
    }

    pub fn stop(mut self) -> Result<QueueWorkerReport, WorldError> {
        self.request_stop();
        let Some(thread) = self.thread.take() else {
            return Ok(QueueWorkerReport::default());
        };
        thread
            .join()
            .map_err(|_| WorldError::new(WorldErrorKind::Storage, "queue worker thread panicked"))?
    }

    fn request_stop(&self) {
        self.control.stopped.store(true, Ordering::Release);
        self.control.wake.notify_all();
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
        if !self.is_stopped() {
            let _ = self.wake.wait_timeout(guard, duration);
        }
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
    if config.request_timeout >= config.lease_duration {
        return Err(WorldError::invalid_request(
            "queue worker request timeout must be shorter than its lease",
        ));
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

        let outcome = endpoint.deliver(&claim, config.request_timeout);
        // A stop request prevents the next claim, but this lease is already
        // owned. Settle it before joining so a successful handler response is
        // not turned into a spurious redelivery during graceful shutdown.
        let completed_at_ms = now_ms()?;
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

    fn deliver(&self, claim: &QueueClaim, timeout: Duration) -> Result<DeliveryOutcome, String> {
        validate_header_value(&claim.queue_name)?;
        validate_header_value(&claim.message_id)?;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| "queue callback timeout is too large".to_owned())?;
        let mut stream = connect(&self.addresses, deadline)?;
        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nx-vqs-queue-name: {}\r\nx-vqs-message-id: {}\r\nx-vqs-message-attempt: {}\r\n\r\n",
            self.path_and_query,
            self.authority,
            claim.body.len(),
            claim.queue_name,
            claim.message_id,
            claim.attempt,
        );
        write_all_before_deadline(&mut stream, request.as_bytes(), deadline)?;
        write_all_before_deadline(&mut stream, &claim.body, deadline)?;
        stream
            .set_write_timeout(Some(remaining_before(deadline)?))
            .and_then(|()| stream.flush())
            .map_err(|error| error.to_string())?;

        let response = read_response(&mut stream, deadline)?;
        parse_response(&response)
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

fn read_response(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, String> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        stream
            .set_read_timeout(Some(remaining_before(deadline)?))
            .map_err(|error| error.to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(response),
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.len() > MAX_RESPONSE_BYTES {
                    return Err("queue callback response exceeded 64 KiB".to_owned());
                }
            }
            Err(error) => return Err(error.to_string()),
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
    use std::net::IpAddr;

    use super::*;

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
