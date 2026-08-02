import type { Logger, LogLevel } from "@sfx/domain";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON logger (§37.7). One line per event so a log aggregator can
 * index the fields rather than regex the message.
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel = "info",
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.minLevel, { ...this.bindings, ...bindings });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message,
      ...this.bindings,
      ...context,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else process.stdout.write(`${line}\n`);
  }
}
