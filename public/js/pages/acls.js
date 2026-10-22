import { h, put, icon, button, badge, callout, clear, toast, tabs, spinner, errorState, confirmDialog, modal } from '../ui.js';
import { parseHuJSON, hasComments, relTime, download, nodeTags, userLabel, lineDiff } from '../util.js';
import { TEMPLATES, SNIPPETS, mergePolicy } from './policy-library.js';
import { visualEditor, accessChecker } from './policy-editor.js';

// ------------------------------------------------------------- highlighter --
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function highlight(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}[\],])/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    if (m[1]) out += `<span class="tk-c">${escapeHtml(m[1])}</span>`;
    else if (m[2]) {
      const cls = m[3] ? 'tk-k' : (/^"(tag:|group:|autogroup:)/.test(m[2]) ? 'tk-t' : 'tk-s');
      out += `<span class="${cls}">${escapeHtml(m[2])}</span>${m[3] ? escapeHtml(m[3]) : ''}`;
    } else if (m[4]) out += `<span class="tk-b">${m[4]}</span>`;
    else if (m[5]) out += `<span class="tk-n">${m[5]}</span>`;
    else if (m[6]) out += `<span class="tk-p">${m[6]}</span>`;
    last = re.lastIndex;
  }
  out += escapeHtml(src.slice(last));
  return out + '\n';
}

// ------------------------------------------------------------------ editor --
function createEditor(initial, onChange) {
  const gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
  const pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', {
    class: 'ed-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off',
    'aria-label': 'Policy file editor',
  });
  ta.value = initial;
  const scroller = h('div', { class: 'ed-scroll' }, pre, ta);
  const el = h('div', { class: 'editor' }, gutter, scroller);
  let errLine = null;

  const paint = () => {
    pre.innerHTML = highlight(ta.value); // escaped above
    const lines = ta.value.split('\n').length;
    if (gutter.childElementCount !== lines) {
      clear(gutter);
      for (let i = 1; i <= lines; i++) gutter.appendChild(h('div', { class: i === errLine ? 'err' : '' }, String(i)));
    } else {
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
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = ta;
      if (s === en && !e.shiftKey) {
        ta.setRangeText('  ', s, en, 'end');
      } else {
        const ls = value.lastIndexOf('\n', s - 1) + 1;
        const block = value.slice(ls, en);
        const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        ta.setRangeText(next, ls, en, 'select');
      }
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
      const { selectionStart: s, value } = ta;
      const ls = value.lastIndexOf('\n', s - 1) + 1;
      const indent = value.slice(ls).match(/^\s*/)[0];
      const prev = value[s - 1];
      const extra = prev === '{' || prev === '[' ? '  ' : '';
      e.preventDefault();
      ta.setRangeText('\n' + indent + extra, s, ta.selectionEnd, 'end');
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
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, (line - 5) * lh);
    },
    focus() { ta.focus(); },
  };
}

