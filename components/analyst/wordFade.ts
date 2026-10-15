/**
 * The demo's word-fade reveal as a rehype plugin (Wave 2 item 4b): every word of the rendered answer becomes a
 * `<span class="w">` with a staggered animation delay, so the answer rises in calmly instead of appearing at once
 * (or with a cursor). Code, pre and the formula box are left whole. Under reduced motion the global rule zeroes the
 * animation, so the spans are inert. PURE: a hast transformer with no dependency beyond the tree it is given.
 */

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP = new Set(['code', 'pre', 'script', 'style']);

/** Wrap the words of every text node (outside code) in fading spans; `stepMs` between words, `startMs` offset. */
export function fadeWords(tree: HastNode, opts: { stepMs?: number; startMs?: number; maxDelayMs?: number } = {}): number {
  const step = opts.stepMs ?? 18;
  const max = opts.maxDelayMs ?? 2_600;
  let n = 0;
  const delay = () => `${Math.min((opts.startMs ?? 0) + n++ * step, max)}ms`;
  const walk = (node: HastNode): void => {
    if (!node.children) return;
    const out: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string' && child.value.trim()) {
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) out.push({ type: 'text', value: part });
          else out.push({ type: 'element', tagName: 'span', properties: { className: ['w'], style: `animation-delay:${delay()}` }, children: [{ type: 'text', value: part }] });
        }
      } else {
        if (child.type === 'element' && child.tagName && !SKIP.has(child.tagName)) walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  walk(tree);
  return n;
}

/** The rehype plugin form: `rehypePlugins={[wordFade]}`. */
export function wordFade() {
  return (tree: HastNode) => {
    fadeWords(tree);
  };
}
