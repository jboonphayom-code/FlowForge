// theme.js — mermaid color theme + per-shape legend colors.
// Owns: isLightMode flag, shapeColors state, and the two functions that
// touch mermaid's theme config. No knowledge of the code editor, parser,
// or render() loop — ui.js is responsible for calling render() after any
// of these setters change something visual.

let isLightMode = false;

const SHAPE_COLOR_DEFAULTS = {
  startEnd:    '#ffb84d',
  arrow:       '#5fa8ff',
  process:     '#22c55e',
  input:       '#f2a9e0',
  display:     '#29abe2',
  decision:    '#8b5cf6',
  connector:   '#e53935',
  preparation: '#facc15',
  subroutine:  '#38bdf8',
  document:    '#c084fc',
  database:    '#fb7185'
};
let shapeColors = Object.assign({}, SHAPE_COLOR_DEFAULTS);

function getShapeColor(key){
  const elId = 'clr' + key[0].toUpperCase() + key.slice(1);
  const el = document.getElementById(elId);
  if(!el){
    // Falls back to the in-memory value, but this almost always means a
    // shape key was added/renamed without adding a matching #clr<Key>
    // color-input in the HTML — warn loudly instead of failing silently,
    // since the fallback can mask the bug for a long time otherwise.
    console.warn(`[theme.js] getShapeColor('${key}'): no #${elId} element found in the DOM; falling back to the in-memory color. Check that the shape key and the color-input id stay in sync.`);
  }
  return (el && el.value) || shapeColors[key];
}

function setShapeColor(key, value){
  shapeColors[key] = value;
}

function resetShapeColors(){
  shapeColors = Object.assign({}, SHAPE_COLOR_DEFAULTS);
}

function isLight(){
  return isLightMode;
}

function toggleLightMode(){
  isLightMode = !isLightMode;
  return isLightMode;
}

function initMermaidTheme(){
  const arrowColor = getShapeColor('arrow');
  mermaid.initialize({
    startOnLoad:false,
    theme: isLightMode ? 'default' : 'dark',
    securityLevel:'loose',
    flowchart:{ htmlLabels:true },
    themeVariables: isLightMode ? {
      background:'#ffffff', primaryColor:'#eef1f7', primaryTextColor:'#101828',
      primaryBorderColor:arrowColor, lineColor:arrowColor, secondaryColor:'#e2e8f0',
      tertiaryColor:'#eef1f7', fontFamily:'Inter, sans-serif'
    } : {
      background:'#0b1220', primaryColor:'#111a2e', primaryTextColor:'#e7ecf6',
      primaryBorderColor:arrowColor, lineColor:arrowColor, secondaryColor:'#182238',
      tertiaryColor:'#111a2e', fontFamily:'Inter, sans-serif'
    }
  });
}

/* ---------------------------------------------------------------
   Inject per-shape colors (classDef/class) into flowchart source
   based on the shape syntax of each node, matching the legend:
   ([..]) start/end, [..] process, [/../] input, [\..\] display,
   {..} decision, ((..)) connector.
--------------------------------------------------------------- */
// Replaces the CONTENTS of every double-quoted label (keeping the quotes
// themselves, and keeping the string the same length) with underscores.
// Used ONLY to build a scratch copy for the id-detection regexes below —
// square brackets that show up INSIDE a node's own label text (e.g. a
// grouped node whose label literally contains "text_rows[0] = ...") would
// otherwise get misread as the `id[...]` "process" shape syntax, which
// only ever legitimately appears OUTSIDE quotes in a real node definition.
// Without this, a label containing bracket text could inject a bogus
// `class text_rows ffProcess` line and add a phantom disconnected node.
function maskQuotedForShapeScan(src){
  return src.replace(/"(?:[^"\\]|\\.)*"/g, m => '"' + '_'.repeat(Math.max(0, m.length - 2)) + '"');
}

// Blanks out `subgraph ...` header lines before shape-scanning. A subgraph
// header like `subgraph fn0["ฟังก์ชัน: main"]` or `subgraph uCol0[" "]`
// uses the exact same `id[...]` bracket syntax as a real "process" node
// definition — without this, the scan below would misdetect the subgraph
// itself as a process-shaped node and paint the whole subgraph box solid
// green (its class assignment lands after, and wins over, any `style`
// rule already set on that id, e.g. the transparent styling used for
// layout-only wrapper subgraphs).
function stripSubgraphHeadersForShapeScan(src){
  return src.split('\n')
    .map(line => /^\s*subgraph\b/i.test(line) ? '' : line)
    .join('\n');
}

