/**
 * Dependency-free syntax highlighter for the TUI.
 *
 * AstroCode ships with only `ink` + `react`, so instead of pulling in
 * highlight.js/shiki we tokenize code blocks ourselves. The tokenizer is
 * deliberately shallow: it colors keywords, strings, numbers, comments,
 * function names, types, and punctuation — enough to make a fenced block
 * readable, not enough to be a compiler front end.
 *
 * `highlightCode(code, lang)` is pure and memoized, so re-rendering a long
 * transcript (the spinner bumps the tick ~10x/sec) never re-tokenizes a block
 * that has already been highlighted.
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'punct';

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Carried line-to-line so block comments and multi-line strings stay colored. */
export interface HighlightState {
  blockComment: string | null;
  string: string | null;
}

export function initialState(): HighlightState {
  return { blockComment: null, string: null };
}

/* ------------------------------------------------------------------ *
 * Language specs (C-like family)
 * ------------------------------------------------------------------ */

interface LangSpec {
  keywords: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  builtins?: ReadonlySet<string>;
  lineComments: readonly string[];
  blockComment?: readonly [string, string];
  quotes: readonly string[];
  /** Quotes whose literals may span lines (JS template, Go raw string). */
  multilineQuotes?: readonly string[];
  /** Quotes where backslash is literal (Go raw strings). */
  rawQuotes?: readonly string[];
  /** Multi-line delimiters handled before single quotes (Python triple). */
  tripleQuotes?: readonly string[];
  /** Treat `#directive` at line start as a keyword (C preprocessor). */
  hashDirective?: boolean;
  /** Color `@Decorator` as a type (Python/Java/TS). */
  decorators?: boolean;
  /** Color Rust `'lifetime` (a quote that isn't a char literal). */
  lifetimes?: boolean;
  /** Keyword match is case-insensitive (SQL). */
  caseInsensitive?: boolean;
}

function set(words: string): ReadonlySet<string> {
  return new Set(words.split(/\s+/).filter(Boolean));
}

const JS_KEYWORDS = set(`
  abstract as async await break case catch class const constructor continue
  debugger declare default delete do else enum export extends false finally for
  from function get if implements import in infer instanceof interface is keyof
  let module namespace new null of package private protected public readonly
  return satisfies set static super switch this throw true try type typeof
  undefined var void while with yield asserts
`);

const JS_BUILTINS = set(`
  Array ArrayBuffer BigInt Boolean Buffer Date Error EvalError Fetch Function
  Infinity Intl JSON Map Math NaN Number Object Promise Proxy RangeError
  ReferenceError Reflect RegExp Set String Symbol SyntaxError TypeError
  URIError URL URLSearchParams WeakMap WeakSet AbortController AbortSignal
  TextDecoder TextEncoder structuredClone console document exports fetch
  globalThis module process queueMicrotask require setTimeout setInterval
  clearTimeout clearInterval window __dirname __filename
`);

const PY_KEYWORDS = set(`
  False None True and as assert async await break class continue def del elif
  else except finally for from global if import in is lambda match nonlocal not
  or pass raise return try while with yield case
`);

const PY_BUILTINS = set(`
  abs all any bool bytes callable chr dict dir divmod enumerate eval filter
  float format frozenset getattr hasattr hash hex id input int isinstance
  issubclass iter len list map max min next object open ord pow print property
  range repr reversed round self cls set setattr slice sorted staticmethod str
  sum super tuple type vars zip Exception ValueError TypeError KeyError
  IndexError RuntimeError StopIteration NotImplemented classmethod
`);

const GO_KEYWORDS = set(`
  break case chan const continue default defer else fallthrough for func go goto
  if import interface map package range return select struct switch type var
`);

const GO_BUILTINS = set(`
  append bool byte cap close complex complex64 complex128 copy delete error
  false float32 float64 imag int int8 int16 int32 int64 iota len make new nil
  panic print println real recover rune string true uint uint8 uint16 uint32
  uint64 uintptr any
`);

const RUST_KEYWORDS = set(`
  as async await break const continue crate dyn else enum extern false fn for
  if impl in let loop match mod move mut pub ref return self Self static struct
  super trait true type unsafe use where while yield
`);

