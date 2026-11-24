/**
 * Incremental parser for a text/event-stream body. Chunks can split anywhere
 * (mid-line, mid-event), so it buffers until a blank line ends an event.
 * EventSource can't POST a file upload, which is why the stream is read by hand.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = "";

  const flush = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) onMessage({ event, data: data.join("\n") });
  };

  // A chunk can end between the \r and \n of a CRLF; hold a trailing \r back
  // until the next chunk shows whether a \n follows.
  let pendingCr = false;

  return {
    feed(chunk: string) {
      let text = (pendingCr ? "\r" : "") + chunk;
      pendingCr = text.endsWith("\r");
      if (pendingCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        flush(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
    },
    end() {
      pendingCr = false;
      if (buffer.trim() !== "") flush(buffer);
      buffer = "";
    },
  };
}
