import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERR_PEER_TIMEOUT,
  ERR_REGISTER_TIMEOUT,
  ERR_ROOM_FULL,
  MAX_PEERS,
  MESSAGE_RATE_LIMIT_PER_MIN,
  PEER_TIMEOUT_MS,
  RATE_LIMIT_WINDOW_MS,
  REGISTER_DEADLINE_MS,
} from '../../core/constants';
import { makeIdentity, makeRegisterRaw, makeSignedSignalRaw } from '../../core/test-support';
import type { HibernatableWebSocket, RoomDurableObjectContext, SqlCursor, SqlValue } from './env';
import { RoomDurableObject } from './room-object';
import { parseSocketAttachment } from './socket-state';

const NOW = 1_700_000_000_000;
const SCOPE = 'room:123e4567-e89b-42d3-a456-426614174000';

class MemorySocket implements HibernatableWebSocket {
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  private attachment: unknown;

  send(message: string): void {
    this.sent.push(message);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = structuredClone(attachment);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class SqliteCursor<T extends Record<string, unknown>> implements SqlCursor<T> {
  constructor(private readonly rows: T[]) {}

  toArray(): T[] {
    return this.rows;
  }
}

class MemoryContext implements RoomDurableObjectContext {
  readonly sockets: MemorySocket[] = [];
  readonly sqlStatements: string[] = [];
  alarmTime: number | null = null;
  private readonly db = new DatabaseSync(':memory:');

  readonly storage = {
    sql: {
      exec: <T extends Record<string, unknown>>(
        query: string,
        ...bindings: SqlValue[]
      ): SqlCursor<T> => {
        this.sqlStatements.push(query.replace(/\s+/g, ' ').trim());
        const statement = this.db.prepare(query);
        const rows =
          statement.columns().length === 0
            ? (statement.run(...bindings), [])
            : statement.all(...bindings);
        return new SqliteCursor(rows as T[]);
      },
    },
    transactionSync: <T>(callback: () => T): T => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },
    setAlarm: (scheduledTime: number): Promise<void> => {
      this.alarmTime = scheduledTime;
      return Promise.resolve();
    },
  };

  acceptWebSocket(socket: HibernatableWebSocket): void {
    this.sockets.push(socket as MemorySocket);
  }

  getWebSockets(): HibernatableWebSocket[] {
    return [...this.sockets];
  }
}

function messagesOfType(socket: MemorySocket, type: string): Record<string, unknown>[] {
  return socket.sent
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((wire) => wire['type'] === type);
}

describe('RoomDurableObject', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('upgrades a canonical scope with the hibernation API', async () => {
    const context = new MemoryContext();
    const client = new MemorySocket();
    const server = new MemorySocket();
    class TestResponse {
      readonly status: number;
      readonly webSocket: HibernatableWebSocket | undefined;

      constructor(_body: unknown, init: { status?: number; webSocket?: HibernatableWebSocket }) {
        this.status = init.status ?? 200;
        this.webSocket = init.webSocket;
      }
    }
    class TestWebSocketPair {
      readonly 0 = client;
      readonly 1 = server;
    }
    vi.stubGlobal('Response', TestResponse);
    vi.stubGlobal('WebSocketPair', TestWebSocketPair);

    const object = new RoomDurableObject(context, {}, () => NOW);
    const response = await object.fetch(
      new Request(`https://signal.example/ws?room=${SCOPE}`, {
        headers: { Upgrade: 'websocket' },
      }),
    );

    expect(response.status).toBe(101);
    expect((response as unknown as { webSocket: HibernatableWebSocket }).webSocket).toBe(client);
    expect(context.sockets).toEqual([server]);
    const attachment = parseSocketAttachment(server.deserializeAttachment());
    expect(attachment?.version).toBe(1);
    expect(attachment?.scope).toBe(SCOPE);
    expect(context.alarmTime).toBeGreaterThan(NOW);
  });

  it('rejects a pre-release attachment that lacks the current rate-limit state', () => {
    expect(
      parseSocketAttachment({
        version: 1,
        connId: 'legacy',
        scope: SCOPE,
        peerId: null,
        connectedAt: NOW,
        lastAliveAt: NOW,
      }),
    ).toBeNull();
  });

  it('rejects an unpublished internal candidate version instead of keeping a migration branch', () => {
    expect(
      parseSocketAttachment({
        version: 2,
        connId: 'candidate',
        scope: SCOPE,
        peerId: null,
        connectedAt: NOW,
        lastAliveAt: NOW,
        messageRateCount: 0,
        messageRateWindowStart: NOW,
      }),
    ).toBeNull();
  });

  it('reconstructs registration order and rejects a signal replay after wake', async () => {
    const context = new MemoryContext();
    const alice = makeIdentity(1);
    const bob = makeIdentity(2);
    const charlie = makeIdentity(3);
    const aliceSocket = new MemorySocket();
    const bobSocket = new MemorySocket();

    const first = new RoomDurableObject(context, {}, () => NOW);
    first.acceptSocket(aliceSocket, SCOPE, 'c-alice', NOW);
    first.webSocketMessage(aliceSocket, await makeRegisterRaw(alice, SCOPE, NOW));
    first.acceptSocket(bobSocket, SCOPE, 'c-bob', NOW + 1);
    first.webSocketMessage(bobSocket, await makeRegisterRaw(bob, SCOPE, NOW));

    const offer = await makeSignedSignalRaw({
      identity: alice,
      scope: SCOPE,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'offer' },
      now: NOW,
      nonceByte: 3,
    });
    first.webSocketMessage(aliceSocket, offer);
    expect(messagesOfType(bobSocket, 'signal-v1')).toHaveLength(1);

    const woken = new RoomDurableObject(context, {}, () => NOW);
    woken.webSocketMessage(aliceSocket, offer);
    expect(messagesOfType(bobSocket, 'signal-v1')).toHaveLength(1);

    const charlieSocket = new MemorySocket();
    woken.acceptSocket(charlieSocket, SCOPE, 'c-charlie', NOW + 2);
    woken.webSocketMessage(charlieSocket, await makeRegisterRaw(charlie, SCOPE, NOW));

    const roomStates = messagesOfType(charlieSocket, 'room-state');
    expect(roomStates.at(-1)?.['payload']).toEqual({
      peers: [alice.peerId, bob.peerId, charlie.peerId],
    });
  });

