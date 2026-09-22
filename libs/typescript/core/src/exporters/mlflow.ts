import { Trace } from '../core/entities/trace';
import { ExportResult } from '@opentelemetry/core';
import {
  Span as OTelSpan,
  SpanProcessor,
  ReadableSpan as OTelReadableSpan,
  SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { Context } from '@opentelemetry/api';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { createAndRegisterMlflowSpan } from '../core/api';
import { getConfiguredTraceMetadata, getConfiguredTraceTags } from '../core/context';
import { InMemoryTraceManager } from '../core/trace_manager';
import { TraceInfo } from '../core/entities/trace_info';
import { createTraceLocationFromExperimentId } from '../core/entities/trace_location';
import { fromOtelStatus, TraceState } from '../core/entities/trace_state';
import {
  SpanAttributeKey,
  TRACE_ID_PREFIX,
  TRACE_SCHEMA_VERSION,
  TraceMetadataKey,
} from '../core/constants';
import { convertHrTimeToMs, aggregateUsageFromSpans } from '../core/utils';
import { getConfig } from '../core/config';
import { MlflowClient } from '../clients';
import { executeOnSpanEndHooks, executeOnSpanStartHooks } from './span_processor_hooks';
import { resolveEnvironmentMetadata } from '../core/utils/environment';

/**
 * Generate a MLflow-compatible trace ID for the given span.
 * @param span The span to generate the trace ID for
 */
function generateTraceId(span: OTelSpan): string {
  // NB: trace Id is already hex string in Typescript OpenTelemetry SDK
  return TRACE_ID_PREFIX + span.spanContext().traceId;
}

function decodeMlflowSpanAttributes(
  attributes: OTelReadableSpan['attributes'],
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' && value.startsWith('"')) {
      try {
        decoded[key] = JSON.parse(value);
      } catch {
        decoded[key] = value;
      }
    } else {
      decoded[key] = value;
    }
  }
  return decoded;
}

