const { app, BrowserWindow, nativeImage } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const assetDir = path.join(projectRoot, "apps", "desktop", "assets");
const svgPath = path.join(assetDir, "forge-icon.svg");
const pngPath = path.join(assetDir, "forge-icon.png");
const icoPath = path.join(assetDir, "forge-icon.ico");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

function createIco(images) {
  const headerSize = 6;
  const directorySize = images.length * 16;
  let offset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(directorySize);
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

app.whenReady().then(async () => {
  const svg = readFileSync(svgPath, "utf8");
  const window = new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width: 512,
    height: 512,
    backgroundColor: "#00000000",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const document = `<!doctype html><style>html,body{width:512px;height:512px;margin:0;overflow:hidden;background:transparent}svg{display:block;width:512px;height:512px}</style>${svg}`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
  window.showInactive();
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const rendered = await window.webContents.capturePage();
  window.destroy();
  const source = nativeImage.createFromBuffer(rendered.toPNG());
  if (source.isEmpty()) throw new Error("Forge SVG could not be rendered");
  writeFileSync(pngPath, source.toPNG());
  const images = iconSizes.map((size) => ({
    size,
    png: source.resize({ width: size, height: size, quality: "best" }).toPNG(),
  }));
  writeFileSync(icoPath, createIco(images));
  console.log(`Generated Forge brand assets: ${path.relative(projectRoot, icoPath)}`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
