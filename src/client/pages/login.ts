import { h, icon, logo, button, callout, codeBlock } from '../ui.js';
import { store, hostOf } from '../util.js';

export function render(ctx, _params, root) {
  const locked = ctx.config.lockedUrl;
  const lastUrl = ctx.conn?.url || store.get('lastUrl', '');

  const urlInput = h('input', {
    class: 'input', id: 'hs-url', name: 'url', type: 'url', inputmode: 'url', autocomplete: 'url',
    placeholder: 'https://headscale.example.com', value: locked || lastUrl, spellcheck: 'false',
    readonly: !!locked, required: true,
  });
  const keyInput = h('input', {
    class: 'input mono', id: 'hs-key', name: 'key', type: 'password', autocomplete: 'off',
    placeholder: 'hskey-api-…', spellcheck: 'false', required: true,
  });
  const reveal = h('button', { type: 'button', class: 'input-addon', 'aria-label': 'Show API key', title: 'Show / hide' }, icon('eye', 16));
  reveal.addEventListener('click', () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; keyInput.focus(); });
  const remember = h('input', { type: 'checkbox', id: 'hs-remember', checked: store.get('rememberDefault', true) });
  const errBox = h('div', { class: 'login-error', 'aria-live': 'polite' });
  const submit = button('Connect', { variant: 'primary', type: 'submit', cls: 'btn-block' });

  if (ctx.loginError) { errBox.appendChild(callout('error', null, ctx.loginError)); ctx.loginError = null; }

  const form = h('form', { class: 'stack', novalidate: true },
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Headscale server URL'),
      urlInput,
      h('span', { class: 'help' }, locked
        ? 'This console is locked to this server by the HEADSCALE_URL setting.'
        : 'The public URL of your Headscale server (its server_url), including https://.')),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'API key'),
      h('div', { class: 'input-group' }, keyInput, reveal),
      h('span', { class: 'help' }, 'Create one on the server with ', h('code', 'headscale apikeys create --expiration 90d'))),
    h('label', { class: 'check' }, remember,
      h('span', h('span', { class: 'check-label' }, 'Remember me on this device'),
        h('span', { class: 'help' }, 'Stores the key in this browser. Leave unchecked on shared computers.'))),
    errBox,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.replaceChildren();
    let url = (locked || urlInput.value).trim();
    const key = keyInput.value.trim();
    if (!url) { urlInput.focus(); errBox.appendChild(callout('error', null, 'Enter your Headscale server URL.')); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    try { new URL(url); } catch { errBox.appendChild(callout('error', null, 'That doesn\'t look like a valid URL.')); return; }
    if (!key) { keyInput.focus(); errBox.appendChild(callout('error', null, 'Enter an API key.')); return; }

    submit.disabled = true;
    submit.classList.add('loading');
    try {
      store.set('rememberDefault', remember.checked);
      await ctx.connect({ url, key, remember: remember.checked });
      location.hash = '#/machines';
    } catch (err) {
      let msg = err.message;
      if (err.status === 401) msg = 'The API key was rejected. Check that it is correct and has not expired.';
      else if (err.status === 404) msg = `No Headscale API found at ${hostOf(url)}. Check the URL (it should be the server_url from your Headscale config).`;
      errBox.appendChild(callout('error', 'Could not connect', msg));
    } finally {
      submit.disabled = false;
      submit.classList.remove('loading');
    }
  });

  const card = h('div', { class: 'login-card' },
    h('div', { class: 'login-brand' }, logo(30), h('div',
      h('h1', 'Headscale Console'),
      h('p', { class: 'muted' }, 'Sign in to manage your tailnet'))),
    form);

  const help = h('details', { class: 'login-help' },
    h('summary', 'Need an API key?'),
    h('div', { class: 'stack-sm' },
      h('p', 'Run this on the machine or container where Headscale is installed:'),
      codeBlock('headscale apikeys create --expiration 90d'),
      h('p', { class: 'muted' }, 'Running Headscale in Docker? Prefix it with ', h('code', 'docker exec -it headscale'), '. The key is shown only once.')));

  root.appendChild(h('div', { class: 'login' },
    h('div', { class: 'login-inner' }, card, help,
      h('p', { class: 'login-foot muted' }, icon('lock', 12), h('span', 'Your API key is only sent to your Headscale server, via this console.')))));

  setTimeout(() => (locked || urlInput.value ? keyInput : urlInput).focus(), 50);
}
