// @vitest-environment happy-dom
// Task 21: article HTML -> whitelisted node tree -> Vue elements. Synthetic inputs only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeNews, MAX_INPUT, MAX_DEPTH } from '../src/calc/newsHtml.js'
import NewsBody from '../src/components/NewsBody.vue'

const html = (text) => mount(NewsBody, { props: { text } }).html({ raw: true })
const tree = (text) => sanitizeNews(text)

afterEach(() => { vi.restoreAllMocks() })

describe('sanitizeNews: dropped with their content', () => {
  it('script never runs and leaves nothing', () => {
    const alert = vi.fn()
    window.alert = alert
    globalThis.__pwned = false
    expect(tree('<script>alert(1);window.__pwned=true</script><p>ok</p>')).toEqual([{ t: 'p', c: ['ok'] }])
    expect(alert).not.toHaveBeenCalled()
    expect(globalThis.__pwned).toBe(false)
  })

  it('iframe, style, img (with onerror), object, embed, form, video, template, noscript', () => {
    const out = tree([
      '<iframe src="https://x.example/"></iframe>', '<style>p{color:red}</style>',
      '<img src="x" onerror="alert(1)">', '<object data="x"></object>', '<embed src="x">',
      '<form action="https://x.example/"><p>form text</p></form>', '<video src="x"></video>',
      '<template><p>tpl</p></template>', '<noscript><p>ns</p></noscript>', '<p>kept</p>',
    ].join(''))
    expect(out).toEqual([{ t: 'p', c: ['kept'] }])
  })

  it('svg and math elements vanish, including an HTML-looking anchor inside them (namespace trick)', () => {
    const out = tree('<svg onload="alert(1)"><a href="https://evil.example/">svg link</a><foreignObject><p>fo</p></foreignObject></svg>'
      + '<math><mtext><a href="https://evil.example/">math link</a></mtext><mglyph><style><img src=x onerror=alert(1)></style></mglyph></math>'
      + '<p>after</p>')
    expect(out).toEqual([{ t: 'p', c: ['after'] }])
    expect(JSON.stringify(out)).not.toMatch(/evil|link|fo|alert/)
  })
})

describe('sanitizeNews: only HTML-namespace elements', () => {
  it('an SVG / MathML element named like a whitelisted tag is dropped with its text', () => {
    const doc = document.implementation.createHTMLDocument('')
    const a = doc.createElementNS('http://www.w3.org/2000/svg', 'a')
    a.setAttribute('href', 'https://evil.example/')
    a.append('svg-a')
    const p = doc.createElementNS('http://www.w3.org/1998/Math/MathML', 'p')
    p.append('math-p')
    const ok = doc.createElement('p')
    ok.append('html-p')
    doc.body.append(a, p, ok)
    class Parser { parseFromString() { return doc } }
    expect(sanitizeNews('<p>x</p>', { parser: Parser })).toEqual([{ t: 'p', c: ['html-p'] }])
  })
})

describe('sanitizeNews: attributes and links', () => {
  it('drops every attribute of whitelisted tags (on*, style, class, id)', () => {
    expect(tree('<p onclick="alert(1)" style="color:red" class="x" id="y">t</p>')).toEqual([{ t: 'p', c: ['t'] }])
  })

  it.each([
    ['javascript:alert(1)'], ['JaVaScRiPt:alert(1)'], [' javascript:alert(1)'], ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'], ['http://plain.example/x'], ['//host.example/p'], ['/relative/path'], ['relative'], ['#frag'],
    [''], ['https://'], ['https://user:pass@evil.example/'], ['https://user@evil.example/'], ['https://:pw@evil.example/'],
  ])('href %j renders as plain text', (href) => {
    expect(tree(`<p><a href="${href.replace(/"/g, '&quot;')}">x</a></p>`)).toEqual([{ t: 'p', c: ['x'] }])
  })

  it('an https link keeps only href; own target / rel / onclick are dropped', () => {
    const out = tree('<p><a href="https://tap.tradernet.global/x?a=1" target="_self" rel="opener" onclick="alert(1)">x</a></p>')
    expect(out).toEqual([{ t: 'p', c: [{ t: 'a', href: 'https://tap.tradernet.global/x?a=1', c: ['x'] }] }])
  })

  it('renders links with target=_blank rel="noopener noreferrer" and nothing else', () => {
    const w = mount(NewsBody, { props: { text: '<p><a href="https://tap.tradernet.global/x" onclick="alert(1)" target="_self">x</a></p>' } })
    const a = w.get('a')
    expect(a.attributes()).toEqual({ href: 'https://tap.tradernet.global/x', target: '_blank', rel: 'noopener noreferrer' })
  })
})

