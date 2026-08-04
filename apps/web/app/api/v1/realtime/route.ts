import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The realtime stream (§17, requirements 11 and 12).
 *
 * Server-Sent Events rather than a WebSocket: the traffic is one-directional —
 * the server says "something changed", the client fetches. A duplex protocol
 * would be capability the design deliberately does not want, since accepting an
 * offer stays an ordinary authenticated POST (requirement 13).
 *
 * ## Authorization
 *
 * **The client never names a channel.** It opens this stream and the server
 * decides what it will receive, computed from the session:
 *
 *   - `expert:<their own profile id>` — only if they have an expert profile
 *   - `customer:<their own customer profile id>`
 *
 * That is requirement 11 satisfied by removing the attack surface rather than by
 * guarding it. There is no channel parameter to tamper with, no token to forge,
 * and no subscribe message to craft: an expert cannot ask for another expert's
 * channel because asking is not part of the protocol.
 *
 * Both channels are derived from **identity**, so the set is computed once and
 * stays true for the life of the stream. An earlier version listed the customer's
 * request ids instead, and the end-to-end run found the hole: a customer who
 * opens the dashboard and then submits a request — client-side navigation, one
 * long-lived connection — was subscribed to a set computed before their request
 * existed, and sat watching a spinner while it was already being matched.
 *
 * ## Payload
 *
 * `{"type":"offer.opened"}` and nothing else (requirement 12). No scores, no
 * ranks, no other expert's identity, no customer text. The client's response is
 * to re-fetch through the ordinary authorized endpoints, which is where every
 * access decision already lives.
 */
export async function GET(request: Request) {
  const actor = await requireActor();
  const { realtimeHub, logger } = getContainer();

  // Computed here, from the session. Never from the request, and never from a
  // query whose result could change while the stream is open.
  const allowed = new Set<string>();
  if (actor.expert) allowed.add(`expert:${actor.expert.profileId}`);
  if (actor.customerProfileId) allowed.add(`customer:${actor.customerProfileId}`);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (line: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      };

      // Tells the client it is live, so it can distinguish "connected, nothing
      // has happened" from "never connected" — which is the difference between
      // trusting the stream and falling back to polling (requirement 14).
      send(`event: ready\ndata: ${JSON.stringify({ channels: allowed.size })}\n\n`);

      const unsubscribe =
        realtimeHub?.subscribe((signal) => {
          // The filter that makes the design safe. A signal for a channel this
          // session is not entitled to is dropped here, in the process that
          // knows who they are.
          if (!allowed.has(signal.channel)) return;
          send(`event: signal\ndata: ${JSON.stringify({ type: signal.type })}\n\n`);
        }) ?? (() => undefined);

      // Keeps proxies and load balancers from closing an idle stream. A comment
      // frame is not an event, so it cannot be mistaken for one.
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), 25_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", close);
      if (!realtimeHub) {
        logger.debug("realtime stream opened with no provider; holding it open", {
          userId: actor.userId,
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer by default, which turns a realtime stream into
      // a batch one.
      "x-accel-buffering": "no",
    },
  });
}
