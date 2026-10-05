import { logs, SeverityNumber, type AnyValueMap } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { redactLogAttributes, redactSecrets } from "./redact";

let started = false;

export function initTelemetry(): void {
  if (started) return;
  started = true;
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "dollas",
    }),
    processors: [new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() })],
  });
  logs.setGlobalLoggerProvider(provider);
}

function logger() {
  return logs.getLogger("dollas");
}

export function logInfo(body: string, attributes: Record<string, string> = {}): void {
  logger().emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body: redactSecrets(body),
    attributes: redactLogAttributes(attributes),
  });
}

export function logError(error: unknown, attributes: Record<string, string> = {}): void {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
  const message = redactSecrets(err.message);
  const fields: AnyValueMap = {
    "error.type": err.name,
    "error.message": message,
    "error.stack": redactSecrets(err.stack ?? ""),
    ...redactLogAttributes(attributes),
  };
  logger().emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: message,
    attributes: fields,
  });
}
