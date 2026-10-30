// Draws build/icon.png (1024px) from the app icon. electron-builder turns it into .icns and .ico.
import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';

await mkdir('build', { recursive: true });
const svg = await readFile('src/renderer/assets/icon.svg');
await sharp(svg, { density: 768 }).resize(1024, 1024).png().toFile('build/icon.png');
console.log('build/icon.png');
