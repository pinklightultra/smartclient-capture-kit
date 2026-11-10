#!/usr/bin/env bash
# Rebuild docs/media/demo.gif from a real run.
#
# Requires, on PATH: node, ffmpeg, asciinema (2.x), and agg
# (https://github.com/asciinema/agg). Chromium must already be installed
# for Playwright (`npx playwright install chromium`).
#
# The recording is scripts/demo-capture.js. It calls safeShot. The cast is
# not edited. agg plays it at 1x and holds the last terminal frame so the
# refusal can be read. The before/after frames are the PNGs that run wrote:
# before.png is a page screenshot, roster.png is the file safeShot wrote
# after the cover verified.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

for cmd in node ffmpeg asciinema agg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "record-demo: missing $cmd on PATH" >&2
    exit 1
  fi
done

OUT_DIR=/tmp/kit-demo
CAST=/tmp/kit-demo.cast
TERM_GIF=/tmp/kit-demo-term.gif
BEFORE_FRAME=/tmp/kit-demo-before-frame.png
AFTER_FRAME=/tmp/kit-demo-after-frame.png
GIF="$ROOT/docs/media/demo.gif"
SESSION=$(mktemp)
trap 'rm -f "$SESSION"' EXIT

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$ROOT/docs/media"

cat > "$SESSION" <<EOF
#!/bin/bash
cd $(printf '%q' "$ROOT")
printf '%s\n' '$ node scripts/demo-capture.js /tmp/kit-demo'
node scripts/demo-capture.js /tmp/kit-demo
status=\$?
if [[ \$status -ne 0 ]]; then
  exit "\$status"
fi
EOF
chmod +x "$SESSION"

asciinema rec --quiet --overwrite --cols 80 --rows 12 \
  -c "$SESSION" "$CAST"

if [[ ! -f "$OUT_DIR/roster.png" || ! -f "$OUT_DIR/before.png" ]]; then
  echo "record-demo: the run did not write before.png and roster.png" >&2
  exit 1
fi
if [[ -f "$OUT_DIR/cover-unverifiable.png" ]]; then
  echo "record-demo: cover-unverifiable.png was written; the refusal failed" >&2
  exit 1
fi

agg --font-size 15 --line-height 1.35 --theme asciinema \
  --speed 1 --idle-time-limit 5 --last-frame-duration 5 --fps-cap 12 \
  "$CAST" "$TERM_GIF"

read -r W H < <(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=p=0:s=x "$TERM_GIF" | awk -F x '{print $1, $2}')

node - "$OUT_DIR/before.png" "$OUT_DIR/roster.png" "$BEFORE_FRAME" "$AFTER_FRAME" "$W" "$H" <<'JS'
const sharp = require('sharp');
const [beforeSrc, afterSrc, beforeDest, afterDest, widthRaw, heightRaw] = process.argv.slice(2);
const width = Number(widthRaw);
const height = Number(heightRaw);
const captionH = 34;

async function frame(src, caption, dest) {
  const meta = await sharp(src).metadata();
  const availW = width;
  const availH = height - captionH;
  const scale = Math.min(availW / meta.width, availH / meta.height);
  const iw = Math.max(1, Math.round(meta.width * scale));
  const ih = Math.max(1, Math.round(meta.height * scale));
  const img = await sharp(src).resize(iw, ih).png().toBuffer();
  const svg = Buffer.from(
    `<svg width="${width}" height="${captionH}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="100%" height="100%" fill="#143044"/>` +
    `<text x="12" y="23" fill="#ffffff" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="15">${caption}</text>` +
    `</svg>`
  );
  await sharp({
    create: { width, height, channels: 4, background: '#e6eef5' },
  }).composite([
    { input: svg, left: 0, top: 0 },
    { input: img, left: Math.floor((width - iw) / 2), top: captionH + Math.floor((availH - ih) / 2) },
  ]).png().toFile(dest);
}

Promise.all([
  frame(beforeSrc, 'Before: fictional roster. Page screenshot, not a capture.', beforeDest),
  frame(afterSrc, 'After: roster.png. Cover verified, then the file was written.', afterDest),
]).catch((error) => {
  console.error(error);
  process.exit(1);
});
JS

ffmpeg -y -loglevel error \
  -i "$TERM_GIF" \
  -loop 1 -t 3.2 -i "$BEFORE_FRAME" \
  -loop 1 -t 3.2 -i "$AFTER_FRAME" \
  -filter_complex "\
    [0:v]fps=12,scale=${W}:${H}:flags=lanczos,setsar=1[v0];\
    [1:v]fps=12,scale=${W}:${H}:flags=lanczos,setsar=1[v1];\
    [2:v]fps=12,scale=${W}:${H}:flags=lanczos,setsar=1[v2];\
    [v0][v1][v2]concat=n=3:v=1:a=0,split[s0][s1];\
    [s0]palettegen=max_colors=96:stats_mode=diff[p];\
    [s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle\
  " \
  -loop 0 "$GIF"

python3 - "$GIF" <<'PY'
import os, struct, sys
path = sys.argv[1]
data = open(path, 'rb').read()
if data[:6] not in (b'GIF87a', b'GIF89a'):
    raise SystemExit('not a gif')
width, height, packed = struct.unpack_from('<HHB', data, 6)
i = 13
if packed & 0x80:
    i += 3 * (2 << (packed & 7))
frames = 0
centiseconds = 0
delay = 0
while i < len(data):
    block = data[i]
    if block == 0x3B:
        break
    if block == 0x21:
        ext = data[i + 1]
        if ext == 0xF9:
            delay = struct.unpack_from('<H', data, i + 4)[0]
            i += 8
            continue
        i += 2
        while data[i] != 0:
            i += 1 + data[i]
        i += 1
        continue
    if block == 0x2C:
        frames += 1
        centiseconds += delay or 10
        image_packed = data[i + 9]
        i += 10
        if image_packed & 0x80:
            i += 3 * (2 << (image_packed & 7))
        i += 1  # LZW minimum code size
        while data[i] != 0:
            i += 1 + data[i]
        i += 1
        continue
    raise SystemExit(f'unexpected gif block {block:#x} at {i}')
seconds = centiseconds / 100
size = os.path.getsize(path)
print(f'frames={frames} duration={seconds:.2f}s size={size} bytes {width}x{height}')
if seconds > 15:
    raise SystemExit(f'gif is {seconds:.2f}s, over 15s')
if size > 3 * 1024 * 1024:
    raise SystemExit(f'gif is {size} bytes, over 3MB')
PY

echo "wrote $GIF"
