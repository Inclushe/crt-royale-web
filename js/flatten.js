// Two mechanical, shader-agnostic transforms applied to every libretro .glsl
// file so that strict GLSL ES (ANGLE/WebGL2) accepts what lenient desktop GL
// drivers do:
//
// 1. flattenConditionals(): evaluates the preprocessor *conditionals*
//    (#if/#ifdef/#elif/#else/#endif) for the selected stage and target,
//    keeping all #define macro lines and code untouched. This leaves a single
//    linear shader text for the chosen stage.
//
// 2. hoistGlobalInitializers(): GLSL ES requires global initializers to be
//    constant expressions, but Cg-converted shaders blank out `const` with a
//    macro and initialize globals from other globals. The initializers are
//    moved, in source order, into a generated function called at the top of
//    main() — semantically identical, ES-legal.

// ---------------------------------------------------------------------------
// Minimal C-preprocessor expression evaluator (integers, defined(), the usual
// operators). Unknown identifiers evaluate to 0, like a C preprocessor.
// ---------------------------------------------------------------------------

function tokenizeExpr(s) {
  const tokens = [];
  const re = /\s*(0[xX][0-9a-fA-F]+|\d+|[A-Za-z_]\w*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%!~^&|()<>?:,])/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) {
      if (/^\s*$/.test(s.slice(i))) break;
      throw new Error(`bad token in #if expression: "${s.slice(i, i + 12)}"`);
    }
    tokens.push(m[1]);
    i = re.lastIndex;
  }
  return tokens;
}

function evalTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t) => { if (next() !== t) throw new Error(`expected ${t}`); };

  function primary() {
    const t = next();
    if (t === '(') { const v = ternary(); expect(')'); return v; }
    if (t === '!') return primary() ? 0 : 1;
    if (t === '~') return ~primary();
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (/^0[xX]/.test(t)) return parseInt(t, 16);
    if (/^\d/.test(t)) return parseInt(t, 10);
    if (/^[A-Za-z_]/.test(t)) return 0; // unexpanded identifier
    throw new Error(`unexpected token ${t}`);
  }
  const binary = (ops, sub) => () => {
    let v = sub();
    while (ops.includes(peek())) {
      const op = next(); const r = sub();
      switch (op) {
        case '*': v = v * r; break; case '/': v = r ? (v / r) | 0 : 0; break;
        case '%': v = r ? v % r : 0; break;
        case '+': v = v + r; break; case '-': v = v - r; break;
        case '<<': v = v << r; break; case '>>': v = v >> r; break;
        case '<': v = v < r ? 1 : 0; break; case '>': v = v > r ? 1 : 0; break;
        case '<=': v = v <= r ? 1 : 0; break; case '>=': v = v >= r ? 1 : 0; break;
        case '==': v = v === r ? 1 : 0; break; case '!=': v = v !== r ? 1 : 0; break;
        case '&': v = v & r; break; case '^': v = v ^ r; break; case '|': v = v | r; break;
        case '&&': v = (v && r) ? 1 : 0; break; case '||': v = (v || r) ? 1 : 0; break;
      }
    }
    return v;
  };
  const mul = binary(['*', '/', '%'], primary);
  const add = binary(['+', '-'], mul);
  const shift = binary(['<<', '>>'], add);
  const rel = binary(['<', '>', '<=', '>='], shift);
  const eq = binary(['==', '!='], rel);
  const band = binary(['&'], eq);
  const bxor = binary(['^'], band);
  const bor = binary(['|'], bxor);
  const land = binary(['&&'], bor);
  const lor = binary(['||'], land);
  function ternary() {
    const c = lor();
    if (peek() === '?') {
      next(); const a = ternary(); expect(':'); const b = ternary();
      return c ? a : b;
    }
    return c;
  }
  const v = ternary();
  return v;
}

