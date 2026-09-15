#!/usr/bin/env node
/**
 * FOH telemetry bridge.
 *
 * A browser cannot open a UDP socket, and lighting consoles speak nothing else:
 * Art-Net 4 and sACN (ANSI E1.31) are both UDP multicast/broadcast. This daemon
 * is the only part of the system that sits on the show network. It binds those
 * two ports, validates and parses the frames, and relays them to the visualizer
 * over a WebSocket.
 *
 * It is deliberately a RELAY, not a renderer. It holds no show state and makes
 * no patch decisions -- it converts wire frames into the engine's DMX_UPDATE
 * shape and forwards them. Everything downstream stays testable without a
 * console on the desk.
 *
 * Usage:
 *   npm run bridge
 *   npm run bridge -- --port 8080 --artnet-port 6454 --sacn-port 5568
 *
 * Wire format sent to each client, per universe frame:
 *   bytes 0-1   universe, uint16 big-endian
 *   bytes 2-3   channel count, uint16 big-endian (1..512)
 *   bytes 4..   channel levels, one byte each
 *
 * A fixed 4-byte header keeps the browser's parse allocation-free: it reads the
 * header, then copies the levels straight into a pooled buffer.
 */

import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import express from 'express';
import { WebSocketServer } from 'ws';

/* -------------------------------------------------------------------------- */
/* Protocol constants                                                         */
/* -------------------------------------------------------------------------- */

/** Art-Net binds a fixed port by specification (Art-Net 4, section 5). */
const ARTNET_PORT = 6454;
/** sACN binds a fixed port by specification (ANSI E1.31-2018, section 4.1). */
const SACN_PORT = 5568;

/** `"Art-Net\0"`, the 8-byte ArtDmx packet identifier. */
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii');
/** OpDmx, little-endian at bytes 8-9. */
const ARTNET_OP_DMX = 0x5000;
/** Art-Net 4 is protocol revision 14; anything older is not worth parsing. */
const ARTNET_MIN_PROTOCOL_VERSION = 14;
/** Shortest legal ArtDmx packet: 18-byte header plus two channels. */
const ARTNET_HEADER_BYTES = 18;

/** `"ASC-E1.17\0\0\0"`, the 12-byte ACN packet identifier at bytes 4-15. */
const SACN_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);
/** VECTOR_ROOT_E131_DATA, at bytes 18-21. */
const SACN_VECTOR_ROOT_DATA = 0x00000004;
/** VECTOR_E131_DATA_PACKET, at bytes 40-43. */
const SACN_VECTOR_FRAMING_DATA = 0x00000002;
/** VECTOR_DMP_SET_PROPERTY, at byte 117. */
const SACN_VECTOR_DMP_SET_PROPERTY = 0x02;
/** Offset of the DMP property-value count; the start code follows it. */
const SACN_DMP_COUNT_OFFSET = 123;
/** Shortest legal E1.31 data packet: 126-byte header plus the start code. */
const SACN_HEADER_BYTES = 126;
/** Byte 112, bit 6: a preview frame is for console visualisers, not output. */
const SACN_OPTION_PREVIEW = 0x80;
/** Byte 112, bit 5: the source is terminating this universe. */
const SACN_OPTION_TERMINATED = 0x40;

/** One full DMX512 universe. */
const UNIVERSE_CHANNELS = 512;
/** Fixed header on every relayed frame. See the module comment. */
const RELAY_HEADER_BYTES = 4;

/**
 * Sequence numbers wrap at 256, so "newer" is a comparison on a ring rather
 * than on integers. A gap wider than this is read as a source restart rather
 * than as an out-of-order arrival.
 */
