$version: "2"

namespace vercel.workflow.world

/// Logical queue name, e.g. a flow or step topic.
string QueueName

/// Queue message identifier.
///
/// Should be stable across redeliveries of one enqueued message: the
/// runtime's inline step ownership uses it as a liveness lease. An
/// implementation that mints a fresh ID per delivery still works, but owner
/// redeliveries fall back to the slower backstop path.
string MessageId

/// W3C trace context propagated through the queue.
map TraceCarrier {
    key: String
    value: String
}

map QueueHeaders {
    key: String
    value: String
}

/// Opaque queue payload.
///
/// The runtime's invoke and health-check payload schemas are deliberately not
/// modeled yet: they are producer-and-consumer-private, versioned by run spec
/// version, and encoded as CBOR or JSON depending on that version. Modeling
/// them belongs in a follow-up once the transport story is settled.
blob QueuePayload

structure EnqueueOptions {
    /// Target a specific deployment rather than the current one.
    deploymentId: DeploymentId

    idempotencyKey: String

    headers: QueueHeaders

    /// Delay delivery by this many seconds.
    delaySeconds: Integer

    /// Spec version of the target run, which selects the transport format.
    specVersion: Integer

    /// Routing hint naming the region the message should be sent to.
    region: String
}

/// Returns the deployment this World writes as.
@readonly
operation GetDeploymentId {
    input := {}

    output := {
        @required
        deploymentId: DeploymentId
    }

    errors: [
        ThrottledError
        InternalError
    ]
}

/// Enqueues one message. Delivery is at-least-once.
operation Enqueue {
    input := {
        @required
        queueName: QueueName

        @required
        message: QueuePayload

        options: EnqueueOptions
    }

    output := {
        /// Assigned message ID, when the queue reports one.
        messageId: MessageId
    }

    errors: [
        BadRequestError
        ThrottledError
        InternalError
    ]
}

/// Instructs the caller to redeliver the message later.
structure RetryDirective {
    @required
    timeoutSeconds: Integer
}

/// Delivers one queued message to the workflow runtime.
///
/// This is the reverse direction: a queue adapter calls the runtime. Today's
/// `createQueueHandler` becomes a thin per-language adapter that exposes this
/// operation over whatever the platform hands it, rather than an operation in
/// its own right.
@callback
operation DeliverQueueMessage {
    input := {
        @required
        queueName: QueueName

        @required
        message: QueuePayload

        /// 1-based delivery attempt.
        @required
        attempt: Integer

        @required
        messageId: MessageId

        requestId: String
    }

    output := {
        /// Present when the runtime wants the message redelivered instead of
        /// acknowledged.
        retry: RetryDirective
    }

    errors: [
        BadRequestError
        InternalError
    ]
}
