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
    return u.protocol === 'https:' && u.hostname ? u.href : null
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
    if (!KEEP.has(tag)) { out.push(...c); continue } // unknown tag: keep its sanitized content
    if (c.length) out.push({ t: tag, c })
  }
  return out
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
 * blockquote (h1/h5/h6 become p); no attributes except https `href` on links; dangerous
 * elements go with their content, unknown ones are unwrapped. Plain text: paragraphs at blank
 * lines, line breaks inside. Anything but a non-empty string gives [].
 */
export function sanitizeNews(text, { parser } = {}) {
  if (typeof text !== 'string' || !text.trim()) return []
  const src = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text
  if (!looksLikeHtml(src)) return plain(src)
  const P = parser || globalThis.DOMParser
  if (!P) return plain(src.replace(/<[^>]*>/g, ' '))
  const doc = new P().parseFromString(src, 'text/html')
  return walk(doc.body ? doc.body.childNodes : [], 0, [])
}
