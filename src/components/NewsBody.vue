<!-- Article body: the whitelisted tree of calc/newsHtml.js rendered with h(). Text goes in as
     text nodes; links get only href (https, checked), target and rel. -->
<script>
import { computed, defineComponent, h } from 'vue'
import { sanitizeNews } from '../calc/newsHtml.js'

const LINK = { target: '_blank', rel: 'noopener noreferrer' }

function render(nodes) {
  return nodes.map((x) => {
    if (typeof x === 'string') return x
    if (x.t === 'br') return h('br')
    if (x.t === 'a') return h('a', { href: x.href, ...LINK }, render(x.c))
    return h(x.t, render(x.c))
  })
}

export default defineComponent({
  name: 'NewsBody',
  props: { text: { type: null, default: '' } },
  setup(props) {
    const tree = computed(() => sanitizeNews(props.text))
    return () => h('div', { class: 'nbody' }, render(tree.value))
  },
})
</script>
