const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const url = require("url");
const fs = require("fs");
const crypto = require("crypto");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
    frame: false,
  });

  mainWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, "index.html"),
      protocol: "file:",
      slashes: true,
    }),
  );

  // 개발 중에만 devtools를 연다. (패키징된 앱에서는 열지 않는다.)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", function () {
    mainWindow = null;
  });
}

app.on("ready", createWindow);

app.on("window-all-closed", function () {
  app.quit();
});

app.on("activate", function () {
  if (mainWindow === null) {
    createWindow();
  }
});

/* =======================================================================
 *  데이터 저장 (프로젝트 폴더 안 wardrobe/)
 *  - wardrobe/items/<id>.png : 배경이 지워진 옷 이미지
 *  - wardrobe/data.json      : 옷/룩 메타데이터
 * ===================================================================== */

// 패키징된 앱에서 __dirname은 읽기 전용(app.asar) 안이라 쓰기가 실패한다.
// 그래서 배포판에서는 사용자 데이터 폴더를 쓰고, 개발 중에는 프로젝트 폴더를 쓴다.
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath("userData"), "wardrobe")
  : path.join(__dirname, "wardrobe");
const ITEMS_DIR = path.join(DATA_DIR, "items");
const DATA_FILE = path.join(DATA_DIR, "data.json");

function ensureDirs() {
  fs.mkdirSync(ITEMS_DIR, { recursive: true });
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { items: [], looks: [] };
  }
}

function writeData(data) {
  ensureDirs();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function dataUrlToBuffer(dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64, "base64");
}

function dataUrlMime(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,/);
  return m ? m[1] : "image/png";
}

function itemToClient(item) {
  const file = path.join(ITEMS_DIR, `${item.id}.png`);
  let image = null;
  try {
    image = "data:image/png;base64," + fs.readFileSync(file).toString("base64");
  } catch {
    image = null;
  }
  return { id: item.id, kind: item.kind, image };
}

/* ---------- 배경 제거 ---------- */
// 패키지를 require 하는 비용이 크므로 최초 1회만 로드한다.
let removeBackground = null;
function getRemover() {
  if (!removeBackground) {
    removeBackground =
      require("@imgly/background-removal-node").removeBackground;
  }
  return removeBackground;
}

let heicConvert = null;
function getHeicConvert() {
  if (!heicConvert) heicConvert = require("heic-convert");
  return heicConvert;
}

let sharp = null;
function getSharp() {
  if (!sharp) sharp = require("sharp");
  return sharp;
}

// HEIC/HEIF인지 판별한다. mime이 명확하지 않을 수 있어 매직 바이트(ftyp 박스)도 확인한다.
function isHeic(buffer, mime) {
  if (mime && /hei[cf]/i.test(mime)) return true;
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    return ["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"].includes(brand);
  }
  return false;
}

// HEIC면 PNG 버퍼로 변환하고, 아니면 원본을 그대로 돌려준다.
// Chromium(<img>/canvas)과 배경 제거 라이브러리 모두 HEIC를 못 읽으므로 먼저 변환해야 한다.
async function toSupportedImage(buffer, mime) {
  if (!isHeic(buffer, mime)) return { buffer, mime };
  const convert = getHeicConvert();
  const out = await convert({ buffer, format: "PNG" });
  return { buffer: Buffer.from(out), mime: "image/png" };
}

ipcMain.handle("remove-background", async (_event, dataUrl) => {
  try {
    const remove = getRemover();
    const { buffer: inputBuffer, mime } = await toSupportedImage(
      dataUrlToBuffer(dataUrl),
      dataUrlMime(dataUrl),
    );
    // 라이브러리가 raw Buffer를 타입 없는 Blob으로 감싸 mime을 못 읽는 문제가 있어
    // (→ "Unsupported format") 올바른 mime을 지정한 Blob으로 직접 넘긴다.
    const inputBlob = new Blob([inputBuffer], { type: mime });
    const blob = await remove(inputBlob, { output: { format: "image/png" } });
    const outBuffer = Buffer.from(await blob.arrayBuffer());
    // 브러쉬 '복원'에 쓸 원본도 함께 돌려준다. 제거 결과(PNG)와 같은 크기·방향이 되도록
    // EXIF 회전 없이 PNG로 재인코딩한다(PNG엔 방향 태그가 없어 브라우저가 멋대로 회전시키지 않음).
    const originalPng = await getSharp()(inputBuffer).png().toBuffer();
    return {
      success: true,
      dataUrl: "data:image/png;base64," + outBuffer.toString("base64"),
      originalDataUrl: "data:image/png;base64," + originalPng.toString("base64"),
    };
  } catch (error) {
    console.error("배경 제거 실패:", error);
    return { success: false, error: error.message };
  }
});

/* ---------- 옷 ---------- */
ipcMain.handle("list-items", async () => {
  const data = readData();
  return data.items.map(itemToClient);
});

ipcMain.handle("add-item", async (_event, { kind, dataUrl }) => {
  try {
    ensureDirs();
    const id = newId();
    fs.writeFileSync(
      path.join(ITEMS_DIR, `${id}.png`),
      dataUrlToBuffer(dataUrl),
    );
    const data = readData();
    const item = { id, kind };
    data.items.push(item);
    writeData(data);
    return { success: true, item: itemToClient(item) };
  } catch (error) {
    console.error("옷 저장 실패:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-item", async (_event, id) => {
  try {
    const data = readData();
    data.items = data.items.filter((it) => it.id !== id);
    writeData(data);
    // 이미지 파일도 함께 지운다. (룩에 들어간 옷은 룩북에서 자동으로 건너뛴다.)
    try {
      fs.unlinkSync(path.join(ITEMS_DIR, `${id}.png`));
    } catch {}
    return { success: true };
  } catch (error) {
    console.error("옷 삭제 실패:", error);
    return { success: false, error: error.message };
  }
});

/* ---------- 룩 ---------- */
ipcMain.handle("list-looks", async () => {
  return readData().looks;
});

ipcMain.handle("save-look", async (_event, look) => {
  try {
    const data = readData();
    const saved = { id: newId(), ...look };
    data.looks.push(saved);
    writeData(data);
    return { success: true, look: saved };
  } catch (error) {
    console.error("룩 저장 실패:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("delete-look", async (_event, id) => {
  try {
    const data = readData();
    data.looks = data.looks.filter((l) => l.id !== id);
    writeData(data);
    return { success: true };
  } catch (error) {
    console.error("룩 삭제 실패:", error);
    return { success: false, error: error.message };
  }
});
