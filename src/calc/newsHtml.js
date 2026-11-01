// Article text (getNewsDetail `text`: broker HTML or plain text) -> a whitelisted node tree that
// components/NewsBody.vue turns into Vue elements. The HTML is parsed with DOMParser into a
// detached document (scripts never run, nothing loads) and only read from; no markup string is
// ever handed back to the page.
//
// Tree: a string is a text node; {t: tag, c: [children]}; {t: 'a', href, c}; {t: 'br'}.

export const MAX_INPUT = 200_000 // characters parsed; the rest is cut
export const MAX_DEPTH = 20 // element nesting kept; deeper elements become their text

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const KEEP = new Set(['p', 'br', 'a', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'h2', 'h3', 'h4', 'blockquote'])
const AS_P = new Set(['h1', 'h5', 'h6'])
// Unknown block-like tags: a paragraph of their content (unwrapped when they hold blocks).
const BLOCKISH = new Set([
  'div', 'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'tr', 'td', 'th', 'dt', 'dd', 'pre', 'address',
])
// Whitelisted tags that are blocks; everything else in the tree (text, b, i, a, br…) is inline.
const BLOCK = new Set(['p', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote'])
const isBlock = (x) => typeof x === 'object' && BLOCK.has(x.t)
// Removed together with everything inside them.
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'textarea', 'option', 'img', 'picture', 'source', 'svg', 'math', 'video', 'audio', 'track', 'canvas',
  'map', 'link', 'meta', 'base', 'head', 'title', 'template', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext',
  'dialog', 'portal', 'slot',
])
const ELEMENT = 1
const TEXT = 3
const CDATA = 4

/** Absolute https URL or null (relative, protocol-relative and every other scheme are refused). */
export function safeHref(v) {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const u = new URL(v.trim()) // no base: relative links throw
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null
  } catch {
    return null
  }
}

const looksLikeHtml = (s) => /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/i.test(s)

// Only HTML-namespace elements count; SVG / MathML elements (foreign content) are dropped whole.
const tagOf = (el) => (el.namespaceURI === HTML_NS ? String(el.localName || '').toLowerCase() : null)
const dropped = (el) => {
  const tag = tagOf(el)
  return tag === null || DROP.has(tag)
}

/** Text of a subtree without dropped elements; iterative (no recursion limit to hit). */
function textOf(root) {
  let out = ''
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()
    if (n.nodeType === TEXT || n.nodeType === CDATA) out += n.nodeValue || ''
    else if (n.nodeType === ELEMENT && !dropped(n)) {
      for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i])
    }
  }
  return out
}

function walk(nodes, depth, out) {
  for (const n of nodes) {
    if (n.nodeType === TEXT || n.nodeType === CDATA) {
      if (n.nodeValue) out.push(n.nodeValue)
      continue
    }
    if (n.nodeType !== ELEMENT || dropped(n)) continue // comments, processing instructions, dropped
    if (depth >= MAX_DEPTH) {
      const s = textOf(n)
      if (s) out.push(s)
      continue
    }
    const raw = tagOf(n)
    const tag = AS_P.has(raw) ? 'p' : raw
    if (tag === 'br') { out.push({ t: 'br' }); continue }
    const c = walk(n.childNodes, depth + 1, [])
    if (tag === 'a') {
      const href = safeHref(n.getAttribute('href'))
      if (!href) { out.push(...c); continue } // not a safe link: its content as plain text
      if (c.length) out.push({ t: 'a', href, c })
      continue
    }
    if (BLOCKISH.has(tag)) {
      if (c.some(isBlock)) out.push(...c)
      else if (c.length) out.push({ t: 'p', c })
      continue
    }
    if (!KEEP.has(tag)) { out.push(...c); continue } // unknown inline tag: keep its sanitized content
    if (c.length) out.push({ t: tag, c })
  }
  return out
}

// Top level: each run of inline nodes becomes one paragraph (whitespace-only runs are dropped).
function paragraphs(nodes) {
  const out = []
  let run = []
  const flush = () => {
    if (run.some((x) => (typeof x === 'string' ? x.trim() !== '' : x.t !== 'br'))) out.push({ t: 'p', c: run })
    run = []
  }
  for (const x of nodes) {
    if (isBlock(x)) { flush(); out.push(x) } else run.push(x)
  }
  flush()
  return out
}

// Entities of plain text (AT&amp;T) via the detached parser; '<' is escaped first, so nothing
// in the text can become an element.
function decode(text, P) {
  if (!P || !text.includes('&')) return text
  try {
    const body = new P().parseFromString(text.replace(/</g, '&lt;'), 'text/html').body
    return body ? body.textContent : text
  } catch {
    return text
  }
}

function plain(text) {
  return text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const c = []
      block.split('\n').forEach((line, i) => {
        if (i) c.push({ t: 'br' })
        if (line) c.push(line)
      })
      return { t: 'p', c }
    })
}

/**
 * Broker article text -> whitelisted tree. Tags kept: p br a ul ol li b strong i em h2 h3 h4
 * blockquote (h1/h5/h6 and block-like unknown tags become p); no attributes except https `href`
 * (no credentials) on links; dangerous elements go with their content, unknown inline ones are
 * unwrapped; top-level inline runs become paragraphs. Plain text: entities decoded, paragraphs at
 * blank lines, line breaks inside. Anything but a non-empty string gives [].
 */
export function sanitizeNews(text, { parser } = {}) {
  if (typeof text !== 'string' || !text.trim()) return []
  const src = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text
  const P = parser || globalThis.DOMParser
  if (!looksLikeHtml(src)) return plain(decode(src, P))
  if (!P) return plain(src.replace(/<[^>]*>/g, ' '))
  const doc = new P().parseFromString(src, 'text/html')
  return paragraphs(walk(doc.body ? doc.body.childNodes : [], 0, []))
}
