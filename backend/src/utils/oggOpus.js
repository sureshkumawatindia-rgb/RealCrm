// What WhatsApp needs for a voice note (Cloud API audio messages, checked 2026-10-12): an Ogg
// file with the Opus codec, mono. The first Ogg page holds the OpusHead packet: "OpusHead",
// version, then the channel count.
function isOggOpusMono(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 47) return false;
  if (buffer.toString('latin1', 0, 4) !== 'OggS') return false;
  const payload = 27 + buffer[26]; // page header + its segment table
  if (buffer.length < payload + 19) return false;
  return buffer.toString('latin1', payload, payload + 8) === 'OpusHead' && buffer[payload + 9] === 1;
}

module.exports = { isOggOpusMono };
