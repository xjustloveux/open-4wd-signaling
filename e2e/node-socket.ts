/** E2E 測試使用的最小 WebSocket 介面。 */
import { WebSocket } from 'ws';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** 把 ws 的事件介面轉成屬性式回呼，供 E2E 測試共用。 */
export function adaptNodeWebSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  const adapter: WebSocketLike = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.on('open', () => adapter.onopen?.());
  socket.on('message', (data) => adapter.onmessage?.({ data: data.toString() }));
  socket.on('close', () => adapter.onclose?.());
  socket.on('error', () => adapter.onerror?.());
  return adapter;
}
