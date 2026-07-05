// ui.js — application entry point: DOM wiring, editor <-> preview glue,
// samples, zoom/pan, and file/PNG/SVG export. Imports the pure parser
// from parser.js and the mermaid/color theme from theme.js; owns all
// other state itself (this is still one file on purpose — it's the
// 'controller' layer, and splitting it further mostly adds import
// noise without reducing coupling, since it all really does talk to
// the same handful of DOM elements and the same render() call).

import { convertCodeToMermaid } from './parser.js';
import {
  SHAPE_COLOR_DEFAULTS,
  setShapeColor,
  resetShapeColors,
  isLight,
  toggleLightMode,
  initMermaidTheme,
  applyShapeColors
} from './theme.js';

initMermaidTheme();

const codeEl = document.getElementById('code');
const dirEl = document.getElementById('direction');
const modeEl = document.getElementById('modeSelect');
const host = document.getElementById('diagramHost');
const statusWrap = document.getElementById('status');
const statusText = document.getElementById('statusText');
const zoomLabel = document.getElementById('zoomLabel');
const editorLabel = document.getElementById('editorLabel');
const mmdDrawer = document.getElementById('mmdDrawer');
const mmdOutput = document.getElementById('mmdOutput');

/* ---------------------------------------------------------------
   AUTOSAVE (localStorage) — keeps whatever's in the editor safe
   across accidental refreshes/tab closes. Best-effort: if
   localStorage is unavailable (private browsing, quota, etc.) we
   just silently skip saving/restoring rather than breaking the app.
--------------------------------------------------------------- */
const AUTOSAVE_KEY = 'flowchartStudio.autosave.v1';

function loadAutosave(){
  try{
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if(!raw) return null;
    const data = JSON.parse(raw);
    return (data && typeof data.code === 'string') ? data : null;
  }catch(e){
    return null;
  }
}

function saveAutosave(){
  try{
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
      code: codeEl.value,
      mode: modeEl.value,
      direction: dirEl.value,
      savedAt: Date.now()
    }));
  }catch(e){ /* storage full/unavailable — autosave is best-effort */ }
}

/* ---------------------------------------------------------------
   DAY / NIGHT MODE
--------------------------------------------------------------- */
const themeToggleBtn = document.getElementById('themeToggle');

