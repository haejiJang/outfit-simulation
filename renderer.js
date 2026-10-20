// ===== 상수 =====
const COLS = 4;
const ROWS = 2;
const PAGE_SIZE = COLS * ROWS; // 8

// 옷을 zone에 처음 불러올 때의 기본 배치 (zone 크기에 대한 비율)
//  cx, cy : 중심 좌표(0~1)   w : 너비(zone 너비에 대한 비율)
const DEFAULT_PLACEMENT = {
  top: { cx: 0.5, cy: 0.32, w: 0.58 },
  bottom: { cx: 0.5, cy: 0.72, w: 0.55 },
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

class ClothingSimulation {
  constructor() {
    this.items = { top: [], bottom: [] };
    this.itemsById = new Map();
    this.looks = [];

    this.page = { top: 0, bottom: 0 };
    this.selection = { top: null, bottom: null }; // { itemId, cx, cy, w }

    this.addKind = "top";
    this.edit = null; // 현재 화면에서 편집 중인 브러쉬 상태 (없으면 null)
    this.addShowing = false; // 지금 결과를 하나 보여주는 중인지
    this.addQueue = []; // 저장 대기 중인 {removed, original} 쌍들
    this.lookbookIndex = 0;

    // zone 안에서 클릭한 옷을 맨 앞으로 올리기 위한 z-index 카운터
    this.zCounter = 0;

    // 옷 이미지의 불투명 영역 중심 보정값 캐시 (src -> {fx, fy})
    this.trimCache = new Map();

    // 옷장 화면 상태
    this.wardKind = "top";
    this.wardPage = { top: 0, bottom: 0 };
    this.wardSelected = new Set(); // 삭제하려고 고른 옷 id들

    this.init();
  }

  async init() {
    this.bindNavigation();
    this.bindMatching();
    this.bindWardrobe();
    this.bindAdd();
    this.bindSaveLook();
    this.bindLookbook();

    await this.loadItems();
    await this.loadLooks();
  }

  /* ===================== 화면 전환 ===================== */
  switchScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");

    if (id === "start-screen") this.resetMatching();
    if (id === "matching-screen") this.renderMatching();
    if (id === "wardrobe-screen") this.renderWardrobe();
    if (id === "lookbook-screen") this.renderLookbook();
  }

  // 홈으로 나가면 매칭 선택 상태와 zone 안을 초기화
  resetMatching() {
    this.selection = { top: null, bottom: null };
    this.page = { top: 0, bottom: 0 };
    const zone = document.getElementById("matching-zone");
    if (zone) zone.innerHTML = "";
  }

  bindNavigation() {
    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => this.switchScreen(btn.dataset.goto));
    });
  }

  /* ===================== 데이터 로드 ===================== */
  async loadItems() {
    const all = await window.api.listItems();
    this.items = { top: [], bottom: [] };
    this.itemsById.clear();
    for (const item of all) {
      if (item.kind === "top" || item.kind === "bottom") {
        this.items[item.kind].push(item);
        this.itemsById.set(item.id, item);
      }
    }
    this.renderGrid("top");
    this.renderGrid("bottom");
  }

  async loadLooks() {
    this.looks = await window.api.listLooks();
  }

  /* ===================== 매칭 화면 ===================== */
  bindMatching() {
    document.querySelectorAll(".clothes-list").forEach((list) => {
      const kind = list.dataset.kind;
      list.querySelectorAll(".list-arrow").forEach((arrow) => {
        arrow.addEventListener("click", () => {
          const dir = arrow.dataset.dir === "next" ? 1 : -1;
          this.page[kind] = clamp(this.page[kind] + dir, 0, this.maxPage(kind));
          this.renderGrid(kind);
        });
      });
    });

    document.getElementById("matching-save").addEventListener("click", () => this.goToSaveLook());
  }

  maxPage(kind) {
    return Math.max(0, Math.ceil(this.items[kind].length / PAGE_SIZE) - 1);
  }

  renderMatching() {
    this.renderGrid("top");
    this.renderGrid("bottom");
    this.renderMatchingZone();
  }

  renderGrid(kind) {
    const grid = document.querySelector(`.grid[data-grid="${kind}"]`);
    grid.innerHTML = "";

    const start = this.page[kind] * PAGE_SIZE;
    const slice = this.items[kind].slice(start, start + PAGE_SIZE);

    for (let i = 0; i < PAGE_SIZE; i++) {
      const item = slice[i];
      const cell = document.createElement("div");
      cell.className = "box cell";
      if (!item) {
        cell.classList.add("empty");
      } else {
        const img = document.createElement("img");
        img.src = item.image;
        cell.appendChild(img);
        if (this.selection[kind] && this.selection[kind].itemId === item.id) {
          cell.classList.add("chosen");
        }
        cell.addEventListener("click", () => this.selectItem(kind, item));
      }
      grid.appendChild(cell);
    }

    // 화살표 활성/비활성
    const list = document.querySelector(`.clothes-list[data-kind="${kind}"]`);
    const prev = list.querySelector('.list-arrow[data-dir="prev"]');
    const next = list.querySelector('.list-arrow[data-dir="next"]');
    prev.disabled = this.page[kind] <= 0;
    next.disabled = this.page[kind] >= this.maxPage(kind);
  }

  selectItem(kind, item) {
    const prev = this.selection[kind];
    if (prev) {
      // 같은 종류를 다시 선택 → 배치(위치·크기)는 유지하고 옷만 교체
      this.selection[kind] = { ...prev, itemId: item.id };
    } else {
      this.selection[kind] = { itemId: item.id, ...DEFAULT_PLACEMENT[kind] };
    }
    this.renderGrid(kind);
    this.renderMatchingZone();
  }

  renderMatchingZone() {
    const zone = document.getElementById("matching-zone");
    zone.innerHTML = "";
    for (const kind of ["top", "bottom"]) {
      const sel = this.selection[kind];
      if (!sel) continue;
      const item = this.itemsById.get(sel.itemId);
      if (!item) continue;
      this.placeItem(zone, sel, item.image, true);
    }
  }

  /* ---- zone 안에 옷 이미지 배치 (interactive=true면 드래그/휠 조작) ---- */
  placeItem(zone, placement, src, interactive) {
    const img = document.createElement("img");
    img.className = "clothing-item" + (interactive ? " draggable" : "");
    img.src = src;
    img.draggable = false;

    const layout = () => {
      const zw = zone.clientWidth;
      const zh = zone.clientHeight;
      const w = placement.w * zw;
      const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const h = w / ar;
      // 투명 여백 때문에 옷이 치우쳐 보이지 않도록, 불투명 영역의 중심을 (cx, cy)에 맞춘다
      const trim = this.getTrim(img);
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      img.style.left = `${placement.cx * zw - w / 2 - trim.fx * w}px`;
      img.style.top = `${placement.cy * zh - h / 2 - trim.fy * h}px`;
    };

    if (img.complete && img.naturalWidth) layout();
    else img.addEventListener("load", layout);

    // 저장된 쌓임 순서(z)를 반영
    if (placement.z != null) img.style.zIndex = placement.z;

    if (interactive) this.attachInteraction(img, zone, placement, layout);
    zone.appendChild(img);
    return img;
  }

  /* ---- 이미지의 불투명 영역 중심이 전체 이미지 중심에서 얼마나 벗어나는지 계산
         (fx, fy: 이미지 너비/높이에 대한 비율). 투명 여백 보정에 사용 ---- */
  getTrim(img) {
    const src = img.src;
    if (this.trimCache.has(src)) return this.trimCache.get(src);

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    let trim = { fx: 0, fy: 0 };
    if (nw && nh) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, nw, nh).data;
        let minX = nw, minY = nh, maxX = -1, maxY = -1;
        for (let y = 0; y < nh; y++) {
          for (let x = 0; x < nw; x++) {
            if (data[(y * nw + x) * 4 + 3] > 10) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX >= minX && maxY >= minY) {
          const ccx = (minX + maxX + 1) / 2;
          const ccy = (minY + maxY + 1) / 2;
          trim = { fx: ccx / nw - 0.5, fy: ccy / nh - 0.5 };
        }
      } catch (e) {
        // 픽셀을 읽지 못하면 보정 없이 진행
      }
      this.trimCache.set(src, trim);
    }
    return trim;
  }

  attachInteraction(img, zone, placement, layout) {
    // 드래그로 위치 이동
    let dragging = false;
    let grabDX = 0; // 포인터와 이미지 중심의 차이(px)
    let grabDY = 0;

    img.addEventListener("pointerdown", (e) => {
      dragging = true;
      img.classList.add("dragging");
      // 클릭한 옷을 맨 앞으로 (순서를 placement에 저장해 다음 화면까지 유지)
      placement.z = ++this.zCounter;
      img.style.zIndex = placement.z;
      img.setPointerCapture(e.pointerId);
      const rect = zone.getBoundingClientRect();
      // rect는 CSS 스케일이 반영된 시각 크기, clientWidth는 레이아웃 크기 → 비율로 보정
      const scale = rect.width / zone.clientWidth;
      const centerX = placement.cx * zone.clientWidth;
      const centerY = placement.cy * zone.clientHeight;
      grabDX = (e.clientX - rect.left) / scale - centerX;
      grabDY = (e.clientY - rect.top) / scale - centerY;
    });

    img.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = zone.getBoundingClientRect();
      const scale = rect.width / zone.clientWidth;
      const zw = zone.clientWidth;
      const zh = zone.clientHeight;
      const centerX = (e.clientX - rect.left) / scale - grabDX;
      const centerY = (e.clientY - rect.top) / scale - grabDY;
      placement.cx = clamp(centerX / zw, 0, 1);
      placement.cy = clamp(centerY / zh, 0, 1);
      layout();
    });

    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      img.classList.remove("dragging");
      try {
        img.releasePointerCapture(e.pointerId);
      } catch {}
    };
    img.addEventListener("pointerup", stop);
    img.addEventListener("pointercancel", stop);

    // 휠(스크롤)로 크기 조절 (비율 고정) — 감도 낮춤
    img.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.01 : 0.99;
      placement.w = clamp(placement.w * factor, 0.1, 1.5);
      layout();
    });
  }

  /* ===================== 옷장 화면 ===================== */
  bindWardrobe() {
    // 상의/하의 탭
    document.querySelectorAll("[data-ward-kind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.wardKind = btn.dataset.wardKind;
        this.wardSelected.clear();
        this.renderWardrobe();
      });
    });

    // 좌/우 화살표 (현재 탭만 넘긴다)
    document.querySelectorAll("[data-ward-dir]").forEach((arrow) => {
      arrow.addEventListener("click", () => {
        const dir = arrow.dataset.wardDir === "next" ? 1 : -1;
        const kind = this.wardKind;
        this.wardPage[kind] = clamp(this.wardPage[kind] + dir, 0, this.maxPage(kind));
        this.renderWardrobeGrid();
      });
    });

    // 추가: 옷 추가 화면으로 (보고 있던 탭을 이어준다)
    document.getElementById("wardrobe-add").addEventListener("click", () => {
      this.setAddKind(this.wardKind);
      this.switchScreen("add-screen");
    });

    // 쓰레기통: 선택한 옷 삭제
    document.getElementById("wardrobe-trash").addEventListener("click", () => {
      if (this.wardSelected.size > 0) this.deleteSelectedItems();
    });
  }

  renderWardrobe() {
    this.wardSelected.clear(); // 화면에 들어올 때 선택 초기화
    document.querySelectorAll("[data-ward-kind]").forEach((b) => {
      b.classList.toggle("unselected", b.dataset.wardKind !== this.wardKind);
    });
    this.renderWardrobeGrid();
  }

  renderWardrobeGrid() {
    const grid = document.getElementById("wardrobe-grid");
    grid.innerHTML = "";

    const kind = this.wardKind;
    const start = this.wardPage[kind] * PAGE_SIZE;
    const slice = this.items[kind].slice(start, start + PAGE_SIZE);

    for (let i = 0; i < PAGE_SIZE; i++) {
      const item = slice[i];
      const cell = document.createElement("div");
      cell.className = "box cell";
      if (!item) {
        cell.classList.add("empty");
      } else {
        const img = document.createElement("img");
        img.src = item.image;
        cell.appendChild(img);
        if (this.wardSelected.has(item.id)) cell.classList.add("chosen");
        cell.addEventListener("click", () => this.onWardCellClick(item));
      }
      grid.appendChild(cell);
    }

    const prev = document.querySelector('[data-ward-dir="prev"]');
    const next = document.querySelector('[data-ward-dir="next"]');
    prev.disabled = this.wardPage[kind] <= 0;
    next.disabled = this.wardPage[kind] >= this.maxPage(kind);

    this.renderWardrobeControls();
  }

  // 선택 개수에 따라 쓰레기통 버튼/안내 문구를 갱신한다.
  renderWardrobeControls() {
    const count = this.wardSelected.size;

    const trash = document.getElementById("wardrobe-trash");
    trash.classList.toggle("active", count > 0);
    trash.disabled = count === 0; // 고른 게 없으면 삭제 불가

    const hint = document.getElementById("wardrobe-hint");
    hint.classList.toggle("show", count > 0);
    hint.textContent = count > 0 ? `${count}벌 선택됨` : "";
  }

  onWardCellClick(item) {
    if (this.wardSelected.has(item.id)) this.wardSelected.delete(item.id);
    else this.wardSelected.add(item.id);
    this.renderWardrobeGrid();
  }

  async deleteSelectedItems() {
    const ids = [...this.wardSelected];
    if (ids.length === 0) return;

    const ok = await this.confirmDialog(
      `선택한 옷 ${ids.length}벌을 삭제할까요? 되돌릴 수 없어요.`,
    );
    if (!ok) return;

    for (const id of ids) {
      const res = await window.api.deleteItem(id);
      if (!res.success) {
        alert("옷 삭제에 실패했어요: " + res.error);
      }
    }

    this.wardSelected.clear();
    await this.loadItems();
    // 삭제로 페이지가 범위를 벗어났으면 당긴다.
    const kind = this.wardKind;
    this.wardPage[kind] = clamp(this.wardPage[kind], 0, this.maxPage(kind));
    this.renderWardrobeGrid();
  }

  /* ---- 공통 확인 모달 (true/false 반환) ---- */
  confirmDialog(message, okLabel = "삭제") {
    return new Promise((resolve) => {
      const modal = document.getElementById("confirm-modal");
      const text = document.getElementById("confirm-text");
      const ok = document.getElementById("confirm-ok");
      const cancel = document.getElementById("confirm-cancel");

      text.textContent = message;
      ok.textContent = okLabel;
      modal.hidden = false;

      const cleanup = () => {
        modal.hidden = true;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
      };
      const onOk = () => {
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
    });
  }

  // confirmDialog와 같은 모달을 재사용하되, 취소 버튼 없이 확인만 보여주는 알림용
  alertDialog(message, okLabel = "확인") {
    return new Promise((resolve) => {
      const modal = document.getElementById("confirm-modal");
      const text = document.getElementById("confirm-text");
      const ok = document.getElementById("confirm-ok");
      const cancel = document.getElementById("confirm-cancel");

      text.textContent = message;
      ok.textContent = okLabel;
      cancel.hidden = true;
      modal.hidden = false;

      const onOk = () => {
        modal.hidden = true;
        cancel.hidden = false; // 다음 confirmDialog를 위해 원복
        ok.removeEventListener("click", onOk);
        resolve();
      };
      ok.addEventListener("click", onOk);
    });
  }

  setAddKind(kind) {
    this.addKind = kind;
    document.querySelectorAll(".kind-button").forEach((b) => {
      b.classList.toggle("unselected", b.dataset.kind !== kind);
    });
  }

  /* ===================== 룩 저장 화면 ===================== */
  bindSaveLook() {
    document.getElementById("save-back").addEventListener("click", () => {
      // back: 매칭으로 돌아가되 배치한 룩은 그대로 유지한다.
      this.switchScreen("matching-screen");
    });
    document.getElementById("save-confirm").addEventListener("click", () => this.confirmSaveLook());
  }

  goToSaveLook() {
    if (!this.selection.top && !this.selection.bottom) {
      alert("상의나 하의를 먼저 선택해주세요.");
      return;
    }
    this.switchScreen("save-look-screen");

    const zone = document.getElementById("save-zone");
    zone.innerHTML = "";
    for (const kind of ["top", "bottom"]) {
      const sel = this.selection[kind];
      if (!sel) continue;
      const item = this.itemsById.get(sel.itemId);
      if (!item) continue;
      this.placeItem(zone, { ...sel }, item.image, false);
    }
  }

  async confirmSaveLook() {
    const look = { top: null, bottom: null };
    for (const kind of ["top", "bottom"]) {
      const sel = this.selection[kind];
      if (sel) {
        look[kind] = { itemId: sel.itemId, cx: sel.cx, cy: sel.cy, w: sel.w, z: sel.z };
      }
    }

    const res = await window.api.saveLook(look);
    if (!res.success) {
      alert("룩 저장에 실패했어요: " + res.error);
      return;
    }
    await this.loadLooks();
    this.lookbookIndex = this.looks.length - 1;
    this.switchScreen("matching-screen");
  }

  /* ===================== 룩북 화면 ===================== */
  bindLookbook() {
    document.getElementById("lookbook-prev").addEventListener("click", () => {
      this.lookbookIndex = clamp(this.lookbookIndex - 1, 0, this.looks.length - 1);
      this.renderLookbook();
    });
    document.getElementById("lookbook-next").addEventListener("click", () => {
      this.lookbookIndex = clamp(this.lookbookIndex + 1, 0, this.looks.length - 1);
      this.renderLookbook();
    });
    document.getElementById("lookbook-delete").addEventListener("click", () => this.deleteCurrentLook());
  }

  renderLookbook() {
    const empty = document.getElementById("lookbook-empty");
    const prev = document.getElementById("lookbook-prev");
    const next = document.getElementById("lookbook-next");
    const zone = document.getElementById("lookbook-zone");

    // 기존에 배치된 옷 이미지만 비우고 empty 안내 문구는 유지
    zone.querySelectorAll(".clothing-item").forEach((el) => el.remove());

    if (this.looks.length === 0) {
      empty.hidden = false;
      prev.disabled = true;
      next.disabled = true;
      return;
    }

    empty.hidden = true;
    this.lookbookIndex = clamp(this.lookbookIndex, 0, this.looks.length - 1);

    const look = this.looks[this.lookbookIndex];

    for (const kind of ["top", "bottom"]) {
      const p = look[kind];
      if (!p) continue;
      const item = this.itemsById.get(p.itemId);
      if (!item) continue;
      this.placeItem(zone, { ...p }, item.image, false);
    }

    prev.disabled = this.lookbookIndex <= 0;
    next.disabled = this.lookbookIndex >= this.looks.length - 1;
  }

  async deleteCurrentLook() {
    if (this.looks.length === 0) return;
    const look = this.looks[this.lookbookIndex];
    if (!(await this.confirmDialog("이 룩을 삭제할까요?"))) return;

    const res = await window.api.deleteLook(look.id);
    if (!res.success) {
      alert("삭제에 실패했어요: " + res.error);
      return;
    }
    await this.loadLooks();
    this.lookbookIndex = clamp(this.lookbookIndex, 0, this.looks.length - 1);
    this.renderLookbook();
  }

  /* ===================== 옷 추가 화면 ===================== */
  bindAdd() {
    document.querySelectorAll(".kind-button").forEach((btn) => {
      btn.addEventListener("click", () => this.setAddKind(btn.dataset.kind));
    });

    const uploadBox = document.getElementById("upload-box");
    const fileInput = document.getElementById("file-input");

    uploadBox.addEventListener("click", () => {
      if (!uploadBox.classList.contains("busy")) fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files);
      if (!files.length) return;
      const dataUrls = await Promise.all(files.map((f) => this.readFileAsDataUrl(f)));
      fileInput.value = ""; // 같은 파일 재선택 허용
      await this.processUploads(dataUrls);
    });

    // 드래그 앤 드롭 업로드 (맥북 스크린샷 미리보기 끌어다 놓기 포함)
    uploadBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!uploadBox.classList.contains("busy")) uploadBox.classList.add("dragover");
    });
    uploadBox.addEventListener("dragleave", (e) => {
      e.preventDefault();
      uploadBox.classList.remove("dragover");
    });
    uploadBox.addEventListener("drop", async (e) => {
      e.preventDefault();
      uploadBox.classList.remove("dragover");
      if (uploadBox.classList.contains("busy")) return;

      const files = this.extractImageFiles(e.dataTransfer);
      if (!files.length) return;

      const dataUrls = await Promise.all(files.map((f) => this.readFileAsDataUrl(f)));
      await this.processUploads(dataUrls);
    });

    document.getElementById("add-save").addEventListener("click", () => this.saveAddedItem());
  }

  // 이미지 파일인지 판별. HEIC는 File.type이 비어 있을 수 있어 확장자도 함께 본다.
  isImageFile(file) {
    if (!file) return false;
    if (file.type.startsWith("image/")) return true;
    return /\.(heic|heif|png|jpe?g|webp|gif)$/i.test(file.name || "");
  }

  // 드롭된 데이터에서 이미지 파일들을 꺼낸다. 스크린샷 미리보기는 files 또는 items로 들어온다.
  extractImageFiles(dataTransfer) {
    if (!dataTransfer) return [];

    if (dataTransfer.files && dataTransfer.files.length) {
      return Array.from(dataTransfer.files).filter((f) => this.isImageFile(f));
    }

    if (dataTransfer.items && dataTransfer.items.length) {
      const files = [];
      for (const item of dataTransfer.items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (this.isImageFile(file)) files.push(file);
      }
      return files;
    }

    return [];
  }

  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async processUploads(dataUrls) {
    const uploadBox = document.getElementById("upload-box");
    const uploadText = uploadBox.querySelector(".upload-text");
    const zone = document.getElementById("add-zone");
    const saveBtn = document.getElementById("add-save");

    const total = dataUrls.length;
    uploadBox.classList.add("busy");
    saveBtn.disabled = true;
    this.edit = null;
    this.addShowing = false;
    this.addQueue = [];

    let failed = 0;

    for (let i = 0; i < total; i++) {
      const progress = total > 1 ? ` (${i + 1}/${total})` : "";
      uploadText.textContent = "배경을 지우는 중…";
      // 아직 보여줄 결과가 없을 때만 zone에 진행 상태를 띄운다(먼저 준비된 결과는 그대로 유지).
      if (!this.addShowing) {
        zone.innerHTML = `<div class="zone-placeholder">배경을 지우는 중…${progress}</div>`;
      }

      const res = await window.api.removeBackground(dataUrls[i]);
      if (!res.success) {
        failed++;
        continue;
      }

      // 크롭은 저장 시점으로 미룬다. 브러쉬 편집(특히 '복원')은 자르기 전 전체
      // 해상도에서 해야 원본과 좌표가 정확히 겹치기 때문이다.
      this.addQueue.push({ removed: res.dataUrl, original: res.originalDataUrl });

      // 첫 결과면 바로 보여주고, 이미 보여주는 중이면 대기 장수만 갱신한다.
      if (!this.addShowing) this.showNextResult();
      else this.updateSaveLabel();
    }

    uploadBox.classList.remove("busy");
    uploadText.innerHTML = "옷 사진<br />업로드하기";

    if (!this.addShowing) {
      zone.innerHTML = '<div class="zone-placeholder">배경 제거에 실패했어요.<br>다른 사진으로 시도해보세요.</div>';
      if (failed) await this.alertDialog("배경 제거에 실패했어요.");
    } else if (failed) {
      await this.alertDialog(`${failed}장은 배경 제거에 실패해서 건너뛰었어요.`);
    }
  }

  // 큐에서 다음 결과를 꺼내 브러쉬 편집기를 띄운다. 큐가 비면 안내 문구로 되돌린다.
  showNextResult() {
    const zone = document.getElementById("add-zone");
    const saveBtn = document.getElementById("add-save");

    if (this.addQueue.length === 0) {
      this.addShowing = false;
      this.edit = null;
      saveBtn.disabled = true;
      this.updateSaveLabel();
      zone.innerHTML = '<div class="zone-placeholder">배경이 제거된 옷이 여기에 보여요</div>';
      return;
    }

    this.addShowing = true;
    const pair = this.addQueue.shift();
    this.startEditor(pair);
  }

  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /* ---- 브러쉬 보정 편집기: 지우개(배경 지우기) / 복원(원본 되살리기) ---- */
  async startEditor(pair) {
    const zone = document.getElementById("add-zone");
    const saveBtn = document.getElementById("add-save");

    const [removedImg, origImg] = await Promise.all([
      this.loadImage(pair.removed),
      this.loadImage(pair.original),
    ]);
    const w = removedImg.naturalWidth;
    const h = removedImg.naturalHeight;

    // 작업용(전체 해상도): 브러쉬가 여기에 그려지고, 최종 저장도 이 캔버스로 한다.
    const work = document.createElement("canvas");
    work.width = w;
    work.height = h;
    work.getContext("2d").drawImage(removedImg, 0, 0);

    // 원본(전체 해상도): '복원' 모드에서 되살릴 픽셀의 출처.
    const orig = document.createElement("canvas");
    orig.width = w;
    orig.height = h;
    orig.getContext("2d").drawImage(origImg, 0, 0);

    // 표시용(축소): 큰 사진도 매끄럽게 그리도록 최대 변을 660px로 제한.
    const maxSide = 660;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const display = document.createElement("canvas");
    display.className = "edit-canvas";
    display.width = Math.round(w * scale);
    display.height = Math.round(h * scale);

    this.edit = {
      work,
      orig,
      display,
      removedImg,
      w,
      h,
      mode: "erase",
      brushPct: 6, // 지름 = 짧은 변의 이 비율(%)
      drawing: false,
      last: null,
    };

    zone.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "edit-wrap";
    wrap.appendChild(display);
    wrap.appendChild(this.buildBrushToolbar());
    zone.appendChild(wrap);

    this.renderEditDisplay();
    this.bindEditPointer();

    saveBtn.disabled = false;
    this.updateSaveLabel();
  }

  buildBrushToolbar() {
    const bar = document.createElement("div");
    bar.className = "brush-toolbar";
    bar.innerHTML =
      '<button type="button" class="brush-mode active" data-mode="erase">지우개</button>' +
      '<button type="button" class="brush-mode" data-mode="restore">복원</button>' +
      '<input type="range" class="brush-size" min="2" max="25" value="6" title="브러쉬 크기" />' +
      '<button type="button" class="brush-reset">초기화</button>';

    bar.querySelectorAll(".brush-mode").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.edit.mode = btn.dataset.mode;
        bar
          .querySelectorAll(".brush-mode")
          .forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
    bar.querySelector(".brush-size").addEventListener("input", (e) => {
      this.edit.brushPct = Number(e.target.value);
    });
    bar
      .querySelector(".brush-reset")
      .addEventListener("click", () => this.resetEdit());
    return bar;
  }

  renderEditDisplay() {
    const { display, work } = this.edit;
    const ctx = display.getContext("2d");
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(work, 0, 0, display.width, display.height);
  }

  // 원본 해상도 기준 브러쉬 반지름(px)
  brushRadius() {
    return Math.max(
      4,
      (Math.min(this.edit.w, this.edit.h) * this.edit.brushPct) / 100 / 2,
    );
  }

  // 한 점에 원형 브러쉬를 찍는다. erase=투명화, restore=원본 픽셀 복사.
  stamp(x, y) {
    const ctx = this.edit.work.getContext("2d");
    const r = this.brushRadius();
    ctx.save();
    if (this.edit.mode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      // 원 주변 영역만 원본에서 복사(전체 그리기보다 가볍다).
      const x0 = Math.max(0, Math.floor(x - r));
      const y0 = Math.max(0, Math.floor(y - r));
      const x1 = Math.min(this.edit.w, Math.ceil(x + r));
      const y1 = Math.min(this.edit.h, Math.ceil(y + r));
      ctx.drawImage(this.edit.orig, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.restore();
  }

  // 이전 점에서 현재 점까지 촘촘히 찍어 선이 끊기지 않게 한다.
  strokeTo(x, y) {
    const last = this.edit.last || { x, y };
    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, this.brushRadius() / 2);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      this.stamp(last.x + (dx * i) / n, last.y + (dy * i) / n);
    }
    this.edit.last = { x, y };
  }

  bindEditPointer() {
    const d = this.edit.display;
    // 화면 좌표 → 전체 해상도 좌표
    const toXY = (e) => {
      const rect = d.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * this.edit.w,
        y: ((e.clientY - rect.top) / rect.height) * this.edit.h,
      };
    };
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      this.edit.drawing = true;
      this.edit.last = null;
      const p = toXY(e);
      this.stamp(p.x, p.y);
      this.edit.last = p;
      this.renderEditDisplay();
    });
    d.addEventListener("pointermove", (e) => {
      if (!this.edit.drawing) return;
      const p = toXY(e);
      this.strokeTo(p.x, p.y);
      this.renderEditDisplay();
    });
    const end = () => {
      this.edit.drawing = false;
      this.edit.last = null;
    };
    d.addEventListener("pointerup", end);
    d.addEventListener("pointercancel", end);
  }

  // 브러쉬 편집을 처음 배경 제거 결과로 되돌린다.
  resetEdit() {
    const ctx = this.edit.work.getContext("2d");
    ctx.clearRect(0, 0, this.edit.w, this.edit.h);
    ctx.drawImage(this.edit.removedImg, 0, 0);
    this.renderEditDisplay();
  }

  // 저장 버튼에 남은 장수를 표시한다 (여러 장일 때만).
  updateSaveLabel() {
    const saveBtn = document.getElementById("add-save");
    const remaining = this.addQueue.length;
    saveBtn.textContent = remaining > 0 ? `save (${remaining + 1})` : "save";
  }

  /* ---- 투명 배경 PNG에서 옷(불투명 영역)의 경계 상자를 찾아 크롭 ---- */
  cropToContent(dataUrl, padding = 0.04) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        let data;
        try {
          data = ctx.getImageData(0, 0, w, h).data;
        } catch {
          resolve(dataUrl); // 캔버스 오염 등 → 원본 유지
          return;
        }

        // 행/열별로 "충분히 불투명한" 픽셀 수를 센다.
        // 배경 제거가 옷에서 떨어진 곳에 남기는 희미한 잔여 픽셀/헤일로 때문에
        // 단순 경계 상자는 여백이 크게 잡힌다. alpha 임계값을 올리고(헤일로 제거),
        // 행/열에 일정 개수 이상 모여 있어야 "옷"으로 인정해(흩어진 노이즈 제거) 잘라낸다.
        const alphaThreshold = 48;
        const colCount = new Uint32Array(w);
        const rowCount = new Uint32Array(h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > alphaThreshold) {
              colCount[x]++;
              rowCount[y]++;
            }
          }
        }

        // 노이즈 무시 기준: 해당 행/열에 모인 불투명 픽셀이 이 수보다 적으면 내용으로 보지 않는다.
        const minColPixels = Math.max(3, Math.round(h * 0.01));
        const minRowPixels = Math.max(3, Math.round(w * 0.01));

        let minX = 0;
        while (minX < w && colCount[minX] < minColPixels) minX++;
        let maxX = w - 1;
        while (maxX >= 0 && colCount[maxX] < minColPixels) maxX--;
        let minY = 0;
        while (minY < h && rowCount[minY] < minRowPixels) minY++;
        let maxY = h - 1;
        while (maxY >= 0 && rowCount[maxY] < minRowPixels) maxY--;

        // 옷을 못 찾으면 원본 그대로
        if (maxX < minX || maxY < minY) {
          resolve(dataUrl);
          return;
        }

        // 경계 상자에 약간의 여백을 더한다.
        const padX = Math.round((maxX - minX + 1) * padding);
        const padY = Math.round((maxY - minY + 1) * padding);
        const sx = clamp(minX - padX, 0, w - 1);
        const sy = clamp(minY - padY, 0, h - 1);
        const sw = clamp(maxX + padX, sx, w - 1) - sx + 1;
        const sh = clamp(maxY + padY, sy, h - 1) - sy + 1;

        const out = document.createElement("canvas");
        out.width = sw;
        out.height = sh;
        out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(out.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async saveAddedItem() {
    if (!this.edit) return;
    // 브러쉬 편집이 반영된 전체 해상도 결과를 투명 영역 기준으로 잘라 저장한다.
    const cropped = await this.cropToContent(this.edit.work.toDataURL("image/png"));
    const res = await window.api.addItem(this.addKind, cropped);
    if (!res.success) {
      alert("옷 저장에 실패했어요: " + res.error);
      return;
    }
    await this.loadItems();

    const hasNext = this.addQueue.length > 0;
    // 다음 대기 옷을 보여주거나, 마지막이면 안내 문구로 되돌린다.
    this.showNextResult();
    await this.alertDialog(hasNext ? "옷을 추가했어요! 다음 옷을 보여줄게요." : "옷을 추가했어요!");
  }
}

// ===== 반응형 스케일 =====
// 1280×832 디자인을 창 크기에 맞춰 균일 축소/확대 (contain 방식: 항상 전체가 보이도록)
const DESIGN_W = 1280;
const DESIGN_H = 832;
function fitStage() {
  const scale = Math.min(
    window.innerWidth / DESIGN_W,
    window.innerHeight / DESIGN_H,
  );
  document.documentElement.style.setProperty("--scale", scale);
}

document.addEventListener("DOMContentLoaded", () => {
  fitStage();
  window.addEventListener("resize", fitStage);
  new ClothingSimulation();
});

// 업로드 영역 밖에 파일을 떨어뜨렸을 때 Electron이 그 파일로 이동하는 기본 동작 차단
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