const RUST_BUILTINS = set(`
  bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize
  Box Rc Arc RefCell Cell Mutex Option Result Some None Ok Err String Vec
  HashMap HashSet BTreeMap VecDeque println print format vec panic todo
  unimplemented matches assert_eq
`);

const JAVA_KEYWORDS = set(`
  abstract assert boolean break byte case catch char class const continue
  default do double else enum extends final finally float for goto if
  implements import instanceof int interface long native new package private
  protected public return short static strictfp super switch synchronized this
  throw throws transient try void volatile while var record sealed permits
  yield true false null
`);

const JAVA_BUILTINS = set(`
  ArrayList Arrays Boolean Character Collections Double Exception Float HashMap
  HashSet IOException Integer Iterable Iterator List Long Map Math Object
  Optional RuntimeException Set Stream String StringBuilder System Thread
  Runnable Double CharSequence
`);

const C_KEYWORDS = set(`
  auto break case char const continue default do double else enum extern float
  for goto if inline int long register restrict return short signed sizeof
  static struct switch typedef union unsigned void volatile while class
  namespace template typename public private protected virtual override new
  delete this nullptr true false using try catch throw constexpr noexcept
  operator friend explicit mutable const_cast static_cast dynamic_cast
  reinterpret_cast
`);

const C_BUILTINS = set(`
  bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t
  FILE NULL stdout stderr stdin printf scanf malloc free memcpy memset strlen
  strcmp strcpy sprintf fprintf sizeof std string vector map set cout cin cerr
  endl
`);

const CS_KEYWORDS = set(`
  abstract as base bool break byte case catch char checked class const continue
  decimal default delegate do double else enum event explicit extern false
  finally fixed float for foreach goto if implicit in int interface internal is
  lock long namespace new null object operator out override params private
  protected public readonly ref return sbyte sealed short sizeof stackalloc
  static string struct switch this throw true try typeof uint ulong unchecked
  unsafe ushort using var virtual void volatile while async await record
`);

const CS_BUILTINS = set(`
  Console String Int32 Int64 Double Boolean List Dictionary Task IEnumerable
  Exception Math DateTime Array Object Nullable
`);

const RUBY_KEYWORDS = set(`
  alias and begin break case class def defined do else elsif end ensure false
  for if in module next nil not or redo rescue retry return self super then true
  undef unless until when while yield lambda proc require require_relative
  attr_accessor attr_reader attr_writer
`);

const RUBY_BUILTINS = set(`
  Array Hash String Integer Float Symbol Proc Kernel Object Class Module Struct
  puts print p raise loop
`);

const PHP_KEYWORDS = set(`
  abstract and array as break callable case catch class clone const continue
  declare default do echo else elseif empty enddeclare endfor endforeach endif
  endswitch endwhile enum extends final finally fn for foreach function global
  goto if implements include include_once instanceof insteadof interface isset
  list match namespace new or print private protected public readonly require
  require_once return static switch throw trait try unset use var while xor
  yield true false null
`);

const PHP_BUILTINS = set(`
  array_filter array_map count explode implode json_decode json_encode printf
  print_r preg_match sprintf strlen var_dump
`);

const SQL_KEYWORDS = set(`
  select from where insert into values update set delete create alter drop
  table index view join inner left right outer full on group by having order asc
  desc limit offset union all distinct as and or not null is in between like
  exists case when then else end primary key foreign references unique default
  constraint database grant revoke commit rollback begin transaction
`);

const SQL_BUILTINS = set(`
  bigint boolean cast coalesce count date decimal integer max min numeric
  varchar text timestamp avg sum
`);

const SH_KEYWORDS = set(`
  if then else elif fi for while until do done case esac function in return
  break continue local export readonly declare unset shift exit set source
  alias echo printf read eval exec trap
`);

const SH_BUILTINS = set(`
  awk cat cd chmod chown cp curl cut date df diff docker du env find git grep
  gzip head kill kubectl ln ls make mkdir mv node npm patch paste pip ps pwd
  python rm rmdir scp sed sleep sort ssh sudo tail tar tee top touch tr uniq
  wc wget which whoami xargs
`);

