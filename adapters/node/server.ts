/**
 * Node 傳輸適配器。只做四件事：搬字串、記時間、存計數、送 bytes。
 * 全部協定語意屬核心，本檔不解讀訊息內容。
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ERR_REGISTER_REJECTED,
  MESSAGE_RATE_LIMIT_PER_MIN,
  RATE_LIMIT_WINDOW_MS,
  TIMESTAMP_TOLERANCE_MS,
  TURN_TOKEN_PURPOSE,
} from '../../core/constants';
import { isSignalingScope, verifyRegisterProof } from '../../core/protocol';
import { checkRate, type RateWindow } from '../../core/rate-limit';
import { step, type Effect, type Input } from '../../core/room';
import { emptyRoom, isRoomEmpty, type ConnId, type RoomState } from '../../core/state';
import { buildTurnToken } from '../../core/turn-token';
import { parseTurnTokenRequest } from '../../core/turn-token-request';
import { readConfig, type ServerConfig } from './config';

const TICK_INTERVAL_MS = 5_000;
// 與協定單訊息上限一致；超限由 ws 以 1009 關閉，早於任何緩衝放大。
// vendored wire-parser 未匯出此常數，故此處保留獨立字面量，兩處數值須同步變動。
const MAX_MESSAGE_BYTES = 256 * 1024;
// /turn-token 請求體上限；正常請求（peerId＋proof）遠小於此，超限即中止不再收。
const MAX_TURN_BODY_BYTES = 4_096;

type TurnBodyResult = { ok: true; text: string } | { ok: false; overLimit: boolean };

/** 讀 /turn-token 請求體：逾上限即停止累積並回報超限，由呼叫端回 413 後切斷連線。 */
function readTurnBody(request: IncomingMessage): Promise<TurnBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_TURN_BODY_BYTES) {
        request.pause();
        resolve({ ok: false, overLimit: true });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString() }));
    request.on('error', () => resolve({ ok: false, overLimit: false }));
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * 解析 request-target 成 URL。Node 會把 absolute-form 等畸形 target（如 `http://[`）
 * 原樣放進 request.url，直接 new URL 會拋例外冒泡成未捕捉例外＝整個行程崩潰，
 * 故解析失敗一律回 null，由呼叫端以客戶端錯誤拒絕。
 */