function evalCondition(expr, macros) {
  // defined(X) / defined X
  expr = expr.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g,
    (_, a, b) => (macros.has(a ?? b) ? '1' : '0'));
  // expand object-like macros (bounded rounds to handle chains)
  for (let round = 0; round < 8; round++) {
    let changed = false;
    expr = expr.replace(/[A-Za-z_]\w*/g, (id) => {
      if (macros.has(id)) {
        const def = macros.get(id);
        if (def.args === null && def.body.trim() !== id) {
          changed = true;
          return `(${def.body})`;
        }
      }
      return id;
    });
    if (!changed) break;
  }
  return evalTokens(tokenizeExpr(expr)) !== 0;
}

// ---------------------------------------------------------------------------

export function flattenConditionals(source, predefined) {
  const macros = new Map(); // name -> {args: null|string[], body}
  for (const [k, v] of Object.entries(predefined)) {
    macros.set(k, { args: null, body: String(v) });
  }

  // join line continuations
  const rawLines = source.split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    let l = rawLines[i];
    while (l.endsWith('\\') && i + 1 < rawLines.length) {
      l = l.slice(0, -1) + ' ' + rawLines[++i];
    }
    lines.push(l);
  }

  const out = [];
  // stack frames: { active: branch currently taken, taken: some branch taken, parentActive }
  const stack = [];
  const isLive = () => stack.every(f => f.active);

  for (const line of lines) {
    const d = line.match(/^\s*#\s*(\w+)\s*(.*?)\s*$/);
    const directive = d ? d[1] : null;
    const rest = d ? d[2] : '';

    switch (directive) {
      case 'if': case 'ifdef': case 'ifndef': {
        const parentActive = isLive();
        let cond = false;
        if (parentActive) {
          try {
            if (directive === 'if') cond = evalCondition(rest, macros);
            else if (directive === 'ifdef') cond = macros.has(rest.split(/\s/)[0]);
            else cond = !macros.has(rest.split(/\s/)[0]);
          } catch (e) {
            throw new Error(`cannot evaluate "#${directive} ${rest}": ${e.message}`);
          }
        }
        stack.push({ active: parentActive && cond, taken: cond, parentActive });
        continue;
      }
      case 'elif': {
        const f = stack[stack.length - 1];
        if (!f) throw new Error('#elif without #if');
        if (f.taken || !f.parentActive) { f.active = false; }
        else {
          const cond = evalCondition(rest, macros);
          f.active = cond; f.taken = cond;
        }
        continue;
      }
      case 'else': {
        const f = stack[stack.length - 1];
        if (!f) throw new Error('#else without #if');
        f.active = f.parentActive && !f.taken;
        f.taken = true;
        continue;
      }
      case 'endif':
        if (!stack.pop()) throw new Error('#endif without #if');
        continue;
      default:
        break;
    }

    if (!isLive()) continue;

    if (directive === 'define') {
      const m = rest.match(/^(\w+)(\(([^)]*)\))?\s*(.*)$/);
      if (m) {
        macros.set(m[1], {
          args: m[2] ? m[3].split(',').map(s => s.trim()).filter(Boolean) : null,
          body: m[4] ?? '',
        });
      }
      out.push(line); // keep macro definitions for the GLSL compiler
      continue;
    }
    if (directive === 'undef') {
      macros.delete(rest.split(/\s/)[0]);
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------

// Semantics-preserving ES-compatibility shims, applied uniformly to all
// shaders. GLSL ES has no implicit int->float conversion; desktop GLSL does,
// and Cg-converted shaders rely on it in a few well-defined spots.
// Wrapping an argument whose parameter type is float in float(...) is a no-op
// where the code was already valid and legalizes the integer case.
function wrapArgInFloat(text, fnName, argIndex) {
  let result = '';
  let from = 0;
  for (;;) {
    const idx = text.indexOf(fnName + '(', from);
    if (idx === -1) break;
    // make sure it's a whole identifier
    if (idx > 0 && /[\w.]/.test(text[idx - 1])) { from = idx + fnName.length; continue; }
    // parse balanced arguments
    let depth = 0;
    let args = [];
    let argStart = idx + fnName.length + 1;
    let i = argStart;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) { args.push(text.slice(argStart, i)); break; }
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push(text.slice(argStart, i));
        argStart = i + 1;
      }
    }
    if (i >= text.length) break;
    if (args.length > argIndex) {
      const a = args[argIndex].trim();
      if (!/^float\s*\(/.test(a)) args[argIndex] = ` float(${a})`;
      result += text.slice(from, idx) + fnName + '(' + args.join(',') + ')';
      from = i + 1;
    } else {
      result += text.slice(from, i + 1);
      from = i + 1;
    }
  }
  return result + text.slice(from);
}