const SUN_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><path d="M20.4 14.7A8.5 8.5 0 0 1 9.3 3.6a.6.6 0 0 0-.7-.8A9.5 9.5 0 1 0 21.2 15.4a.6.6 0 0 0-.8-.7z"/></svg>`;

function setThemeIcon(){
  themeToggleBtn.innerHTML = isLight() ? MOON_ICON : SUN_ICON;
  themeToggleBtn.title = isLight() ? 'สลับเป็นโหมดกลางคืน' : 'สลับเป็นโหมดกลางวัน';
}
setThemeIcon();

themeToggleBtn.onclick = ()=>{
  toggleLightMode();
  document.documentElement.setAttribute('data-theme', isLight() ? 'light' : 'dark');
  setThemeIcon();
  initMermaidTheme();
  if(lastGoodSVG !== null || codeEl.value.trim()) render();
};

/* ---------------------------------------------------------------
   SHAPE-COLOR POPOVER (legend-style color assignment per shape)
--------------------------------------------------------------- */
const colorWheelBtn = document.getElementById('colorWheelBtn');
const colorPopover = document.getElementById('colorPopover');

colorWheelBtn.onclick = (e)=>{
  e.stopPropagation();
  colorPopover.classList.toggle('open');
};

document.addEventListener('click', (e)=>{
  if(!colorPopover.contains(e.target) && e.target !== colorWheelBtn){
    colorPopover.classList.remove('open');
  }
});

function debounce(fn, delay){
  let t = null;
  return (...args)=>{
    clearTimeout(t);
    t = setTimeout(()=> fn(...args), delay);
  };
}

const debouncedColorRender = debounce(()=>{
  initMermaidTheme();
  if(lastGoodSVG !== null || codeEl.value.trim()) render();
}, 180);

const debouncedAutosave = debounce(saveAutosave, 400);
codeEl.addEventListener('input', debouncedAutosave);
dirEl.addEventListener('change', saveAutosave);

colorPopover.querySelectorAll('input[type="color"]').forEach(input=>{
  input.addEventListener('input', ()=>{
    setShapeColor(input.dataset.key, input.value);
    debouncedColorRender();
  });
});

document.getElementById('resetShapeColors').onclick = (e)=>{
  e.stopPropagation();
  resetShapeColors();
  colorPopover.querySelectorAll('input[type="color"]').forEach(input=>{
    input.value = SHAPE_COLOR_DEFAULTS[input.dataset.key];
  });
  initMermaidTheme();
  if(lastGoodSVG !== null || codeEl.value.trim()) render();
};

let scale = 1;
let panX = 0;
let panY = 0;
// Zoom range widened: long source files can produce very tall/wide
// diagrams that need to shrink well past the old 0.25 floor to fit,
// and detail inspection benefits from zooming in past the old 3x cap.
// MIN_SCALE is a *starting point* — it gets lowered per-diagram below
// if a particular layout (e.g. a very wide LR flowchart) needs to
// shrink further than this just to fit on screen at all.
let MIN_SCALE = 0.02;
const MAX_SCALE = 8;
// Single source of truth for zoom step, used by both the +/- buttons and
// the mouse-wheel handler below. Previously these used different hardcoded
// factors (1.25 for buttons, 1.1 for wheel), so wheel-zooming felt slower
// / less responsive than clicking the buttons for no real reason.
const ZOOM_STEP = 1.25;
let renderCounter = 0;
let lastGoodSVG = null;
let lastGeneratedMermaid = null;

/* ---------------------------------------------------------------
   SAMPLE LIBRARIES
--------------------------------------------------------------- */
const MERMAID_DEFAULT =
`flowchart TD
    A[คริสต์มาส] -->|หาเงิน| B(ไปช้อปปิ้ง)
    B --> C{คิดดูก่อน}
    C -->|หนึ่ง| D[แล็ปท็อป]
    C -->|สอง| E[ไอโฟน]
    C -->|สาม| F[รถยนต์]`;

const MERMAID_SAMPLES = {
  "Flowchart": MERMAID_DEFAULT,
  "การตัดสินใจ": `flowchart LR
    Start([เริ่มต้น]) --> Q{อากาศดีไหม?}
    Q -->|ดี| A[ไปเดินเล่น]
    Q -->|ไม่ดี| B[อยู่บ้านอ่านหนังสือ]
    A --> End([จบ])
    B --> End`,
  "กระบวนการทำงาน": `flowchart TD
    A[รับคำสั่งซื้อ] --> B[ตรวจสอบสต็อก]
    B --> C{มีสินค้าไหม?}
    C -->|มี| D[แพ็กสินค้า]
    C -->|ไม่มี| E[แจ้งลูกค้า]
    D --> F[จัดส่ง]
    E --> G[สิ้นสุด]
    F --> G`,
  "Sequence": `sequenceDiagram
    participant U as ผู้ใช้
    participant S as เซิร์ฟเวอร์
    U->>S: ส่งคำขอเข้าสู่ระบบ
    S-->>U: ตอบกลับผลลัพธ์
    U->>S: ขอข้อมูลโปรไฟล์
    S-->>U: ส่งข้อมูลโปรไฟล์`,
  "Class": `classDiagram
    class สัตว์ {
      +String ชื่อ
      +ร้อง()
    }
    class แมว {
      +ข่วน()
    }
    สัตว์ <|-- แมว`,
  "Mindmap": `mindmap
  root((แผนงาน))
    วิจัย
      สำรวจตลาด
      คู่แข่ง
    พัฒนา
      ออกแบบ
      สร้างต้นแบบ
    เปิดตัว
      การตลาด
      ขาย`
};

const CODE_SAMPLES = {
  "C++ คำนวณเกรด": `#include <iostream>
using namespace std;

int main() {
    string name;
    float score;
    char grade;

    cout << "===== Grade Calculator =====" << endl;
    cout << "Enter student name: ";
    cin >> name;
    cout << "Enter score (0-100): ";
    cin >> score;

    if (score >= 80) {
        grade = 'A';
    } else if (score >= 70) {
        grade = 'B';
    } else if (score >= 60) {
        grade = 'C';
    } else if (score >= 50) {
        grade = 'D';
    } else {
        grade = 'F';
    }

    cout << "\\nStudent : " << name << endl;
    cout << "Score   : " << score << endl;
    cout << "Grade   : " << grade << endl;

    return 0;
}`,
  "C++ ลูป for": `#include <iostream>
