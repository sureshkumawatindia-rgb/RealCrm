const path = require('path');
const voice = require(path.join(__dirname, '../../../crm/frontend/js/voice-note.js'));
const { isOggOpusMono } = require('../utils/oggOpus');

// The browser's WebM → Ogg Opus conversion for voice notes (CP3, crm/frontend/js/voice-note.js).
// A small WebM like Chrome's MediaRecorder makes: a Segment and Clusters of unknown size,
// an Opus track with its OpusHead, and SimpleBlocks without lacing.
const vint = (n) => {
  for (let length = 1; length <= 8; length += 1) {
    if (n < 2 ** (7 * length) - 1) {
      const bytes = [];
      let v = n;
      for (let i = 0; i < length; i += 1) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      }
      bytes[0] |= 0x80 >> (length - 1);
      return bytes;
    }
  }
  throw new Error('too big');
};
const idBytes = (id) => {
  const bytes = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return bytes;
};
const el = (id, data) => Buffer.from([...idBytes(id), ...vint(data.length), ...data]);
const unknown = (id, children) => Buffer.concat([Buffer.from([...idBytes(id), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...children]);
const uint = (n) => [n];

function opusHead(channels) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  return head;
}

// packets: Opus packets; TOC 0x08 = SILK, 20 ms, one frame (960 samples at 48 kHz).
function webm({ channels = 1, packets }) {
  const track = el(0xae, Buffer.concat([
    el(0xd7, uint(1)),
    el(0x86, Buffer.from('A_OPUS')),
    el(0x63a2, opusHead(channels)),
    el(0xe1, el(0x9f, uint(channels))),
  ]));
  const blocks = packets.map((packet, i) => el(0xa3, Buffer.from([0x81, 0x00, i * 20, 0x80, ...packet])));
  return Buffer.concat([
    el(0x1a45dfa3, el(0x4282, Buffer.from('webm'))),
    unknown(0x18538067, [el(0x1654ae6b, track), unknown(0x1f43b675, [el(0xe7, uint(0)), ...blocks])]),
  ]);
}

// Reads every Ogg page back: header fields, packets, and whether its CRC is right.
function pages(bytes) {
  const out = [];
  let pos = 0;
  while (pos < bytes.length) {
    expect(bytes.toString('latin1', pos, pos + 4)).toBe('OggS');
    const count = bytes[pos + 26];
    const lacing = [...bytes.subarray(pos + 27, pos + 27 + count)];
    const length = 27 + count + lacing.reduce((a, b) => a + b, 0);
    const page = Buffer.from(bytes.subarray(pos, pos + length));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    const packets = [];
    let at = 27 + count;
    let size = 0;
    for (const l of lacing) {
      size += l;
      if (l < 255) {
        packets.push(page.subarray(at, at + size));
        at += size;
        size = 0;
      }
    }
    out.push({ headerType: page[5], granule: page.readUInt32LE(6), crcOk: voice.oggCrc(page) === crc, packets });
    pos += length;
  }
  return out;
}

describe('Voice notes: WebM recording → Ogg Opus for WhatsApp', () => {
  it('moves every Opus packet into Ogg pages with the head, the tags, timing and CRCs', () => {
    const packets = Array.from({ length: 120 }, (_, i) => [0x08, ...Array.from({ length: 30 + (i % 7) }, (__, j) => (i + j) & 0xff)]);
    packets.push([0x08, ...Array.from({ length: 300 }, (_, j) => j & 0xff)]); // a packet longer than 255 bytes
    const ogg = Buffer.from(voice.webmToOgg(webm({ packets })));

    expect(isOggOpusMono(ogg)).toBe(true);
    const all = pages(ogg);
    expect(all.every((page) => page.crcOk)).toBe(true);
    expect(all[0]).toMatchObject({ headerType: 2, granule: 0 });
    expect(all[0].packets[0].toString('latin1', 0, 8)).toBe('OpusHead');
    expect(all[1].packets[0].toString('latin1', 0, 8)).toBe('OpusTags');
    expect(all.at(-1).headerType).toBe(4); // the last page
    expect(all.at(-1).granule).toBe(packets.length * 960); // 20 ms each at 48 kHz
    const audio = all.slice(2).flatMap((page) => page.packets.map((p) => [...p]));
    expect(audio).toEqual(packets);
  });

  it('refuses a stereo recording and a recording without Opus', () => {
    expect(() => voice.webmToOgg(webm({ channels: 2, packets: [[0x08, 1, 2, 3]] }))).toThrow('mono');
    expect(() => voice.webmToOgg(Buffer.from('not a webm file at all'))).toThrow();
  });

  it('counts the samples of Opus packets from their TOC byte', () => {
    expect(voice.packetSamples(Uint8Array.from([0x08]))).toBe(960); // SILK 20 ms
    expect(voice.packetSamples(Uint8Array.from([0xf8]))).toBe(960); // CELT 20 ms
    expect(voice.packetSamples(Uint8Array.from([0x09]))).toBe(1920); // two frames
    expect(voice.packetSamples(Uint8Array.from([0x0b, 0x03]))).toBe(2880); // code 3, three frames
  });
});