// ------------------------------------------------------------------- page --
export async function render(ctx, _params, root) {
  let view = 'editor';
  let saved = '';
  let updatedAt = null;
  let readOnly = false;
  let editor;
  let checkTimer;

  const statusEl = h('div', { class: 'ed-status' });
  const tabBar = h('div');
  const content = h('div', h('div', { class: 'center pad-y' }, spinner(24)));

  const saveBtn = button('Save', { variant: 'primary', icon: 'check' });
  const discardBtn = button('Discard changes', { size: 'sm' });
  const formatBtn = button('Format', { size: 'sm', icon: 'code' });
  const validateBtn = button('Validate', { size: 'sm', icon: 'shield' });
  const templatesBtn = button('Templates', { size: 'sm', icon: 'file' });
  const rulesBtn = button('Add rules', { size: 'sm', icon: 'plus' });
  const downloadBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Download policy', 'aria-label': 'Download policy' }, icon('download', 17));
  const uploadBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Import from file', 'aria-label': 'Import policy file' }, icon('upload', 17));
  const fileInput = h('input', { type: 'file', accept: '.json,.hujson,.txt,application/json', hidden: true });

  root.append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Access controls'),
        h('p', { class: 'muted' }, 'Define who can reach what in your tailnet with a policy file. ',
          h('a', { href: 'https://headscale.net/stable/ref/acls/', target: '_blank', rel: 'noopener' }, 'Policy reference', icon('exit', 12)))),
      h('div', { class: 'page-actions' }, saveBtn)),
    tabBar, content, fileInput);

  const dirty = () => editor && editor.value !== saved;

  function setStatus() {
    if (!editor) return;
    clear(statusEl);
    const parsed = parseHuJSON(editor.value);
    editor.setErrorLine(parsed.ok ? null : parsed.line);
    if (!parsed.ok) {
      put(statusEl, h('span', { class: 'ed-state error' }, icon('alert', 14), ' ', parsed.line ? `Syntax error on line ${parsed.line}` : 'Syntax error'),
        parsed.line ? h('button', { class: 'link-btn', type: 'button', onclick: () => editor.focusLine(parsed.line) }, 'Go to line') : null,
        h('span', { class: 'muted small ed-msg' }, parsed.error));
    } else if (dirty()) {
      statusEl.append(h('span', { class: 'ed-state warn' }, h('span', { class: 'dot dot-warn' }), 'Unsaved changes'));
    } else {
      statusEl.append(h('span', { class: 'ed-state ok' }, icon('check', 14), ' ',
        updatedAt ? `Saved · last updated ${relTime(updatedAt)}` : (saved ? 'Saved' : 'No policy set — all traffic is allowed')));
    }
    saveBtn.disabled = readOnly || !dirty() || !parsed.ok;
    discardBtn.disabled = !dirty();
  }

  async function serverCheck(text, quiet) {
    const r = await ctx.api.checkPolicy(text);
    if (!quiet) {
      if (r.unsupported) toast('This Headscale version cannot validate without saving.', 'info');
      else if (r.ok) toast('Policy is valid', 'success');
    }
    return r;
  }

  async function save() {
    const text = editor.value;
    const parsed = parseHuJSON(text);
    if (!parsed.ok) { toast('Fix the syntax error first', 'error'); return; }
    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    try {
      const r = await ctx.api.setPolicy(text);
      saved = r.policy ?? text;
      updatedAt = r.updatedAt || new Date().toISOString();
      if (editor.value !== saved) editor.value = saved;
      toast('Policy saved and applied', 'success');
    } catch (e) {
      const errBox = h('div', { class: 'stack' },
        callout('error', 'Headscale rejected the policy', e.message),
        /file|mode/i.test(e.message) ? callout('info', 'Policy is managed by a file',
          h('span', 'Set ', h('code', 'policy.mode: database'), ' in your Headscale config to edit the policy from this console.')) : null);
      modal({ title: 'Policy not saved', size: 'md', body: errBox, footer: (api) => [button('OK', { variant: 'primary', onClick: () => api.close() })] });
    } finally {
      saveBtn.classList.remove('loading');
      setStatus();
    }
  }

  function chooseTemplate() {
    modal({
      title: 'Start from a template',
      subtitle: 'Replaces the editor contents. Nothing is applied until you save.',
      size: 'md',
      body: (api) => h('div', { class: 'template-list' }, Object.values(TEMPLATES).map((t) =>
        h('button', {
          class: 'template', type: 'button',
          onclick: async () => {
            if (editor.value.trim() && editor.value !== t.text) {
              const ok = await confirmDialog({ title: 'Replace current policy?', message: 'Your unsaved edits in the editor will be replaced.', confirmLabel: 'Replace' });
              if (!ok) return;
            }
            editor.value = t.text;
            setStatus();
            api.close();
            view = 'editor';
            draw();
          },
        }, h('strong', t.name), h('span', { class: 'muted small' }, t.desc)))),
      footer: [],
    });
  }

  function chooseSnippet() {
    modal({
      title: 'Add prebuilt rules',
      subtitle: 'Merged into the policy in the editor. Nothing is applied until you save.',
      size: 'md',
      body: (api) => h('div', { class: 'template-list' }, SNIPPETS.map((s) =>
        h('button', { class: 'template', type: 'button', onclick: async () => { if (await addSnippet(s)) api.close(); } },
          h('strong', s.name), h('span', { class: 'muted small' }, s.desc)))),
      footer: [],
    });
  }

  async function addSnippet(s) {
    const parsed = parseHuJSON(editor.value.trim() ? editor.value : '{}');
    const base = parsed.ok ? parsed.value ?? {} : null;
    if (!base || typeof base !== 'object' || Array.isArray(base)) { toast('Fix the policy\'s syntax before adding rules', 'error'); return false; }
    if (hasComments(editor.value)) {
      const ok = await confirmDialog({ title: 'Remove comments?', message: 'Adding rules rewrites the policy as plain JSON, which removes comments. Download a copy first to keep them.', confirmLabel: 'Add anyway' });
      if (!ok) return false;
    }
    const u = (ctx.data.users || [])[0];
    const admin = u ? (u.name.includes('@') ? u.name : `${u.name}@`) : 'admin@';
    editor.value = JSON.stringify(mergePolicy(base, s.make(admin)), null, 2) + '\n';
    view = 'editor';
    draw();
    toast(`Added "${s.name}" — review and save to apply`, 'success');
    return true;
  }

  saveBtn.addEventListener('click', save);
  rulesBtn.addEventListener('click', chooseSnippet);
  discardBtn.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Discard changes?', message: 'Your edits will be lost.', confirmLabel: 'Discard', danger: true })) {
      editor.value = saved; setStatus();
    }
  });
  formatBtn.addEventListener('click', async () => {
    const parsed = parseHuJSON(editor.value);
    if (!parsed.ok) { toast('Fix the syntax error before formatting', 'error'); return; }
    if (hasComments(editor.value)) {
      const ok = await confirmDialog({ title: 'Remove comments?', message: 'Formatting rewrites the policy as plain JSON, which removes comments.', confirmLabel: 'Format anyway' });
      if (!ok) return;
    }
    editor.value = JSON.stringify(parsed.value, null, 2) + '\n';
    setStatus();
  });
  validateBtn.addEventListener('click', async () => {
    const parsed = parseHuJSON(editor.value);
    if (!parsed.ok) { toast(`Syntax error${parsed.line ? ' on line ' + parsed.line : ''}`, 'error'); editor.focusLine(parsed.line || 1); return; }
    validateBtn.classList.add('loading');
    const r = await serverCheck(editor.value);
    validateBtn.classList.remove('loading');
    if (!r.ok) {
      modal({ title: 'Policy has errors', size: 'md', body: callout('error', null, r.error), footer: (api) => [button('OK', { variant: 'primary', onClick: () => api.close() })] });
    }
  });
  templatesBtn.addEventListener('click', chooseTemplate);
  downloadBtn.addEventListener('click', () => download('policy.hujson', editor.value));
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    editor.value = await f.text();
    fileInput.value = '';
    setStatus();
    toast(`Loaded ${f.name} — review and save to apply`, 'info');
  });

  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!saveBtn.disabled) save();
    }
  };
  const onUnload = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onUnload);

  function draw() {
    clear(tabBar).appendChild(tabs([
      { id: 'editor', label: 'Policy file', icon: 'code' },
      { id: 'visual', label: 'Visual editor', icon: 'edit' },
      { id: 'check', label: 'Access checker', icon: 'shield' },
      { id: 'preview', label: 'Preview rules', icon: 'eye' },
      { id: 'tags', label: 'Tags', icon: 'tag' },
      { id: 'changes', label: 'Changes', icon: 'file' },
    ], view, (v) => { view = v; draw(); }));
    clear(content);
    if (view === 'editor') {
      put(content,
        readOnly ? callout('info', 'Read-only', 'This server loads its policy from a file, so it can only be viewed here.') : null,
        h('div', { class: 'editor-card' },
          h('div', { class: 'editor-toolbar' }, statusEl,
            h('div', { class: 'row-gap' }, rulesBtn, templatesBtn, formatBtn, validateBtn, discardBtn, uploadBtn, downloadBtn)),
          editor.el),
        h('p', { class: 'help mt-2' }, 'HuJSON: comments and trailing commas are allowed. Press ', h('kbd', 'Ctrl'), '+', h('kbd', 'S'), ' to save.'));
      setStatus();
    } else if (view === 'visual') {
      content.appendChild(visualEditor(ctx, { get: () => editor.value, set: (t) => { editor.value = t; setStatus(); }, readOnly }));
    } else if (view === 'check') {
      content.appendChild(accessChecker(ctx, editor.value));
    } else if (view === 'changes') {
      content.appendChild(changesView(saved, editor.value));
    } else if (view === 'preview') {
      content.appendChild(preview(ctx, editor.value));
    } else {
      content.appendChild(tagsView(ctx, editor.value));
    }
  }

  try {
    const [p] = await Promise.all([ctx.api.getPolicy(), ctx.load()]);
    saved = p.policy || '';
    updatedAt = p.updatedAt && !p.empty ? p.updatedAt : null;
    editor = createEditor(saved || '', () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(setStatus, 120);
    });
    if (p.empty) {
      content.replaceChildren();
    }
    draw();
    if (p.empty) {
      content.prepend(callout('info', 'No policy yet',
        h('span', 'Without a policy every device can reach every other device. ',
          h('button', { class: 'link-btn', type: 'button', onclick: chooseTemplate }, 'Start from a template'), '.')));
    }
  } catch (e) {
    clear(content).appendChild(errorState(e));
  }

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    clearTimeout(checkTimer);
  };
}