// Declaration-driven int->float coercion. GLSL ES lacks the implicit scalar
// conversions desktop GLSL performs; we re-insert them as explicit float()
// casts, but only where the file's own declarations prove the types:
//   - <int ident> (*,/,+,-) <vector ident>  and the mirrored form
//   - a bare int identifier passed where a function's only signature
//     declares a scalar float parameter
function coerceIntFloatUsage(text) {
  const intIdents = new Set();
  for (const m of text.matchAll(/\bfor\s*\(\s*int\s+(\w+)/g)) intIdents.add(m[1]);
  for (const m of text.matchAll(/\b(?:static\s+)?const\s+int\s+(\w+)\s*=/g)) intIdents.add(m[1]);
  for (const m of text.matchAll(/\buniform\s+(?:\w+\s+)?int\s+(\w+)/g)) intIdents.add(m[1]);
  if (!intIdents.size) return text;

  // simple object-macro aliases of int identifiers (#define frame_count FrameCount)
  for (let round = 0; round < 2; round++) {
    for (const m of text.matchAll(/^[ \t]*#define\s+(\w+)\s+(\w+)\s*$/gm)) {
      if (intIdents.has(m[2])) intIdents.add(m[1]);
    }
  }

  // float/vec identifiers: "all" includes function parameters (terminator , or
  // )), "decls" only statement declarations. Conflicts make an identifier
  // ambiguous for the corresponding rule.
  const collect = (re) => {
    const s = new Set();
    for (const m of text.matchAll(re)) s.add(m[1]);
    return s;
  };
  const vecAll = collect(/\b(?:float[234]|vec[234])\s+(\w+)\s*[=;,)]/g);
  const floatAll = collect(/\bfloat\s+(\w+)\s*[=;,)]/g);
  const vecDecls = collect(/\b(?:float[234]|vec[234])\s+(\w+)\s*[=;]/g);
  const floatDecls = collect(/\bfloat\s+(\w+)\s*[=;]/g);

  // binary-operator rule: a conflicting *statement* declaration as float
  // disqualifies (float-typed parameter shadowing is harmless: float(x) is a
  // no-op on floats); any vector declaration disqualifies (float(vec) is an
  // error).
  const opInts = new Set([...intIdents].filter(id => !floatDecls.has(id) && !vecAll.has(id)));
  const opVec = new Set([...vecAll].filter(id => !intIdents.has(id)));
  const opFloat = new Set([...floatAll].filter(id => !intIdents.has(id)));
  if (opInts.size) {
    const K = [...opInts].join('|');
    for (const others of [opVec, opFloat]) {
      if (!others.size) continue;
      const V = [...others].join('|');
      text = text.replace(new RegExp(`\\b(${K})\\b(\\s*[*+/-]\\s*)\\b(${V})\\b`, 'g'),
        (s, k, op, v) => `float(${k})${op}${v}`);
      text = text.replace(new RegExp(`\\b(${V})\\b(\\s*[*+/-]\\s*)\\b(${K})\\b`, 'g'),
        (s, v, op, k) => `${v}${op}float(${k})`);
    }
  }

  // call-argument rule: parameter names live in their own scope, so only
  // conflicting statement declarations matter
  const intIdentsForCalls = new Set(
    [...intIdents].filter(id => !floatDecls.has(id) && !vecDecls.has(id)));
  if (!intIdentsForCalls.size) return text;
  intIdents.clear();
  for (const id of intIdentsForCalls) intIdents.add(id);

  // function signatures: name -> list of param type lists (scalar types only)
  const sigs = new Map();
  for (const m of text.matchAll(/\b(?:inline\s+)?(?:float[234]?|vec[234]|bool|int|void)\s+(\w+)\s*\(([^()]*)\)\s*\{/g)) {
    const name = m[1];
    const params = m[2].trim() === '' ? [] :
      m[2].split(',').map(p => {
        const t = p.trim().replace(/\b(const|in|out|inout|highp|mediump|lowp|COMPAT_PRECISION)\b/g, '').trim();
        return t.split(/\s+/)[0];
      });
    if (!sigs.has(name)) sigs.set(name, []);
    sigs.get(name).push(params);
  }
  for (const [name, overloads] of sigs) {
    if (overloads.length !== 1) continue; // only safe with a single signature
    const params = overloads[0];
    let from = 0;
    for (;;) {
      const idx = text.indexOf(name + '(', from);
      if (idx === -1) break;
      if (idx > 0 && /[\w.]/.test(text[idx - 1])) { from = idx + name.length; continue; }
      // skip the definition itself
      // parse balanced args
      let depth = 0, args = [], argStart = idx + name.length + 1, i = argStart;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') { if (depth === 0) { args.push(text.slice(argStart, i)); break; } depth--; }
        else if (c === ',' && depth === 0) { args.push(text.slice(argStart, i)); argStart = i + 1; }
      }
      if (i >= text.length) break;
      const isDefinition = /^\s*\{/.test(text.slice(i + 1, i + 8)) && args.some(a => /\b(float|int|vec|bool)/.test(a));
      if (!isDefinition && args.length === params.length) {
        let changed = false;
        for (let a = 0; a < args.length; a++) {
          const bare = args[a].trim();
          if (params[a] === 'float' && intIdents.has(bare)) {
            args[a] = ` float(${bare})`;
            changed = true;
          }
        }
        if (changed) {
          text = text.slice(0, idx) + name + '(' + args.join(',') + ')' + text.slice(i + 1);
        }
      }
      from = idx + name.length;
    }
  }
  return text;
}

export function applyEsCompatShims(text) {
  text = wrapArgInFloat(text, 'textureLod', 2); // lod parameter is float
  text = coerceIntFloatUsage(text);
  return text;
}

// ---------------------------------------------------------------------------

const GLOBAL_DECL_RE =
  /^(\s*)((?:static\s+|const\s+|highp\s+|mediump\s+|lowp\s+|COMPAT_PRECISION\s+)*)(\w+)(\s+)(\w+)(\s*\[[^\]]*\])?\s*=/;