const SPECS: Record<string, LangSpec> = {
  js: {
    keywords: JS_KEYWORDS,
    builtins: JS_BUILTINS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    multilineQuotes: ['`'],
  },
  json: {
    keywords: set('true false null'),
    lineComments: [],
    quotes: ['"'],
  },
  python: {
    keywords: PY_KEYWORDS,
    builtins: PY_BUILTINS,
    lineComments: ['#'],
    quotes: ['"', "'"],
    tripleQuotes: ['"""', "'''"],
    decorators: true,
  },
  go: {
    keywords: GO_KEYWORDS,
    builtins: GO_BUILTINS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    multilineQuotes: ['`'],
    rawQuotes: ['`'],
  },
  rust: {
    keywords: RUST_KEYWORDS,
    builtins: RUST_BUILTINS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    lifetimes: true,
  },
  java: {
    keywords: JAVA_KEYWORDS,
    builtins: JAVA_BUILTINS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    decorators: true,
  },
  c: {
    keywords: C_KEYWORDS,
    builtins: C_BUILTINS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    hashDirective: true,
  },
  csharp: {
    keywords: CS_KEYWORDS,
    builtins: CS_BUILTINS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  ruby: {
    keywords: RUBY_KEYWORDS,
    builtins: RUBY_BUILTINS,
    lineComments: ['#'],
    quotes: ['"', "'"],
  },
  php: {
    keywords: PHP_KEYWORDS,
    builtins: PHP_BUILTINS,
    lineComments: ['//', '#'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  sql: {
    keywords: SQL_KEYWORDS,
    builtins: SQL_BUILTINS,
    lineComments: ['--'],
    blockComment: ['/*', '*/'],
    quotes: ["'", '"'],
    caseInsensitive: true,
  },
  shell: {
    keywords: SH_KEYWORDS,
    builtins: SH_BUILTINS,
    lineComments: ['#'],
    quotes: ['"', "'"],
  },
  docker: {
    keywords: set(
      'from run cmd label maintainer expose env add copy entrypoint volume ' +
        'user workdir arg onbuild stopsignal healthcheck shell as',
    ),
    lineComments: ['#'],
    quotes: ['"', "'"],
  },
  plain: {
    keywords: set(''),
    lineComments: ['//', '#'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
  },
};

/* ------------------------------------------------------------------ *
 * Language detection
 * ------------------------------------------------------------------ */

const ALIASES: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  ts: 'js', tsx: 'js', typescript: 'js',
  json: 'json', jsonc: 'json', json5: 'json',
  py: 'python', python: 'python', python3: 'python',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  java: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c',
  cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
  rb: 'ruby', ruby: 'ruby',
  php: 'php',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  fish: 'shell', ksh: 'shell',
  docker: 'docker', dockerfile: 'docker', containerfile: 'docker',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  xhtml: 'markup', rss: 'markup',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml', properties: 'toml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'plain', text: 'plain', plaintext: 'plain', log: 'plain', diff: 'plain',
};

/**
 * Map a fenced-code info string to a strategy key. The first token of the
 * info string is the language (` ```ts title="x" ` → `ts`); unknown or empty
 * input degrades to `plain`, which still colors strings/numbers/comments.
 */
export function detectLanguage(info?: string | null): string {
  if (!info) return 'plain';
  const first = info.trim().split(/[\s:{,]+/)[0]?.toLowerCase() ?? '';
  return ALIASES[first] ?? 'plain';
}

/* ------------------------------------------------------------------ *
 * Scanning helpers
 * ------------------------------------------------------------------ */

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUM_STICKY =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)(?:[uUlLfFnN]|[iIuU](?:8|16|32|64|128|size))?/y;
const IDENT_STICKY = /[A-Za-z_$][A-Za-z0-9_$]*/y;

function readQuoted(
  line: string,
  start: number,
  quote: string,
  raw: boolean,
): { end: number; closed: boolean } {
  const n = line.length;
  let i = start + quote.length;
  while (i < n) {
    if (!raw && line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line.startsWith(quote, i)) return { end: i + quote.length, closed: true };
    i++;
  }
  return { end: n, closed: false };
}

function classify(
  word: string,
  line: string,
  end: number,
  spec: LangSpec,
): TokenKind {
  const key = spec.caseInsensitive ? word.toLowerCase() : word;
  if (spec.keywords.has(key)) return 'keyword';
  if (spec.types?.has(key) || spec.builtins?.has(key)) return 'type';
  let j = end;
  while (line[j] === ' ' || line[j] === '\t') j++;
  if (line[j] === '(') return 'function';
  if (/^[A-Z]/.test(word) && word.length > 1) return 'type';
  return 'plain';
}

/* ------------------------------------------------------------------ *
 * C-like scanner
 * ------------------------------------------------------------------ */

function scanClikeLine(
  line: string,
  st: HighlightState,
  spec: LangSpec,
): Token[] {
  const out: Token[] = [];
  const n = line.length;
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  let i = 0;
  const firstNonSpace = line.search(/\S/);

  while (i < n) {
    // Resume an open block comment.
    if (st.blockComment) {
      const close = spec.blockComment?.[1] ?? '*/';
      const end = line.indexOf(close, i);
      if (end === -1) {
        push(line.slice(i), 'comment');
        return out;
      }
      push(line.slice(i, end + close.length), 'comment');
      i = end + close.length;
      st.blockComment = null;
      continue;
    }

    // Resume an open multi-line string.
    if (st.string) {
      const raw = spec.rawQuotes?.includes(st.string) ?? false;
      const res = readQuoted(line, i, st.string, raw);
      push(line.slice(i, res.end), 'string');
      i = res.end;
      if (res.closed) st.string = null;
      else return out;
      continue;
    }

    const ch = line[i];

    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }

    const lc = spec.lineComments.find((c) => line.startsWith(c, i));
    if (lc) {
      push(line.slice(i), 'comment');
      return out;
    }

    if (spec.blockComment && line.startsWith(spec.blockComment[0], i)) {
      const open = spec.blockComment[0];
      const close = spec.blockComment[1];
      const end = line.indexOf(close, i + open.length);
      if (end === -1) {
        push(line.slice(i), 'comment');
        st.blockComment = open;
        return out;
      }
      push(line.slice(i, end + close.length), 'comment');
      i = end + close.length;
      continue;
    }

    if (spec.tripleQuotes) {
      const tq = spec.tripleQuotes.find((q) => line.startsWith(q, i));
      if (tq) {
        const end = line.indexOf(tq, i + tq.length);
        if (end === -1) {
          push(line.slice(i), 'string');
          st.string = tq;
          return out;
        }
        push(line.slice(i, end + tq.length), 'string');
        i = end + tq.length;
        continue;
      }
    }

    if (spec.hashDirective && ch === '#' && i === firstNonSpace) {
      IDENT_STICKY.lastIndex = i;
      const m = IDENT_STICKY.exec(line);
      const word = m ? m[0] : '#';
      push(line.slice(i, i + word.length), 'keyword');
      i += word.length;
      continue;
    }

    // Rust lifetime: `'a` not followed by a closing quote.
    if (spec.lifetimes && ch === "'" && IDENT_START.test(line[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(line[j])) j++;
      if (line[j] !== "'") {
        push(line.slice(i, j), 'type');
        i = j;
        continue;
      }
    }

    if (spec.quotes.includes(ch)) {
      const raw = spec.rawQuotes?.includes(ch) ?? false;
      const res = readQuoted(line, i, ch, raw);
      push(line.slice(i, res.end), 'string');
      i = res.end;
      if (!res.closed) {
        st.string = ch;
        return out;
      }
      continue;
    }

    if (spec.decorators && ch === '@') {
      IDENT_STICKY.lastIndex = i + 1;
      const m = IDENT_STICKY.exec(line);
      const word = m ? m[0] : '';
      push(line.slice(i, i + 1 + word.length), 'type');
      i += 1 + word.length;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
      NUM_STICKY.lastIndex = i;
      const m = NUM_STICKY.exec(line);
      if (m && m.index === i && m[0].length > 0) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }

    if (IDENT_START.test(ch)) {
      IDENT_STICKY.lastIndex = i;
      const m = IDENT_STICKY.exec(line);
      const word = m ? m[0] : ch;
      push(word, classify(word, line, i + word.length, spec));
      i += word.length;
      continue;
    }

    push(ch, 'punct');
    i++;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Markup (HTML / XML / SVG)
 * ------------------------------------------------------------------ */

function scanMarkupLine(line: string, st: HighlightState): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  let i = 0;
  const n = line.length;

  while (i < n) {
    if (st.blockComment) {
      const end = line.indexOf('-->', i);
      if (end === -1) {
        push(line.slice(i), 'comment');
        return out;
      }
      push(line.slice(i, end + 3), 'comment');
      i = end + 3;
      st.blockComment = null;
      continue;
    }
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      if (end === -1) {
        push(line.slice(i), 'comment');
        st.blockComment = '<!--';
        return out;
      }
      push(line.slice(i, end + 3), 'comment');
      i = end + 3;
      continue;
    }
    if (line[i] === '<') {
      // Consume one tag: <name attr="v" ...> or </name> or <?xml?> or <!DOCTYPE>
      const close = line.indexOf('>', i);
      const tag = close === -1 ? line.slice(i) : line.slice(i, close + 1);
      pushTag(tag, out);
      i += tag.length;
      continue;
    }
    // Text content up to the next '<'.
    const next = line.indexOf('<', i);
    const text = next === -1 ? line.slice(i) : line.slice(i, next);
    push(text, 'plain');
    i += text.length;
  }
  return out;
}

function pushTag(tag: string, out: Token[]): void {
  let i = 0;
  const n = tag.length;
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  // Leading `<`, `</`, `<!`, `<?`
  const lead = /^(<\/?[!?]?)/.exec(tag)?.[0] ?? '<';
  push(lead, 'punct');
  i = lead.length;

  while (i < n) {
    const ch = tag[i];
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (tag[j] === ' ' || tag[j] === '\t')) j++;
      push(tag.slice(i, j), 'plain');
      i = j;
      continue;
    }
    if (ch === '>' || tag.startsWith('/>', i)) {
      push(tag.slice(i), 'punct');
      return;
    }
    if (ch === '=') {
      push('=', 'punct');
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const res = readQuoted(tag, i, ch, false);
      push(tag.slice(i, res.end), 'string');
      i = res.end;
      continue;
    }
    if (/[A-Za-z_:-]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_:.-]/.test(tag[j])) j++;
      const word = tag.slice(i, j);
      // The very first word is the tag name; later words are attributes.
      push(word, i === lead.length ? 'keyword' : 'function');
      i = j;
      continue;
    }
    push(ch, 'punct');
    i++;
  }
}