function spanWithDecodedAttributes(span: OTelReadableSpan): OTelReadableSpan {
  const decoded = decodeMlflowSpanAttributes(span.attributes);
  return new Proxy(span, {
    get(target, prop) {
      if (prop === 'attributes') {
        return decoded;
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
}

/**
 * Serialize all spans in a completed trace to OTLP protobuf so the OSS
 * tracking server persists them in SqlSpan. DB-backed trace metrics such as
 * Tool Calls and span latency are computed from SqlSpan rather than the JSON
 * trace artifact.
 */
function serializeSpansToOtlp(spans: OTelReadableSpan[]): Uint8Array | undefined {
  const serializable = spans.filter((s) => s?.resource != null && s?.instrumentationScope != null);
  if (serializable.length === 0) {
    return undefined;
  }

  try {
    const bytes = ProtobufTraceSerializer.serializeRequest(
      serializable.map(spanWithDecodedAttributes),
    );
    return bytes && bytes.length > 0 ? bytes : undefined;
  } catch (err) {
    console.warn(
      '[mlflow] Failed to serialize spans to OTLP protobuf; spans will remain available ' +
        'in the JSON trace artifact but will not appear in DB-backed span metrics.',
      err,
    );
    return undefined;
  }
}

export class MlflowSpanProcessor implements SpanProcessor {
  private _exporter: SpanExporter;

  constructor(exporter: SpanExporter) {
    this._exporter = exporter;
  }

  /**
   * Called when a {@link Span} is started, if the `span.isRecording()`
   * returns true.
   * @param span the Span that just started.
   */
  onStart(span: OTelSpan, _parentContext: Context): void {
    const otelTraceId = span.spanContext().traceId;

    let traceId: string;
    const experimentId = getConfig().experimentId;

    if (!span.parentSpanContext?.spanId) {
      // This is a root span
      traceId = generateTraceId(span);

      // Build trace metadata, merging context-injected values
      const traceMetadata: Record<string, string> = {
        ...resolveEnvironmentMetadata(),
        [TraceMetadataKey.SCHEMA_VERSION]: TRACE_SCHEMA_VERSION,
      };
      const ctxMetadata = getConfiguredTraceMetadata();
      if (ctxMetadata) {
        Object.assign(traceMetadata, ctxMetadata);
      }

      // Build trace tags, merging context-injected values
      const tags: Record<string, string> = {};
      const ctxTags = getConfiguredTraceTags();
      if (ctxTags) {
        Object.assign(tags, ctxTags);
      }

      const trace_info = new TraceInfo({
        traceId: traceId,
        traceLocation: createTraceLocationFromExperimentId(experimentId),
        requestTime: convertHrTimeToMs(span.startTime),
        executionDuration: 0,
        state: TraceState.IN_PROGRESS,
        traceMetadata,
        tags,
        assessments: [],
      });
      InMemoryTraceManager.getInstance().registerTrace(otelTraceId, trace_info);
    } else {
      traceId = InMemoryTraceManager.getInstance().getMlflowTraceIdFromOtelId(otelTraceId) || '';

      if (!traceId) {
        console.warn(`No trace ID found for span ${span.name}. Skipping.`);
        return;
      }
    }

    // Set trace ID to the span
    span.setAttribute(SpanAttributeKey.TRACE_ID, JSON.stringify(traceId));

    createAndRegisterMlflowSpan(span);
    executeOnSpanStartHooks(span);
  }

  /**
   * Called when a {@link ReadableSpan} is ended, if the `span.isRecording()`
   * returns true.
   * @param span the Span that just ended.
   */
  onEnd(span: OTelReadableSpan): void {
    const traceManager = InMemoryTraceManager.getInstance();

    executeOnSpanEndHooks(span);

    // Only trigger trace export for root span completion
    if (span.parentSpanContext?.spanId) {
      return;
    }

    // Update trace info
    const traceId = traceManager.getMlflowTraceIdFromOtelId(span.spanContext().traceId);
    if (!traceId) {
      console.warn(`No trace ID found for span ${span.name}. Skipping.`);
      return;
    }

    const trace = InMemoryTraceManager.getInstance().getTrace(traceId);
    if (!trace) {
      console.warn(`No trace found for span ${span.name}. Skipping.`);
      return;
    }

    this.updateTraceInfo(trace.info, span);
    // Aggregate token usage from all spans and add to trace metadata
    const allSpans = Array.from(trace.spanDict.values());
    const aggregatedUsage = aggregateUsageFromSpans(allSpans);
    if (aggregatedUsage) {
      trace.info.traceMetadata[TraceMetadataKey.TOKEN_USAGE] = JSON.stringify(aggregatedUsage);
    }

    this._exporter.export([span], (_) => {});
  }

  /**
   * Update the trace info with the span end time and status.
   * @param trace The trace to update
   * @param span The span to update the trace with
   */
  updateTraceInfo(traceInfo: TraceInfo, span: OTelReadableSpan): void {
    traceInfo.executionDuration = convertHrTimeToMs(span.endTime) - traceInfo.requestTime;

    let state = fromOtelStatus(span.status.code);
    // NB: In OpenTelemetry, status code remains UNSET if not explicitly set
    // by the user. However, there is no way to set the status when using
    // `trace` function wrapper. Therefore, we just automatically set the status
    // to OK if it is not ERROR.
    if (state === TraceState.STATE_UNSPECIFIED) {
      state = TraceState.OK;
    }
    traceInfo.state = state;
  }

  /**
   * Shuts down the processor. Called when SDK is shut down. This is an
   * opportunity for processor to do any cleanup required.
   */
  async shutdown() {
    await this._exporter.shutdown();
  }

  /**
   * Forces to export all finished spans
   */
  async forceFlush() {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this._exporter.forceFlush!();
  }
}

export class MlflowSpanExporter implements SpanExporter {
  private _client: MlflowClient;
  private _pendingExports: Record<string, Promise<void>> = {}; // traceId -> export promise

  constructor(client: MlflowClient) {
    this._client = client;
  }

  export(spans: OTelReadableSpan[], _resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      // Only export root spans
      if (span.parentSpanContext?.spanId) {
        continue;
      }

      const traceManager = InMemoryTraceManager.getInstance();
      const trace = traceManager.popTrace(span.spanContext().traceId);
      if (!trace) {
        console.warn(`No trace found for span ${span.name}. Skipping.`);
        continue;
      }

      // Set the last active trace ID
      traceManager.lastActiveTraceId = trace.info.traceId;

      // Export trace to backend and track the promise
      const exportPromise = this.exportTraceToBackend(trace).catch((error) => {
        console.error(`Failed to export trace ${trace.info.traceId}:`, error);
      });
      this._pendingExports[trace.info.traceId] = exportPromise;
    }
  }

  /**
   * Export a complete trace to the MLflow backend
   * Step 1: Create trace metadata via StartTraceV3 endpoint
   * Step 2: Upload trace data (spans) via artifact repository pattern
   */
  private async exportTraceToBackend(trace: Trace): Promise<void> {
    try {
      // Step 1: Create trace metadata in backend
      const traceInfo = await this._client.createTrace(trace.info);
      // Step 2: Upload trace data (spans) to artifact storage
      await this._client.uploadTraceData(traceInfo, trace.data);

      // Step 3: Also ingest spans through the OSS OTLP endpoint so they are
      // persisted in SqlSpan. The JSON artifact powers trace detail retrieval,
      // while DB-backed metrics (for example Tool Calls in the Overview UI)
      // query the SqlSpan table.
      const otlpBytes = serializeSpansToOtlp(
        trace.data.spans.map((span) => span._span as OTelReadableSpan),
      );
      if (otlpBytes) {
        try {
          await this._client.exportOtlpSpans(getConfig().experimentId, otlpBytes);
        } catch (error) {
          // Preserve the existing trace-export behavior if metrics ingestion
          // fails: the trace is still available through its JSON artifact.
          console.warn(
            `Failed to ingest OTLP spans for trace ${trace.info.traceId}; ` +
              'DB-backed span metrics will be unavailable:',
            error,
          );
        }
      }
    } catch (error) {
      console.error(`Failed to export trace ${trace.info.traceId}:`, error);
      throw error;
    } finally {
      // Remove the promise from the pending exports
      delete this._pendingExports[trace.info.traceId];
    }
  }

  /**
   * Force flush all pending trace exports.
   * Waits for all async export operations to complete.
   */
  async forceFlush(): Promise<void> {
    await Promise.all(Object.values(this._pendingExports));
    this._pendingExports = {};
  }

  /**
   * Shutdown the exporter.
   * Waits for all pending exports to complete before shutting down.
   */
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