function applyShapeColors(src){
  if(!/^\s*(flowchart|graph)\b/i.test(src)) return src;

  const scan = stripSubgraphHeadersForShapeScan(maskQuotedForShapeScan(src));
  const used = new Set();
  const groups = { startEnd:[], process:[], input:[], display:[], decision:[], connector:[],
                    preparation:[], subroutine:[], document:[], database:[] };

  const collect = (regex, bucket) => {
    let m;
    const re = new RegExp(regex, 'g');
    while((m = re.exec(scan)) !== null){
      const id = m[1];
      if(used.has(id)) continue;
      used.add(id);
      groups[bucket].push(id);
    }
  };

  // new-syntax shapes (mermaid v11 `id@{ shape: ..., label: "..." }`)
  collect(String.raw`\b(\w+)@\{\s*shape:\s*sl-rect\b`, 'input');
  collect(String.raw`\b(\w+)@\{\s*shape:\s*hex\b`, 'preparation');
  collect(String.raw`\b(\w+)@\{\s*shape:\s*fr-rect\b`, 'subroutine');
  collect(String.raw`\b(\w+)@\{\s*shape:\s*doc\b`, 'document');
  collect(String.raw`\b(\w+)@\{\s*shape:\s*cyl\b`, 'database');
  collect(String.raw`\b(\w+)@\{\s*shape:\s*curv-trap\b`, 'display');

  collect(String.raw`\b(\w+)\(\(([^()]*)\)\)`, 'connector');
  collect(String.raw`\b(\w+)\(\[([^\[\]]*)\]\)`, 'startEnd');
  collect(String.raw`\b(\w+)\[\/([^\/\]]*)\/\]`, 'input');
  collect(String.raw`\b(\w+)\[\\([^\\\]]*)\\\]`, 'display');
  collect(String.raw`\b(\w+)\{([^{}]*)\}`, 'decision');
  collect(String.raw`\b(\w+)\[([^\[\]]*)\]`, 'process');

  const classDefs = [
    `classDef ffStartEnd fill:${getShapeColor('startEnd')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffProcess fill:${getShapeColor('process')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffInput fill:${getShapeColor('input')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffDisplay fill:${getShapeColor('display')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffDecision fill:${getShapeColor('decision')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffConnector fill:${getShapeColor('connector')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffPreparation fill:${getShapeColor('preparation')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffSubroutine fill:${getShapeColor('subroutine')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffDocument fill:${getShapeColor('document')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`,
    `classDef ffDatabase fill:${getShapeColor('database')},stroke:#0009,stroke-width:1.5px,color:#111827,font-weight:600;`
  ];

  const classAssign = [];
  if(groups.startEnd.length) classAssign.push(`class ${groups.startEnd.join(',')} ffStartEnd`);
  if(groups.process.length) classAssign.push(`class ${groups.process.join(',')} ffProcess`);
  if(groups.input.length) classAssign.push(`class ${groups.input.join(',')} ffInput`);
  if(groups.display.length) classAssign.push(`class ${groups.display.join(',')} ffDisplay`);
  if(groups.decision.length) classAssign.push(`class ${groups.decision.join(',')} ffDecision`);
  if(groups.connector.length) classAssign.push(`class ${groups.connector.join(',')} ffConnector`);
  if(groups.preparation.length) classAssign.push(`class ${groups.preparation.join(',')} ffPreparation`);
  if(groups.subroutine.length) classAssign.push(`class ${groups.subroutine.join(',')} ffSubroutine`);
  if(groups.document.length) classAssign.push(`class ${groups.document.join(',')} ffDocument`);
  if(groups.database.length) classAssign.push(`class ${groups.database.join(',')} ffDatabase`);

  if(classAssign.length === 0) return src;
  return src + '\n' + classDefs.join('\n') + '\n' + classAssign.join('\n');
}

export {
  SHAPE_COLOR_DEFAULTS,
  getShapeColor,
  setShapeColor,
  resetShapeColors,
  isLight,
  toggleLightMode,
  initMermaidTheme,
  applyShapeColors
};
