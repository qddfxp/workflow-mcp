// 布尔门条件求值：expr 由步骤 id 组成，支持 && || ! 与括号。
// 仅在依赖全部落定（done/skipped）后求值一次，结果恒定 → 分支是确定性的。

const IDENT_RE = /^[A-Za-z0-9_\u4e00-\u9fff-]+$/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (src.startsWith('&&', i) || src.startsWith('||', i)) {
      tokens.push({ type: 'op', value: src.slice(i, i + 2) }); i += 2; continue;
    }
    if (ch === '!' || ch === '(' || ch === ')') {
      tokens.push({ type: 'op', value: ch }); i++; continue;
    }
    let j = i;
    while (j < src.length && !/[\s()!]/.test(src[j]) && !src.startsWith('&&', j) && !src.startsWith('||', j)) j++;
    if (j === i) throw new Error(`位置 ${i + 1}: 无法识别的字符 "${ch}"`);
    const word = src.slice(i, j);
    if (!IDENT_RE.test(word)) throw new Error(`位置 ${i + 1}: 非法标识符 "${word}"（只允许中英文、数字、下划线、连字符）`);
    tokens.push({ type: 'ident', value: word }); i = j;
  }
  return tokens;
}

export function evalGate(expr, truth) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (value) => {
    const t = tokens[pos];
    if (!t || t.value !== value) throw new Error(`位置 ${pos + 1}: 期望 "${value}"`);
    pos++;
  };

  function parseOr() {
    let v = parseAnd();
    while (peek() && peek().value === '||') { eat('||'); v = parseAnd() || v; }
    return v;
  }
  function parseAnd() {
    let v = parseFactor();
    while (peek() && peek().value === '&&') { eat('&&'); v = parseFactor() && v; }
    return v;
  }
  function parseFactor() {
    const t = peek();
    if (!t) throw new Error('表达式意外结束');
    if (t.value === '!') { eat('!'); return !parseFactor(); }
    if (t.value === '(') { eat('('); const v = parseOr(); eat(')'); return v; }
    if (t.type !== 'ident') throw new Error(`位置 ${pos + 1}: 此处应为步骤名`);
    pos++;
    return Boolean(truth(t.value));
  }

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`位置 ${pos + 1}: 存在多余内容`);
  return result;
}

export function gateVariables(expr) {
  return tokenize(expr).filter(t => t.type === 'ident').map(t => t.value);
}