/* ------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------ */

function scanCssLine(line: string, st: HighlightState): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  let i = 0;
  const n = line.length;
  let sawColon = false;
  let braceDepth = 0;

  while (i < n) {
    if (st.blockComment) {
      const end = line.indexOf('*/', i);
      if (end === -1) {
        push(line.slice(i), 'comment');
        return out;
      }
      push(line.slice(i, end + 2), 'comment');
      i = end + 2;
      st.blockComment = null;
      continue;
    }
    if (line.startsWith('/*', i)) {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        push(line.slice(i), 'comment');
        st.blockComment = '/*';
        return out;
      }
      push(line.slice(i, end + 2), 'comment');
      i = end + 2;
      continue;
    }
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const res = readQuoted(line, i, ch, false);
      push(line.slice(i, res.end), 'string');
      i = res.end;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      sawColon = false;
      push('{', 'punct');
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      sawColon = false;
      push('}', 'punct');
      i++;
      continue;
    }
    if (ch === ';') {
      sawColon = false;
      push(';', 'punct');
      i++;
      continue;
    }
    if (ch === ':') {
      sawColon = true;
      push(':', 'punct');
      i++;
      continue;
    }
    if (ch === '#') {
      let j = i;
      while (j < n && /[0-9a-fA-F]/.test(line[j + 1] ?? '')) j++;
      push(line.slice(i, j + 1), 'number');
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      NUM_STICKY.lastIndex = i;
      const m = NUM_STICKY.exec(line);
      if (m && m.index === i) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_@#.%&*:-]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_@#.%&*-]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (braceDepth === 0) push(word, 'keyword'); // selector
      else if (!sawColon) push(word, 'function'); // property
      else if (word.startsWith('!')) push(word, 'number'); // !important
      else push(word, 'plain');
      i = j;
      continue;
    }
    push(ch, 'punct');
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * YAML / TOML
 * ------------------------------------------------------------------ */

