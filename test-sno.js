/**
 * Sno.js — eval-free reactive micro-framework
 * Drop-in replacement for the original Sno framework.
 *
 * Supported directives:
 *   data="{ key: value, ... }"   — reactive state (on any element, once)
 *   react                        — re-renders {{expr}} mustaches on data change
 *   if="expr"                    — show/hide based on condition
 *   for="arrayKey"               — loop; uses [item] attribute as template
 *   bind="key"                   — two-way input binding
 *   eval="expr"                  — runs expression once on load
 *   incl="path/to/file.html"     — fetches and injects external HTML
 *   computer / mobile            — responsive visibility (≥600px / ≤600px)
 *
 * Global helpers:
 *   $('expr')                    — reactive expression runner (for onclick etc.)
 *   random(n)                    — Math.floor(Math.random() * n)
 *   toggle(v)                    — !v
 */

(function () {
  "use strict";

  // ─── Utilities ────────────────────────────────────────────────────────────

  window.random = (n) => Math.floor(Math.random() * n);
  window.toggle = (v) => !v;

  const allElements = () => Array.from(document.getElementsByTagName("*"));

  // ─── Expression evaluator (NO eval) ───────────────────────────────────────
  //
  // Supports: arithmetic, comparisons, logical ops, ternary,
  //           property access, array/string methods, typeof,
  //           assignment to top-level data keys (=, +=, -=, *=, /=),
  //           push/pop/shift/unshift on arrays,
  //           and calls to random() / toggle().
  //
  // All identifiers that match a data key are transparently rewritten to
  // data["key"] before the expression tree is walked — this is done via
  // a safe recursive descent parser, never via eval or Function().

  function buildContext(data) {
    // Returns a flat object merging data keys + allowed globals.
    const ctx = Object.create(null);
    for (const k of Object.keys(data)) ctx[k] = data[k];
    ctx.random = window.random;
    ctx.toggle = window.toggle;
    ctx.Math = Math;
    ctx.String = String;
    ctx.Number = Number;
    ctx.Boolean = Boolean;
    ctx.Array = Array;
    ctx.Object = Object;
    ctx.parseInt = parseInt;
    ctx.parseFloat = parseFloat;
    ctx.isNaN = isNaN;
    ctx.undefined = undefined;
    ctx.null = null;
    ctx.true = true;
    ctx.false = false;
    return ctx;
  }

  // ── Tokenizer ──────────────────────────────────────────────────────────────

  const TT = {
    NUM: "NUM", STR: "STR", IDENT: "IDENT",
    PLUS: "+", MINUS: "-", STAR: "*", SLASH: "/", PERCENT: "%",
    EQ2: "==", EQ3: "===", NEQ: "!=", NEQ3: "!==",
    LTE: "<=", GTE: ">=", LT: "<", GT: ">",
    AND: "&&", OR: "||", NOT: "!",
    DOT: ".", LBRACKET: "[", RBRACKET: "]",
    LPAREN: "(", RPAREN: ")", COMMA: ",", QUESTION: "?", COLON: ":",
    ASSIGN: "=", PLUS_ASSIGN: "+=", MINUS_ASSIGN: "-=",
    STAR_ASSIGN: "*=", SLASH_ASSIGN: "/=",
    EOF: "EOF",
  };

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      // skip whitespace
      if (/\s/.test(src[i])) { i++; continue; }

      // number
      if (/[0-9]/.test(src[i])) {
        let num = "";
        while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
        tokens.push({ type: TT.NUM, value: parseFloat(num) });
        continue;
      }

      // string (single or double quote)
      if (src[i] === '"' || src[i] === "'") {
        const q = src[i++];
        let str = "";
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\" && i + 1 < src.length) { i++; str += src[i++]; }
          else str += src[i++];
        }
        i++; // closing quote
        tokens.push({ type: TT.STR, value: str });
        continue;
      }

      // backtick template literal (simple, no nested expressions)
      if (src[i] === "`") {
        i++;
        let str = "";
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\" && i + 1 < src.length) { i++; str += src[i++]; }
          else str += src[i++];
        }
        i++;
        tokens.push({ type: TT.STR, value: str });
        continue;
      }

      // identifier / keyword
      if (/[a-zA-Z_$]/.test(src[i])) {
        let id = "";
        while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) id += src[i++];
        tokens.push({ type: TT.IDENT, value: id });
        continue;
      }

      // two/three-char operators
      const two = src.slice(i, i + 2);
      const three = src.slice(i, i + 3);
      if (three === "===") { tokens.push({ type: TT.EQ3 }); i += 3; continue; }
      if (three === "!==") { tokens.push({ type: TT.NEQ3 }); i += 3; continue; }
      if (two === "==")  { tokens.push({ type: TT.EQ2 }); i += 2; continue; }
      if (two === "!=")  { tokens.push({ type: TT.NEQ }); i += 2; continue; }
      if (two === "<=")  { tokens.push({ type: TT.LTE }); i += 2; continue; }
      if (two === ">=")  { tokens.push({ type: TT.GTE }); i += 2; continue; }
      if (two === "&&")  { tokens.push({ type: TT.AND }); i += 2; continue; }
      if (two === "||")  { tokens.push({ type: TT.OR  }); i += 2; continue; }
      if (two === "+=")  { tokens.push({ type: TT.PLUS_ASSIGN  }); i += 2; continue; }
      if (two === "-=")  { tokens.push({ type: TT.MINUS_ASSIGN }); i += 2; continue; }
      if (two === "*=")  { tokens.push({ type: TT.STAR_ASSIGN  }); i += 2; continue; }
      if (two === "/=")  { tokens.push({ type: TT.SLASH_ASSIGN }); i += 2; continue; }

      // single-char operators
      const ch = src[i];
      const singleMap = {
        "+": TT.PLUS, "-": TT.MINUS, "*": TT.STAR, "/": TT.SLASH,
        "%": TT.PERCENT, "<": TT.LT, ">": TT.GT, "!": TT.NOT,
        ".": TT.DOT, "[": TT.LBRACKET, "]": TT.RBRACKET,
        "(": TT.LPAREN, ")": TT.RPAREN, ",": TT.COMMA,
        "?": TT.QUESTION, ":": TT.COLON, "=": TT.ASSIGN,
      };
      if (singleMap[ch]) { tokens.push({ type: singleMap[ch] }); i++; continue; }

      // unknown — skip
      i++;
    }
    tokens.push({ type: TT.EOF });
    return tokens;
  }

  // ── Parser / interpreter ───────────────────────────────────────────────────

  function parseExpr(src, ctx) {
    const tokens = tokenize(src.trim());
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = (type) => {
      const t = tokens[pos];
      if (type && t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
      pos++;
      return t;
    };
    const check = (...types) => types.includes(peek().type);

    // assignment: ident (= | += | -= | *= | /=) expr
    function assignment() {
      // look-ahead: IDENT followed by assignment operator
      if (
        peek().type === TT.IDENT &&
        pos + 1 < tokens.length &&
        [TT.ASSIGN, TT.PLUS_ASSIGN, TT.MINUS_ASSIGN,
         TT.STAR_ASSIGN, TT.SLASH_ASSIGN].includes(tokens[pos + 1].type)
      ) {
        const name = consume(TT.IDENT).value;
        const op = consume().type;
        const rhs = ternary();
        if (!(name in ctx)) {
          // allow creating new keys
          ctx[name] = undefined;
        }
        if (op === TT.ASSIGN)        ctx[name] = rhs;
        else if (op === TT.PLUS_ASSIGN)  ctx[name] += rhs;
        else if (op === TT.MINUS_ASSIGN) ctx[name] -= rhs;
        else if (op === TT.STAR_ASSIGN)  ctx[name] *= rhs;
        else if (op === TT.SLASH_ASSIGN) ctx[name] /= rhs;
        return ctx[name];
      }
      return ternary();
    }

    function ternary() {
      let cond = or();
      if (check(TT.QUESTION)) {
        consume(TT.QUESTION);
        const yes = ternary();
        consume(TT.COLON);
        const no = ternary();
        return cond ? yes : no;
      }
      return cond;
    }

    function or() {
      let left = and();
      while (check(TT.OR)) { consume(TT.OR); left = left || and(); }
      return left;
    }

    function and() {
      let left = equality();
      while (check(TT.AND)) { consume(TT.AND); left = left && equality(); }
      return left;
    }

    function equality() {
      let left = comparison();
      while (check(TT.EQ2, TT.EQ3, TT.NEQ, TT.NEQ3)) {
        const op = consume().type;
        const right = comparison();
        // eslint-disable-next-line eqeqeq
        if (op === TT.EQ2)  left = left == right;
        if (op === TT.EQ3)  left = left === right;
        if (op === TT.NEQ)  left = left != right;  // eslint-disable-line
        if (op === TT.NEQ3) left = left !== right;
      }
      return left;
    }

    function comparison() {
      let left = addSub();
      while (check(TT.LT, TT.GT, TT.LTE, TT.GTE)) {
        const op = consume().type;
        const right = addSub();
        if (op === TT.LT)  left = left < right;
        if (op === TT.GT)  left = left > right;
        if (op === TT.LTE) left = left <= right;
        if (op === TT.GTE) left = left >= right;
      }
      return left;
    }

    function addSub() {
      let left = mulDiv();
      while (check(TT.PLUS, TT.MINUS)) {
        const op = consume().type;
        const right = mulDiv();
        left = op === TT.PLUS ? left + right : left - right;
      }
      return left;
    }

    function mulDiv() {
      let left = unary();
      while (check(TT.STAR, TT.SLASH, TT.PERCENT)) {
        const op = consume().type;
        const right = unary();
        if (op === TT.STAR)    left = left * right;
        if (op === TT.SLASH)   left = left / right;
        if (op === TT.PERCENT) left = left % right;
      }
      return left;
    }

    function unary() {
      if (check(TT.NOT))   { consume(TT.NOT);   return !unary(); }
      if (check(TT.MINUS)) { consume(TT.MINUS); return -unary(); }
      return callMember();
    }

    function callMember() {
      let obj = primary();

      while (true) {
        if (check(TT.DOT)) {
          consume(TT.DOT);
          const prop = consume(TT.IDENT).value;

          // method call?
          if (check(TT.LPAREN)) {
            consume(TT.LPAREN);
            const args = [];
            while (!check(TT.RPAREN, TT.EOF)) {
              args.push(ternary());
              if (check(TT.COMMA)) consume(TT.COMMA);
            }
            consume(TT.RPAREN);
            if (obj == null) throw new Error(`Cannot call .${prop} on null`);
            obj = obj[prop](...args);
          } else {
            obj = obj == null ? undefined : obj[prop];
          }
        } else if (check(TT.LBRACKET)) {
          consume(TT.LBRACKET);
          const idx = ternary();
          consume(TT.RBRACKET);
          obj = obj == null ? undefined : obj[idx];
        } else {
          break;
        }
      }
      return obj;
    }

    function primary() {
      const t = peek();

      if (t.type === TT.NUM) { consume(); return t.value; }
      if (t.type === TT.STR) { consume(); return t.value; }

      if (t.type === TT.IDENT) {
        consume();
        const name = t.value;

        // boolean/null literals
        if (name === "true")  return true;
        if (name === "false") return false;
        if (name === "null")  return null;
        if (name === "undefined") return undefined;

        // function call at root level (random, toggle, etc.)
        if (check(TT.LPAREN)) {
          consume(TT.LPAREN);
          const args = [];
          while (!check(TT.RPAREN, TT.EOF)) {
            args.push(ternary());
            if (check(TT.COMMA)) consume(TT.COMMA);
          }
          consume(TT.RPAREN);
          const fn = ctx[name];
          if (typeof fn !== "function") throw new Error(`${name} is not a function`);
          return fn(...args);
        }

        // array access on data key: name[idx]
        if (check(TT.LBRACKET)) {
          consume(TT.LBRACKET);
          const idx = ternary();
          consume(TT.RBRACKET);
          const arr = ctx[name];
          return arr == null ? undefined : arr[idx];
        }

        return name in ctx ? ctx[name] : undefined;
      }

      if (t.type === TT.LPAREN) {
        consume(TT.LPAREN);
        const val = ternary();
        consume(TT.RPAREN);
        return val;
      }

      return undefined;
    }

    const result = assignment();
    return { result, ctx };
  }

  // Safe wrapper: returns undefined on parse/runtime errors
  function safeEval(expr, ctx) {
    try {
      return parseExpr(expr, ctx).result;
    } catch (e) {
      console.warn("[Sno] expression error:", expr, e.message);
      return undefined;
    }
  }

  // Mutates ctx then syncs changed keys back into data
  function safeExec(expr, data) {
    const ctx = buildContext(data);
    try {
      parseExpr(expr, ctx);
    } catch (e) {
      console.warn("[Sno] exec error:", expr, e.message);
      return;
    }
    // sync any changed data keys back
    for (const k of Object.keys(data)) {
      if (k in ctx) data[k] = ctx[k];
    }
  }

  // ─── Parse initial data from [data] attribute ──────────────────────────────

  function parseData() {
    const el = document.querySelector("[data]");
    if (!el) { console.warn("[Sno] No [data] element found."); return {}; }
    const src = el.getAttribute("data");
    // Parse a simple object literal: { key: value, ... }
    // We use the tokenizer to read key/value pairs safely.
    try {
      return parseObjectLiteral(src.trim());
    } catch (e) {
      console.warn("[Sno] Could not parse data attribute:", e.message);
      return {};
    }
  }

  function parseObjectLiteral(src) {
    // Strips outer braces then splits on commas at depth 0
    const inner = src.replace(/^\{/, "").replace(/\}$/, "").trim();
    const obj = {};
    // Split on commas that are not inside [] or {}
    const pairs = splitAtDepth(inner, ",");
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx === -1) continue;
      const key = pair.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, "");
      const valSrc = pair.slice(colonIdx + 1).trim();
      obj[key] = parseValue(valSrc);
    }
    return obj;
  }

  function parseValue(src) {
    src = src.trim();
    if (src === "true")  return true;
    if (src === "false") return false;
    if (src === "null")  return null;
    if (src === "undefined") return undefined;
    if ((src.startsWith("'") && src.endsWith("'")) ||
        (src.startsWith('"') && src.endsWith('"')) ||
        (src.startsWith("`") && src.endsWith("`"))) {
      return src.slice(1, -1);
    }
    if (src.startsWith("[")) {
      // array
      const inner = src.slice(1, -1).trim();
      if (!inner) return [];
      return splitAtDepth(inner, ",").map(parseValue);
    }
    if (src.startsWith("{")) {
      return parseObjectLiteral(src);
    }
    const n = Number(src);
    if (!isNaN(n) && src !== "") return n;
    return src;
  }

  function splitAtDepth(str, delimiter) {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of str) {
      if (ch === "[" || ch === "{" || ch === "(") depth++;
      else if (ch === "]" || ch === "}" || ch === ")") depth--;
      if (ch === delimiter && depth === 0) {
        parts.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  // ─── Reactive proxy ────────────────────────────────────────────────────────

  function makeReactive(rawData) {
    return new Proxy(rawData, {
      set(target, prop, value) {
        target[prop] = value;
        $render();
        return true;
      },
    });
  }

  // ─── Template interpolation ────────────────────────────────────────────────

  function revaluate(template, data) {
    return template.replace(/{{(.*?)}}/g, (_, expr) => {
      const ctx = buildContext(data);
      const val = safeEval(expr.trim(), ctx);
      return val === undefined || val === null ? "" : val;
    });
  }

  // ─── Render functions ──────────────────────────────────────────────────────

  let reval = [];
  function parseReval() {
    reval = Array.from(document.querySelectorAll("[react]")).map((el) => ({
      elem: el,
      oldTxt: el.innerHTML,
    }));
  }

  function renderReval(data) {
    for (const r of reval) r.elem.innerHTML = revaluate(r.oldTxt, data);
  }

  let ifs = [];
  function parseIf() {
    ifs = [];
    const els = allElements();
    for (const el of els) {
      const attr = el.getAttribute("if");
      if (attr !== null) ifs.push({ elem: el, attr });
    }
  }

  function renderIfs(data) {
    for (const item of ifs) {
      const ctx = buildContext(data);
      const result = safeEval(item.attr, ctx);
      item.elem.style.display = result ? "" : "none";
    }
  }

  let fors = [];
  function parseFors() {
    fors = [];
    const els = allElements();
    for (const el of els) {
      const attr = el.getAttribute("for");
      if (attr !== null) fors.push({ elem: el, attr });
    }
  }

  function renderFors(data) {
    for (const item of fors) {
      const arr = data[item.attr];
      if (!Array.isArray(arr)) continue;
      const template = item.elem.getAttribute("item") || "";
      let html = "";
      for (let i = 0; i < arr.length; i++) {
        html += template
          .replaceAll("{{item}}", arr[i])
          .replaceAll("{{i}}", i);
      }
      item.elem.innerHTML = html;
    }
  }

  let bound = [];
  function parseBind(data) {
    bound = [];
    const els = allElements();
    for (const el of els) {
      const attr = el.getAttribute("bind");
      if (attr !== null) bound.push({ elem: el, attr });
    }
  }

  function renderBinds(data) {
    for (const item of bound) {
      item.elem.addEventListener("input", function () {
        setTimeout(() => {
          data[item.attr] = item.elem.value;
          $render();
        }, 0);
      });
    }
  }

  let screens = [];
  function parseScreen() {
    screens = [];
    const els = allElements();
    for (const el of els) {
      if (el.getAttribute("computer") !== null)
        screens.push({ elem: el, attr: "computer" });
      else if (el.getAttribute("mobile") !== null)
        screens.push({ elem: el, attr: "mobile" });
    }
  }

  function renderScreens() {
    for (const s of screens) {
      if (s.attr === "mobile")
        s.elem.style.display = window.innerWidth <= 600 ? "block" : "none";
      if (s.attr === "computer")
        s.elem.style.display = window.innerWidth >= 600 ? "block" : "none";
    }
  }

  function parseIncl() {
    const els = allElements();
    for (const el of els) {
      const src = el.getAttribute("incl");
      if (src === null) continue;
      fetch(src)
        .then((r) => r.text())
        .then((html) => { el.innerHTML = html; })
        .catch((e) => console.warn("[Sno] incl failed:", src, e));
    }
  }

  // ─── Global $render ────────────────────────────────────────────────────────

  let _data;
  function $render() {
    renderReval(_data);
    renderIfs(_data);
    renderFors(_data);
  }
  window.$render = $render;

  // ─── Global $ helper (for onclick etc.) ───────────────────────────────────

  window.$ = function (expr) {
    safeExec(expr, _data);
    $render();
  };

  // ─── Boot ──────────────────────────────────────────────────────────────────

  function boot() {
    const raw = parseData();
    _data = makeReactive(raw);

    parseReval();
    parseIf();
    parseFors();
    parseScreen();

    // [eval] — run once on load
    const els = allElements();
    for (const el of els) {
      const expr = el.getAttribute("eval");
      if (expr !== null) safeExec(expr, raw);
    }

    renderBinds(_data);
    parseIncl();

    $render();

    // rAF loop for responsive screens
    function loop() {
      requestAnimationFrame(loop);
      renderScreens();
    }
    loop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();