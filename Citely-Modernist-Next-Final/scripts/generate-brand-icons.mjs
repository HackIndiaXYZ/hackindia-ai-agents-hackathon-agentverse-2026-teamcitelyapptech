// Rasterize the approved SVG; never reconstruct its paths or colours.
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
const svg = await readFile(new URL('../public/branding/citely-04-app-tile.svg', import.meta.url));
for (const size of [16, 32, 180, 192, 512]) {
  const png = await sharp(svg, { density: 192 }).resize(size, size).png().toBuffer();
  await writeFile(new URL(`../public/branding/app-icon-${size}.png`, import.meta.url), png);
  if (size === 180) {
    await writeFile(new URL('../app/apple-icon.png', import.meta.url), png);
    await writeFile(new URL('../public/apple-touch-icon.png', import.meta.url), png);
  }
}
