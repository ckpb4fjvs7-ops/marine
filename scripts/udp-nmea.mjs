/** Plain NMEA 0183 and IEC 61162-450 UdPbC frames, bounded per sender. */
export class UdpNmeaDecoder {
  tails = new Map();

  decode(bytes, sender, requireChecksum = true) {
    let text = Buffer.from(bytes).toString("ascii");
    const header = /^(UdPbC|RaUdP|RrUdP|NkPgN)\0/.exec(text);
    if (header && header[1] !== "UdPbC") return { lines: [], invalidChecksums: 0, format: header[1], unsupported: 1 };
    if (header) text = text.slice(6);
    text = text.replace(/\\[^\\\r\n]{0,512}\\/g, ""); // IEC TAG blocks, separate from sentence checksums.
    text = (this.tails.get(sender) ?? "") + text;
    this.tails.delete(sender);
    const starts = [...text.matchAll(/[$!][A-Z0-9]{5},/g)];
    const lines = [];
    let invalidChecksums = 0;
    for (let index = 0; index < starts.length && index < 256; index++) {
      const start = starts[index].index;
      const segment = text.slice(start, starts[index + 1]?.index ?? text.length);
      const end = segment.search(/[\r\n\0]/);
      const candidate = (end < 0 ? segment : segment.slice(0, end)).trim();
      if (candidate.length > 4096) continue;
      const star = candidate.indexOf("*");
      if (star >= 0 && candidate.length >= star + 3) {
        const sentence = candidate.slice(0, star + 3);
        const given = sentence.slice(star + 1);
        let checksum = 0;
        for (let i = 1; i < star; i++) checksum ^= sentence.charCodeAt(i);
        if (!/^[0-9a-f]{2}$/i.test(given) || parseInt(given, 16) !== checksum) { invalidChecksums++; continue; }
        lines.push(sentence);
      } else if (!requireChecksum && star < 0 && end >= 0) {
        lines.push(candidate);
      } else if (end < 0 && index === starts.length - 1) {
        this.tails.set(sender, candidate);
      } else invalidChecksums++;
    }
    if (this.tails.size > 32) this.tails.delete(this.tails.keys().next().value);
    return { lines, invalidChecksums, format: header ? "IEC 61162-450 / UdPbC" : "NMEA / UDP", unsupported: starts.length ? 0 : 1 };
  }
}