function scanYamlLine(line: string): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  let i = 0;
  const n = line.length;
  let valueStart = -1;

  while (i < n) {
    const ch = line[i];
    if (ch === '#') {
      push(line.slice(i), 'comment');
      return out;
    }
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }
    if (ch === '-' && (line[i + 1] === ' ' || line[i + 1] === '\t' || i + 1 === n)) {
      push('-', 'punct');
      i++;
      continue;
    }
    if (ch === ':' && valueStart === -1) {
      push(':', 'punct');
      i++;
      valueStart = i;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const res = readQuoted(line, i, ch, false);
      push(line.slice(i, res.end), 'string');
      i = res.end;
      continue;
    }
    if (valueStart === -1 && /[A-Za-z0-9_.$"'-]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.$-]/.test(line[j])) j++;
      push(line.slice(i, j), 'function'); // key
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(line[i + 1] ?? ''))) {
      NUM_STICKY.lastIndex = i;
      const m = NUM_STICKY.exec(line);
      if (m && m.index === i) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      push(word, /^(true|false|null|yes|no|on|off)$/.test(word) ? 'keyword' : 'plain');
      i = j;
      continue;
    }
    push(ch, 'punct');
    i++;
  }
  return out;
}

function scanTomlLine(line: string): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) {
    push(line, 'comment');
    return out;
  }
  let i = 0;
  const n = line.length;
  let sawEq = false;

  while (i < n) {
    const ch = line[i];
    if (ch === '#') {
      push(line.slice(i), 'comment');
      return out;
    }
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }
    if (ch === '[') {
      const end = line.indexOf(']', i);
      const seg = end === -1 ? line.slice(i) : line.slice(i, end + 1);
      push(seg, 'type');
      i += seg.length;
      continue;
    }
    if (ch === '=') {
      sawEq = true;
      push('=', 'punct');
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const res = readQuoted(line, i, ch, false);
      push(line.slice(i, res.end), 'string');
      i = res.end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      NUM_STICKY.lastIndex = i;
      const m = NUM_STICKY.exec(line);
      if (m && m.index === i) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_.-]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.-]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (!sawEq) push(word, 'function');
      else push(word, /^(true|false)$/.test(word) ? 'keyword' : 'plain');
      i = j;
      continue;
    }
    push(ch, 'punct');
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Markdown (inside fenced md blocks)
 * ------------------------------------------------------------------ */