  it('keeps rooms isolated even when connection ids are identical', async () => {
    const alice = makeIdentity(4);
    const roomA = new RoomDurableObject(new MemoryContext(), {}, () => NOW);
    const roomB = new RoomDurableObject(new MemoryContext(), {}, () => NOW);
    const socketA = new MemorySocket();
    const socketB = new MemorySocket();

    roomA.acceptSocket(socketA, 'room:123e4567-e89b-42d3-a456-426614174000', 'c1', NOW);
    roomB.acceptSocket(socketB, 'room:123e4567-e89b-42d3-b456-426614174001', 'c1', NOW);
    roomA.webSocketMessage(
      socketA,
      await makeRegisterRaw(alice, 'room:123e4567-e89b-42d3-a456-426614174000', NOW),
    );
    roomB.webSocketMessage(
      socketB,
      await makeRegisterRaw(alice, 'room:123e4567-e89b-42d3-b456-426614174001', NOW),
    );

    expect(
      (messagesOfType(socketA, 'room-state').at(-1)?.['payload'] as { peers: string[] }).peers,
    ).toEqual([alice.peerId]);
    expect(
      (messagesOfType(socketB, 'room-state').at(-1)?.['payload'] as { peers: string[] }).peers,
    ).toEqual([alice.peerId]);
  });

  it('rejects a non-canonical scope before accepting the socket', () => {
    const context = new MemoryContext();
    const object = new RoomDurableObject(context, {}, () => NOW);
    const socket = new MemorySocket();

    object.acceptSocket(socket, 'lobby', 'c1', NOW);

    expect(context.sockets).toHaveLength(0);
    expect(socket.closed).toEqual([{ code: 1008, reason: 'register-rejected' }]);
  });

  it('enforces the 64-peer limit through the durable adapter', async () => {
    const context = new MemoryContext();
    const object = new RoomDurableObject(context, {}, () => NOW);

    for (let index = 1; index <= MAX_PEERS; index += 1) {
      const identity = makeIdentity(index);
      const socket = new MemorySocket();
      object.acceptSocket(socket, SCOPE, `c${index}`, NOW);
      object.webSocketMessage(socket, await makeRegisterRaw(identity, SCOPE, NOW));
      expect(socket.closed).toEqual([]);
    }

    const overflowIdentity = makeIdentity(MAX_PEERS + 1);
    const overflowSocket = new MemorySocket();
    object.acceptSocket(overflowSocket, SCOPE, 'overflow', NOW);
    object.webSocketMessage(overflowSocket, await makeRegisterRaw(overflowIdentity, SCOPE, NOW));

    expect(messagesOfType(overflowSocket, 'error').at(-1)?.['payload']).toEqual({
      code: ERR_ROOM_FULL,
    });
    expect(overflowSocket.closed).toEqual([{ code: 1008, reason: ERR_ROOM_FULL }]);
  });