const SKIP_QUALIFIERS = /\b(uniform|attribute|varying|in|out|struct|precision|return)\b/;

export function hoistGlobalInitializers(source) {
  const lines = source.split('\n');
  let depth = 0;
  const assignments = [];
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const stripped = line.replace(/\/\/.*$/, '');

    if (depth === 0 && !/^\s*#/.test(line)) {
      const m = GLOBAL_DECL_RE.exec(stripped);
      if (m && !SKIP_QUALIFIERS.test(m[2] + ' ' + m[3])) {
        // collect the full declaration (may span lines) up to its ';'
        let decl = stripped;
        let j = i;
        while (!/;/.test(decl) && j + 1 < lines.length) {
          j++;
          decl += '\n' + lines[j].replace(/\/\/.*$/, '');
        }
        const semi = decl.indexOf(';');
        const declText = decl.slice(0, semi);
        const eq = declText.indexOf('=');
        const init = declText.slice(eq + 1).trim();
        const name = m[5];
        // keep the declaration, drop the initializer
        out.push(`${m[1]}${m[2]}${m[3]}${m[4]}${name}${m[6] ?? ''};`);
        assignments.push(`    ${name} = ${init};`);
        i = j;
        continue;
      }
    }

    for (const ch of stripped) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    out.push(line);
  }

  if (!assignments.length) return source;

  let text = out.join('\n');
  const mainMatch = text.match(/void\s+main\s*\(\s*(void)?\s*\)/);
  if (!mainMatch) return source;
  const initFn = `void __crt_init_globals()\n{\n${assignments.join('\n')}\n}\n\n`;
  let idx = mainMatch.index;
  text = text.slice(0, idx) + initFn + text.slice(idx);
  // insert the call after main's opening brace
  const braceIdx = text.indexOf('{', idx + initFn.length);
  text = text.slice(0, braceIdx + 1) + '\n    __crt_init_globals();' + text.slice(braceIdx + 1);
  return text;
}