using namespace std;

int main() {
    int n;
    int sum = 0;
    cout << "Enter n: ";
    cin >> n;

    for (int i = 1; i <= n; i++) {
        sum = sum + i;
    }

    cout << "Sum = " << sum << endl;
    return 0;
}`,
  "Java if-else": `public class Main {
    public static void main(String[] args) {
        int age = 20;
        if (age >= 18) {
            System.out.println("Adult");
        } else {
            System.out.println("Minor");
        }
    }
}`,
  "C++ สี + try-catch": `#include <iostream>
#include <windows.h>
using namespace std;

int main() {
    _setmode(_fileno(stdout), _O_U16TEXT);
    SetConsoleOutputCP(65001);
    system("cls");

    int a, b;
    cout << "Enter a: ";
    cin >> a;
    cout << "Enter b: ";
    cin >> b;

    try {
        if (b == 0) {
            throw "หารด้วยศูนย์";
        }
        int result = a / b;
        textcolor(GREEN);
        cout << "ผลลัพธ์ = " << result << endl;
    } catch (...) {
        textcolor(RED);
        cout << "เกิดข้อผิดพลาด: หารด้วยศูนย์ไม่ได้" << endl;
    }

    return 0;
}`,
  "JavaScript while": `function main() {
    let i = 0;
    let total = 0;
    while (i < 5) {
        total = total + i;
        i = i + 1;
    }
    console.log(total);
}`
};

function buildSamples(){
  const wrap = document.getElementById('samples');
  wrap.innerHTML = '';
  const lib = modeEl.value === 'code' ? CODE_SAMPLES : MERMAID_SAMPLES;
  Object.keys(lib).forEach(name=>{
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = name;
    chip.onclick = ()=>{ codeEl.value = lib[name]; render(); saveAutosave(); };
    wrap.appendChild(chip);
  });
}

function setStatus(ok, msg){
  statusWrap.classList.toggle('err', !ok);
  statusText.textContent = msg;
}

/* ---------------------------------------------------------------
   MODE SWITCH
--------------------------------------------------------------- */
modeEl.addEventListener('change', ()=>{
  const isCode = modeEl.value === 'code';
  editorLabel.textContent = isCode ? 'ซอร์สโค้ด (C / C++ / Java / JavaScript)' : 'โค้ด Mermaid';
  document.getElementById('btnViewMmd').style.display = isCode ? 'inline-block' : 'none';
  document.getElementById('btnOpenFile').style.display = isCode ? 'inline-block' : 'none';
  buildSamples();
  if(isCode && !codeEl.value.trim()){
    codeEl.value = CODE_SAMPLES["C++ คำนวณเกรด"];
  } else if(!isCode && !codeEl.value.trim()){
    codeEl.value = MERMAID_DEFAULT;
  }
  render();
  saveAutosave();
});

/* ---------------------------------------------------------------
   RENDERING
--------------------------------------------------------------- */
function applyDirectionIfFlowchart(src){
  const dir = dirEl.value;
  const trimmed = src.trim();
  const m = trimmed.match(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)/i);
  if(m) return trimmed.replace(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)/i, `$1 ${dir}`);
  return src;
}

async function render(){
  const raw = codeEl.value.trim();
  if(!raw){
    host.innerHTML = '<div class="center-wrap"><div class="empty-hint">เขียนโค้ดทางซ้าย แล้วกด "แปลงเป็นภาพ" เพื่อดูโฟลว์ชาร์ต</div></div>';
    setStatus(true, 'พร้อมใช้งาน');
    lastGeneratedMermaid = null;
    return;
  }

  let mermaidSrc;
  if(modeEl.value === 'code'){
    try{
      mermaidSrc = convertCodeToMermaid(raw);
      lastGeneratedMermaid = mermaidSrc;
    }catch(err){
      const msg = (err && err.message) ? err.message : String(err);
      host.innerHTML = `<div class="center-wrap"><div class="error-box"><b>แปลงซอร์สโค้ดไม่สำเร็จ</b>\n\n${msg}</div></div>`;
      setStatus(false, 'แปลงโค้ดไม่สำเร็จ');
      return;
    }
  } else {
    mermaidSrc = raw;
    lastGeneratedMermaid = null;
  }

  const src = applyShapeColors(applyDirectionIfFlowchart(mermaidSrc));
  const id = 'mmd-' + (renderCounter++);
  try{
    const { svg } = await mermaid.render(id, src);
    lastGoodSVG = svg;
    host.innerHTML = `<div class="center-wrap"><div class="transform-wrap" id="tw">${svg}</div></div>`;
    setStatus(true, 'แปลงสำเร็จ');
    if(mmdOutput) mmdOutput.textContent = lastGeneratedMermaid || '';

    // Measure natural size, then auto-fit large diagrams so nothing starts off-screen.
    requestAnimationFrame(()=>{
      const svgEl = document.querySelector('#tw svg');
      if(svgEl){
        // Mermaid attaches its own responsive `max-width` (and sometimes
        // width/height) inline style so the SVG auto-shrinks to fit
        // whatever container it's dropped into. That's exactly what was
        // breaking wide LR/RL diagrams: getBoundingClientRect() measured
        // the box AFTER mermaid's own CSS had already shrunk it to the
        // container width, so "natural size" was never the diagram's real
        // size for anything wider than the host panel — the fit/zoom math
        // was built on a wrong number from the start. Strip that styling
        // and read the true size straight from viewBox instead, which is
        // always accurate no matter the diagram's orientation or aspect ratio.
        svgEl.removeAttribute('style');
        svgEl.style.maxWidth = 'none';
        svgEl.style.maxHeight = 'none';

        const viewBox = svgEl.getAttribute('viewBox');
        const vb = viewBox ? viewBox.trim().split(/\s+/).map(Number) : null;
        if(vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0){
          naturalW = vb[2];
          naturalH = vb[3];
        } else {
          const svgBox = svgEl.getBoundingClientRect();
          naturalW = svgBox.width;
          naturalH = svgBox.height;
        }
        const hostBox = host.getBoundingClientRect();
        const fitScale = Math.min(
          (hostBox.width - 64) / naturalW,
          (hostBox.height - 64) / naturalH
        );
        // If this diagram needs to be smaller than the default floor just
        // to fit, lower the floor for it (with 30% headroom to zoom out
        // a bit further still) instead of clamping and leaving it oversized.
        if(isFinite(fitScale) && fitScale > 0){
          MIN_SCALE = Math.min(0.02, fitScale * 0.7);
        }
        scale = (isFinite(fitScale) && fitScale < 1) ? Math.max(MIN_SCALE, fitScale) : 1;
      }
      panX = 0; panY = 0;
      applyZoom();
    });
  }catch(err){
    const msg = (err && err.message) ? err.message : String(err);
    host.innerHTML = `<div class="center-wrap"><div class="error-box"><b>สร้างผังงานไม่สำเร็จ</b>\n\n${msg}</div></div>`;
    setStatus(false, 'พบข้อผิดพลาด');
    document.querySelectorAll('body > svg[id^="mmd-"]').forEach(n => n.remove());
  }
}

let naturalW = null;
let naturalH = null;

function applyZoom(){
  const tw = document.getElementById('tw');
  const svgEl = document.querySelector('#tw svg');
  // Resize the actual SVG element rather than CSS-scaling it. A CSS
  // `transform: scale()` on vector content gets rasterized once by the
  // GPU compositor and then stretched, which is what causes the blur —
  // especially noticeable when zoomed in a lot. Setting real width/height
  // on the SVG makes the browser re-render the vector paths crisply at
  // the exact target size, at any zoom level.
  if(svgEl && naturalW && naturalH){
    svgEl.style.width = (naturalW * scale) + 'px';
    svgEl.style.height = (naturalH * scale) + 'px';
  }
  if(tw){
    tw.style.transform = `translate(${panX}px, ${panY}px)`;
  }
  zoomLabel.textContent = Math.round(scale*100) + '%';
}

document.getElementById('btnRender').onclick = render;
dirEl.onchange = render;

document.getElementById('zoomIn').onclick = ()=>{ scale = Math.min(scale * ZOOM_STEP, MAX_SCALE); applyZoom(); };
document.getElementById('zoomOut').onclick = ()=>{ scale = Math.max(scale / ZOOM_STEP, MIN_SCALE); applyZoom(); };
document.getElementById('zoomReset').onclick = ()=>{ scale = 1; panX = 0; panY = 0; applyZoom(); };

/* ---------------------------------------------------------------
   HAND TOOL (click-and-drag panning)
--------------------------------------------------------------- */
const handBtn = document.getElementById('handTool');
let handToolOn = false;
let isPanning = false;
let panStartX = 0, panStartY = 0, scrollStartX = 0, scrollStartY = 0;

handBtn.onclick = ()=>{
  handToolOn = !handToolOn;
  handBtn.classList.toggle('active', handToolOn);
  host.classList.toggle('hand-mode', handToolOn);
};

host.addEventListener('mousedown', (e)=>{
  if(!handToolOn) return;
  isPanning = true;
  host.classList.add('panning');
  panStartX = e.clientX; panStartY = e.clientY;
  scrollStartX = panX; scrollStartY = panY;
  e.preventDefault();
});
window.addEventListener('mousemove', (e)=>{
  if(!isPanning) return;
  panX = scrollStartX + (e.clientX - panStartX);
  panY = scrollStartY + (e.clientY - panStartY);
  applyZoom();
});
window.addEventListener('mouseup', ()=>{
  if(isPanning){ isPanning = false; host.classList.remove('panning'); }
});

host.addEventListener('touchstart', (e)=>{
  if(!handToolOn || e.touches.length !== 1) return;
  isPanning = true;
  host.classList.add('panning');
  panStartX = e.touches[0].clientX; panStartY = e.touches[0].clientY;
  scrollStartX = panX; scrollStartY = panY;
}, { passive:true });
host.addEventListener('touchmove', (e)=>{
  if(!isPanning || e.touches.length !== 1) return;
  panX = scrollStartX + (e.touches[0].clientX - panStartX);
  panY = scrollStartY + (e.touches[0].clientY - panStartY);
  applyZoom();
}, { passive:true });
host.addEventListener('touchend', ()=>{
  isPanning = false;
  host.classList.remove('panning');
});

/* Mouse-wheel zoom, centered on the cursor position */
host.addEventListener('wheel', (e)=>{
  if(!document.querySelector('#tw svg')) return;
  e.preventDefault();

  const hostBox = host.getBoundingClientRect();
  const mx = e.clientX - (hostBox.left + hostBox.width / 2);
  const my = e.clientY - (hostBox.top + hostBox.height / 2);

  const oldScale = scale;
  const newScale = e.deltaY < 0
    ? Math.min(scale * ZOOM_STEP, MAX_SCALE)
    : Math.max(scale / ZOOM_STEP, MIN_SCALE);

  if(newScale === oldScale) return;

  // Keep the point currently under the cursor fixed on screen while zooming.
  panX = mx - (newScale / oldScale) * (mx - panX);
  panY = my - (newScale / oldScale) * (my - panY);
  scale = newScale;
  applyZoom();
}, { passive:false });

document.getElementById('btnSVG').onclick = ()=>{
  if(!lastGoodSVG){ alert('กรุณาแปลงโค้ดเป็นภาพก่อน'); return; }
  const blob = new Blob([lastGoodSVG], { type:'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'flowchart.svg'; a.click();
  URL.revokeObjectURL(url);
};

// Mermaid always embeds node/edge labels as <foreignObject><div>...</div></foreignObject>
// (this happens no matter how htmlLabels/defaultRenderer are configured in recent
// Mermaid versions). Browsers refuse to export a <canvas> that was ever painted from
// an <img> whose SVG source contains a <foreignObject> ("Tainted canvases may not be
// exported"). To make PNG export work reliably we rewrite every foreignObject label
// into a plain SVG <text> element (with tspans for multi-line labels) before
// rasterizing, so the exported image never touches a foreignObject at all.
function convertForeignObjectsToSvgText(svgRoot){
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const foreignObjects = Array.from(svgRoot.querySelectorAll('foreignObject'));
  foreignObjects.forEach(fo=>{
    const width = parseFloat(fo.getAttribute('width')) || 0;
    const height = parseFloat(fo.getAttribute('height')) || 0;
    // The foreignObject isn't anchored at (0,0) inside its parent <g> — Mermaid
    // positions it with its own x/y offset (e.g. x="-40" y="-10") to center the
    // label on the node. Without adding that offset back in, the replacement
    // <text> renders at the group's origin instead of the label's real spot,
    // which is what made text drift away from its shape in exported PNGs.
    const offsetX = parseFloat(fo.getAttribute('x')) || 0;
    const offsetY = parseFloat(fo.getAttribute('y')) || 0;
    const holder = fo.querySelector('span, p, div') || fo;

    let color = '#ccc';
    let fontWeight = 'normal';
    let fontSize = '16px';
    try{
      const cs = window.getComputedStyle(holder);
      if(cs){
        if(cs.color) color = cs.color;
        if(cs.fontWeight) fontWeight = cs.fontWeight;
        if(cs.fontSize) fontSize = cs.fontSize;
      }
    }catch(e){ /* ignore, fall back to defaults */ }

    // Split into lines: prefer explicit <p>/<br> blocks, else treat as one line.
    let lines = [];
    const ps = fo.querySelectorAll('p');
    if(ps.length > 1){
      lines = Array.from(ps).map(p=>p.textContent.trim());
    } else {
      const raw = (fo.textContent || '').replace(/\u00a0/g,' ').trim();
      lines = raw.split(/\n+/).map(s=>s.trim()).filter(Boolean);
      if(lines.length === 0) lines = [''];
    }

    const textEl = document.createElementNS(SVG_NS, 'text');
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('fill', color);
    textEl.setAttribute('style', 'font-family:Inter,sans-serif;font-size:' + fontSize + ';font-weight:' + fontWeight + ';');

    const lineHeight = Math.min(height / Math.max(lines.length, 1), 22) || 16;
    const totalH = lineHeight * lines.length;
    const startY = offsetY + (height / 2) - (totalH / 2) + (lineHeight * 0.8);

    lines.forEach((line, i)=>{
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', String(offsetX + width / 2));
      tspan.setAttribute('y', String(startY + i * lineHeight));
      tspan.textContent = line;
      textEl.appendChild(tspan);
    });

    if(fo.parentNode) fo.parentNode.replaceChild(textEl, fo);
  });
}

document.getElementById('btnPNG').onclick = ()=>{
  if(!lastGoodSVG){ alert('กรุณาแปลงโค้ดเป็นภาพก่อน'); return; }

  // ใช้ SVG node ที่ render อยู่จริงในหน้า (ผ่าน HTML parser ซึ่งรองรับ entity ของ mermaid ได้กว้างกว่า)
  // แทนการ parse string ด้วย DOMParser แบบ XML เข้มงวด ที่อาจ error กับบาง entity แล้วโหลดภาพไม่ได้
  const liveSvg = document.querySelector('#tw svg');
  if(!liveSvg){
    alert('ไม่พบภาพผังงานในขณะนี้ กรุณาแปลงเป็นภาพก่อน');
    return;
  }

  const svgClone = liveSvg.cloneNode(true);
  let w = 0, h = 0;

  const wAttr = parseFloat(svgClone.getAttribute('width'));
  const hAttr = parseFloat(svgClone.getAttribute('height'));
  const viewBox = svgClone.getAttribute('viewBox');

  if(wAttr && hAttr && !isNaN(wAttr) && !isNaN(hAttr)){
    w = wAttr; h = hAttr;
  } else if(viewBox){
    const parts = viewBox.trim().split(/\s+/).map(Number);
    if(parts.length === 4 && parts[2] && parts[3]){ w = parts[2]; h = parts[3]; }
  }
  if((!w || !h) && naturalW && naturalH){
    w = naturalW; h = naturalH;
  }
  if(!w || !h){ w = 1200; h = 800; }

  svgClone.setAttribute('width', String(w));
  svgClone.setAttribute('height', String(h));
  svgClone.style.width = '';
  svgClone.style.height = '';
  if(!svgClone.getAttribute('xmlns')) svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  convertForeignObjectsToSvgText(svgClone);

  const svgMarkup = new XMLSerializer().serializeToString(svgClone);
  const svgBlob = new Blob([svgMarkup], { type:'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();

  img.onerror = ()=>{
    URL.revokeObjectURL(url);
    alert('ไม่สามารถสร้างไฟล์ PNG ได้ ลองใช้ปุ่ม "ดาวน์โหลด SVG" แทน หรือแปลงเป็นภาพใหม่อีกครั้ง');
  };

  img.onload = ()=>{
    try{
      const scaleFactor = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scaleFactor));
      canvas.height = Math.max(1, Math.round(h * scaleFactor));
      const ctx = canvas.getContext('2d');
      ctx.scale(scaleFactor, scaleFactor);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob=>{
        if(!blob){
          alert('ไม่สามารถสร้างไฟล์ PNG ได้ ลองใช้ปุ่ม "ดาวน์โหลด SVG" แทน');
          return;
        }
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl; a.download = 'flowchart.png'; a.click();
        URL.revokeObjectURL(pngUrl);
      }, 'image/png');
    } catch(err){
      alert('เกิดข้อผิดพลาดขณะสร้าง PNG: ' + (err && err.message ? err.message : String(err)));
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  img.src = url;
};

document.getElementById('btnOpenFile').onclick = ()=>{
  document.getElementById('fileInput').click();
};
document.getElementById('fileInput').addEventListener('change', (e)=>{
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    modeEl.value = 'code';
    editorLabel.textContent = 'ซอร์สโค้ด (C / C++ / Java / JavaScript)';
    document.getElementById('btnViewMmd').style.display = 'inline-block';
    document.getElementById('btnOpenFile').style.display = 'inline-block';
    buildSamples();
    codeEl.value = String(reader.result || '');
    render();
    saveAutosave();
    setStatus(true, 'โหลดไฟล์ ' + file.name + ' แล้ว');
  };
  reader.onerror = ()=>{
    alert('ไม่สามารถอ่านไฟล์นี้ได้ กรุณาตรวจสอบว่าเป็นไฟล์ข้อความ (.c/.cpp/.java/.js)');
  };
  reader.readAsText(file);
  e.target.value = ''; // allow re-selecting the same file later
});

document.getElementById('btnViewMmd').onclick = ()=>{
  if(!lastGeneratedMermaid){ alert('ยังไม่มีโค้ด Mermaid ที่แปลงได้ กด "แปลงเป็นภาพ" ก่อน'); return; }
  mmdOutput.textContent = lastGeneratedMermaid;
  mmdDrawer.classList.add('open');
};
document.getElementById('btnCloseMmd').onclick = ()=> mmdDrawer.classList.remove('open');
document.getElementById('btnCopyMmd').onclick = ()=>{
  if(!lastGeneratedMermaid) return;
  navigator.clipboard.writeText(lastGeneratedMermaid);
};
document.getElementById('btnUseMmd').onclick = ()=>{
  if(!lastGeneratedMermaid) return;
  modeEl.value = 'mermaid';
  editorLabel.textContent = 'โค้ด Mermaid';
  document.getElementById('btnViewMmd').style.display = 'none';
  codeEl.value = lastGeneratedMermaid;
  buildSamples();
  mmdDrawer.classList.remove('open');
  render();
  saveAutosave();
};

codeEl.addEventListener('keydown', (e)=>{
  if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); render(); }
});

const restored = loadAutosave();
if(restored){
  modeEl.value = restored.mode === 'code' ? 'code' : 'mermaid';
  dirEl.value = restored.direction || dirEl.value;
  const isCode = modeEl.value === 'code';
  editorLabel.textContent = isCode ? 'ซอร์สโค้ด (C / C++ / Java / JavaScript)' : 'โค้ด Mermaid';
  document.getElementById('btnViewMmd').style.display = isCode ? 'inline-block' : 'none';
  document.getElementById('btnOpenFile').style.display = isCode ? 'inline-block' : 'none';
  buildSamples();
  codeEl.value = restored.code;
} else {
  document.getElementById('btnViewMmd').style.display = 'none';
  document.getElementById('btnOpenFile').style.display = 'none';
  buildSamples();
  codeEl.value = MERMAID_DEFAULT;
}
render();