function scanMarkdownLine(line: string): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text) out.push({ text, kind });
  };
  if (/^\s*#{1,6}\s/.test(line)) {
    push(line, 'keyword');
    return out;
  }
  if (/^\s*>/.test(line)) {
    push(line, 'comment');
    return out;
  }
  if (/^\s*(```|~~~)/.test(line)) {
    push(line, 'punct');
    return out;
  }
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) push(line.slice(last, m.index), 'plain');
    const tok = m[0];
    if (tok.startsWith('`')) push(tok, 'string');
    else if (tok.startsWith('[')) push(tok, 'type');
    else push(tok, 'keyword');
    last = m.index + tok.length;
  }
  if (last < line.length) push(line.slice(last), 'plain');
  return out;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

function scanLine(line: string, lang: string, st: HighlightState): Token[] {
  switch (lang) {
    case 'markup':
      return scanMarkupLine(line, st);
    case 'css':
      return scanCssLine(line, st);
    case 'yaml':
      return scanYamlLine(line);
    case 'toml':
      return scanTomlLine(line);
    case 'markdown':
      return scanMarkdownLine(line);
    default:
      return scanClikeLine(line, st, SPECS[lang] ?? SPECS.plain);
  }
}

/** Merge adjacent same-kind tokens so we emit the fewest `<Text>` spans. */
function coalesce(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === t.kind) prev.text += t.text;
    else out.push({ ...t });
  }
  return out;
}

const CACHE = new Map<string, Token[][]>();
const CACHE_LIMIT = 200;

/**
 * Highlight a whole code block. Returns one token array per input line, so
 * the renderer can wrap and gutter each line independently. Memoized by
 * language + source.
 */
export function highlightCode(code: string, lang: string): Token[][] {
  const key = `${lang}\u0000${code}`;
  const hit = CACHE.get(key);
  if (hit) return hit;

  const st = initialState();
  const lines = code.split('\n');
  const result = lines.map((l) => coalesce(scanLine(l, lang, st)));

  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, result);
  return result;
}

/** Test hook: drop the memo table. */
export function clearHighlightCache(): void {
  CACHE.clear();
}
