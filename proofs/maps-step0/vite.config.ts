import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

const TILE_SIZE = 256;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const contents = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(contents));
  return Buffer.concat([length, contents, checksum]);
}

function solidTile(red: number, green: number, blue: number): Buffer {
  const rowLength = 1 + TILE_SIZE * 4;
  const pixels = Buffer.alloc(rowLength * TILE_SIZE);
  for (let row = 0; row < TILE_SIZE; row += 1) {
    const offset = row * rowLength + 1;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const pixel = offset + column * 4;
      pixels[pixel] = red;
      pixels[pixel + 1] = green;
      pixels[pixel + 2] = blue;
      pixels[pixel + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(TILE_SIZE, 0);
  header.writeUInt32BE(TILE_SIZE, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function localPictureTiles(): Plugin {
  const tiles = {
    A: solidTile(48, 132, 180),
    B: solidTile(221, 112, 58),
  };

  function serveTileFixtures(server: Pick<ViteDevServer, 'middlewares'>, serveHealthy: boolean): void {
    server.middlewares.use((request, response, next) => {
      const match = request.url?.match(/^\/tiles\/(A|B)(-outage)?\.png(?:\?.*)?$/);
      if (!match || (!match[2] && !serveHealthy)) return next();

      response.setHeader('Cache-Control', 'no-store');
      if (match[2]) {
        response.statusCode = 503;
        response.end('Simulated provider outage');
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/png');
      response.end(tiles[match[1] as keyof typeof tiles]);
    });
  }

  return {
    name: 'maps-step0-local-picture-tiles',
    configureServer: (server) => serveTileFixtures(server, true),
    configurePreviewServer: (server) => serveTileFixtures(server, false),
    generateBundle() {
      for (const [picture, source] of Object.entries(tiles)) {
        this.emitFile({ type: 'asset', fileName: `tiles/${picture}.png`, source });
      }
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [localPictureTiles()],
  build: { target: ['chrome107', 'edge107', 'firefox104', 'safari16'] },
  server: { host: '127.0.0.1' },
});
