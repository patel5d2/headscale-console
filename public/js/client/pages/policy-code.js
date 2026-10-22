// The HuJSON code editor: a textarea over a syntax-highlighted <pre>, with a line gutter.
import { clear, h } from '../ui.js';
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
/** HTML for the highlighted policy. Every piece of source text is escaped. */
export function highlight(src) {
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}[\],])/g;
    let out = '';
    let last = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        out += escapeHtml(src.slice(last, m.index));
        const [, comment, str, colon, bool, num, punct] = m;
        if (comment)
            out += `<span class="tk-c">${escapeHtml(comment)}</span>`;
        else if (str) {
            const cls = colon ? 'tk-k' : /^"(tag:|group:|autogroup:)/.test(str) ? 'tk-t' : 'tk-s';
            out += `<span class="${cls}">${escapeHtml(str)}</span>${colon ? escapeHtml(colon) : ''}`;
        }
        else if (bool)
            out += `<span class="tk-b">${bool}</span>`;
        else if (num)
            out += `<span class="tk-n">${num}</span>`;
        else
            out += `<span class="tk-p">${punct}</span>`;
        last = re.lastIndex;
    }
    return out + escapeHtml(src.slice(last)) + '\n';
}
export function createEditor(initial, onChange) {
    const gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
    const pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
    const ta = h('textarea', { class: 'ed-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Policy file editor' });
    ta.value = initial;
    const el = h('div', { class: 'editor' }, gutter, h('div', { class: 'ed-scroll' }, pre, ta));
    let errLine = null;
    const paint = () => {
        pre.innerHTML = highlight(ta.value); // escaped in highlight()
        const lines = ta.value.split('\n').length;
        if (gutter.childElementCount !== lines) {
            clear(gutter).append(...Array.from({ length: lines }, (_, i) => h('div', { class: i + 1 === errLine ? 'err' : '' }, String(i + 1))));
        }
        else {
            [...gutter.children].forEach((d, i) => d.classList.toggle('err', i + 1 === errLine));
        }
    };
    const sync = () => {
        pre.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
        gutter.scrollTop = ta.scrollTop;
    };
    ta.addEventListener('input', () => { paint(); sync(); onChange(ta.value); });
    ta.addEventListener('scroll', sync);
    ta.addEventListener('keydown', (e) => {
        const { selectionStart: s, selectionEnd: en, value } = ta;
        const lineStart = value.lastIndexOf('\n', s - 1) + 1;
        if (e.key === 'Tab') {
            e.preventDefault();
            if (s === en && !e.shiftKey)
                ta.setRangeText('  ', s, en, 'end');
            else {
                const block = value.slice(lineStart, en);
                ta.setRangeText(e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  '), lineStart, en, 'select');
            }
            ta.dispatchEvent(new Event('input'));
        }
        else if (e.key === 'Enter') {
            // Keep the current indentation; indent one more level after { or [.
            const indent = value.slice(lineStart).match(/^[ \t]*/)[0];
            const extra = value[s - 1] === '{' || value[s - 1] === '[' ? '  ' : '';
            e.preventDefault();
            ta.setRangeText('\n' + indent + extra, s, en, 'end');
            ta.dispatchEvent(new Event('input'));
        }
    });
    paint();
    return {
        el,
        get value() { return ta.value; },
        set value(v) { ta.value = v; paint(); sync(); },
        setErrorLine(l) { errLine = l; paint(); },
        focusLine(line) {
            const lines = ta.value.split('\n');
            const pos = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
            ta.focus();
            ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
            ta.scrollTop = Math.max(0, (line - 5) * (parseFloat(getComputedStyle(ta).lineHeight) || 20));
        },
        focus() { ta.focus(); },
    };
}
//# sourceMappingURL=policy-code.js.map