// LETTORE ZIP interno (zip.js, al posto di adm-zip): file veri, dimensioni dichiarate false («zip bomb»), file non ZIP o troncati.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { Zip } = require('../zip');

// ZIP con una voce deflate; usize = dimensione dichiarata (anche falsa), crc = CRC dichiarato
function mk(content, { usize = content.length, crc = zlib.crc32(content), name = 'stop_times.txt', method = 8 } = {}) {
  const d = method === 8 ? zlib.deflateRawSync(content) : content, nm = Buffer.from(name);
  const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(method, 8); loc.writeUInt32LE(d.length, 18); loc.writeUInt32LE(usize, 22); loc.writeUInt16LE(nm.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(method, 10); cen.writeUInt32LE(crc >>> 0, 16); cen.writeUInt32LE(d.length, 20); cen.writeUInt32LE(usize, 24); cen.writeUInt16LE(nm.length, 28);
  const body = Buffer.concat([loc, nm, d]), cd = Buffer.concat([cen, nm]), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}
const text = Buffer.from('trip_id,stop_id\n'.repeat(5000));

test('ZIP valido (deflate e stored): nomi e contenuto', () => {
  for (const method of [8, 0]) {
    const e = new Zip(mk(text, { method })).getEntries();
    assert.equal(e.length, 1); assert.equal(e[0].entryName, 'stop_times.txt'); assert.ok(e[0].getData().equals(text));
  }
});
test('zip bomb: dimensione dichiarata falsa (0 o più piccola) -> rifiutato senza decomprimere tutto', () => {
  const big = Buffer.alloc(8e6, 65);
  for (const usize of [0, 1000]) assert.throws(() => new Zip(mk(big, { usize })).getEntries()[0].getData(), /decompressione non riuscita/);
});
test('CRC sbagliato, file non ZIP, troncato: errore chiaro (mai un crash del processo)', () => {
  assert.throws(() => new Zip(mk(text, { crc: 1234 })).getEntries()[0].getData(), /CRC/);
  assert.throws(() => new Zip(Buffer.from('non sono uno zip, davvero')), /ZIP/);
  const z = mk(text); assert.throws(() => new Zip(z.subarray(0, z.length - 30)), /ZIP/);
});
