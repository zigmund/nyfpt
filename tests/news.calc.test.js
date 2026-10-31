// Task 21: news time conversion, list paging helpers, field normalisation. Synthetic data only.
import { describe, expect, it } from 'vitest'
import {
  parseOffset, newsOffset, newsTime, agoLabel, mergeItems, hasMore, sentimentOf, httpsUrl, relatedTickers,
} from '../src/calc/news.js'

const NY = 'America/New_York'
const ALMATY = 'Asia/Almaty' // UTC+5, no DST
const at = (iso) => Date.parse(iso)

describe('parseOffset', () => {
  it.each([
    ['+0300', 10800], ['+03:00', 10800], ['-0430', -16200], ['+05', 18000], ['+0000', 0], ['Z', 0], [' +0300 ', 10800],
  ])('%j -> %d s', (s, v) => expect(parseOffset(s)).toBe(v))
  it.each([[null], [undefined], [''], ['MSK'], ['+3'], ['+2500'], ['+0360'], [10800]])('%j -> null', (s) => {
    expect(parseOffset(s)).toBeNull()
  })
})

describe('newsOffset: from the data first, then learned, then the market clock', () => {
  it('own timeZone wins', () => expect(newsOffset({ timeZone: '+0200' }, { learned: 10800, clock: 0 })).toBe(7200))
  it('a zone learned from an article', () => expect(newsOffset({}, { learned: 10800, clock: 0 })).toBe(10800))
  it('the server offset of the app market clock', () => expect(newsOffset({ timeZone: 'bad' }, { clock: 10800 })).toBe(10800))
  it('unknown', () => expect(newsOffset({}, {})).toBeNull())
})

describe('newsTime', () => {
  it('list date (server wall time) + offset -> UTC, local full time and relative label', () => {
    const r = newsTime('2026-10-31 11:01:00', 10800, at('2026-10-31T11:01:00Z'), ALMATY)
    expect(r.sec).toBe(at('2026-10-31T08:01:00Z') / 1000)
    expect(r.full).toBe('Oct 31, 2026, 1:01 PM GMT+5')
    expect(r.ago).toBe('3h ago')
  })

  it('detail dateTime with its own zone; a New York viewer sees New York time', () => {
    const r = newsTime('2026-10-31T11:01:00', parseOffset('+0300'), at('2026-10-31T08:31:00Z'), NY)
    expect(r.full).toBe('Oct 31, 2026, 4:01 AM GMT-4')
    expect(r.ago).toBe('30m ago')
  })

  it('a different server offset moves the instant (nothing is hard-coded)', () => {
    expect(newsTime('2026-10-31 11:01:00', 0, at('2026-10-31T12:00:00Z')).sec).toBe(at('2026-10-31T11:01:00Z') / 1000)
  })

  it('null without an offset or with a bad date', () => {
    expect(newsTime('2026-10-31 11:01:00', null, 0)).toBeNull()
    expect(newsTime('31.10.2026', 10800, 0)).toBeNull()
    expect(newsTime(null, 10800, 0)).toBeNull()
    expect(newsTime('2026-10-31 25:01:00', 10800, 0)).toBeNull()
  })
})

describe('agoLabel', () => {
  const now = at('2026-10-31T12:00:00Z')
  const s = (iso) => at(iso) / 1000
  it.each([
    ['2026-10-31T11:59:30Z', 'Just now'],
    ['2026-10-31T12:03:00Z', 'Just now'], // device clock behind the broker
    ['2026-10-31T11:55:00Z', '5m ago'],
    ['2026-10-31T09:00:00Z', '3h ago'],
    ['2026-10-30T11:00:00Z', '1d ago'],
    ['2026-10-25T12:00:00Z', '6d ago'],
    ['2026-10-19T12:00:00Z', 'Oct 19'],
    ['2024-07-02T12:00:00Z', 'Jul 2, 2024'],
  ])('%s -> %s', (iso, label) => expect(agoLabel(s(iso), now, 'UTC')).toBe(label))
})

describe('paging', () => {
  it('mergeItems drops duplicate and id-less rows, keeps order', () => {
    const a = [{ id: 1 }, { id: 2 }]
    const r = mergeItems(a, [{ id: 2 }, { id: '3' }, { id: 3 }, null, { title: 'no id' }, { id: 4 }])
    expect(r.items.map((x) => x.id)).toEqual([1, 2, '3', 4])
    expect(r.added).toBe(2)
    expect(a).toHaveLength(2) // not mutated
  })

  it('hasMore: stops at total, on an empty page and on a page with nothing new', () => {
    expect(hasMore({ total: 45, skip: 0, got: 20, added: 20 })).toBe(true)
    expect(hasMore({ total: 45, skip: 40, got: 5, added: 5 })).toBe(false)
    expect(hasMore({ total: 45, skip: 20, got: 0, added: 0 })).toBe(false)
    expect(hasMore({ total: 45, skip: 20, got: 20, added: 0 })).toBe(false)
    expect(hasMore({ total: null, skip: 0, got: 20, added: 20, take: 20 })).toBe(true)
    expect(hasMore({ total: null, skip: 0, got: 7, added: 7, take: 20 })).toBe(false)
  })
})

describe('fields', () => {
  it('sentimentOf maps known values only', () => {
    expect(sentimentOf(' Positive ')).toBe('positive')
    expect(sentimentOf('NEGATIVE')).toBe('negative')
    expect(sentimentOf('neutral')).toBe('neutral')
    for (const v of ['', null, 'bullish', '1', 0, {}]) expect(sentimentOf(v)).toBeNull()
  })

  it('httpsUrl accepts only absolute https', () => {
    expect(httpsUrl('https://finance.yahoo.com/x')).toBe('https://finance.yahoo.com/x')
    for (const v of ['http://a.example/', '/news/1', '', null, 'javascript:alert(1)', 'data:text/html,x', '//a.example/x', 'https://']) {
      expect(httpsUrl(v)).toBeNull()
    }
  })

  it('relatedTickers: strings or objects, unique, at most 3', () => {
    expect(relatedTickers(['AAA.US', 'BBB.US', 'AAA.US', '', 'CCC.US', 'DDD.US'])).toEqual(['AAA.US', 'BBB.US', 'CCC.US'])
    expect(relatedTickers([{ ticker: 'AAA.US' }, { c: 'BBB.US' }, { x: 1 }, 5])).toEqual(['AAA.US', 'BBB.US'])
    expect(relatedTickers('AAA.US')).toEqual([])
    expect(relatedTickers(null)).toEqual([])
  })
})
