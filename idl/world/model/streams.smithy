$version: "2"

namespace vercel.workflow.world

/// An unbounded byte stream.
@streaming
blob ByteStream

/// One chunk of a stream, with its 0-based position.
structure StreamChunk {
    @required
    index: Integer

    @required
    data: Blob
}

list StreamChunkList {
    member: StreamChunk
}

list ChunkDataList {
    member: Blob
}

list StreamNameList {
    member: StreamName
}

/// Appends one chunk to a stream.
operation WriteStreamChunk {
    input := {
        @required
        runId: RunId

        @required
        name: StreamName

        @required
        chunk: Blob
    }

    output := {}

    errors: [
        RunNotFoundError
        StreamExpiredError
        ConflictError
        ThrottledError
        InternalError
    ]
}

/// Appends several chunks in order, in one request.
///
/// An optional optimization. Callers fall back to repeated
/// `WriteStreamChunk` calls when an implementation does not provide it.
@optionalCapability(name: "writeStreamChunks")
operation WriteStreamChunks {
    input := {
        @required
        runId: RunId

        @required
        name: StreamName

        /// Chunks to append, in order.
        @required
        chunks: ChunkDataList
    }

    output := {}

    errors: [
        RunNotFoundError
        StreamExpiredError
        ConflictError
        ThrottledError
        InternalError
    ]
}

/// Closes a stream. No further chunks may be appended.
@idempotent
operation CloseStream {
    input := {
        @required
        runId: RunId

        @required
        name: StreamName
    }

    output := {}

    errors: [
        RunNotFoundError
        StreamNotFoundError
        StreamExpiredError
        ThrottledError
        InternalError
    ]
}

/// Reads a stream live, waiting for chunks until the stream closes.
///
/// A positive `startIndex` skips that many chunks from the start. A negative
/// one starts that many chunks before the current end, clamped to zero.
@readonly
operation ReadStream {
    input := {
        @required
        runId: RunId

        @required
        name: StreamName

        startIndex: Integer
    }

    output := {
        @required
        body: ByteStream
    }

    errors: [
        RunNotFoundError
        StreamNotFoundError
        StreamExpiredError
        ThrottledError
        InternalError
    ]
}

/// Lists the stream names belonging to a run.
@readonly
operation ListStreams {
    input := {
        @required
        runId: RunId
    }

    output := {
        @required
        names: StreamNameList
    }

    errors: [
        RunNotFoundError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Reads a point-in-time page of already-written chunks.
///
/// Unlike `ReadStream`, this never waits. `done` reports whether the stream
/// is closed: `done: false` with `hasMore: false` means nothing is available
/// right now, but more chunks may still arrive.
@readonly
@paginated(inputToken: "cursor", outputToken: "cursor", pageSize: "limit", items: "chunks")
operation ListStreamChunks {
    input := {
        @required
        runId: RunId

        @required
        name: StreamName

        @range(min: 1, max: 1000)
        limit: Integer

        cursor: Cursor
    }

    output := {
        @required
        chunks: StreamChunkList

        cursor: Cursor

        /// Whether more already-written chunks remain.
        @required
        hasMore: Boolean

        /// Whether the stream is closed.
        @required
        done: Boolean
    }

    errors: [
        RunNotFoundError
        StreamNotFoundError
        StreamExpiredError
        BadRequestError
        ThrottledError
        InternalError
    ]
}

/// Reads lightweight stream metadata.
///
/// Useful for resolving a negative `startIndex` into an absolute position
/// before opening a live read.
@readonly
operation GetStreamInfo {
    input := {
        @required
        runId: RunId

        @required
        name: StreamName
    }

    output := {
        /// Index of the last known chunk, or -1 when the stream is empty.
        @required
        tailIndex: Integer

        /// Whether the stream is closed.
        @required
        done: Boolean
    }

    errors: [
        RunNotFoundError
        StreamNotFoundError
        StreamExpiredError
        ThrottledError
        InternalError
    ]
}
