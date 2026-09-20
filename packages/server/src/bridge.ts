import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { BridgeError, HEALTH_PATH, WS_PATH } from "@zcode-for-chrome/shared";
import type { BridgeResponse, ErrorCode, Hello, HelloAck, ToolName } from "@zcode-for-chrome/shared";
import { log } from "./log.js";

export const SERVER_NAME = "zcode-for-chrome";
export const SERVER_VERSION = "0.1.0";

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 10000;

export interface ExtensionInfo {
  extensionVersion: string;
  chromeVersion: string;
}

export interface BridgeOptions {
  portRange: [number, number];
  fixedPort?: number;
  token?: string;
  allowedOrigin?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveConnection {
  ws: WebSocket;
  info: ExtensionInfo;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
}

export class Bridge {
  private readonly opts: BridgeOptions;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private active: ActiveConnection | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private boundPort = 0;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  getPort(): number {
    return this.boundPort;
  }

  isConnected(): boolean {
    return this.active !== null && this.active.ws.readyState === WebSocket.OPEN;
  }

  extensionInfo(): ExtensionInfo | null {
    return this.active ? { ...this.active.info } : null;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    this.wss = new WebSocketServer({ noServer: true });
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));

    const candidates: number[] = [];
    if (this.opts.fixedPort !== undefined) {
      candidates.push(this.opts.fixedPort);
    } else {
      for (let p = this.opts.portRange[0]; p <= this.opts.portRange[1]; p++) candidates.push(p);
    }

    let lastError: unknown = null;
    for (const port of candidates) {
      try {
        await this.listen(port);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
          lastError = err;
          continue;
        }
        throw err;
      }
      this.boundPort = port;
      // A partir de aquí los errores del server no deben tumbar el proceso.
      this.server.on("error", (err) => log("error", "http server error", { err: String(err) }));
      log("info", "bridge listening", { port });
      return port;
    }
    throw lastError ?? new Error("no hay puertos disponibles en el rango");
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.failPending("EXT_NOT_CONNECTED", "puente detenido");
    if (this.active) this.teardown(this.active, 1001, "server stop");
    this.active = null;
    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      wss?.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async call<T>(tool: ToolName, params: unknown, timeoutMs: number): Promise<T> {
    const conn = this.active;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeError(
        "EXT_NOT_CONNECTED",
        `la extensión no está conectada (tool ${tool})`,
        "comprueba que la extensión está cargada y que el popup muestra connected",
      );
    }
    const id = randomUUID();
    const request = { type: "request", id, tool, params: (params ?? {}) } as const;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", `la extensión no respondió a ${tool} en ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      });
      conn.ws.send(JSON.stringify(request), (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
        }
        reject(new BridgeError("INTERNAL", `no se pudo enviar ${tool} al puente: ${String(err)}`));
      });
    });
  }

  private onRequest(req: IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url === HEALTH_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
          port: this.boundPort,
          extensionConnected: this.isConnected(),
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = (req.url ?? "").split("?")[0];
    const origin = req.headers.origin ?? "";
    const originOk =
      this.opts.allowedOrigin !== undefined
        ? origin === this.opts.allowedOrigin
        : origin.startsWith("chrome-extension://");
    if (url !== WS_PATH || !originOk) {
      log("warn", "upgrade rechazado", { url, origin });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      log("warn", "hello timeout, cerrando conexión");
      ws.close(4000, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const type = (msg as { type?: unknown })?.type;
      if (type === "hello") {
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        this.onHello(ws, msg as Hello);
        return;
      }
      if (type === "response") this.onResponse(msg as BridgeResponse);
    });

    ws.on("close", () => {
      if (helloTimer) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }
    });
    ws.on("error", (err) => log("warn", "ws error", { err: String(err) }));
  }

  private onHello(ws: WebSocket, hello: Hello): void {
    if (this.opts.token !== undefined && hello.token !== this.opts.token) {
      log("warn", "hello rechazado: token inválido");
      ws.close(4001, "bad token");
      return;
    }
    const info: ExtensionInfo = {
      extensionVersion: String(hello.extensionVersion ?? "?"),
      chromeVersion: String(hello.chromeVersion ?? "?"),
    };
    // Un hello repetido sobre la conexión ya activa viola el protocolo (un
    // hello por conexión): se ignora para no cerrar el propio socket.
    if (this.active !== null && this.active.ws === ws) {
      log("warn", "hello repetido en la conexión activa, ignorado");
      return;
    }
    // Solo una extensión activa: la última en hacer hello gana.
    if (this.active) this.teardown(this.active, 4000, "replaced");

    const conn: ActiveConnection = { ws, info, pingTimer: null, pongTimer: null };
    conn.pingTimer = setInterval(() => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      if (conn.pongTimer) clearTimeout(conn.pongTimer);
      // Sin pong en PONG_TIMEOUT_MS la conexión se da por muerta.
      conn.pongTimer = setTimeout(() => {
        log("warn", "pong timeout, terminando conexión");
        conn.ws.terminate();
      }, PONG_TIMEOUT_MS);
      conn.ws.ping();
    }, PING_INTERVAL_MS);
    conn.ws.on("pong", () => {
      if (conn.pongTimer) {
        clearTimeout(conn.pongTimer);
        conn.pongTimer = null;
      }
    });
    conn.ws.on("close", () => {
      // Cualquier cierre (natural o iniciado por el servidor) desarma el
      // keepalive: si no, cada desconexión de la extensión fuga el intervalo.
      this.clearKeepalive(conn);
      if (this.active === conn) {
        this.active = null;
        this.failPending("EXT_NOT_CONNECTED", "la extensión se desconectó");
        log("info", "extension desconectada");
      }
    });
    this.active = conn;

    const ack: HelloAck = { type: "hello_ack", serverVersion: SERVER_VERSION };
    ws.send(JSON.stringify(ack));
    log("info", "extension conectada", {
      extensionVersion: info.extensionVersion,
      chromeVersion: info.chromeVersion,
    });
  }

  private clearKeepalive(conn: ActiveConnection): void {
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
    if (conn.pongTimer) {
      clearTimeout(conn.pongTimer);
      conn.pongTimer = null;
    }
  }

  private teardown(conn: ActiveConnection, code: number, reason: string): void {
    this.clearKeepalive(conn);
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(code, reason);
    }
    if (this.active === conn) this.active = null;
    this.failPending("EXT_NOT_CONNECTED", `conexión cerrada (${reason})`);
  }

  private onResponse(msg: BridgeResponse): void {
    const p = this.pending.get(msg.responseTo);
    if (!p) return;
    this.pending.delete(msg.responseTo);
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      p.reject(new BridgeError(msg.error.code, msg.error.message, msg.error.hint));
    }
  }

  private failPending(code: ErrorCode, message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new BridgeError(code, message));
    }
  }
}
