// LETTORE ZIP minimo (solo lettura in memoria, nessuna estrazione su disco), al posto della libreria adm-zip.
// Perché: adm-zip ha avuto più vulnerabilità (zip bomb con dimensione dichiarata falsa, errori asincroni che fermano il processo, percorsi e
// link simbolici in estrazione). Qui serve solo leggere i file di testo dei GTFS ACTV: lo fa zlib di Node, con limiti rigidi.
//   · si leggono solo le voci del «central directory» (fine del file), metodi 0 (stored) e 8 (deflate); niente cifratura, niente ZIP64;
//   · ogni file decompresso ha un tetto (ENTRY_MAX) imposto a zlib (maxOutputLength): la dimensione dichiarata nello ZIP non è creduta;
//     il risultato deve poi coincidere con quella dichiarata e con il CRC-32 (zlib.crc32, Node ≥ 22.2);
//   · al massimo MAX_ENTRIES voci; nomi solo come testo (nessun percorso su disco); errori sempre sincroni (try/catch di chi chiama).
// Interfaccia compatibile con l'uso che se ne faceva: new Zip(buffer | percorso).getEntries() -> [{ entryName, size, getData() }].
const fs = require('fs');
const zlib = require('zlib');

const LIMITS = { ENTRY_MAX: 256 * 1024 * 1024, TOTAL_MAX: 768 * 1024 * 1024, MAX_ENTRIES: 2000, FILE_MAX: 512 * 1024 * 1024 };
const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50, SIG_Z64_LOC = 0x07064b50;

class Zip {
  constructor(src) {
    const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(String(src));
    if (buf.length > LIMITS.FILE_MAX) throw new Error('file ZIP troppo grande');
    if (buf.length < 22) throw new Error('non è un file ZIP');
    this.buf = buf; this.total = 0; this.entries = this.#central();
  }
  // fine dell'archivio: firma EOCD negli ultimi 64 KB + 22 byte (commento al massimo 65535 byte)
  #central() {
    const b = this.buf, stop = Math.max(0, b.length - 22 - 0xffff);
    let e = -1;
    for (let i = b.length - 22; i >= stop; i--) if (b.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
    if (e < 0) throw new Error('fine dell\'archivio ZIP non trovata');
    if (e >= 20 && b.readUInt32LE(e - 20) === SIG_Z64_LOC) throw new Error('ZIP64 non supportato');
    const count = b.readUInt16LE(e + 10), size = b.readUInt32LE(e + 12), off = b.readUInt32LE(e + 16);
    if (count > LIMITS.MAX_ENTRIES) throw new Error('troppe voci nello ZIP');
    if (off + size > e) throw new Error('indice dello ZIP non valido');
    const out = [];
    for (let p = off, k = 0; k < count; k++) {
      if (p + 46 > e || b.readUInt32LE(p) !== SIG_CEN) throw new Error('voce dell\'indice ZIP non valida');
      const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16);
      const csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
      const loc = b.readUInt32LE(p + 42), end = p + 46 + nlen + xlen + clen;
      if (end > e) throw new Error('voce dell\'indice ZIP non valida');
      const name = b.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
      out.push(new Entry(this, { name, flags, method, crc, csize, usize, loc }));
      p = end;
    }
    return out;
  }
  getEntries() { return this.entries; }
}

class Entry {
  constructor(zip, h) { this.zip = zip; this.h = h; this.entryName = h.name; this.size = h.usize; this.isDirectory = h.name.endsWith('/'); }
  getData() {
    const { zip, h } = this, b = zip.buf;
    if (this.isDirectory) return Buffer.alloc(0);
    if (h.flags & 0x1) throw new Error(`${h.name}: file cifrato`);
    if (h.method !== 0 && h.method !== 8) throw new Error(`${h.name}: compressione ${h.method} non supportata`);
    if (h.usize > LIMITS.ENTRY_MAX) throw new Error(`${h.name}: file troppo grande`);
    if (h.loc + 30 > b.length || b.readUInt32LE(h.loc) !== SIG_LOC) throw new Error(`${h.name}: intestazione locale non valida`);
    const start = h.loc + 30 + b.readUInt16LE(h.loc + 26) + b.readUInt16LE(h.loc + 28);
    if (start + h.csize > b.length) throw new Error(`${h.name}: dati troncati`);
    const raw = b.subarray(start, start + h.csize);
    let data;
    if (h.method === 0) data = Buffer.from(raw);
    else {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(LIMITS.ENTRY_MAX, Math.max(h.usize, 1)) }); }
      catch (e) { throw new Error(`${h.name}: decompressione non riuscita (${e.code || e.message})`); }
    }
    if (data.length !== h.usize) throw new Error(`${h.name}: dimensione diversa da quella dichiarata`);
    if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== h.crc) throw new Error(`${h.name}: CRC non valido`);
    zip.total += data.length;
    if (zip.total > LIMITS.TOTAL_MAX) throw new Error('troppi dati decompressi dallo ZIP');
    return data;
  }
}

module.exports = { Zip, LIMITS };