// --------------------------------------------------------------- preview --
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function chipList(items) {
  return h('div', { class: 'badges' }, asArr(items).map((s) => badge(String(s), /^(tag:|group:|autogroup:)/.test(s) ? 'tag' : 'neutral')));
}

function preview(ctx, text) {
  const parsed = parseHuJSON(text);
  if (!text.trim()) return callout('info', 'No policy', 'With no policy, all devices can reach each other.');
  if (!parsed.ok) return callout('error', 'Can\'t preview', `The policy has a syntax error${parsed.line ? ` on line ${parsed.line}` : ''}.`);
  const p = parsed.value || {};
  const users = ctx.data.users || [];
  const groups = p.groups || {};

  // "Show rules for" filter
  const sel = h('select', { class: 'input input-sm' },
    h('option', { value: '' }, 'Everyone'),
    h('optgroup', { label: 'Users' }, users.map((u) => h('option', { value: 'u:' + u.name }, userLabel(u)))),
    Object.keys(p.tagOwners || {}).length ? h('optgroup', { label: 'Tags' }, Object.keys(p.tagOwners).map((t) => h('option', { value: 't:' + t }, t))) : null);
  const body = h('div', { class: 'stack' });

  const appliesTo = (src) => {
    const v = sel.value;
    if (!v) return true;
    const list = asArr(src);
    if (list.includes('*')) return true;
    if (v.startsWith('u:')) {
      const name = v.slice(2);
      const u = users.find((x) => x.name === name);
      const ids = [name, `${name}@`, u?.email].filter(Boolean);
      return list.some((s) => ids.includes(s) || s === 'autogroup:member' ||
        (s.startsWith('group:') && asArr(groups[s]).some((m) => ids.includes(m))));
    }
    const tag = v.slice(2);
    return list.some((s) => s === tag || s === 'autogroup:tagged');
  };

  const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table table-top' },
    h('thead', h('tr', head.map((x) => h('th', x)))), h('tbody', rows)));

  const draw = () => {
    clear(body);
    const acls = asArr(p.acls).filter((r) => appliesTo(r.src));
    const grants = asArr(p.grants).filter((r) => appliesTo(r.src));
    const ssh = asArr(p.ssh).filter((r) => appliesTo(r.src));

    body.appendChild(h('div', { class: 'stat-row' },
      stat('ACL rules', asArr(p.acls).length), stat('Grants', asArr(p.grants).length), stat('SSH rules', asArr(p.ssh).length),
      stat('Groups', Object.keys(groups).length), stat('Tags', Object.keys(p.tagOwners || {}).length), stat('Hosts', Object.keys(p.hosts || {}).length)));

    body.appendChild(section('Network access rules', acls.length
      ? table(['#', 'Source', 'Destination', 'Protocol'], acls.map((r, i) => h('tr',
        h('td', { class: 'muted' }, i + 1), h('td', chipList(r.src)), h('td', chipList(r.dst)), h('td', r.proto || h('span', { class: 'muted' }, 'any')))))
      : h('p', { class: 'help' }, sel.value ? 'No ACL rules apply.' : 'No ACL rules defined.')));

    if (asArr(p.grants).length) {
      body.appendChild(section('Grants', grants.length
        ? table(['#', 'Source', 'Destination', 'Access'], grants.map((r, i) => h('tr',
          h('td', { class: 'muted' }, i + 1), h('td', chipList(r.src)), h('td', chipList(r.dst)),
          h('td', r.ip ? chipList(r.ip) : null, r.app ? h('div', { class: 'muted small' }, 'app: ' + Object.keys(r.app).join(', ')) : null,
            r.via ? h('div', { class: 'muted small' }, 'via: ' + asArr(r.via).join(', ')) : null))))
        : h('p', { class: 'help' }, 'No grants apply.')));
    }

    body.appendChild(section('Tailscale SSH', ssh.length
      ? table(['Action', 'Source', 'Destination', 'As users'], ssh.map((r) => h('tr',
        h('td', badge(r.action || 'accept', r.action === 'check' ? 'warning' : 'success')), h('td', chipList(r.src)), h('td', chipList(r.dst)), h('td', chipList(r.users)))))
      : h('p', { class: 'help' }, 'No SSH rules.')));

    if (Object.keys(groups).length) {
      body.appendChild(section('Groups', table(['Group', 'Members'], Object.entries(groups).map(([g, m]) => h('tr', h('td', { class: 'mono' }, g), h('td', chipList(m)))))));
    }
    if (Object.keys(p.hosts || {}).length) {
      body.appendChild(section('Hosts', table(['Name', 'Address'], Object.entries(p.hosts).map(([n, a]) => h('tr', h('td', { class: 'mono' }, n), h('td', { class: 'mono' }, a))))));
    }
    const aa = p.autoApprovers || {};
    const aaRows = [
      ...Object.entries(aa.routes || {}).map(([r, who]) => h('tr', h('td', { class: 'mono' }, r), h('td', chipList(who)))),
      ...(aa.exitNode ? [h('tr', h('td', 'Exit node'), h('td', chipList(aa.exitNode)))] : []),
    ];
    if (aaRows.length) body.appendChild(section('Auto approvers', table(['Route', 'Approved for'], aaRows)));
    if (asArr(p.nodeAttrs).length) {
      body.appendChild(section('Node attributes', table(['Target', 'Attributes'], asArr(p.nodeAttrs).map((r) => h('tr', h('td', chipList(r.target)), h('td', chipList(r.attr)))))));
    }
  };
  sel.addEventListener('change', draw);
  draw();
  return h('div', { class: 'stack' },
    h('div', { class: 'toolbar' }, h('label', { class: 'inline-label' }, 'Show rules for', sel),
      h('span', { class: 'muted small' }, 'Preview of the policy in the editor (including unsaved changes).')),
    body);
}

