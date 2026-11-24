import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "./sse";

function collect() {
  const messages: SseMessage[] = [];
  return { messages, parser: createSseParser((m) => messages.push(m)) };
}

describe("createSseParser", () => {
  it("parses whole events", () => {
    const { messages, parser } = collect();
    parser.feed('event: stage\ndata: {"stage":"ingest"}\n\nevent: log\ndata: {"text":"hi"}\n\n');
    expect(messages).toEqual([
      { event: "stage", data: '{"stage":"ingest"}' },
      { event: "log", data: '{"text":"hi"}' },
    ]);
  });

  it("handles events split across chunks at any point", () => {
    const { messages, parser } = collect();
    const stream = 'event: result\ndata: {"a":1}\n\nevent: stage\r\ndata: {"b":2}\r\n\r\n';
    for (const char of stream) parser.feed(char);
    expect(messages).toEqual([
      { event: "result", data: '{"a":1}' },
      { event: "stage", data: '{"b":2}' },
    ]);
  });

  it("joins multi-line data, skips comments, and flushes a final event without a blank line", () => {
    const { messages, parser } = collect();
    parser.feed(": keep-alive\n\ndata: line one\ndata: line two\n");
    parser.end();
    expect(messages).toEqual([{ event: "message", data: "line one\nline two" }]);
  });
});
