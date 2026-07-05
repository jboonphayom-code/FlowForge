// parser.js — Heuristic C/C++/Java/JavaScript -> Mermaid flowchart converter.
// Pure logic module: no DOM access, no globals leak outside this file.
// Public API: convertCodeToMermaid(sourceCode) -> mermaid flowchart source (string).
// Throws Error with a Thai message the UI layer can show directly if nothing
// parseable is found (see convertCodeToMermaid at the bottom of this file).

// All parser state (node/edge lists, counters, the loop/switch context
// stack, and the offset-tracking source string) now lives INSIDE this
// factory function instead of at module scope. Each call to createParser()
// gets its own fresh, isolated state, so multiple conversions can safely
// run concurrently (e.g. Promise.all([...]) or overlapping calls from the
// UI) without one run's counters/node list bleeding into another's.
function createParser(){
  let nodeCounter = 0;
  let connectorCounter = 0;
  let nodeDefs = [];
  let edgeDefs = [];
  let contextStack = []; // stack of { type:'loop'|'switch', continueTarget, breakExits:[] }

  // The comment/directive-stripped source that all character offsets used
  // during parsing are relative to (see convertCodeToMermaid). Kept around
  // purely so lineAt() can translate an offset back into a 1-based line
  // number for error messages — nothing else reads from it.
  let sourceForLines = '';

  // Translates a character offset (into sourceForLines) into a 1-based line
  // number. Used to tell the user *where* in their code a parse error is,
  // instead of just that one happened.
  function lineAt(offset){
    const lim = Math.max(0, Math.min(offset, sourceForLines.length));
    let line = 1;
    for(let k = 0; k < lim; k++){
      if(sourceForLines[k] === '\n') line++;
    }
    return line;
  }

  function sanitizeLabel(text){
    if(!text) return ' ';
    // Truncate the RAW text first, then escape backslashes. If we escaped
    // first (doubling every `\` to `\\`) and truncated afterwards, the cut
    // could land in the middle of a doubled-backslash pair, leaving a single
    // dangling `\` right before the closing quote or the "..." ellipsis —
    // producing an invalid escape sequence and making Mermaid's parser throw
    // (this is exactly what happened with long strings full of `\x2588`
    // Unicode block escapes, like flag/ASCII-art drawing code).
    let raw = String(text).replace(/\s+/g,' ').trim();
    if(raw.length > 70) raw = raw.slice(0,67) + '...';
    // Escape backslashes AFTER truncating. Node labels can end up inside
    // Mermaid's YAML-like `@{ shape: ..., label: "..." }` syntax, which
    // treats a lone backslash as the start of an escape sequence. Source
    // code that contains string literals with backslashes (\x2588, \n, \t,
    // Windows paths like C:\Users, etc.) would otherwise produce an invalid
    // escape and make Mermaid throw a parse error, breaking the whole
    // conversion. Doubling every backslash keeps it as a literal character.
    let t = raw.replace(/\\/g, '\\\\').replace(/"/g, "'");
    return t || ' ';
  }

  // Maps our internal shape keys to mermaid v11 expanded-shape names.
  // (see: https://mermaid.js.org/syntax/flowchart.html#expanded-node-shapes)
  const SHAPE_MAP = {
    input:       'sl-rect',  // Manual Input (sloped rectangle) — keyboard entry (cin/scanf/input()/Scanner)
    preparation: 'hex',      // Preparation (hexagon) — e.g. initializing a loop counter
    subroutine:  'fr-rect',  // Subroutine / Predefined Process (framed rectangle) — user-defined function calls
    document:    'doc',      // Document — writing to a file / printed report
    database:    'cyl',      // Database (cylinder) — SQL / query operations
    output:      'curv-trap' // Display (curved trapezoid) — screen/console output (cout/printf/console.log),
                              // matches the true ANSI/ISO 5807 "Display" symbol instead of a plain parallelogram
  };

  // Shared wording for every terminal ("End") node, whether it comes from
  // an explicit `return` or from control flow simply falling off the end
  // of the function. Keeping this in one place means both cases read the
  // same way ("จบ" / "จบ (return ...)") instead of the two previously
  // drifting apart ("return ค่า" vs. plain "จบ").
  function endLabel(text){
    return text ? ('จบ (return ' + text + ')') : 'จบ';
  }

  function newNode(shape, text){
    const id = 'n' + (nodeCounter++);
    const label = sanitizeLabel(text);
    let def;
    if(shape === 'start' || shape === 'end') def = `${id}(["${label}"])`;
    else if(shape === 'decision') def = `${id}{"${label}"}`;
    else if(SHAPE_MAP[shape]) def = `${id}@{ shape: ${SHAPE_MAP[shape]}, label: "${label}" }`;
    else def = `${id}["${label}"]`;
    nodeDefs.push(def);
    return id;
  }

  // Connector labels cycle A, B, C ... Z, A2, B2, ... to keep circles short.
  function nextConnectorLabel(){
    const n = connectorCounter++;
    const letter = String.fromCharCode(65 + (n % 26));
    const round = Math.floor(n / 26);
    return round === 0 ? letter : letter + (round + 1);
  }

  // A real on-page connector: a small circle, used twice with the SAME label
  // (once where flow leaves, once where it re-enters) with NO edge drawn
  // between the two — matching the standard flowchart convention for
  // avoiding long / crossing loop-back lines.
  function newConnectorPair(){
    const label = nextConnectorLabel();
    const outId = 'n' + (nodeCounter++);
    const inId = 'n' + (nodeCounter++);
    nodeDefs.push(`${outId}(("${label}"))`);
    nodeDefs.push(`${inId}(("${label}"))`);
    return { outId, inId };
  }

  function connect(exits, targetId){
    for(const e of exits){
      edgeDefs.push(`${e.from} -->${e.label ? '|' + sanitizeLabel(e.label) + '|' : ''} ${targetId}`);
    }
  }

  // Route "exits" back to "targetId" (a loop's condition/start node). If
  // connectors are enabled, insert a matching pair of connector circles
  // instead of one long back-edge.
  function connectLoopBack(exits, targetId, useConnectors){
    if(!exits.length) return;
    if(!useConnectors){
      connect(exits, targetId);
      return;
    }
    const { outId, inId } = newConnectorPair();
    connect(exits, outId);
    edgeDefs.push(`${inId} --> ${targetId}`);
  }

  function maskLiterals(src){
    const re = new RegExp('"(?:\\\\.|[^"\\\\])*"' + "|'(?:\\\\.|[^'\\\\])*'", 'g');
    return src.replace(re, m => '"' + '_'.repeat(Math.max(0, m.length-2)) + '"');
  }

  // Matches a function-style signature: two word-ish tokens (a return type
  // and a name) followed by a parenthesized parameter list and an opening
  // brace. Deliberately requires TWO tokens before the `(` so bare control
  // structures like `if (...)` / `while (...)` / `for (...)` (only one
  // token) never match this.
  const FUNC_SIG_RE = /\b([\w:<>,\s\*&]+?)\s+(\w+)\s*\([^)]*\)\s*\{/g;

  // Walks backward from `idx` over characters that could plausibly be part
  // of a return-type prefix (the same char class FUNC_SIG_RE allows before
  // a function name), so a bare `\bmain\(...)` match can be widened to
  // include its `int `/`void `/etc. prefix. Without this, the otherFunctions
  // count below would double-count main() itself: once as "main" (from the
  // narrow \bmain match) and once as "int main(...)" (from the broader
  // FUNC_SIG_RE scan), since the two wouldn't appear to overlap.
  function extendSignatureStart(str, idx){
    let k = idx;
    while(k > 0 && /[\w:<>,\s\*&]/.test(str[k-1])) k--;
    return k;
  }

  function extractMainBody(origSrc, maskedSrc){
    let braceIdx, sigStart, functionName;
    const mm = maskedSrc.match(/\bmain\s*\([^)]*\)\s*\{/);
    if(mm){
      braceIdx = mm.index + mm[0].length - 1;
      sigStart = extendSignatureStart(maskedSrc, mm.index);
      functionName = 'main';
    } else {
      FUNC_SIG_RE.lastIndex = 0;
      const m2 = FUNC_SIG_RE.exec(maskedSrc);
      if(m2){
        braceIdx = m2.index + m2[0].length - 1;
        sigStart = m2.index;
        functionName = m2[2];
      }
    }
    if(braceIdx === undefined){
      return { orig: origSrc, masked: maskedSrc, offset: 0, functionName: null, otherFunctions: 0 };
    }
    let depth = 1, j = braceIdx + 1;
    while(j < maskedSrc.length){
      if(maskedSrc[j] === '{') depth++;
      else if(maskedSrc[j] === '}'){ depth--; if(depth === 0) break; }
      j++;
    }
    if(depth !== 0){
      // Ran off the end of the file without finding the closing brace for
      // this function — a missing/extra `{` or `}` somewhere in the body,
      // which previously silently swallowed everything to the end of the
      // file as if it belonged to this function. Point at the opening
      // brace's line instead of guessing.
      const e = new Error(`ไม่พบวงเล็บปีกกา "}" ที่ปิดคู่กับฟังก์ชัน ให้ตรงกัน (เปิดที่บรรทัดที่ ${lineAt(braceIdx)}) กรุณาตรวจสอบว่าใส่ปีกกาปิดครบทุกจุดหรือไม่`);
      e.line = lineAt(braceIdx);
      throw e;
    }

    // Count OTHER top-level function-looking signatures in the source, so
    // the caller can warn the user that only `functionName` was converted
    // and the rest of the file was silently ignored — previously this
    // happened with no indication at all.
    let otherFunctions = 0;
    FUNC_SIG_RE.lastIndex = 0;
    let fm;
    while((fm = FUNC_SIG_RE.exec(maskedSrc)) !== null){
      if(fm.index >= sigStart && fm.index < j) continue; // the function we already picked
      otherFunctions++;
    }

    return {
      orig: origSrc.slice(braceIdx+1, j),
      masked: maskedSrc.slice(braceIdx+1, j),
      offset: braceIdx + 1,
      functionName,
      otherFunctions
    };
  }

  // Finds EVERY top-level function-looking block in the source (used by
  // the "ทั้งหมด" / all-functions conversion mode). Walks left to right
  // with a fresh copy of FUNC_SIG_RE, and after extracting each function's
  // body jumps the scan past its closing brace — so a nested function
  // declared inside another one (legal in JS) is treated as part of its
  // parent's body rather than pulled out as a second top-level entry.
  function findAllFunctions(origSrc, maskedSrc){
    const re = new RegExp(FUNC_SIG_RE.source, 'g');
    const results = [];
    let m;
    while((m = re.exec(maskedSrc)) !== null){
      const braceIdx = m.index + m[0].length - 1;
      let depth = 1, j = braceIdx + 1;
      while(j < maskedSrc.length){
        if(maskedSrc[j] === '{') depth++;
        else if(maskedSrc[j] === '}'){ depth--; if(depth === 0) break; }
        j++;
      }
      if(depth !== 0){
        const e = new Error(`ไม่พบวงเล็บปีกกา "}" ที่ปิดคู่กับฟังก์ชัน "${m[2]}" ให้ตรงกัน (เปิดที่บรรทัดที่ ${lineAt(m.index)}) กรุณาตรวจสอบว่าใส่ปีกกาปิดครบทุกจุดหรือไม่`);
        e.line = lineAt(m.index);
        throw e;
      }
      results.push({
        name: m[2],
        orig: origSrc.slice(braceIdx+1, j),
        masked: maskedSrc.slice(braceIdx+1, j),
        offset: braceIdx + 1
      });
      re.lastIndex = j + 1; // resume scanning AFTER this function's body
    }
    return results;
  }

  function classifyGeneric(text){
    const t = text.trim();
    // Manual Input: any keyboard-entry construct (rendered as a sloped rectangle)
    if(/^\s*(cin|scanf)\b/.test(t)) return { type:'input', text };
    if(/=\s*(input\s*\(|prompt\s*\(|\w+(\.\w+)*\.(nextInt|nextLine|nextDouble|next)\s*\()/.test(t)) return { type:'input', text };
    // Console/screen output
    if(/^\s*(cout|printf|wprintf|print|System\.out\.print(ln)?|console\.log)\b/.test(t)) return { type:'output', text };
    // Document: writing to a file / printed report
    if(/\b(ofstream|fprintf|fputs|fwrite)\b/.test(t) && !/\bstdout\b/.test(t)) return { type:'document', text };
    if(/\.(write|writelines|writeAllText)\s*\(/.test(t) || /\bfs\.writeFile\w*\s*\(/.test(t)) return { type:'document', text };
    // Database: SQL / query-style operations
    if(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(t)) return { type:'database', text };
    if(/\.(query|execute|executeQuery|executeUpdate)\s*\(/.test(t) || /\b(cursor|connection|conn|db)\s*\.\s*\w+\s*\(/.test(t)) return { type:'database', text };
    // Subroutine: a bare call to a (presumably user-defined) function/method,
    // i.e. the whole statement IS the call — not an assignment, not a
    // control-flow keyword. Matches the "Predefined Process" flowchart symbol.
    if(/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*\s*\([^]*\)\s*;?\s*$/.test(t) && !hasTopLevelAssignment(t)){
      return { type:'subroutine', text };
    }
    return { type:'simple', text };
  }

  // Scans for a bare '=' assignment OUTSIDE any parentheses/brackets — used
  // to tell a real top-level assignment apart from an '=' that only appears
  // *inside* the call's own argument list, e.g. a default parameter
  // `foo(x = 5)` or an arrow-function argument `list.sort((a,b)=>a-b)`.
  // The previous check (`!/[=]/.test(...)`) looked at the whole statement
  // regardless of nesting, so any call whose arguments merely contained an
  // '=' was wrongly disqualified from being classified as a subroutine call.
  function hasTopLevelAssignment(str){
    let depth = 0;
    for(let i = 0; i < str.length; i++){
      const c = str[i];
      if(c === '(' || c === '[') depth++;
      else if(c === ')' || c === ']') depth--;
      else if(c === '=' && depth === 0){
        const prev = str[i-1], next = str[i+1];
        // skip ==, !=, <=, >=, => — none of those are an assignment
        if(prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=' || next === '>') continue;
        return true;
      }
    }
    return false;
  }

  function extractOutputLabel(text){
    let t = text.replace(/;\s*$/, '');
    if(/^\s*cout/.test(t)){
      const rest = t.replace(/^\s*cout\s*/, '');
      const parts = rest.split('<<').map(p=>p.trim()).filter(Boolean);
      const out = [];
      for(const p of parts){
        if(p === 'endl' || p === 'std::endl') continue;
        const sm = p.match(/^"([\s\S]*)"$/);
        if(sm) out.push(sm[1].replace(/\\n/g,' ').replace(/\\t/g,' '));
        else out.push('{' + p + '}');
      }
      return out.join('').trim() || 'แสดงผล';
    }
    const pm = t.match(/\(([\s\S]*)\)\s*$/);
    if(pm){
      return pm[1].split(/[+,]/).map(s=>{
        const cleaned = s.trim().replace(/^L(?=")/, ''); // strip wide-string L prefix, e.g. L"text"
        const sm = cleaned.match(/^"([\s\S]*)"$/);
        return sm ? sm[1] : '{' + s.trim() + '}';
      }).join(' ').trim() || 'แสดงผล';
    }
    return t;
  }

  function extractDocumentLabel(text){
    return 'บันทึกเอกสาร: ' + text.replace(/;\s*$/, '').trim();
  }

  function extractDatabaseLabel(text){
    return 'ฐานข้อมูล: ' + text.replace(/;\s*$/, '').trim();
  }

  function extractSubroutineLabel(text){
    return text.replace(/;\s*$/, '').trim();
  }

  function extractInputLabel(text){
    let t = text.replace(/;\s*$/, '');
    if(/^\s*cin/.test(t)){
      const parts = t.replace(/^\s*cin\s*/, '').split('>>').map(p=>p.trim()).filter(Boolean);
      return 'รับค่า: ' + parts.join(', ');
    }
    const m = t.match(/scanf\s*\(([\s\S]*)\)/);
    if(m){
      const args = m[1].split(',').map(s=>s.trim());
      return 'รับค่า: ' + args.slice(1).join(', ').replace(/&/g,'');
    }
    return t;
  }

  // Statements that only configure the console/terminal or runtime locale —
  // not part of the algorithm itself. Hidden from the flowchart when the
  // "ซ่อนคำสั่งระบบ" toggle is on, so readers focus on the logic, not on
  // console plumbing.
  const SYSTEM_CALL_PATTERNS = [
    /^_setmode\s*\(/i,
    /^_fileno\s*\(/i,
    /^GetStdHandle\s*\(/i,
    /^SetConsoleTextAttribute\s*\(/i,
    /^SetConsoleOutputCP\s*\(/i,
    /^SetConsoleCP\s*\(/i,
    /^setlocale\s*\(/i,
    /^system\s*\(\s*"(cls|clear|pause|chcp[^"]*)"\s*\)/i,
    /^std::ios(_base)?::sync_with_stdio\s*\(/i,
    /^ios_base::sync_with_stdio\s*\(/i,
    /^cin\.tie\s*\(/i,
    /^setvbuf\s*\(/i
  ];
  function isSystemCall(text){
    const t = text.trim();
    return SYSTEM_CALL_PATTERNS.some(re => re.test(t));
  }

  // Console-formatting calls (set color / move cursor) that, when placed
  // right before an output statement, read more naturally as ONE box —
  // e.g. `textcolor(RED); wprintf(L"เกิดข้อผิดพลาด");` becomes a single
  // "แสดงผลข้อความ (ปรับสี): ..." box instead of two separate boxes.
  const GROUP_PREFIX_PATTERNS = [
    { re:/^(textcolor|settextcolor|setcolor|textbackground)\s*\(/i, note:'ปรับสีข้อความ' },
    { re:/^gotoxy\s*\(/i, note:'ย้ายตำแหน่งเคอร์เซอร์' }
  ];
  function matchGroupPrefix(text){
    const t = text.trim();
    for(const p of GROUP_PREFIX_PATTERNS){ if(p.re.test(t)) return p.note; }
    return null;
  }

  // Walks the parsed statement tree (recursing into every nested body:
  // if/else, loops, switch-cases, try/catch/finally) applying, in order:
  //  1) system-call hiding — matching statements are dropped entirely
  //     (the flow just skips over them, no dangling node)
  //  2) output grouping — a formatting call immediately followed by an
  //     output statement collapses into a single output node
  function postProcessStmts(stmts, opts){
    const hideSystem = !!opts.hideSystem;
    const groupOutputs = !!opts.groupOutputs;

    // Recurse first so nested blocks are cleaned up too.
    for(const s of stmts){
      if(s.thenBody) s.thenBody = postProcessStmts(s.thenBody, opts);
      if(s.elseBody) s.elseBody = postProcessStmts(s.elseBody, opts);
      if(s.body && Array.isArray(s.body)) s.body = postProcessStmts(s.body, opts);
      if(s.tryBody) s.tryBody = postProcessStmts(s.tryBody, opts);
      if(s.catchBody) s.catchBody = postProcessStmts(s.catchBody, opts);
      if(s.finallyBody) s.finallyBody = postProcessStmts(s.finallyBody, opts);
      if(s.cases) s.cases.forEach(c => { c.body = postProcessStmts(c.body, opts); });
    }

    let out = stmts;
    if(hideSystem){
      out = out.filter(s => !((s.type === 'simple' || s.type === 'subroutine') && isSystemCall(s.text)));
    }

    if(groupOutputs){
      const merged = [];
      for(let k = 0; k < out.length; k++){
        const cur = out[k];
        const next = out[k+1];
        if(next && next.type === 'output' &&
           (cur.type === 'simple' || cur.type === 'subroutine')){
          const note = matchGroupPrefix(cur.text);
          if(note){
            merged.push({ type:'output', text: next.text, groupNote: note });
            k++; // consume the paired output too
            continue;
          }
        }
        merged.push(cur);
      }
      out = merged;
    }

    return out;
  }

  function parseStatements(orig, masked, baseOffset){
    baseOffset = baseOffset || 0;
    let i = 0;
    const n = masked.length;
    const stmts = [];

    function skipWs(){ while(i < n && /\s/.test(masked[i])) i++; }
    function matchKeyword(kw){ skipWs(); return new RegExp('^' + kw + '\\b').test(masked.slice(i)); }
    function findMatching(openCh, closeCh, start){
      let depth = 1, j = start + 1;
      while(j < n){
        if(masked[j] === openCh) depth++;
        else if(masked[j] === closeCh){ depth--; if(depth === 0) return j; }
        j++;
      }
      // Reached the end of this scope without finding the matching
      // bracket — genuinely unbalanced source, not something we can
      // recover from by guessing. Point at the line where it opened.
      const openLine = lineAt(baseOffset + start);
      const e = new Error(`ไม่พบ "${closeCh}" ที่ปิดคู่กับ "${openCh}" ให้ตรงกัน (เปิดที่บรรทัดที่ ${openLine}) กรุณาตรวจสอบวงเล็บที่บรรทัดนี้`);
      e.line = openLine;
      throw e;
    }
    function readParenGroup(){
      skipWs();
      const start = i;
      const end = findMatching('(', ')', i);
      const content = orig.slice(start+1, end);
      i = end + 1;
      return content.trim();
    }
    function readBlockOrSingle(){
      skipWs();
      if(masked[i] === '{'){
        const start = i, end = findMatching('{', '}', i);
        const io = orig.slice(start+1, end), im = masked.slice(start+1, end);
        i = end + 1;
        return parseStatements(io, im, baseOffset + start + 1);
      }
      const s = readSingleStatement();
      return s ? [s] : [];
    }
    function skipToSemi(){
      let depth = 0;
      while(i < n){
        const c = masked[i];
        if(c === '(' || c === '[') depth++;
        else if(c === ')' || c === ']') depth--;
        else if(c === ';' && depth <= 0){ i++; break; }
        i++;
      }
    }
    function readGenericStatement(){
      const start = i;
      let depth = 0;
      while(i < n){
        const c = masked[i];
        if(c === '(' || c === '[') depth++;
        else if(c === ')' || c === ']') depth--;
        else if(c === ';' && depth <= 0) break;
        else if(c === '{' && depth <= 0) break;
        i++;
      }
      const text = orig.slice(start, i).trim();
      if(masked[i] === ';') i++;
      if(!text) return null;
      return classifyGeneric(text);
    }
    function readIf(){
      i += 2;
      const cond = readParenGroup();
      const thenBody = readBlockOrSingle();
      skipWs();
      let elseBody = null;
      if(matchKeyword('else')){
        i += 4; skipWs();
        elseBody = matchKeyword('if') ? [readIf()] : readBlockOrSingle();
      }
      return { type:'if', cond, thenBody, elseBody };
    }
    function readWhile(){
      i += 5;
      const cond = readParenGroup();
      const body = readBlockOrSingle();
      return { type:'while', cond, body };
    }
    function readDoWhile(){
      i += 2;
      const body = readBlockOrSingle();
      skipWs();
      if(matchKeyword('while')) i += 5;
      const cond = readParenGroup();
      skipWs();
      if(masked[i] === ';') i++;
      return { type:'dowhile', cond, body };
    }
    function splitForParts(maskedInner, origInner){
      let depth = 0; const idxs = [];
      for(let k=0;k<maskedInner.length;k++){
        const c = maskedInner[k];
        if(c==='('||c==='[') depth++;
        else if(c===')'||c===']') depth--;
        else if(c===';' && depth===0) idxs.push(k);
      }
      if(idxs.length < 2) return { init:'', cond: origInner.trim(), incr:'' };
      return {
        init: origInner.slice(0, idxs[0]).trim(),
        cond: origInner.slice(idxs[0]+1, idxs[1]).trim(),
        incr: origInner.slice(idxs[1]+1).trim()
      };
    }
    function readFor(){
      i += 3; skipWs();
      const start = i, end = findMatching('(', ')', i);
      const innerOrig = orig.slice(start+1, end), innerMasked = masked.slice(start+1, end);
      i = end + 1;
      const parts = splitForParts(innerMasked, innerOrig);
      const body = readBlockOrSingle();
      return { type:'for', init:parts.init, cond:parts.cond, incr:parts.incr, body };
    }
    function parseCases(orig2, masked2, base2){
      const cases = [];
      const re = /\b(case\s+[^:]+|default)\s*:/g;
      const matches = []; let m;
      while((m = re.exec(masked2))) matches.push({ index:m.index, end:re.lastIndex, text:m[1] });
      for(let k=0;k<matches.length;k++){
        const bodyStart = matches[k].end;
        const bodyEnd = k+1 < matches.length ? matches[k+1].index : masked2.length;
        const label = orig2.slice(matches[k].index, matches[k].end-1).trim();
        cases.push({
          label,
          body: parseStatements(orig2.slice(bodyStart, bodyEnd), masked2.slice(bodyStart, bodyEnd), base2 + bodyStart)
        });
      }
      return cases;
    }
    function readSwitch(){
      i += 6;
      const expr = readParenGroup();
      skipWs();
      const start = i, end = findMatching('{', '}', i);
      const cases = parseCases(orig.slice(start+1, end), masked.slice(start+1, end), baseOffset + start + 1);
      i = end + 1;
      return { type:'switch', expr, cases };
    }
    function readTry(){
      i += 3; // consume 'try'
      const tryBody = readBlockOrSingle();
      let catchBody = [];
      let hasCatch = false;
      skipWs();
      while(matchKeyword('catch')){
        hasCatch = true;
        i += 5; skipWs();
        if(masked[i] === '('){ readParenGroup(); } // catch parameter, not needed for the diagram
        catchBody = catchBody.concat(readBlockOrSingle());
        skipWs();
      }
      let finallyBody = null;
      if(matchKeyword('finally')){
        i += 7;
        finallyBody = readBlockOrSingle();
      }
      return { type:'trycatch', tryBody, catchBody, hasCatch, finallyBody };
    }
    function readReturn(){
      i += 6; // consume 'return'
      skipWs();
      const start = i;
      skipToSemi();
      const text = orig.slice(start, Math.max(start, i-1)).trim();
      return { type:'return', text };
    }
    function readSingleStatement(){
      skipWs();
      if(i >= n) return null;
      const stmtLine = lineAt(baseOffset + i);
      let node;
      if(matchKeyword('if')) node = readIf();
      else if(matchKeyword('while')) node = readWhile();
      else if(matchKeyword('for')) node = readFor();
      else if(matchKeyword('do')) node = readDoWhile();
      else if(matchKeyword('switch')) node = readSwitch();
      else if(matchKeyword('try')) node = readTry();
      else if(matchKeyword('return')) node = readReturn();
      else if(matchKeyword('throw')){
        i += 5; skipWs();
        const start = i;
        skipToSemi();
        const text = orig.slice(start, Math.max(start, i-1)).trim();
        node = { type:'throw', text };
      }
      else if(matchKeyword('break')){ skipToSemi(); node = { type:'break' }; }
      else if(matchKeyword('continue')){ skipToSemi(); node = { type:'continue' }; }
      else if(masked[i] === '{'){
        const start = i, end = findMatching('{', '}', i);
        const io = orig.slice(start+1,end), im = masked.slice(start+1,end);
        i = end + 1;
        node = { type:'block', body: parseStatements(io, im, baseOffset + start + 1) };
      }
      else node = readGenericStatement();
      if(node && node.line === undefined) node.line = stmtLine;
      return node;
    }

    while(true){
      skipWs();
      if(i >= n) break;
      const before = i;
      const s = readSingleStatement();
      if(!s){ if(i === before) break; else continue; }
      if(s.type === 'block') stmts.push(...s.body);
      else stmts.push(s);
      if(i === before) break; // safety against infinite loop
    }
    return stmts;
  }

  function processStatements(stmts, entryExits){
    let exits = entryExits;
    for(const stmt of stmts){
      if(!exits.length) break; // dead code after return/etc — stop routing
      exits = processStatement(stmt, exits);
    }
    return exits;
  }

  // Find the nearest enclosing context matching a predicate (innermost first).
  function findContext(pred){
    for(let k = contextStack.length - 1; k >= 0; k--){
      if(pred(contextStack[k])) return contextStack[k];
    }
    return null;
  }

  function processStatement(stmt, entryExits){
    const useConnectors = true; // always use connector circles for loop-backs

    switch(stmt.type){
      case 'simple': {
        const id = newNode('process', stmt.text.replace(/;\s*$/, ''));
        connect(entryExits, id);
        return [{ from:id }];
      }
      case 'input': {
        const id = newNode('input', extractInputLabel(stmt.text));
        connect(entryExits, id);
        return [{ from:id }];
      }
      case 'output': {
        const label = stmt.groupNote
          ? `แสดงผลข้อความ (${stmt.groupNote}): ${extractOutputLabel(stmt.text)}`
          : extractOutputLabel(stmt.text);
        const id = newNode('output', label);
        connect(entryExits, id);
        return [{ from:id }];
      }
      case 'document': {
        const id = newNode('document', extractDocumentLabel(stmt.text));
        connect(entryExits, id);
        return [{ from:id }];
      }
      case 'database': {
        const id = newNode('database', extractDatabaseLabel(stmt.text));
        connect(entryExits, id);
        return [{ from:id }];
      }
      case 'subroutine': {
        const id = newNode('subroutine', extractSubroutineLabel(stmt.text));
        connect(entryExits, id);
        return [{ from:id }];
      }
      case 'if': {
        const id = newNode('decision', stmt.cond);
        connect(entryExits, id);
        const thenExits = processStatements(stmt.thenBody, [{ from:id, label:'ใช่' }]);
        const elseExits = stmt.elseBody
          ? processStatements(stmt.elseBody, [{ from:id, label:'ไม่' }])
          : [{ from:id, label:'ไม่' }];
        return thenExits.concat(elseExits);
      }
      case 'while': {
        const id = newNode('decision', stmt.cond);
        connect(entryExits, id);
        const ctx = { type:'loop', continueTarget:id, breakExits:[] };
        contextStack.push(ctx);
        const bodyExits = processStatements(stmt.body, [{ from:id, label:'ใช่' }]);
        contextStack.pop();
        connectLoopBack(bodyExits, id, useConnectors);
        // A literal `while(true)`/`while(1)` can never evaluate false, so the
        // "ไม่" exit is unreachable — omit it instead of wiring a dead arrow
        // to whatever code happens to follow (which real execution can never
        // reach, e.g. a trailing `return` after the loop).
        const condIsAlwaysTrue = /^\s*(true|1)\s*$/i.test(stmt.cond || '');
        return condIsAlwaysTrue ? [...ctx.breakExits] : [{ from:id, label:'ไม่' }, ...ctx.breakExits];
      }
      case 'dowhile': {
        const startId = newNode('process', 'เริ่มลูป');
        connect(entryExits, startId);
        // Pre-create the condition node so `continue` (which jumps to the
        // bottom-of-loop test in a do-while) has a target while the body
        // is still being processed.
        const condId = newNode('decision', stmt.cond);
        const ctx = { type:'loop', continueTarget:condId, breakExits:[] };
        contextStack.push(ctx);
        const bodyExits = processStatements(stmt.body, [{ from:startId }]);
        contextStack.pop();
        connect(bodyExits, condId);
        connectLoopBack([{ from:condId, label:'ใช่' }], startId, useConnectors);
        return [{ from:condId, label:'ไม่' }, ...ctx.breakExits];
      }
      case 'for': {
        let exits = entryExits;
        if(stmt.init){
          // Standard convention: initializing the loop-control variable
          // uses the Preparation (hexagon) symbol, not a plain process box.
          const initId = newNode('preparation', stmt.init);
          connect(exits, initId);
          exits = [{ from:initId }];
        }
        const condId = newNode('decision', stmt.cond || 'true');
        connect(exits, condId);
        // Pre-create the increment node (if any) so `continue` can target it —
        // in a for-loop, continue runs the increment before re-testing.
        const incrId = stmt.incr ? newNode('process', stmt.incr) : null;
        const ctx = { type:'loop', continueTarget: incrId || condId, breakExits:[] };
        contextStack.push(ctx);
        let bodyExits = processStatements(stmt.body, [{ from:condId, label:'ใช่' }]);
        contextStack.pop();
        if(incrId){
          connect(bodyExits, incrId);
          connectLoopBack([{ from:incrId }], condId, useConnectors);
        } else {
          connectLoopBack(bodyExits, condId, useConnectors);
        }
        const forCondIsAlwaysTrue = /^\s*(true|1)?\s*$/i.test(stmt.cond || '');
        return forCondIsAlwaysTrue ? [...ctx.breakExits] : [{ from:condId, label:'ไม่' }, ...ctx.breakExits];
      }
      case 'switch': {
        const id = newNode('decision', stmt.expr);
        connect(entryExits, id);
        const ctx = { type:'switch', breakExits:[] };
        contextStack.push(ctx);
        let fallExits = []; // C-style fallthrough: flow that "fell off the
                             // end" of the previous case with no break
        for(const c of stmt.cases){
          const caseEntry = [{ from:id, label:c.label }, ...fallExits];
          fallExits = processStatements(c.body, caseEntry);
        }
        contextStack.pop();
        // Anything that fell through past the very last case, plus every
        // explicit `break;` hit anywhere inside the switch, both exit here.
        return ctx.breakExits.concat(fallExits);
      }
      case 'trycatch': {
        // Simplified approximation: try-block runs, then a decision asks
        // whether an exception occurred. This can't know at flowchart-time
        // which line actually throws, but it keeps both paths visible,
        // which is the usual convention for showing try/catch on a flowchart.
        const tryExits = processStatements(stmt.tryBody, entryExits);
        if(!stmt.hasCatch){
          if(stmt.finallyBody && stmt.finallyBody.length){
            return processStatements(stmt.finallyBody, tryExits);
          }
          return tryExits;
        }
        const decId = newNode('decision', 'เกิดข้อผิดพลาด (exception)?');
        connect(tryExits, decId);
        const catchExits = processStatements(stmt.catchBody, [{ from:decId, label:'ใช่' }]);
        let exits = [{ from:decId, label:'ไม่' }].concat(catchExits);
        if(stmt.finallyBody && stmt.finallyBody.length){
          return processStatements(stmt.finallyBody, exits);
        }
        return exits;
      }
      case 'return': {
        const id = newNode('end', endLabel(stmt.text));
        connect(entryExits, id);
        return [];
      }
      case 'throw': {
        // Treated as terminal within its own block, same as return/break —
        // the surrounding try/catch's "เกิดข้อผิดพลาด?" decision already
        // represents the possibility of an exception, so the code path
        // that explicitly throws simply stops here rather than
        // (incorrectly) falling through to the next statement.
        const id = newNode('process', stmt.text ? ('โยนข้อยกเว้น: ' + stmt.text) : 'โยนข้อยกเว้น');
        connect(entryExits, id);
        return [];
      }
      case 'break': {
        const id = newNode('process', 'break');
        connect(entryExits, id);
        const ctx = contextStack.length ? contextStack[contextStack.length - 1] : null;
        if(ctx) ctx.breakExits.push({ from:id });
        return []; // code after break in this block is unreachable
      }
      case 'continue': {
        const id = newNode('process', 'continue');
        connect(entryExits, id);
        const ctx = findContext(c => c.type === 'loop'); // continue always targets the nearest LOOP, even through a switch
        if(ctx) connect([{ from:id }], ctx.continueTarget);
        return []; // code after continue in this block is unreachable
      }
      default:
        return entryExits;
    }
  }

  // Strips comments/preprocessor lines the same way for both modes, so the
  // two code paths below only differ in which function body(ies) they pull
  // out of the cleaned source.
  function preprocessSource(src){
    // Block comments are blanked out char-by-char rather than with a flat
    // ' '.repeat(m.length): the naive version collapses every newline the
    // comment contained into spaces, which shortens the line count of
    // everything after a multi-line comment and makes line numbers in
    // error messages point at the wrong place. Keeping the '\n' characters
    // (and only blanking everything else) preserves both the total length
    // (so downstream character offsets don't shift) and the real line
    // numbering.
    let s = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    s = s.replace(/\/\/.*$/gm, m => ' '.repeat(m.length));
    s = s.replace(/^\s*#.*$/gm, '');
    s = s.replace(/^\s*using\s+namespace\s+\w+\s*;\s*$/gm, '');
    s = s.replace(/^\s*(import|package)\s+[^\n]*$/gm, '');
    sourceForLines = s;
    return s;
  }

  // Converts ONE already-extracted function body (parsed statements) into
  // its own start...end node/edge chain, appending onto the shared
  // nodeDefs/edgeDefs arrays. Returns null if the body had nothing
  // convertible (e.g. an empty function), so callers can skip it.
  function convertOneFunctionBody(bodyOrig, bodyMasked, bodyOffset, startLabel){
    let stmts = parseStatements(bodyOrig, bodyMasked, bodyOffset);
    stmts = postProcessStmts(stmts, { hideSystem: true, groupOutputs: true });
    if(!stmts.length) return null;

    const startId = newNode('start', startLabel);
    let exits = processStatements(stmts, [{ from:startId }]);
    // Every path through the diagram must land on an explicit terminal
    // node: `return` statements already got their own ("case 'return'"
    // above), so this only fires for whatever's left over after control
    // simply falls off the end of the function body without a return —
    // guaranteeing the flowchart never ends on a dangling arrow.
    if(exits.length){
      const endId = newNode('end', endLabel(null));
      connect(exits, endId);
    }
    return true;
  }

  function convertCodeToMermaid(src, options){
    options = options || {};
    const mode = options.mode === 'all' ? 'all' : 'main';

    nodeCounter = 0; connectorCounter = 0; nodeDefs = []; edgeDefs = []; contextStack = [];
    const s = preprocessSource(src);
    const masked = maskLiterals(s);

    if(mode === 'all'){
      const funcs = findAllFunctions(s, masked);
      if(!funcs.length){
        throw new Error('ไม่พบฟังก์ชันที่แปลงเป็นผังงานได้ ลองตรวจสอบว่าโค้ดมีฟังก์ชันอย่างน้อยหนึ่งฟังก์ชัน');
      }

      const lines = ['flowchart TD'];
      let convertedCount = 0;
      let skippedEmpty = [];

      funcs.forEach((fn, idx) => {
        // Each function gets its own slice of nodeDefs/edgeDefs so it can
        // be wrapped in its own `subgraph ... end` block — node IDs still
        // stay globally unique because nodeCounter/connectorCounter are
        // NOT reset between functions (only once, above, for the whole run).
        nodeDefs = []; edgeDefs = [];
        const ok = convertOneFunctionBody(fn.orig, fn.masked, fn.offset, 'เริ่มต้น: ' + fn.name);
        if(!ok){ skippedEmpty.push(fn.name); return; }
        convertedCount++;
        const subgraphId = 'fn' + idx;
        lines.push(`    subgraph ${subgraphId}["ฟังก์ชัน: ${sanitizeLabel(fn.name)}"]`);
        nodeDefs.forEach(d => lines.push('        ' + d));
        edgeDefs.forEach(e => lines.push('        ' + e));
        lines.push('    end');
      });

      if(convertedCount === 0){
        throw new Error('พบฟังก์ชันในซอร์สโค้ด แต่ทุกฟังก์ชันว่างเปล่าหรือไม่มีคำสั่งที่แปลงเป็นผังงานได้');
      }

      let warning = null;
      if(skippedEmpty.length){
        warning = `ฟังก์ชันต่อไปนี้ไม่มีคำสั่งที่แปลงได้ จึงถูกข้ามไป: ${skippedEmpty.join(', ')}`;
      }

      return { mermaid: lines.join('\n'), warning };
    }

    // mode === 'main' (default): convert only main() / the first function found.
    const body = extractMainBody(s, masked);
    let stmts = parseStatements(body.orig, body.masked, body.offset);
    stmts = postProcessStmts(stmts, { hideSystem: true, groupOutputs: true });

    if(!stmts.length){
      const hint = body.offset != null
        ? ` (เริ่มตรวจสอบจากบรรทัดที่ ${lineAt(body.offset)})`
        : '';
      throw new Error('ไม่พบคำสั่งที่แปลงเป็นผังงานได้ ลองตรวจสอบว่าโค้ดมีฟังก์ชัน main() หรือมีคำสั่งอยู่จริง' + hint);
    }

    const startId = newNode('start', 'เริ่มต้น');
    let exits = processStatements(stmts, [{ from:startId }]);
    // Every path through the diagram must land on an explicit terminal
    // node: `return` statements already got their own ("case 'return'"
    // above), so this only fires for whatever's left over after control
    // simply falls off the end of the function body without a return —
    // guaranteeing the flowchart never ends on a dangling arrow.
    if(exits.length){
      const endId = newNode('end', endLabel(null));
      connect(exits, endId);
    }

    const lines = ['flowchart TD'];
    nodeDefs.forEach(d => lines.push('    ' + d));
    edgeDefs.forEach(e => lines.push('    ' + e));

    // Warn (rather than silently ignore) when the source has more than one
    // function-looking block: this mode only ever converts a single
    // function (main(), or the first one found), so anything else in the
    // file was dropped. The UI layer decides how to surface this — and can
    // point the user at options.mode:'all' to see every function instead.
    let warning = null;
    if(body.otherFunctions > 0){
      warning = `พบฟังก์ชันอื่นอีก ${body.otherFunctions} ฟังก์ชันในซอร์สโค้ด ระบบแปลงเป็นผังงานเฉพาะฟังก์ชัน "${body.functionName}" เท่านั้น (เลือกโหมด "ทั้งหมด" เพื่อแปลงทุกฟังก์ชัน)`;
    }

    return { mermaid: lines.join('\n'), warning };
  }


  return { convertCodeToMermaid };
}

// Convenience wrapper preserving the original module API: callers that
// just want a one-shot conversion don't need to know about createParser()
// at all. Each call spins up a brand-new isolated instance under the hood.
// options.mode: 'main' (default) converts only main()/first function found;
// 'all' converts every top-level function, each in its own subgraph.
// Returns { mermaid, warning } — see convertCodeToMermaid above.
function convertCodeToMermaid(src, options){
  return createParser().convertCodeToMermaid(src, options);
}

export { createParser, convertCodeToMermaid };
