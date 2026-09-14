/**
 * FOH bridge wire-protocol tests.
 *
 * The parsers sit between a lighting console and the visualizer, on a port that
 * also carries discovery and sync traffic. A parser that is merely permissive
 * relays garbage as dimmer levels, so these tests care as much about what is
 * REJECTED as about what is decoded.
 *
 * Plain JavaScript rather than TypeScript because the daemon it covers is a
 * Node script, not part of the browser bundle.
 */

import { describe, expect, it } from 'vitest';

import {
  encodeRelayFrame,
  isNewerSequence,
  parseArtDmx,
  parseSacn,
} from '../scripts/foh_bridge_daemon.js';

/** Build a well-formed Art-Net 4 ArtDmx packet. */
function artDmx({ universe = 1, sequence = 1, channels = [10, 20] } = {}) {
  const packet = Buffer.alloc(18 + channels.length);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8); // OpDmx
  packet.writeUInt16BE(14, 10); // protocol version
  packet.writeUInt8(sequence, 12);
  packet.writeUInt8(0, 13); // physical
  packet.writeUInt16LE(universe, 14);
  packet.writeUInt16BE(channels.length, 16);
  Buffer.from(channels).copy(packet, 18);
  return packet;
}

/** Build a well-formed sACN / E1.31 data packet. */
function sacn({ universe = 1, sequence = 1, channels = [10, 20], options = 0, startCode = 0 } = {}) {
  const packet = Buffer.alloc(126 + channels.length);
  packet.writeUInt16BE(0x0010, 0); // preamble size
  packet.writeUInt16BE(0x0000, 2); // postamble size
  Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0]).copy(packet, 4);
  packet.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
  packet.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
  packet.writeUInt8(100, 108); // priority
  packet.writeUInt8(sequence, 111);
  packet.writeUInt8(options, 112);
  packet.writeUInt16BE(universe, 113);
  packet.writeUInt8(0x02, 117); // VECTOR_DMP_SET_PROPERTY
  packet.writeUInt8(0xa1, 118);
  packet.writeUInt16BE(channels.length + 1, 123); // includes the start code
  packet.writeUInt8(startCode, 125);
  Buffer.from(channels).copy(packet, 126);
  return packet;
}

describe('parseArtDmx', () => {
  it('decodes universe, sequence and levels from a valid frame', () => {
    const frame = parseArtDmx(artDmx({ universe: 7, sequence: 42, channels: [255, 0, 128, 64] }));

    expect(frame).not.toBeNull();
    expect(frame.universe).toBe(7);
    expect(frame.sequence).toBe(42);
    expect(Array.from(frame.channels)).toEqual([255, 0, 128, 64]);
  });

  it('masks the Port-Address to 15 bits', () => {
    // The top bit of the 16-bit field is not part of the address.
    const frame = parseArtDmx(artDmx({ universe: 0x8001 }));
    expect(frame.universe).toBe(1);
  });

  it('rejects a packet that is not Art-Net', () => {
    const packet = artDmx();
    packet.write('Art-Nut\0', 0, 'ascii');
    expect(parseArtDmx(packet)).toBeNull();
  });

  it('rejects a non-ArtDmx opcode such as ArtPoll', () => {
    const packet = artDmx();
    packet.writeUInt16LE(0x2000, 8); // OpPoll
    expect(parseArtDmx(packet)).toBeNull();
  });

  it('rejects a protocol revision older than Art-Net 4', () => {
    const packet = artDmx();
    packet.writeUInt16BE(13, 10);
    expect(parseArtDmx(packet)).toBeNull();
  });

  it('rejects an odd length, which the specification forbids', () => {
    const packet = artDmx({ channels: [1, 2, 3, 4] });
    packet.writeUInt16BE(3, 16);
    expect(parseArtDmx(packet)).toBeNull();
  });

  it('rejects a length that runs past the end of the packet', () => {
    const packet = artDmx({ channels: [1, 2] });
    packet.writeUInt16BE(512, 16);
    expect(parseArtDmx(packet)).toBeNull();
  });

  it('rejects a truncated packet', () => {
    expect(parseArtDmx(artDmx().subarray(0, 12))).toBeNull();
  });
});

