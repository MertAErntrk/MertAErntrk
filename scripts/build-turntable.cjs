const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

// Offline asset build requires sharp; normal builds use the committed atlas.
const root = path.resolve(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'assets/avatar-turntable.json'), 'utf8'));
const size = 224;
const fps = 3;
const count = source.order.length;
const columns = 4;
const rows = Math.ceil(count / columns);

async function build() {
  const atlas = fs.readFileSync(path.join(root, 'assets', source.image)).toString('base64');
  const frames = [];
  for (const cell of source.order) {
    const frame = source.frames[cell];
    const [x, y, width, height] = frame.crop;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="' + frame.viewBox.join(' ') + '">' +
      '<defs><clipPath id="crop"><rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '"/></clipPath></defs>' +
      '<image width="' + source.width + '" height="' + source.height + '" clip-path="url(#crop)" href="data:image/png;base64,' + atlas + '"/></svg>';
    frames.push(await sharp(Buffer.from(svg)).png().toBuffer());
  }
  // Keep only the original views: no blending or motion-estimated in-between frames.
  const composites = frames.map((input, index) => ({ input, left: index % columns * size, top: Math.floor(index / columns) * size }));
  const image = 'avatar-rotation.webp';
  await sharp({ create: { width: size * columns, height: size * rows, channels: 4, background: '#00000000' } })
    .composite(composites).webp({ lossless: true, effort: 6 }).toFile(path.join(root, 'assets', image));
  const metadata = {
    image, mime: 'image/webp', size, columns, rows, frames: count, fps,
    durationMs: count / fps * 1000,
    width: size * columns, height: size * rows,
    source: 'avatar-turntable.json',
    interpolation: 'none',
    lossless: true,
  };
  fs.writeFileSync(path.join(root, 'assets/avatar-rotation.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ ...metadata, bytes: fs.statSync(path.join(root, 'assets', image)).size }));
}

build().catch(error => { console.error(error); process.exitCode = 1; });
