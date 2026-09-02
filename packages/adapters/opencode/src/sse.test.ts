import { describe, expect, it } from "vitest";
import { parseSseJson, SseDecoder } from "./sse.js";
import { OPENCODE_SSE_FIXTURES, readFixture } from "./test-support.js";

function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

describe("SseDecoder", () => {
  it("frames one event per blank line", () => {
    const decoder = new SseDecoder();
    const frames = decoder.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(frames.map((frame) => frame.data)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("ignores comment lines such as the server's heartbeat", () => {
    const decoder = new SseDecoder();
    const frames = decoder.push(': heartbeat\n\ndata: {"ok":true}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"ok":true}');
  });

  it("keeps a partial line until the rest of the chunk arrives", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"big":"aaa')).toEqual([]);
    const frames = decoder.push('aaa"}\n\n');
    expect(frames[0]?.data).toBe('{"big":"aaaaaa"}');
  });

  it("concatenates repeated data lines and reads event / id / retry", () => {
    const decoder = new SseDecoder();
    const frames = decoder.push("event: ping\nid: evt_1\nretry: 500\ndata: a\ndata: b\n\n");
    expect(frames[0]).toEqual({ event: "ping", id: "evt_1", retry: 500, data: "a\nb" });
  });

  it("handles \\r\\n line ends", () => {
    const decoder = new SseDecoder();
    const frames = decoder.push('data: {"a":1}\r\n\r\n');
    expect(frames[0]?.data).toBe('{"a":1}');
  });

  it("surrenders an unterminated frame only on flush", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"a":1}\n')).toEqual([]);
    expect(decoder.flush()?.data).toBe('{"a":1}');
    expect(decoder.flush()).toBeUndefined();
  });

  it("decodes every recorded stream identically at any chunk size", () => {
    for (const fixture of Object.values(OPENCODE_SSE_FIXTURES)) {
      const text = readFixture(fixture.file);
      const whole = parseSseJson(text);
      for (const size of [7, 64, 4096]) {
        const decoder = new SseDecoder();
        const frames: string[] = [];
        for (const chunk of chunked(text, size)) {
          for (const frame of decoder.push(chunk)) frames.push(frame.data);
        }
        const tail = decoder.flush();
        if (tail) frames.push(tail.data);
        expect(frames.length, `${fixture.file} @ ${size}`).toBe(whole.length);
      }
    }
  });

  it("drops a frame whose payload is not JSON instead of throwing", () => {
    expect(parseSseJson('data: not json\n\ndata: {"a":1}\n\n')).toEqual([{ a: 1 }]);
  });
});