describe('parseSacn', () => {
  it('decodes universe, sequence and levels from a valid frame', () => {
    const frame = parseSacn(sacn({ universe: 300, sequence: 9, channels: [1, 2, 3] }));

    expect(frame).not.toBeNull();
    expect(frame.universe).toBe(300);
    expect(frame.sequence).toBe(9);
    expect(Array.from(frame.channels)).toEqual([1, 2, 3]);
  });

  it('accepts a universe above the Art-Net range', () => {
    // sACN addresses up to 63999; clamping to Art-Net's 32767 would drop these.
    const frame = parseSacn(sacn({ universe: 40000 }));
    expect(frame.universe).toBe(40000);
  });

  it('rejects a preview frame, which is not what the rig is outputting', () => {
    expect(parseSacn(sacn({ options: 0x80 }))).toBeNull();
  });

  it('rejects a stream-terminated frame', () => {
    expect(parseSacn(sacn({ options: 0x40 }))).toBeNull();
  });

  it('rejects a non-zero start code, which is RDM rather than levels', () => {
    expect(parseSacn(sacn({ startCode: 0xcc }))).toBeNull();
  });

  it('rejects a packet whose ACN identifier is wrong', () => {
    const packet = sacn();
    packet.write('BAD-E1.17\0\0\0', 4, 'ascii');
    expect(parseSacn(packet)).toBeNull();
  });

  it('rejects a sync packet, whose framing vector differs', () => {
    const packet = sacn();
    packet.writeUInt32BE(0x00000001, 40); // VECTOR_E131_EXTENDED_SYNCHRONIZATION
    expect(parseSacn(packet)).toBeNull();
  });

  it('rejects a truncated packet', () => {
    expect(parseSacn(sacn().subarray(0, 80))).toBeNull();
  });
});

describe('isNewerSequence', () => {
  it('accepts the first frame seen for a universe', () => {
    expect(isNewerSequence(undefined, 0)).toBe(true);
  });

  it('accepts a straightforward increment', () => {
    expect(isNewerSequence(10, 11)).toBe(true);
  });

  it('rejects a repeat of the current sequence', () => {
    expect(isNewerSequence(10, 10)).toBe(false);
  });

  it('rejects a frame that arrived out of order', () => {
    expect(isNewerSequence(10, 9)).toBe(false);
  });

  it('accepts the wrap from 255 to 0 rather than stalling the universe', () => {
    expect(isNewerSequence(255, 0)).toBe(true);
    expect(isNewerSequence(250, 3)).toBe(true);
  });

  it('accepts a large backward jump as a source restart', () => {
    // Refusing this would wedge the universe until the counter caught up.
    expect(isNewerSequence(10, 200)).toBe(false);
    expect(isNewerSequence(200, 10)).toBe(true);
  });
});

describe('encodeRelayFrame', () => {
  it('writes the universe and channel count into a fixed four-byte header', () => {
    const frame = encodeRelayFrame(513, Buffer.from([7, 8, 9]));

    expect(frame.readUInt16BE(0)).toBe(513);
    expect(frame.readUInt16BE(2)).toBe(3);
    expect(Array.from(frame.subarray(4))).toEqual([7, 8, 9]);
    expect(frame.length).toBe(7);
  });

  it('round-trips a full universe', () => {
    const channels = Buffer.alloc(512);
    channels[0] = 255;
    channels[511] = 128;

    const frame = encodeRelayFrame(1, channels);

    expect(frame.length).toBe(516);
    expect(frame.readUInt16BE(2)).toBe(512);
    expect(frame[4]).toBe(255);
    expect(frame[515]).toBe(128);
  });
});