  it('keeps a registered idle peer while the runtime still reports its socket', async () => {
    let clock = NOW;
    const context = new MemoryContext();
    const object = new RoomDurableObject(context, {}, () => clock);
    const identity = makeIdentity(70);
    const socket = new MemorySocket();
    object.acceptSocket(socket, SCOPE, 'c-timeout', clock);
    object.webSocketMessage(socket, await makeRegisterRaw(identity, SCOPE, clock));

    clock += PEER_TIMEOUT_MS + 1;
    object.alarm();

    expect(socket.closed).toEqual([]);
  });

  it('expires a peer after the runtime stops reporting its socket', async () => {
    let clock = NOW;
    const context = new MemoryContext();
    const object = new RoomDurableObject(context, {}, () => clock);
    const identity = makeIdentity(75);
    const socket = new MemorySocket();
    object.acceptSocket(socket, SCOPE, 'c-missing', clock);
    object.webSocketMessage(socket, await makeRegisterRaw(identity, SCOPE, clock));
    context.sockets.length = 0;

    clock += PEER_TIMEOUT_MS + 1;
    object.alarm();

    expect(socket.closed).toEqual([{ code: 1008, reason: ERR_PEER_TIMEOUT }]);
  });

  it('still closes a socket that misses the registration deadline', () => {
    let clock = NOW;
    const context = new MemoryContext();
    const object = new RoomDurableObject(context, {}, () => clock);
    const socket = new MemorySocket();
    object.acceptSocket(socket, SCOPE, 'c-pending', clock);

    clock += REGISTER_DEADLINE_MS + 1;
    object.alarm();

    expect(socket.closed).toEqual([{ code: 1008, reason: ERR_REGISTER_TIMEOUT }]);
  });

  it('persists the pre-parse per-connection message limit across hibernation wake', async () => {
    let clock = NOW;
    const context = new MemoryContext();
    const alice = makeIdentity(71);
    const bob = makeIdentity(72);
    const aliceSocket = new MemorySocket();
    const bobSocket = new MemorySocket();
    const first = new RoomDurableObject(context, {}, () => clock);
    first.acceptSocket(aliceSocket, SCOPE, 'c-rate-alice', clock);
    first.webSocketMessage(aliceSocket, await makeRegisterRaw(alice, SCOPE, clock));
    first.acceptSocket(bobSocket, SCOPE, 'c-rate-bob', clock);
    first.webSocketMessage(bobSocket, await makeRegisterRaw(bob, SCOPE, clock));

    for (let index = 1; index < MESSAGE_RATE_LIMIT_PER_MIN; index += 1)
      first.webSocketMessage(aliceSocket, '{}');

    const woken = new RoomDurableObject(context, {}, () => clock);
    const dropped = await makeSignedSignalRaw({
      identity: alice,
      scope: SCOPE,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'dropped' },
      now: clock,
      nonceByte: 8,
    });
    woken.webSocketMessage(aliceSocket, dropped);
    expect(messagesOfType(bobSocket, 'signal-v1')).toHaveLength(0);
    expect(aliceSocket.closed).toEqual([]);

    clock += RATE_LIMIT_WINDOW_MS + 1;
    const allowed = await makeSignedSignalRaw({
      identity: alice,
      scope: SCOPE,
      target: bob.peerId,
      message: { type: 'sdp-offer', sdp: 'allowed' },
      now: clock,
      nonceByte: 9,
    });
    woken.webSocketMessage(aliceSocket, allowed);
    expect(messagesOfType(bobSocket, 'signal-v1')).toHaveLength(1);
  });

  it('does not rewrite room_peer while relaying with stable membership', async () => {
    const context = new MemoryContext();
    const alice = makeIdentity(73);
    const bob = makeIdentity(74);
    const aliceSocket = new MemorySocket();
    const bobSocket = new MemorySocket();
    const object = new RoomDurableObject(context, {}, () => NOW);
    object.acceptSocket(aliceSocket, SCOPE, 'c-write-alice', NOW);
    object.webSocketMessage(aliceSocket, await makeRegisterRaw(alice, SCOPE, NOW));
    object.acceptSocket(bobSocket, SCOPE, 'c-write-bob', NOW);
    object.webSocketMessage(bobSocket, await makeRegisterRaw(bob, SCOPE, NOW));
    context.sqlStatements.length = 0;

    object.webSocketMessage(
      aliceSocket,
      await makeSignedSignalRaw({
        identity: alice,
        scope: SCOPE,
        target: bob.peerId,
        message: { type: 'sdp-offer', sdp: 'offer' },
        now: NOW,
        nonceByte: 10,
      }),
    );

    expect(messagesOfType(bobSocket, 'signal-v1')).toHaveLength(1);
    expect(
      context.sqlStatements.filter(
        (statement) =>
          statement.startsWith('DELETE FROM room_peer') ||
          statement.startsWith('INSERT INTO room_peer'),
      ),
    ).toEqual([]);
  });
});