describe('sanitizeNews: structure', () => {
  it('keeps nesting of whitelisted tags', () => {
    expect(tree('<p><b><i>t</i></b></p>')).toEqual([{ t: 'p', c: [{ t: 'b', c: [{ t: 'i', c: ['t'] }] }] }])
  })

  it('keeps the whole whitelist', () => {
    const src = '<h2>h2</h2><h3>h3</h3><h4>h4</h4><p>a<br>b <strong>s</strong> <em>e</em></p>'
      + '<ul><li>u</li></ul><ol><li>o</li></ol><blockquote>q</blockquote>'
    expect(html(src)).toBe(`<div class="nbody">${src}</div>`)
  })

  it('unwraps unknown inline tags, keeping their text', () => {
    expect(tree('<div><span>t</span></div>')).toEqual([{ t: 'p', c: ['t'] }])
    expect(tree('<p><span class="x">a</span><u>b</u></p>')).toEqual([{ t: 'p', c: ['a', 'b'] }])
    expect(tree('<table><tr><td>cell</td><td>two</td></tr></table>')).toEqual([{ t: 'p', c: ['cell'] }, { t: 'p', c: ['two'] }])
  })

  it('block-like unknown tags become paragraphs, so their texts never run together', () => {
    expect(tree('<div>A</div><div>B</div>')).toEqual([{ t: 'p', c: ['A'] }, { t: 'p', c: ['B'] }])
    expect(html('<div>A</div><div>B</div>')).toBe('<div class="nbody"><p>A</p><p>B</p></div>')
    for (const tag of ['section', 'article', 'header', 'footer', 'figure', 'figcaption', 'pre', 'address']) {
      expect(tree(`<${tag}>x</${tag}><p>y</p>`), tag).toEqual([{ t: 'p', c: ['x'] }, { t: 'p', c: ['y'] }])
    }
    expect(tree('<dl><dt>k</dt><dd>v</dd></dl>')).toEqual([{ t: 'p', c: ['k'] }, { t: 'p', c: ['v'] }])
  })

  it('a block-like tag holding blocks is unwrapped (no p inside p)', () => {
    expect(tree('<div><p>a</p><div>b</div></div>')).toEqual([{ t: 'p', c: ['a'] }, { t: 'p', c: ['b'] }])
    expect(tree('<ul><li><div>x</div></li></ul>')).toEqual([{ t: 'ul', c: [{ t: 'li', c: [{ t: 'p', c: ['x'] }] }] }])
  })

  it('top-level inline runs are wrapped into one paragraph; whitespace-only runs vanish', () => {
    expect(tree('Lead <b>bold</b> <a href="https://e.example/">l</a><br>tail<p>next</p>\n  <span>end</span>')).toEqual([
      { t: 'p', c: ['Lead ', { t: 'b', c: ['bold'] }, ' ', { t: 'a', href: 'https://e.example/', c: ['l'] }, { t: 'br' }, 'tail'] },
      { t: 'p', c: ['next'] },
      { t: 'p', c: ['\n  ', 'end'] },
    ])
    expect(tree('<p>a</p>\n\n<p>b</p>')).toEqual([{ t: 'p', c: ['a'] }, { t: 'p', c: ['b'] }])
  })

  it('h1 / h5 / h6 become paragraphs', () => {
    expect(tree('<h1>a</h1><h5>b</h5><h6>c</h6>')).toEqual([{ t: 'p', c: ['a'] }, { t: 'p', c: ['b'] }, { t: 'p', c: ['c'] }])
  })

  it('nested disallowed tags inside allowed ones keep their text but not the tags', () => {
    expect(tree('<p><font color="red"><span><b>bold</b> tail</span></font></p>'))
      .toEqual([{ t: 'p', c: [{ t: 'b', c: ['bold'] }, ' tail'] }])
  })

  it('comments are dropped; text is never parsed as markup again', () => {
    expect(tree('<p>a<!-- <script>x</script> -->b &lt;script&gt;c</p>')).toEqual([{ t: 'p', c: ['a', 'b <script>c'] }])
    const out = html('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
    expect(out).toBe('<div class="nbody"><p>&lt;img src=x onerror=alert(1)&gt;</p></div>')
  })

  it('elements left empty after sanitizing disappear (br stays)', () => {
    expect(tree('<p><img src="x"></p><p>a<br></p>')).toEqual([{ t: 'p', c: ['a', { t: 'br' }] }])
  })

  it('depth beyond the limit keeps the text without tags (and without dropped content)', () => {
    const deep = '<b>'.repeat(MAX_DEPTH + 5) + 'deep<script>x</script><svg><a href="https://e/">s</a></svg>' + '</b>'.repeat(MAX_DEPTH + 5)
    const out = tree(deep)
    let depth = 0
    expect(out[0].t).toBe('p') // the top-level inline run
    let node = out[0].c[0]
    while (node && typeof node === 'object') { depth++; node = node.c[0] }
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH)
    expect(node).toBe('deep')
    expect(JSON.stringify(out)).not.toMatch(/script|"x"|"s"/)
  })

  it('input is capped', () => {
    const out = tree(`<p>${'a'.repeat(MAX_INPUT + 1000)}</p>`)
    expect(out[0].c[0].length).toBeLessThanOrEqual(MAX_INPUT)
  })
})

