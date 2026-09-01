/**
 * One HTTP `upgrade` listener for the whole sidecar, dispatching websocket handshakes by path.
 *
 * Node emits `upgrade` to every listener, so two independent `server.on('upgrade')` handlers can't
 * each 404 what they don't recognise without killing each other's sockets. Modules register a route
 * here instead; the dispatcher hands the socket to the first matching route and rejects the rest
 * (an unclaimed upgrade socket would otherwise sit open until the server's timeout).
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export type WsRouteHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, match: RegExpExecArray) => void;

interface WsRoute { path: RegExp; handler: WsRouteHandler; }

const routes: WsRoute[] = [];

/** Register a websocket path. `path` is matched against the raw request URL (query string included). */
export function registerWsRoute(path: RegExp, handler: WsRouteHandler): void {
  routes.push({ path, handler });
}

/** Test seam: forget every registered route (the registry is module-global). */
export function _resetWsRoutes(): void { routes.length = 0; }

export function dispatchUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = req.url ?? '';
  for (const r of routes) {
    const m = r.path.exec(url);
    if (m) { r.handler(req, socket, head, m); return true; }
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
  return false;
}

const attached = new WeakSet<HttpServer>();

/** Attach the dispatcher to an HTTP server (idempotent per server — every websocket module calls this
 *  for the server it is given, so tests that stand up their own server need no extra wiring).
 *  Registration order = match priority; routes registered later still work — the list is read per upgrade. */
export function attachWsDispatcher(server: HttpServer): void {
  if (attached.has(server)) return;
  attached.add(server);
  server.on('upgrade', (req, socket, head) => dispatchUpgrade(req, socket, head));
}