const SEQUENCE_WRAP_WINDOW = 128;

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    port: 8080,
    artnetPort: ARTNET_PORT,
    sacnPort: SACN_PORT,
    host: '0.0.0.0',
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--port':
      case '--artnet-port':
      case '--sacn-port': {
        if (value === undefined) throw new Error(`${flag} requires a value.`);
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          throw new Error(`${flag} must be a port in 1..65535, got "${value}".`);
        }
        if (flag === '--port') options.port = parsed;
        else if (flag === '--artnet-port') options.artnetPort = parsed;
        else options.sacnPort = parsed;
        i++;
        break;
      }
      case '--host': {
        if (value === undefined) throw new Error('--host requires a value.');
        options.host = value;
        i++;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown flag "${flag}". Try --help.`);
    }
  }

  return options;
}

const USAGE = `FOH telemetry bridge -- relays Art-Net 4 and sACN to the visualizer.

  --port <n>         WebSocket / HTTP port to serve on  (default 8080)
  --artnet-port <n>  UDP port to listen for Art-Net on  (default ${ARTNET_PORT})
  --sacn-port <n>    UDP port to listen for sACN on     (default ${SACN_PORT})
  --host <addr>      Address to bind the UDP sockets to (default 0.0.0.0)
  --help             This message
`;

/* -------------------------------------------------------------------------- */
/* Parsers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse an Art-Net 4 ArtDmx packet.
 *
 * Returns `null` for anything that is not a well-formed ArtDmx frame --
 * ArtPoll, ArtSync and malformed packets all land on the same port and must be
 * ignored rather than relayed as levels.
 */
export function parseArtDmx(packet) {
  if (packet.length < ARTNET_HEADER_BYTES) return null;
  if (!packet.subarray(0, 8).equals(ARTNET_ID)) return null;
  if (packet.readUInt16LE(8) !== ARTNET_OP_DMX) return null;
  if (packet.readUInt16BE(10) < ARTNET_MIN_PROTOCOL_VERSION) return null;

  // 15-bit Port-Address: Net in the high byte, SubUni in the low byte.
  const universe = packet.readUInt16LE(14) & 0x7fff;
  const length = packet.readUInt16BE(16);

  // Length is specified as even and 2..512. An odd or oversized length means a
  // corrupt frame, and trusting it would read past the packet.
  if (length < 2 || length > UNIVERSE_CHANNELS || length % 2 !== 0) return null;
  if (packet.length < ARTNET_HEADER_BYTES + length) return null;

  return {
    universe,
    sequence: packet.readUInt8(12),
    channels: packet.subarray(ARTNET_HEADER_BYTES, ARTNET_HEADER_BYTES + length),
  };
}

/**
 * Parse an sACN / ANSI E1.31 data packet.
 *
 * Returns `null` for sync packets, discovery packets, preview frames and
 * anything malformed. Preview frames are explicitly excluded: they carry
 * console-visualiser levels rather than what is being output to the rig, and
 * relaying them would show the operator a rig that is not lit.
 */
export function parseSacn(packet) {
  if (packet.length < SACN_HEADER_BYTES) return null;
  if (!packet.subarray(4, 16).equals(SACN_ID)) return null;
  if (packet.readUInt32BE(18) !== SACN_VECTOR_ROOT_DATA) return null;
  if (packet.readUInt32BE(40) !== SACN_VECTOR_FRAMING_DATA) return null;
  if (packet.readUInt8(117) !== SACN_VECTOR_DMP_SET_PROPERTY) return null;

  const options = packet.readUInt8(112);
  if ((options & SACN_OPTION_PREVIEW) !== 0) return null;
  if ((options & SACN_OPTION_TERMINATED) !== 0) return null;

  // The DMP count includes the start code byte, so the channel count is one
  // less. A count of 1 is a valid keep-alive carrying no levels.
  const propertyCount = packet.readUInt16BE(SACN_DMP_COUNT_OFFSET);
  const length = propertyCount - 1;
  if (length < 1 || length > UNIVERSE_CHANNELS) return null;
  if (packet.length < SACN_HEADER_BYTES + length) return null;

  // Byte 125 is the DMX start code. Non-zero start codes address RDM and other
  // alternate payloads, which are not dimmer levels.
  if (packet.readUInt8(125) !== 0x00) return null;

  return {
    universe: packet.readUInt16BE(113),
    sequence: packet.readUInt8(111),
    channels: packet.subarray(SACN_HEADER_BYTES, SACN_HEADER_BYTES + length),
  };
}

/**
 * Whether `next` is newer than `previous` on the 8-bit sequence ring.
 *
 * Both protocols wrap 255 -> 0, so a plain `>` would reject every frame for the
 * rest of the show after the first wrap. A jump backwards wider than the window
 * is treated as a source restart and accepted, because refusing it would wedge
 * the universe until the counter caught up.
 */
export function isNewerSequence(previous, next) {
  if (previous === undefined) return true;
  if (next === previous) return false;
  const forward = (next - previous + 256) % 256;
  return forward < SEQUENCE_WRAP_WINDOW;
}

/**
 * Pack one parsed universe into the relay frame described in the module
 * comment. Allocates once per frame; the browser side reuses a pooled buffer.
 */
export function encodeRelayFrame(universe, channels) {
  const frame = Buffer.allocUnsafe(RELAY_HEADER_BYTES + channels.length);
  frame.writeUInt16BE(universe, 0);
  frame.writeUInt16BE(channels.length, 2);
  channels.copy(frame, RELAY_HEADER_BYTES);
  return frame;
}

/* -------------------------------------------------------------------------- */
/* Daemon                                                                     */
/* -------------------------------------------------------------------------- */

class FohBridge {
  #options;
  #clients = new Set();
  #sockets = [];
  #httpServer = null;
  #wss = null;
  /** universe -> last accepted sequence byte. */
  #lastSequence = new Map();

  #stats = {
    startedAt: Date.now(),
    artnetFrames: 0,
    sacnFrames: 0,
    droppedStale: 0,
    droppedMalformed: 0,
    relayed: 0,
  };

  constructor(options) {
    this.#options = options;
  }

  async start() {
    this.#startHttp();
    await Promise.all([
      this.#bindUdp('artnet', this.#options.artnetPort, parseArtDmx),
      this.#bindUdp('sacn', this.#options.sacnPort, parseSacn),
    ]);
  }

  #startHttp() {
    const app = express();

    app.get('/health', (_req, res) => {
      const uptimeSeconds = Math.round((Date.now() - this.#stats.startedAt) / 1000);
      res.json({ status: 'ok', uptimeSeconds, clients: this.#clients.size, ...this.#stats });
    });

    this.#httpServer = createServer(app);
    this.#wss = new WebSocketServer({ server: this.#httpServer });

    this.#wss.on('connection', (socket, request) => {
      this.#clients.add(socket);
      const peer = request.socket.remoteAddress ?? 'unknown';
      console.log(`[bridge] client connected from ${peer} (${this.#clients.size} total)`);

      socket.on('close', () => {
        this.#clients.delete(socket);
        console.log(`[bridge] client disconnected (${this.#clients.size} remaining)`);
      });

      // A client error must drop that client, never the daemon.
      socket.on('error', (error) => {
        console.error(`[bridge] client socket error: ${error.message}`);
        this.#clients.delete(socket);
      });
    });

    this.#httpServer.listen(this.#options.port, () => {
      console.log(`[bridge] websocket + health on http://localhost:${this.#options.port}`);
    });
  }

  /**
   * Bind one protocol's UDP port.
   *
   * A bind failure is reported and swallowed rather than fatal: running only
   * Art-Net (or only sACN) is a legitimate configuration, and on a desk where
   * another visualiser already holds one port the other still works.
   */
  #bindUdp(name, port, parse) {
    return new Promise((resolve) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });

      socket.on('message', (packet) => {
        const frame = parse(packet);
        if (frame === null) {
          this.#stats.droppedMalformed++;
          return;
        }

        if (name === 'artnet') this.#stats.artnetFrames++;
        else this.#stats.sacnFrames++;

        // Both protocols can be live on the same universe, and a slow path can
        // deliver an older frame after a newer one. Relaying it would flicker
        // the rig backwards for a frame.
        const previous = this.#lastSequence.get(frame.universe);
        if (frame.sequence !== 0 && !isNewerSequence(previous, frame.sequence)) {
          this.#stats.droppedStale++;
          return;
        }
        this.#lastSequence.set(frame.universe, frame.sequence);

        this.#broadcast(encodeRelayFrame(frame.universe, frame.channels));
      });

      socket.on('error', (error) => {
        console.error(`[bridge] ${name} socket error: ${error.message}`);
        socket.close();
        resolve();
      });

      socket.bind(port, this.#options.host, () => {
        console.log(`[bridge] listening for ${name} on ${this.#options.host}:${port}`);
        this.#sockets.push(socket);
        resolve();
      });
    });
  }

  #broadcast(frame) {
    for (const client of this.#clients) {
      // readyState 1 is OPEN. Sending to a closing socket throws.
      if (client.readyState !== 1) continue;
      client.send(frame, { binary: true }, (error) => {
        if (error) console.error(`[bridge] send failed: ${error.message}`);
      });
    }
    this.#stats.relayed++;
  }

  async stop() {
    for (const socket of this.#sockets) socket.close();
    this.#sockets = [];

    for (const client of this.#clients) client.close(1001, 'bridge shutting down');
    this.#clients.clear();

    this.#wss?.close();
    this.#httpServer?.close();

    // Give the close frames a moment to flush before the process exits.
    await delay(50);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[bridge] ${error.message}`);
    process.exit(1);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const bridge = new FohBridge(options);
  await bridge.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[bridge] ${signal} received, shutting down.`);
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only run when executed directly, so the parsers above can be unit tested.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[bridge] fatal:', error);
    process.exit(1);
  });
}