// Unsaved edits as a diff against the saved policy, with 3 lines of context.
function changesView(saved, current) {
  if (saved === current) return callout('info', 'No changes', 'The editor matches the saved policy.');
  const d = lineDiff(saved, current);
  if (!d) return callout('info', 'Too large to compare here', 'Download the policy to compare it locally.');
  const near = (k) => d.slice(Math.max(0, k - 3), k + 4).some((x) => x.op !== ' ');
  const rows = [];
  let gap = false;
  d.forEach((r, k) => {
    if (!near(k)) { if (!gap) rows.push(h('div', { class: 'diff-gap' }, '⋯')); gap = true; return; }
    gap = false;
    rows.push(h('div', { class: `diff-line diff-${{ '+': 'add', '-': 'del', ' ': 'ctx' }[r.op]}` }, `${r.op} ${r.line}`));
  });
  const count = (op) => d.filter((r) => r.op === op).length;
  return h('div', { class: 'stack' },
    h('p', { class: 'help' }, `${count('+')} lines added and ${count('-')} removed, compared with the saved policy. Nothing is applied until you save.`),
    h('div', { class: 'diff' }, rows));
}

function stat(label, n) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));
}
function section(title, el) {
  return h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', title)), el);
}

function tagsView(ctx, text) {
  const parsed = parseHuJSON(text || '{}');
  const owners = parsed.ok ? parsed.value?.tagOwners || {} : {};
  const nodes = ctx.data.nodes || [];
  const inUse = new Map();
  for (const n of nodes) for (const t of nodeTags(n)) inUse.set(t, (inUse.get(t) || 0) + 1);
  const all = [...new Set([...Object.keys(owners), ...inUse.keys()])].sort();
  if (!all.length) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('tag', 22)), h('div', { class: 'empty-title' }, 'No tags defined'),
      h('div', { class: 'empty-text' }, 'Add tags under "tagOwners" in the policy file, then assign them to machines.'));
  }
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', h('tr', h('th', 'Tag'), h('th', 'Owners'), h('th', 'Machines'))),
    h('tbody', all.map((t) => h('tr',
      h('td', badge(t, 'tag')),
      h('td', owners[t] ? chipList(owners[t]) : h('span', { class: 'badge badge-warning', title: 'In use on a machine but not defined in tagOwners' }, 'Not in policy')),
      h('td', inUse.get(t) ? h('a', { href: '#/machines', onclick: (e) => { e.preventDefault(); sessionStorage.setItem('hsconsole:machines.q', JSON.stringify(t)); ctx.navigate('#/machines'); } }, `${inUse.get(t)} machine${inUse.get(t) === 1 ? '' : 's'}`) : h('span', { class: 'muted' }, 'None')))))));
}

