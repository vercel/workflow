import * as Attr from '../telemetry/semantic-conventions.js';
import { getActiveSpan } from '../telemetry.js';
import type { CompressionStats } from './compression.js';
import type { GuestCodeStats } from './hardened.js';

/** Record compression details on the active serialization or replay span. */
export async function recordCompression(
  stats: CompressionStats,
  operation: 'serialize' | 'deserialize'
): Promise<void> {
  if (!stats.recorded) return;
  try {
    const span = await getActiveSpan();
    if (!span) return;
    const uncompressedBytes = stats.uncompressedBytes ?? 0;
    const storedBytes = stats.storedBytes ?? 0;
    span.setAttributes({
      ...Attr.SerializationOperation(operation),
      ...Attr.SerializationCompressed(stats.compressed ?? false),
      ...Attr.SerializationCodec(stats.codec ?? 'none'),
      ...Attr.SerializationUncompressedBytes(uncompressedBytes),
      ...Attr.SerializationStoredBytes(storedBytes),
      ...(stats.compressed && uncompressedBytes > 0
        ? Attr.SerializationCompressionRatio(
            1 - storedBytes / uncompressedBytes
          )
        : {}),
    });
  } catch {
    // Telemetry must never break serialization.
  }
}

/** Record workflow code that hardened serialization could not avoid running. */
export async function recordGuestCodeExecutions(
  stats: GuestCodeStats
): Promise<void> {
  if (stats.executions.length === 0) return;
  try {
    const span = await getActiveSpan();
    if (!span) return;
    const details = [
      ...new Set(
        stats.executions.map((execution) =>
          execution.detail
            ? `${execution.kind} (${execution.detail})`
            : execution.kind
        )
      ),
    ];
    span.setAttributes({
      ...Attr.SerializationGuestCodeExecutions(stats.executions.length),
      ...Attr.SerializationGuestCodeDetails(details),
    });
  } catch {
    // Telemetry must never break serialization.
  }
}
