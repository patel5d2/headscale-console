import { h, button, copyable, callout, codeBlock, clear, toast, errorState, statusDot, emptyState } from '../ui.js';
import { nodeName, nodeIPv4, nodeIPv6 } from '../util.js';
export async function render(ctx, _params, root) {
    const tableHost = h('div');
    const domainInput = h('input', {
        class: 'input mono', placeholder: 'tail.example.com', value: ctx.prefs.baseDomain, spellcheck: 'false', 'aria-label': 'MagicDNS base domain',
    });
    const saveDomain = button('Save', { variant: 'primary', size: 'sm' });
    saveDomain.addEventListener('click', () => {
        const v = domainInput.value.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
        if (v && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) {
            toast('Enter a valid domain, e.g. tail.example.com', 'error');
            return;
        }
        ctx.prefs.baseDomain = v;
        domainInput.value = v;
        toast(v ? 'Base domain saved' : 'Base domain cleared', 'success');
        drawTable();
    });
    root.append(h('div', { class: 'page-head' }, h('div', h('h1', 'DNS'), h('p', { class: 'muted' }, 'MagicDNS names, nameservers and split DNS for your tailnet.'))), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'MagicDNS')), h('div', { class: 'card-body stack' }, h('p', { class: 'help' }, 'MagicDNS gives every machine a name like ', h('code', 'machine.your-base-domain'), '. Headscale serves these names to clients; the base domain comes from ', h('code', 'dns.base_domain'), ' in your Headscale config.'), h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Tailnet DNS name (base domain)'), h('div', { class: 'inline-form' }, domainInput, saveDomain), h('span', { class: 'help' }, 'Enter the same value as dns.base_domain so the console can show full machine names. Headscale\'s API doesn\'t expose it, so it\'s stored in this browser.')))), h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', 'Machine names')), tableHost), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Nameservers, split DNS & records')), h('div', { class: 'card-body stack' }, callout('info', 'Managed in the Headscale config file', 'Unlike Tailscale SaaS, Headscale reads global nameservers, split DNS, search domains and extra records from config.yaml rather than the API. Edit the dns block and restart Headscale (extra_records_path is reloaded live).'), h('p', { class: 'help' }, 'Example ', h('code', 'dns'), ' block for config.yaml:'), codeBlock(dnsSnippet(ctx.prefs.baseDomain)), h('p', { class: 'help' }, 'Point a split-DNS domain at your Pi-hole or internal resolver to resolve LAN names over the tailnet, and use extra records to give services friendly names.'))));
    function drawTable() {
        const nodes = (ctx.data.nodes || []).slice().sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
        const base = ctx.prefs.baseDomain;
        clear(tableHost);
        if (!nodes.length) {
            tableHost.appendChild(emptyState('dns', 'No machines', 'Machine names will appear here once devices join.'));
            return;
        }
        tableHost.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', h('tr', h('th', 'Name'), h('th', 'IPv4'), h('th', { class: 'hide-sm' }, 'IPv6'))), h('tbody', nodes.map((n) => h('tr', h('td', h('span', { class: 'seen' }, statusDot(n.online), copyable(base ? `${nodeName(n)}.${base}` : nodeName(n)))), h('td', nodeIPv4(n) ? copyable(nodeIPv4(n)) : '—'), h('td', { class: 'hide-sm' }, nodeIPv6(n) ? copyable(nodeIPv6(n)) : '—')))))));
        if (!base)
            tableHost.prepend(callout('info', null, 'Set your base domain above to show fully qualified names.'));
    }
    domainInput.addEventListener('keydown', (e) => { if (e.key === 'Enter')
        saveDomain.click(); });
    try {
        await ctx.load();
        drawTable();
    }
    catch (e) {
        tableHost.appendChild(errorState(e));
    }
}
function dnsSnippet(base) {
    return `dns:
  magic_dns: true
  base_domain: ${base || 'tail.example.com'}
  override_local_dns: true
  nameservers:
    global:
      - 1.1.1.1
      - 1.0.0.1
    split:
      # Resolve home.lan through a resolver on your LAN (e.g. Pi-hole)
      home.lan:
        - 192.168.0.2
  search_domains: []
  extra_records:
    - name: "grafana.${base || 'tail.example.com'}"
      type: "A"
      value: "100.64.0.3"`;
}
//# sourceMappingURL=dns.js.map