function parseRequestUrl(rawUrl: string | undefined): URL | null {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

interface Connection {
  readonly socket: WebSocket;
  readonly room: string;
}

/** 提供執行中 Node signaling 伺服器的就緒與關閉操作。 */
export interface RunningServer {
  /** 實際監聽的埠；config.port 為 0 時由作業系統指派，故須等 listen 完成 */
  readonly ready: Promise<number>;
  readonly close: () => Promise<void>;
}

/** 建立具限流、房間隔離與選用 TURN 權杖端點的 Node 伺服器。 */
export function createServer(config: ServerConfig): RunningServer {
  const rooms = new Map<string, RoomState>();
  const connections = new Map<ConnId, Connection>();
  const rateWindows = new Map<string, RateWindow>();
  const messageWindows = new Map<ConnId, RateWindow>();
  const turnTokenWindows = new Map<string, RateWindow>();
  /** 已受理的 /turn-token 證明 nonce：key＝`${peerId}:${nonce}`、值＝證明時戳（供 tick 剪枝） */
  const turnTokenNonces = new Map<string, number>();
  let nextConnId = 0;

  // secret 與 urls 任一缺席（含空字串／空清單）＝端點不掛，該路徑同其他路徑維持 404
  const turn =
    config.turnSharedSecret !== undefined &&
    config.turnSharedSecret !== '' &&
    config.turnUrls.length > 0
      ? { secret: config.turnSharedSecret, urls: config.turnUrls }
      : null;

  const http = createHttpServer((request, response) => {
    const url = parseRequestUrl(request.url);
    if (url === null) {
      // 畸形 request-target＝客戶端錯誤：回 400 即止，不進任何路由判定
      response.writeHead(400).end();
      return;
    }
    if (turn !== null && request.method === 'POST' && url.pathname === '/turn-token') {
      void handleTurnToken(request, response, turn).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const clientIp = (request: IncomingMessage): string => {
    if (config.trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
      if (first !== undefined && first.trim() !== '') return first.trim();
    }
    return request.socket.remoteAddress ?? 'unknown';
  };

  const handleTurnToken = async (
    request: IncomingMessage,
    response: ServerResponse,
    turnConfig: { secret: string; urls: string[] },
  ): Promise<void> => {
    const body = await readTurnBody(request);
    if (!body.ok) {
      // 超限＝回 413 後即刻切斷（early-abort，不收剩餘 bytes）；讀取中斷則無從回應
      if (body.overLimit) response.writeHead(413).end(() => request.destroy());
      return;
    }
    const parsed = parseTurnTokenRequest(body.text, { bucket: 'forbidden' });
    if (parsed === null) {
      response.writeHead(400).end();
      return;
    }
    const ip = clientIp(request);
    const rate = checkRate(turnTokenWindows.get(ip), Date.now(), config.rateLimitPerMin);
    turnTokenWindows.set(ip, rate.window);
    if (!rate.allowed) {
      response.writeHead(429).end();
      return;
    }
    // proof 以 TURN_TOKEN_PURPOSE 佔 room 位做域分隔；時戳窗與簽章語義同 register 路徑
    const now = Date.now();
    if (!verifyRegisterProof(parsed.peerId, TURN_TOKEN_PURPOSE, parsed.proof, now)) {
      respondJson(response, 403, { error: 'invalid-proof' });
      return;
    }
    const nonceId = `${parsed.peerId}:${parsed.proof.nonce}`;
    if (turnTokenNonces.has(nonceId)) {
      respondJson(response, 409, { error: 'nonce-replayed' });
      return;
    }
    turnTokenNonces.set(nonceId, parsed.proof.timestamp);
    respondJson(
      response,
      200,
      await buildTurnToken({
        peerId: parsed.peerId,
        nowMs: now,
        secret: turnConfig.secret,
        urls: turnConfig.urls,
      }),
    );
  };

  const apply = (room: string, input: Input): void => {
    const before = rooms.get(room) ?? emptyRoom(room);
    const { state, effects } = step(before, input, Date.now(), {
      peerTimeoutMs: config.peerTimeoutMs,
    });
    rooms.set(room, state);
    for (const effect of effects) deliver(effect);
    if (isRoomEmpty(state)) rooms.delete(room);
  };

  const deliver = (effect: Effect): void => {
    const connection = connections.get(effect.conn);
    if (connection === undefined) return;
    if (effect.kind === 'send') connection.socket.send(JSON.stringify(effect.wire));
    else connection.socket.close(1008, effect.code);
  };

  http.on('upgrade', (request, socket, head) => {
    // 原始 socket 在升級前後皆可能突發錯誤；無監聽者會拋成未捕捉例外炸掉行程
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    socket.on('error', () => {});
    const url = parseRequestUrl(request.url);
    if (url === null) {
      // 畸形 request-target：升級尚未發生、無 response 物件可用，
      // 照本 handler 既有拒絕慣例寫 raw 回應後切斷（與下方 429 同式）
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientIp(request);
    const rate = checkRate(rateWindows.get(ip), Date.now(), config.rateLimitPerMin);
    rateWindows.set(ip, rate.window);
    if (!rate.allowed) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    const room = url.searchParams.get('room');
    // 哨兵保留（與 core/constants.ts 的 TURN_TOKEN_PURPOSE 註解互為表裡）：
    // 等於哨兵或以 '/' 開頭的房名一律拒絕註冊，'/' 前綴命名空間整段保留給內部用途。
    // 完成升級後立即以 close 送拒絕碼，讓客戶端拿得到與其他註冊拒絕一致的原因字串。
    if (room === null || !isSignalingScope(room)) {
      wss.handleUpgrade(request, socket, head, (ws) => ws.close(1008, ERR_REGISTER_REJECTED));
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const conn = `c${nextConnId++}`;
      connections.set(conn, { socket: ws, room });
      apply(room, { kind: 'connected', conn });

      ws.on('message', (data) => {
        const messageRate = checkRate(
          messageWindows.get(conn),
          Date.now(),
          MESSAGE_RATE_LIMIT_PER_MIN,
        );
        messageWindows.set(conn, messageRate.window);
        if (!messageRate.allowed) return; // 逾額靜默丟棄；計數不讀內容，不涉協定語意
        apply(room, { kind: 'message', conn, raw: data.toString() });
      });
      ws.on('pong', () => apply(room, { kind: 'alive', conn }));
      ws.on('close', () => {
        connections.delete(conn);
        messageWindows.delete(conn);
        apply(room, { kind: 'closed', conn });
      });
      ws.on('error', () => ws.close());
    });
  });

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const [ip, window] of rateWindows)
      if (now - window.windowStart > RATE_LIMIT_WINDOW_MS) rateWindows.delete(ip);
    for (const [ip, window] of turnTokenWindows)
      if (now - window.windowStart > RATE_LIMIT_WINDOW_MS) turnTokenWindows.delete(ip);
    // 逾時戳容忍窗的 nonce 不可能再通過驗證，重放去重表可安全剪枝
    for (const [nonceId, timestamp] of turnTokenNonces)
      if (now - timestamp > TIMESTAMP_TOLERANCE_MS) turnTokenNonces.delete(nonceId);
    for (const room of [...rooms.keys()]) apply(room, { kind: 'tick' });
  }, TICK_INTERVAL_MS);

  const pinger = setInterval(
    () => {
      for (const { socket } of connections.values()) socket.ping();
    },
    Math.max(1_000, Math.round(config.peerTimeoutMs / 3)),
  );

  const ready = new Promise<number>((resolve) => {
    http.listen(config.port, () => {
      const address = http.address();
      resolve(typeof address === 'object' && address !== null ? address.port : config.port);
    });
  });

  return {
    ready,
    close: async () => {
      clearInterval(ticker);
      clearInterval(pinger);
      for (const { socket } of connections.values()) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

if (process.argv[1]?.endsWith('server.ts')) {
  const server = createServer(readConfig(process.env));
  server.ready.then((port) => console.log(`signaling 監聽於 ${port}`));
}
