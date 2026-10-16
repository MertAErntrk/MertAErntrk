const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

// Offline asset build: requires sharp and FFmpeg 7+ with minterpolate (FFMPEG_PATH).
// Normal profile builds consume the committed atlas and need neither dependency.
const root = path.resolve(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'assets/avatar-turntable.json'), 'utf8'));
const work = path.join(root, 'previews/turntable-build');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const renderSize = 224;
const size = 192;
const sourceFps = 3;
const fps = 24;
const count = source.order.length * fps / sourceFps;
const columns = 16;
const rows = count / columns;

async function build() {
  fs.mkdirSync(work, { recursive: true });
  const atlas = fs.readFileSync(path.join(root, 'assets', source.image)).toString('base64');
  const frames = [];
  for (const cell of source.order) {
    const frame = source.frames[cell];
    const [x, y, width, height] = frame.crop;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + renderSize + '" height="' + renderSize + '" viewBox="' + frame.viewBox.join(' ') + '">' +
      '<defs><clipPath id="crop"><rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '"/></clipPath></defs>' +
      '<image width="' + source.width + '" height="' + source.height + '" clip-path="url(#crop)" href="data:image/png;base64,' + atlas + '"/></svg>';
    frames.push(await sharp(Buffer.from(svg)).png().toBuffer());
  }
  // A full cycle on each side supplies motion estimation context at the loop seam.
  for (let index = 0; index < source.order.length * 3; index++) {
    fs.writeFileSync(path.join(work, 'source-' + String(index).padStart(3, '0') + '.png'), frames[index % frames.length]);
  }
  const interpolate = 'minterpolate=fps=' + fps + ':mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none';
  const filter = '[0:v]split[color][alpha];[color]format=yuv444p,' + interpolate + '[rgb];' +
    '[alpha]alphaextract,format=yuv444p,' + interpolate + ',format=gray[a];' +
    '[rgb][a]alphamerge,trim=start_frame=' + count + ':end_frame=' + (count * 2) + ',setpts=PTS-STARTPTS[out]';
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', '-filter_complex_threads', '2',
    '-framerate', String(sourceFps), '-i', path.join(work, 'source-%03d.png'), '-filter_complex', filter,
    '-map', '[out]', '-fps_mode', 'passthrough', '-frames:v', String(count), '-start_number', '0', path.join(work, 'smooth-%03d.png')], { stdio: 'inherit' });
  const composites = [];
  for (let index = 0; index < count; index++) {
    const input = await sharp(path.join(work, 'smooth-' + String(index).padStart(3, '0') + '.png')).resize(size, size).png().toBuffer();
    composites.push({ input, left: index % columns * size, top: Math.floor(index / columns) * size });
  }
  const image = 'avatar-rotation.webp';
  await sharp({ create: { width: size * columns, height: size * rows, channels: 4, background: '#00000000' } })
    .composite(composites).webp({ quality: 72, alphaQuality: 100, effort: 6 }).toFile(path.join(root, 'assets', image));
  const metadata = {
    image, mime: 'image/webp', size, columns, rows, frames: count, fps,
    durationMs: count / fps * 1000,
    width: size * columns, height: size * rows,
    source: 'avatar-turntable.json',
    interpolation: 'FFmpeg minterpolate, motion-compensated RGB and alpha, circular padding',
  };
  fs.writeFileSync(path.join(root, 'assets/avatar-rotation.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ ...metadata, bytes: fs.statSync(path.join(root, 'assets', image)).size }));
}

build().catch(error => { console.error(error); process.exitCode = 1; });
