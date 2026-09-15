$version: "2"

namespace vercel.workflow.world

/// A ready-to-use AES-256 key.
@sensitive
@length(min: 32, max: 32)
blob EncryptionKey

/// World-specific display fields for one run, keyed by column name.
///
/// A null value means "applicable but undeterminable", which is distinct from
/// the key being absent.
@sparse
map RunDisplayFields {
    key: String
    value: String
}

/// Mints a new run ID.
///
/// Returns the bare ULID; the core attaches the `wrun_` prefix.
/// Implementations may embed world-specific metadata such as a region as long
/// as the result stays a valid ULID.
@localOnly
operation CreateRunId {
    input := {
        /// The full options bag passed to `start()`. Implementations read
        /// only the keys they recognize and ignore the rest.
        options: Document
    }

    output := {
        @required
        runId: RunId
    }
}

/// Returns the wall-clock time at which the current invocation will be
/// terminated by the hosting platform, when that is known.
@localOnly
@readonly
operation GetRuntimeDeadline {
    input := {}

    output := {
        deadline: Timestamp
    }
}

/// Returns the environment this World's writes are attributed to.
///
/// Must match the attribution the backend will actually apply. Callers use it
/// to detect cross-environment mismatches, so a plausible-looking wrong value
/// is worse than none.
@localOnly
@readonly
operation GetEnvironment {
    input := {}

    output := {
        environment: String
    }
}

/// Returns extra display fields for a run.
///
/// Called once per displayed run by tooling, so it must be cheap, pure, and
/// non-throwing.
@localOnly
@readonly
operation DescribeRun {
    input := {
        /// The run entity as the caller holds it, which may be a lean
        /// observability row rather than a full record.
        @required
        run: Document
    }

    output := {
        fields: RunDisplayFields
    }
}

/// Resolves the AES-256 key for a run.
///
/// Local only, permanently: key material must never cross a transport
/// boundary. It is modeled here so in-process implementations share one
/// contract across languages, and every transport projection is expected to
/// drop it. Absent support means encryption is disabled.
@localOnly
operation GetEncryptionKeyForRun {
    input := {
        @required
        runId: RunId

        /// Opaque world-specific context, such as a deployment ID, used when
        /// the run entity is not available locally.
        context: Document
    }

    output := {
        key: EncryptionKey
    }
}
