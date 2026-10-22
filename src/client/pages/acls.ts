// Access controls: the policy file editor plus visual editor, access checker, previews,
// changes and history. Every view works on the editor's text; Save applies it.
import { mergePolicy, SNIPPETS, TEMPLATES, type Snippet } from '../../shared/policy-library.js';
import type { Policy } from '../../shared/types.js';
import type { Ctx } from '../types.js';
import { button, callout, clear, confirmDialog, errorState, h, icon, modal, put, spinner, tabs, toast } from '../ui.js';
import { download, hasComments, parseHuJSON, relTime, userRef } from '../util.js';
import { createEditor, type CodeEditor } from './policy-code.js';
import { accessChecker, visualEditor } from './policy-editor.js';
import { historyView } from './policy-history.js';
import { diffView, preview, tagsView } from './policy-views.js';

type View = 'editor' | 'visual' | 'check' | 'preview' | 'tags' | 'changes' | 'history';

export async function render(ctx: Ctx, _params: unknown, root: HTMLElement): Promise<() => void> {
  let view: View = 'editor';
  let saved = '';
  let updatedAt: string | null = null;
  let editor: CodeEditor | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  const readOnly = false; // Headscale's file mode is reported when saving fails

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
  const fileInput = h('input', { type: 'file', accept: '.json,.hujson,.txt,application/json', hidden: true, 'aria-label': 'Policy file to import' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Access controls'),
        h('p', { class: 'muted' }, 'Define who can reach what in your tailnet with a policy file. ',
          h('a', { href: 'https://headscale.net/stable/ref/acls/', target: '_blank', rel: 'noopener' }, 'Policy reference', icon('exit', 12)))),
      h('div', { class: 'page-actions' }, saveBtn)),
    tabBar, content, fileInput);

  const ed = (): CodeEditor => editor!;
  const dirty = (): boolean => !!editor && editor.value !== saved;

  function setStatus(): void {
    if (!editor) return;
    clear(statusEl);
    // A blank editor is "no policy", not a syntax error (it just can't be saved).
    const blank = !editor.value.trim();
    const parsed = blank ? { ok: true as const } : parseHuJSON(editor.value);
    editor.setErrorLine(parsed.ok ? null : parsed.line);
    if (!parsed.ok) {
      put(statusEl, h('span', { class: 'ed-state error' }, icon('alert', 14), ' ', parsed.line ? `Syntax error on line ${parsed.line}` : 'Syntax error'),
        parsed.line ? h('button', { class: 'link-btn', type: 'button', onclick: () => ed().focusLine(parsed.line!) }, 'Go to line') : null,
        h('span', { class: 'muted small ed-msg' }, parsed.error));
    } else if (dirty()) {
      statusEl.append(h('span', { class: 'ed-state warn' }, h('span', { class: 'dot dot-warn' }), 'Unsaved changes'));
    } else {
      statusEl.append(h('span', { class: 'ed-state ok' }, icon('check', 14), ' ',
        updatedAt ? `Saved · last updated ${relTime(updatedAt)}` : (saved ? 'Saved' : 'No policy set — all traffic is allowed')));
    }
    saveBtn.disabled = readOnly || !dirty() || !parsed.ok || blank;
    discardBtn.disabled = !dirty();
  }

  function setText(text: string): void {
    ed().value = text;
    setStatus();
  }

  async function save(): Promise<void> {
    const text = ed().value;
    if (!parseHuJSON(text).ok) { toast('Fix the syntax error first', 'error'); return; }
    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    try {
      const r = await ctx.api.setPolicy(text);
      saved = r.policy ?? text;
      updatedAt = r.updatedAt || new Date().toISOString();
      if (ed().value !== saved) ed().value = saved;
      toast('Policy saved and applied', 'success');
    } catch (e) {
      const msg = (e as Error).message;
      modal({
        title: 'Policy not saved', size: 'md',
        body: h('div', { class: 'stack' },
          callout('error', 'Headscale rejected the policy', msg),
          /file|mode/i.test(msg) ? callout('info', 'Policy is managed by a file',
            h('span', 'Set ', h('code', 'policy.mode: database'), ' in your Headscale config to edit the policy from this console.')) : null),
        footer: (api) => [button('OK', { variant: 'primary', onClick: () => api.close() })],
      });
    } finally {
      saveBtn.classList.remove('loading');
      setStatus();
    }
  }

  function chooseTemplate(): void {
    modal({
      title: 'Start from a template',
      subtitle: 'Replaces the editor contents. Nothing is applied until you save.',
      size: 'md',
      body: (api) => h('div', { class: 'template-list' }, Object.values(TEMPLATES).map((t) =>
        h('button', {
          class: 'template', type: 'button',
          onclick: async () => {
            if (ed().value.trim() && ed().value !== t.text) {
              const ok = await confirmDialog({ title: 'Replace current policy?', message: 'Your unsaved edits in the editor will be replaced.', confirmLabel: 'Replace' });
              if (!ok) return;
            }
            setText(t.text);
            api.close();
            view = 'editor';
            draw();
          },
        }, h('strong', t.name), h('span', { class: 'muted small' }, t.desc)))),
      footer: [],
    });
  }

  async function addSnippet(s: Snippet): Promise<boolean> {
    const parsed = parseHuJSON<Policy>(ed().value.trim() ? ed().value : '{}');
    const base = parsed.ok ? parsed.value : null;
    if (!base || typeof base !== 'object' || Array.isArray(base)) { toast('Fix the policy\'s syntax before adding rules', 'error'); return false; }
    if (hasComments(ed().value)) {
      const ok = await confirmDialog({ title: 'Remove comments?', message: 'Adding rules rewrites the policy as plain JSON, which removes comments. Download a copy first to keep them.', confirmLabel: 'Add anyway' });
      if (!ok) return false;
    }
    const u = (ctx.data.users || [])[0];
    setText(JSON.stringify(mergePolicy(base, s.make(u ? userRef(u) : 'admin@')), null, 2) + '\n');
    view = 'editor';
    draw();
    toast(`Added "${s.name}" — review and save to apply`, 'success');
    return true;
  }

  saveBtn.addEventListener('click', () => void save());
  rulesBtn.addEventListener('click', () => modal({
    title: 'Add prebuilt rules',
    subtitle: 'Merged into the policy in the editor. Nothing is applied until you save.',
    size: 'md',
    body: (api) => h('div', { class: 'template-list' }, SNIPPETS.map((s) =>
      h('button', { class: 'template', type: 'button', onclick: async () => { if (await addSnippet(s)) api.close(); } },
        h('strong', s.name), h('span', { class: 'muted small' }, s.desc)))),
    footer: [],
  }));
  discardBtn.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Discard changes?', message: 'Your edits will be lost.', confirmLabel: 'Discard', danger: true })) setText(saved);
  });
  formatBtn.addEventListener('click', async () => {
    const parsed = parseHuJSON(ed().value);
    if (!parsed.ok) { toast('Fix the syntax error before formatting', 'error'); return; }
    if (hasComments(ed().value)) {
      const ok = await confirmDialog({ title: 'Remove comments?', message: 'Formatting rewrites the policy as plain JSON, which removes comments.', confirmLabel: 'Format anyway' });
      if (!ok) return;
    }
    setText(JSON.stringify(parsed.value, null, 2) + '\n');
  });
  validateBtn.addEventListener('click', async () => {
    const parsed = parseHuJSON(ed().value);
    if (!parsed.ok) { toast(`Syntax error${parsed.line ? ' on line ' + parsed.line : ''}`, 'error'); ed().focusLine(parsed.line || 1); return; }
    validateBtn.classList.add('loading');
    const r = await ctx.api.checkPolicy(ed().value);
    validateBtn.classList.remove('loading');
    if (r.unsupported) toast('This Headscale version cannot validate without saving.', 'info');
    else if (r.ok) toast('Policy is valid', 'success');
    else modal({ title: 'Policy has errors', size: 'md', body: callout('error', null, r.error), footer: (api) => [button('OK', { variant: 'primary', onClick: () => api.close() })] });
  });
  templatesBtn.addEventListener('click', chooseTemplate);
  downloadBtn.addEventListener('click', () => download('policy.hujson', ed().value));
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    setText(await f.text());
    fileInput.value = '';
    toast(`Loaded ${f.name} — review and save to apply`, 'info');
  });

  const onKey = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!saveBtn.disabled) void save();
    }
  };
  const onUnload = (e: BeforeUnloadEvent): void => { if (dirty()) e.preventDefault(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onUnload);

  function draw(): void {
    clear(tabBar).appendChild(tabs<View>([
      { id: 'editor', label: 'Policy file', icon: 'code' },
      { id: 'visual', label: 'Visual editor', icon: 'edit' },
      { id: 'check', label: 'Access checker', icon: 'shield' },
      { id: 'preview', label: 'Preview rules', icon: 'eye' },
      { id: 'tags', label: 'Tags', icon: 'tag' },
      { id: 'changes', label: 'Changes', icon: 'file' },
      { id: 'history', label: 'History', icon: 'history' },
    ], view, (v) => { view = v; draw(); }));
    clear(content);
    const text = ed().value;
    switch (view) {
      case 'editor':
        content.append(
          h('div', { class: 'editor-card' },
            h('div', { class: 'editor-toolbar' }, statusEl, h('div', { class: 'row-gap' }, rulesBtn, templatesBtn, formatBtn, validateBtn, discardBtn, uploadBtn, downloadBtn)),
            ed().el),
          h('p', { class: 'help mt-2' }, 'HuJSON: comments and trailing commas are allowed. Press ', h('kbd', 'Ctrl'), '+', h('kbd', 'S'), ' to save.'));
        setStatus();
        break;
      case 'visual': content.append(visualEditor(ctx, { get: () => ed().value, set: setText, readOnly })); break;
      case 'check': content.append(accessChecker(ctx, text)); break;
      case 'preview': content.append(preview(ctx, text)); break;
      case 'tags': content.append(tagsView(ctx, text)); break;
      case 'changes': content.append(diffView(saved, text, { what: 'the saved policy. Nothing is applied until you save' })); break;
      case 'history':
        content.append(historyView(ctx, {
          get: () => ed().value,
          restore: (t, label) => { setText(t); view = 'editor'; draw(); toast(`Restored the version from ${label} — save to apply it`, 'success'); },
        }));
        break;
    }
  }

  try {
    const [p] = await Promise.all([ctx.api.getPolicy(), ctx.load()]);
    saved = p.policy || '';
    updatedAt = p.updatedAt && !p.empty ? p.updatedAt : null;
    editor = createEditor(saved, () => { clearTimeout(checkTimer); checkTimer = setTimeout(setStatus, 120); });
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
