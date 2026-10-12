/**
 * voice-note.js — recording a WhatsApp voice note in the browser (CP3).
 * WhatsApp needs an Ogg file with the Opus codec, in mono (Cloud API audio messages). Chrome and
 * Edge record Opus inside WebM, so the Opus packets are moved, unchanged, from WebM into Ogg here
 * (no new library: WebM/EBML is read, Ogg pages are written with their CRC). Firefox records Ogg
 * Opus itself. Safari records MP4/AAC, which goes as a normal audio file.
 * Used by inbox.js; the conversion is also tested on the server (tests/voiceNote.test.js).
 */
(function voiceNoteModule(root) {
  // --- WebM (EBML) ---------------------------------------------------------------------------------
  const ID = {
    EBML: 0x1a45dfa3, SEGMENT: 0x18538067, CLUSTER: 0x1f43b675, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, AUDIO: 0xe1,
    BLOCK_GROUP: 0xa0, TRACK_NUMBER: 0xd7, CODEC_ID: 0x86, CODEC_PRIVATE: 0x63a2, CODEC_DELAY: 0x56aa, CHANNELS: 0x9f,
    SIMPLE_BLOCK: 0xa3, BLOCK: 0xa1,
  };
  // Containers whose children are read in place (they may have an unknown size while recording).
  const CONTAINERS = new Set([ID.SEGMENT, ID.CLUSTER, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.BLOCK_GROUP]);

  // A variable-length integer: its length is told by the leading zero bits of the first byte.
  function readVint(bytes, pos, keepMarker) {
    const first = bytes[pos];
    if (first === undefined) return null;
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
    if (length > 8 || pos + length > bytes.length) return null;
    let value = keepMarker ? first : first & (0xff >> length);
    let allOnes = value === (0xff >> length);
    for (let i = 1; i < length; i += 1) {
      value = value * 256 + bytes[pos + i];
      if (bytes[pos + i] !== 0xff) allOnes = false;
    }
    return { value, length, unknown: !keepMarker && allOnes };
  }

  const readUint = (bytes, start, size) => {
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + bytes[start + i];
    return value;
  };

  // → { opusHead, channels, preSkip, packets: [Uint8Array] } of the first Opus track.
  function readWebmOpus(bytes) {
    const tracks = [];
    let track = null;
    const blocks = [];
    let pos = 0;
    while (pos < bytes.length) {
      const id = readVint(bytes, pos, true);
      if (!id) break;
      const size = readVint(bytes, pos + id.length, false);
      if (!size) break;
      const start = pos + id.length + size.length;
      const end = size.unknown ? bytes.length : Math.min(start + size.value, bytes.length);
      if (CONTAINERS.has(id.value)) {
        if (id.value === ID.TRACK_ENTRY) {
          track = { number: 0, codec: '', opusHead: null, channels: 0, codecDelay: 0 };
          tracks.push(track);
        }
        pos = start; // its children come next
        continue;
      }
      const data = bytes.subarray(start, end);
      if (id.value === ID.TRACK_NUMBER && track) track.number = readUint(data, 0, data.length);
      else if (id.value === ID.CODEC_ID && track) track.codec = String.fromCharCode(...data);
      else if (id.value === ID.CODEC_PRIVATE && track) track.opusHead = data.slice();
      else if (id.value === ID.CHANNELS && track) track.channels = readUint(data, 0, data.length);
      else if (id.value === ID.CODEC_DELAY && track) track.codecDelay = readUint(data, 0, data.length);
      else if (id.value === ID.SIMPLE_BLOCK || id.value === ID.BLOCK) blocks.push(data);
      if (size.unknown) break; // only containers can be open-ended
      pos = end;
    }
    const opus = tracks.find((t) => t.codec === 'A_OPUS');
    if (!opus) throw new Error('The recording has no Opus audio.');
    const packets = [];
    for (const block of blocks) {
      const trackNumber = readVint(block, 0, false);
      if (!trackNumber || trackNumber.value !== opus.number) continue;
      const flags = block[trackNumber.length + 2];
      if ((flags >> 1) & 3) throw new Error('Laced WebM blocks are not supported.'); // browsers do not lace audio
      packets.push(block.slice(trackNumber.length + 3));
    }
    const fromHead = opus.opusHead && String.fromCharCode(...opus.opusHead.subarray(0, 8)) === 'OpusHead' ? opus.opusHead : null;
    const channels = fromHead ? fromHead[9] : opus.channels || 1;
    const preSkip = fromHead ? fromHead[10] | (fromHead[11] << 8) : Math.round((opus.codecDelay * 48000) / 1e9) || 312;
    return { opusHead: fromHead || opusHeadFor(channels, preSkip), channels, preSkip, packets };
  }

  // --- Opus and Ogg (RFC 7845) -----------------------------------------------------------------------
  function opusHeadFor(channels, preSkip) {
    const head = new Uint8Array(19);
    head.set([...'OpusHead'].map((c) => c.charCodeAt(0)), 0);
    head[8] = 1;
    head[9] = channels;
    head[10] = preSkip & 0xff;
    head[11] = preSkip >> 8;
    new DataView(head.buffer).setUint32(12, 48000, true);
    return head;
  }

  function opusTags() {
    const vendor = [...'YELLOW CRM'].map((c) => c.charCodeAt(0));
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set([...'OpusTags'].map((c) => c.charCodeAt(0)), 0);
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    return tags; // no user comments
  }

  // Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 section 3.1).
  function packetSamples(packet) {
    if (!packet.length) return 0;
    const config = packet[0] >> 3;
    let frameMs;
    if (config < 12) frameMs = [10, 20, 40, 60][config % 4];
    else if (config < 16) frameMs = [10, 20][config % 2];
    else frameMs = [2.5, 5, 10, 20][config % 4];
    const code = packet[0] & 3;
    const frames = code === 0 ? 1 : code === 3 ? (packet[1] || 0) & 0x3f : 2;
    return Math.round(frames * frameMs * 48);
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let r = i << 24;
      for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      table[i] = r >>> 0;
    }
    return table;
  })();
  function oggCrc(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i += 1) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return crc >>> 0;
  }

  // One Ogg page with whole packets. headerType: 2 first page, 4 last page, 0 otherwise.
  function oggPage(packets, { headerType, granule, serial, sequence }) {
    const lacing = [];
    for (const packet of packets) {
      let left = packet.length;
      while (left >= 255) {
        lacing.push(255);
        left -= 255;
      }
      lacing.push(left);
    }
    const bodyLength = packets.reduce((sum, packet) => sum + packet.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLength);
    const view = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[5] = headerType;
    view.setUint32(6, granule % 0x100000000, true);
    view.setUint32(10, Math.floor(granule / 0x100000000), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const packet of packets) {
      page.set(packet, at);
      at += packet.length;
    }
    view.setUint32(22, oggCrc(page), true);
    return page;
  }

  const segmentsOf = (packet) => Math.floor(packet.length / 255) + 1;

  // Opus packets (and the OpusHead) → an Ogg Opus file.
  function writeOggOpus({ opusHead, packets }, serial = 0x59435243) {
    const pages = [oggPage([opusHead], { headerType: 2, granule: 0, serial, sequence: 0 }), oggPage([opusTags()], { headerType: 0, granule: 0, serial, sequence: 1 })];
    let sequence = 2;
    let granule = 0;
    let group = [];
    let segments = 0;
    const flush = (last) => {
      pages.push(oggPage(group, { headerType: last ? 4 : 0, granule, serial, sequence }));
      sequence += 1;
      group = [];
      segments = 0;
    };
    packets.forEach((packet, index) => {
      if (group.length && (segments + segmentsOf(packet) > 255 || group.length >= 50)) flush(false);
      group.push(packet);
      segments += segmentsOf(packet);
      granule += packetSamples(packet);
      if (index === packets.length - 1) flush(true);
    });
    if (!packets.length) pages.push(oggPage([], { headerType: 4, granule: 0, serial, sequence }));
    const out = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0));
    let at = 0;
    for (const page of pages) {
      out.set(page, at);
      at += page.length;
    }
    return out;
  }

  // A WebM recording (Chrome, Edge) → Ogg Opus bytes; throws when it cannot.
  function webmToOgg(webmBytes) {
    const opus = readWebmOpus(webmBytes instanceof Uint8Array ? webmBytes : new Uint8Array(webmBytes));
    if (opus.channels !== 1) throw new Error('WhatsApp voice notes must be mono.');
    if (!opus.packets.length) throw new Error('The recording is empty.');
    return writeOggOpus(opus);
  }

  // --- recording ------------------------------------------------------------------------------------
  // The microphone, made mono, recorded in the best format the browser has: Ogg (Firefox), WebM
  // (Chrome, Edge; converted to Ogg) or MP4 (Safari; sent as a normal audio file).
  const MAX_SECONDS = 5 * 60;
  const FORMATS = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'];
  const supported = () => typeof window !== 'undefined' && Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);

  async function startRecording({ onTick, onLimit } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.channelCountMode = 'explicit';
    destination.channelInterpretation = 'speakers';
    context.createMediaStreamSource(stream).connect(destination);
    const mimeType = FORMATS.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    // About 24 kbit/s: clear speech, and a 2-minute note stays under WhatsApp's 512 KB for the play button.
    const recorder = new MediaRecorder(destination.stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 24000 });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      onTick?.(seconds);
      if (seconds >= MAX_SECONDS) onLimit?.();
    }, 250);
    const release = () => {
      clearInterval(ticker);
      stream.getTracks().forEach((t) => t.stop());
      context.close().catch(() => {});
    };
    recorder.start(1000);
    return {
      cancel() {
        recorder.addEventListener('stop', release, { once: true });
        if (recorder.state !== 'inactive') recorder.stop();
        else release();
      },
      // → { file: File, voice: boolean } ready to upload.
      stop() {
        return new Promise((resolve, reject) => {
          recorder.addEventListener('stop', async () => {
            release();
            try {
              const type = recorder.mimeType || mimeType;
              const blob = new Blob(chunks, { type });
              if (/ogg/.test(type)) resolve({ file: new File([blob], 'voice-note.ogg', { type: 'audio/ogg' }), voice: true });
              else if (/webm/.test(type)) resolve({ file: new File([webmToOgg(new Uint8Array(await blob.arrayBuffer()))], 'voice-note.ogg', { type: 'audio/ogg' }), voice: true });
              else resolve({ file: new File([blob], 'voice-note.m4a', { type: 'audio/mp4' }), voice: false });
            } catch (error) {
              reject(error);
            }
          }, { once: true });
          recorder.stop();
        });
      },
    };
  }

  const api = { webmToOgg, readWebmOpus, writeOggOpus, packetSamples, oggCrc, startRecording, supported, MAX_SECONDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.crmVoiceNote = api;
}(typeof window !== 'undefined' ? window : globalThis));
