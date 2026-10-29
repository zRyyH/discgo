// Gateway client (PLAN 3.1 step 2, 5.3): identify on every (re)connect, the
// server answers with `ready` (full resync). Reconnects with capped backoff.
import type { ClientEvent, ServerEvent } from '../shared/protocol';
import { API_URL } from './rest';

export type GatewayStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

const GATEWAY_URL = API_URL.replace(/^http/, 'ws') + '/v1/gateway';
const CLIENT_VERSION = '0.1.0';
// Close code the server uses for a bad/expired token.
const POLICY_VIOLATION = 1008;
const PING_EVERY_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

type Listener = (e: ServerEvent) => void;

class Gateway {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongDeadline: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: GatewayStatus) => void>();
  private unauthorized: () => void = () => {};
  status: GatewayStatus = 'idle';

  connect(token: string) {
    this.token = token;
    this.attempt = 0;
    this.open();
  }

  close() {
    this.token = null;
    clearTimeout(this.retryTimer);
    this.stopPing();
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus('idle');
  }

  send(ev: ClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== 'connected') return false;
    this.ws.send(JSON.stringify(ev));
    return true;
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: GatewayStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onUnauthorized(cb: () => void) {
    this.unauthorized = cb;
  }

  private open() {
    if (!this.token) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(GATEWAY_URL);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'identify', d: { token: this.token, client: { version: CLIENT_VERSION, p2p: true } } }));
    };
    ws.onmessage = (m) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(m.data as string);
      } catch {
        return;
      }
      if (ev.op === 'ready') {
        this.attempt = 0;
        this.setStatus('connected');
        this.startPing();
      } else if (ev.op === 'pong') {
        clearTimeout(this.pongDeadline);
        return;
      }
      for (const l of this.listeners) l(ev);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (!this.token) return;
      if (e.code === POLICY_VIOLATION) {
        this.close();
        this.unauthorized();
        return;
      }
      this.setStatus('reconnecting');
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  // The server pings too; this catches a dead link the browser has not noticed.
  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.send({ op: 'ping', d: Date.now() })) return;
      this.pongDeadline = setTimeout(() => this.ws?.close(4000, 'pong timeout'), PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  private stopPing() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongDeadline);
  }

  private setStatus(s: GatewayStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }
}

export const gateway = new Gateway();