describe('sanitizeNews: plain text', () => {
  it('entities are decoded (detached parser), never turned into markup', () => {
    expect(tree('AT&amp;T &quot;up&quot; 5&nbsp;%\n\n&lt;b&gt;not bold&lt;/b&gt; &#8212; ok')).toEqual([
      { t: 'p', c: ['AT&T "up" 5\u00a0%'] },
      { t: 'p', c: ['<b>not bold</b> \u2014 ok'] },
    ])
    expect(html('&lt;img src=x onerror=alert(1)&gt;')).toBe('<div class="nbody"><p>&lt;img src=x onerror=alert(1)&gt;</p></div>')
  })

  it('blank lines split paragraphs; single newlines become <br>', () => {
    expect(tree('First line\nsecond line\n\nNext paragraph\r\n\r\n  \n')).toEqual([
      { t: 'p', c: ['First line', { t: 'br' }, 'second line'] },
      { t: 'p', c: ['Next paragraph'] },
    ])
  })

  it('a "<" without markup stays text', () => {
    expect(tree('P/E < 20 and > 10')).toEqual([{ t: 'p', c: ['P/E < 20 and > 10'] }])
  })

  it.each([[null], [undefined], [''], [42], [{}], [['<p>x</p>']]])('%j gives an empty body', (v) => {
    expect(tree(v)).toEqual([])
    expect(html(v)).toBe('<div class="nbody"></div>')
  })
})

describe('no raw HTML sinks in the sources', () => {
  const files = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(js|vue)$/.test(f) ? [p] : []
  })
  it('src never uses v-html, innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    for (const f of files('src')) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/v-html|innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    }
  })
})
