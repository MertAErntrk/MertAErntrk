const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'profile-content.json'), 'utf8'));
const portrait = fs.readFileSync(path.join(root, 'assets/avatar2-500.png')).toString('base64');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const palettes = {
  dark: { bg: '#0B0F14', fg: '#E6EDF3', muted: '#A8B3C1', accent: '#22D3EE', border: '#34414E', empty: '#111820' },
  light: { bg: '#F8FAFC', fg: '#0F172A', muted: '#475569', accent: '#0E7490', border: '#B6C4D0', empty: '#EAF0F4' },
};

function svg(theme, mobile) {
  const c = palettes[theme];
  const width = mobile ? 320 : 960;
  const height = mobile ? 462 : 352;
  const size = mobile ? 192 : 224;
  const x = mobile ? 64 : 32;
  const y = mobile ? 64 : 76;
  const roleSize = mobile ? 22 : 24;
  const role = profile.roles[0];
  const roleWidth = Number((role.length * roleSize * .6).toFixed(2));
  const tx = mobile ? 20 : 300;
  const roleY = mobile ? 320 : 140;
  const text = (x, y, value, cls, size) => '<text x="' + x + '" y="' + y + '" class="' + cls + '" font-size="' + size + '">' + esc(value) + '</text>';
  const nameSize = mobile ? 26 : 40;
  const bodySize = mobile ? 18 : 22;
  const metaSize = mobile ? 14 : 16;
  // Whole glyphs keep proportional fonts intact; every row shares the scan clock.
  const rows = [
    { id: 'name', y: (mobile ? 303 : 118) - nameSize, baseline: nameSize, size: nameSize, cls: 'name', value: profile.name },
    { id: 'role', y: roleY, baseline: 26, size: roleSize, cls: 'role mono', value: role },
    { id: 'summary-1', y: (mobile ? 390 : 223) - bodySize, baseline: bodySize, size: bodySize, cls: 'body', value: mobile ? 'Data pipelines, lakehouse' : 'Data pipelines, lakehouse design' },
    { id: 'summary-2', y: (mobile ? 416 : 251) - bodySize, baseline: bodySize, size: bodySize, cls: 'body', value: mobile ? 'design and LLM applications.' : 'and LLM applications.' },
    { id: 'meta', y: (mobile ? 445 : 328) - metaSize, baseline: metaSize, size: metaSize, cls: 'mono muted', value: mobile ? '@MertAErntrk' : 'T\u00fcrkiye / @MertAErntrk' },
  ];
  const glyphTiming = (index, count) => {
    const progress = 15.5 * index / Math.max(1, count - 1);
    return { on: Number((.5 + progress).toFixed(6)), off: Number((84 - progress).toFixed(6)) };
  };
  const glyphs = rows.flatMap(row => Array.from(row.value, (_, index) => ({ id: row.id + '-' + index, ...glyphTiming(index, Array.from(row.value).length) })));
  const typedText = row => '<text xml:space="preserve" x="' + (row.id === 'role' ? 20 : 0) + '" y="' + row.baseline + '" class="typed-line ' + row.cls + '" font-size="' + row.size + '"' +
    (row.id === 'role' ? ' textLength="' + roleWidth + '" lengthAdjust="spacingAndGlyphs"' : '') + '>' +
    Array.from(row.value, (char, index) => '<tspan class="motion typed-char char-' + row.id + '-' + index + '">' + esc(char) + '</tspan>').join('') + '</text>';
  const roleGlyphs = Array.from(role, (_, index) => ({ index, ...glyphTiming(index, role.length) }));
  const caretAt = count => 'transform:translateX(' + Number((roleWidth * count / role.length).toFixed(6)) + 'px)';

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" id="still" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="title desc">',
    '<title id="title">' + esc(profile.name + ' - ' + role) + '</title>',
    '<desc id="desc">Data pipelines, lakehouse design and LLM applications. A downward scan reveals the stationary portrait while the name, role, description and handle are typed letter by letter in parallel. The upward scan erases all text in parallel, from the last letter to the first, leaving a faint portrait silhouette.</desc>',
    '<style>',
    'text{font-family:Arial,Helvetica,sans-serif;letter-spacing:0;fill:' + c.fg + '}',
    '.name{font-weight:700}.role,.prompt{fill:' + c.accent + '}.body,.muted{fill:' + c.muted + '}',
    '.mono{font-family:Consolas,"Courier New",monospace}',
    '.motion{transform:none;transform-origin:0 0}.typed-char{visibility:visible}.portrait-image{transform:none}.scan-line,.type-cursor{display:none}',
    // The mask changes coverage while the portrait stays in the same position.
    '@keyframes portrait-scan{0%{transform:scaleY(0)}16%,68%{transform:scaleY(1)}84%,100%{transform:scaleY(0)}}',
    '@keyframes scanner{0%{transform:translateY(0);visibility:visible}15.999%{transform:translateY(' + size + 'px);visibility:visible}16%,67.999%{transform:translateY(' + size + 'px);visibility:hidden}68%{transform:translateY(' + size + 'px);visibility:visible}83.999%{transform:translateY(0);visibility:visible}84%,100%{transform:translateY(0);visibility:hidden}}',
    ...glyphs.map(glyph => '@keyframes glyph-' + glyph.id + '{0%{visibility:hidden}' + glyph.on + '%{visibility:visible}' + glyph.off + '%,100%{visibility:hidden}}'),
    '@keyframes role-status{0%,84%,100%{visibility:hidden}.5%{visibility:visible}}',
    '@keyframes caret-travel{0%{' + caretAt(0) + '}' + roleGlyphs.map(glyph => glyph.on + '%{' + caretAt(glyph.index + 1) + '}').join('') + roleGlyphs.slice().reverse().map(glyph => glyph.off + '%{' + caretAt(glyph.index) + '}').join('') + '100%{' + caretAt(0) + '}}',
    '@keyframes caret-blink{0%,49.999%{transform:scaleY(1)}50%,100%{transform:scaleY(0)}}',
    '@media(prefers-reduced-motion:no-preference){',
    '.portrait-window{animation:portrait-scan 10s linear infinite}.scan-line{display:block;animation:scanner 10s linear infinite}',
    ...glyphs.map(glyph => '.char-' + glyph.id + '{animation:glyph-' + glyph.id + ' 10s step-end infinite}'),
    '.type-status{animation:role-status 10s step-end infinite}',
    '.type-cursor{display:block}.cursor-travel{animation:caret-travel 10s step-end infinite}',
    '.cursor-blink{animation:caret-blink 1s steps(1,end) infinite}',
    '}',
    '@media(prefers-reduced-motion:reduce){.motion{animation:none;transform:none}.scan-line,.type-cursor{display:none}}',
    ':root:target .motion{animation:none;transform:none}:root:target .scan-line,:root:target .type-cursor{display:none}',
    '</style>',
    '<defs>',
    '<image id="portrait" width="' + size + '" height="' + size + '" href="data:image/png;base64,' + portrait + '"/>',
    '<mask id="portrait-alpha" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="' + size + '" height="' + size + '" style="mask-type:alpha"><use href="#portrait"/></mask>',
    '<clipPath id="portrait-frame"><rect width="' + size + '" height="' + size + '" rx="8"/></clipPath>',
    '<clipPath id="portrait-reveal"><rect class="motion portrait-window" width="' + size + '" height="' + size + '"/></clipPath>',
    '</defs>',
    '<rect width="' + width + '" height="' + height + '" rx="8" fill="' + c.bg + '"/>',
    '<rect x=".5" y=".5" width="' + (width - 1) + '" height="' + (height - 1) + '" rx="8" fill="none" stroke="' + c.border + '"/>',
    text(mobile ? 20 : 32, 29, '$ whoami', 'mono prompt', 16),
    mobile ? '' : text(757, 29, '~/MertAErntrk', 'mono muted', 16),
    '<path d="M0 44H' + width + '" stroke="' + c.border + '"/>',
    '<g id="portrait-area" transform="translate(' + x + ' ' + y + ')">',
    '<rect width="' + size + '" height="' + size + '" rx="8" fill="' + c.empty + '"/>',
    '<g clip-path="url(#portrait-frame)"><use class="portrait-silhouette" href="#portrait" opacity=".02"/><g clip-path="url(#portrait-reveal)"><use class="portrait-image" href="#portrait"/></g>',
    '<g mask="url(#portrait-alpha)"><rect class="motion scan-line" y="-2" width="' + size + '" height="4" fill="' + c.accent + '"/></g></g>',
    '<rect x=".5" y=".5" width="' + (size - 1) + '" height="' + (size - 1) + '" rx="8" fill="none" stroke="' + c.border + '"/>',
    '</g>',
    ...rows.map(row => '<g id="info-' + row.id + '" class="info-row" transform="translate(' + tx + ' ' + row.y + ')">' +
      (row.id === 'role' ? text(0, 26, '>', 'mono prompt motion type-status', roleSize) : '') + typedText(row) +
      (row.id === 'role' ? '<g transform="translate(20 0)"><g class="motion type-status type-cursor"><g class="motion cursor-travel"><rect class="motion cursor-blink" y="5" width="2" height="25" fill="' + c.accent + '"/></g></g></g>' : '') + '</g>'),
    mobile ? '' : text(32, 328, '$ scan --portrait', 'mono muted', 16),
    '</svg>\n',
  ].join('\n');
}

function picture() {
  const sources = [
    ['(prefers-reduced-motion: reduce) and (max-width: 767px) and (prefers-color-scheme: dark)', 'dark-mobile.svg#still'],
    ['(prefers-reduced-motion: reduce) and (max-width: 767px)', 'light-mobile.svg#still'],
    ['(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)', 'dark.svg#still'],
    ['(prefers-reduced-motion: reduce)', 'light.svg#still'],
    ['(max-width: 767px) and (prefers-color-scheme: dark)', 'dark-mobile.svg'],
    ['(max-width: 767px)', 'light-mobile.svg'],
    ['(prefers-color-scheme: dark)', 'dark.svg'],
  ];
  return '<picture>\n' + sources.map(([media, src]) => '  <source media="' + media + '" srcset="' + src + '" />').join('\n') +
    '\n  <img src="light.svg" width="100%" alt="' + esc(profile.name + ', ' + profile.roles.join(', ') + '. Data pipelines, lakehouse design and LLM applications.') + '" />\n</picture>';
}

function architectureTable() {
  const rows = [];
  for (let index = 0; index < profile.capabilities.length; index += 2) {
    const items = profile.capabilities.slice(index, index + 2);
    const cells = items.map(item => '<td ' + (items.length === 1 ? 'colspan="2"' : 'width="50%"') + ' valign="top">\n' +
      '<p><strong>&bull; ' + esc(item.title) + '</strong></p>\n<p>' + esc(item.description) + '</p>\n</td>');
    rows.push('<tr>\n' + cells.join('\n') + '\n</tr>');
  }
  return '<table width="100%">\n' + rows.join('\n') + '\n</table>';
}

const readme = [
  picture(),
  '## About',
  '**' + profile.roles.join(' \u00b7 ') + '**',
  ...profile.about,
  '## Architecture & System Design',
  architectureTable(),
  '## Current Focus',
  ...profile.focus.map(item => '### ' + item.title + '\n\n' + item.description),
  '## Selected Work',
  ...profile.projects.map(item => '- **[' + item.title + '](' + item.url + ')** — ' + item.description),
  '## Connect',
  profile.links.map(link => '[' + link.label + '](' + link.url + ')').join(' \u00b7 '),
  '',
].join('\n\n');

const articles = items => items.map(item => '<article><h3>' + esc(item.title) + '</h3><p>' + esc(item.description) + '</p></article>').join('\n');
const preview = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta name="color-scheme" content="light dark"><title>' + esc(profile.name) + ' | Profile</title>',
  '<style>',
  '*{box-sizing:border-box}body{margin:0;background:#fff;color:#0f172a;font:16px/1.7 Arial,Helvetica,sans-serif;letter-spacing:0}',
  'main{width:min(100%,1024px);margin:24px auto 64px;padding:0 32px}picture,picture img{display:block;width:100%;height:auto}',
  'h2{font-size:24px;line-height:1.3;margin:38px 0 20px;padding-bottom:12px;border-bottom:1px solid #d0d7de}',
  'h3{font-size:18px;line-height:1.4;margin:0 0 8px}p{margin:0 0 16px}a{color:#0e7490;text-underline-offset:4px}',
  'a:hover{text-decoration-thickness:2px}a:focus-visible,button:focus-visible{outline:2px solid #0e7490;outline-offset:4px}',
  '.roles{color:#0e7490;font-weight:600}.capabilities{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}',
  '.capabilities article{min-width:0;padding:22px;border:1px solid #d0d7de;border-radius:6px;background:#f8fafc}.capabilities article:last-child:nth-child(odd){grid-column:1/-1}',
  '.capabilities h3{margin-bottom:10px}.capabilities h3::before{content:"\\2022";margin-right:8px}.capabilities p{max-width:72ch;margin:0;color:#475569;overflow-wrap:anywhere}.focus{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}',
  '.tools{display:flex;justify-content:flex-end;margin-bottom:8px}button{width:36px;height:36px;display:grid;place-items:center;border:1px solid #b6c4d0;border-radius:6px;background:transparent;cursor:pointer}',
  'button img{width:18px;height:18px}button:hover{border-color:#0e7490;background:#eaf0f4}button:disabled{cursor:default}button:disabled img{opacity:.5}',
  '@media(prefers-color-scheme:dark){body{background:#080b10;color:#e6edf3}h2,.capabilities article{border-color:#34414e}.capabilities article{background:#0b0f14}.capabilities p{color:#a8b3c1}a,.roles{color:#22d3ee}button{border-color:#34414e}button img{filter:invert(1)}button:hover{border-color:#22d3ee;background:#111820}a:focus-visible,button:focus-visible{outline-color:#22d3ee}}',
  '@media(max-width:900px){.focus{grid-template-columns:1fr;gap:12px}}',
  '@media(max-width:767px){main{margin:12px auto 40px;padding:0 16px}.capabilities{grid-template-columns:1fr;gap:12px}.capabilities article{padding:18px}h2{font-size:22px;margin-top:32px}.tools{margin-bottom:8px}button{width:44px;height:44px}}',
  '</style></head><body><main>',
  '<div class="tools"><button id="motion-toggle" type="button" aria-pressed="false" aria-label="Show static profile" title="Show static profile"><img src="assets/pause.svg" alt="" /></button></div>',
  picture(),
  '<section aria-labelledby="about"><h2 id="about">About</h2><p class="roles">' + esc(profile.roles.join(' \u00b7 ')) + '</p>' +
    profile.about.map(value => '<p>' + esc(value) + '</p>').join('') + '</section>',
  '<section aria-labelledby="architecture"><h2 id="architecture">Architecture &amp; System Design</h2><div class="capabilities">' + articles(profile.capabilities) + '</div></section>',
  '<section aria-labelledby="focus"><h2 id="focus">Current Focus</h2><div class="focus">' + articles(profile.focus) + '</div></section>',
  '<section aria-labelledby="projects"><h2 id="projects">Selected Work</h2><ul>' + profile.projects.map(item => '<li><a href="' + esc(item.url) + '">' + esc(item.title) + '</a> — ' + esc(item.description) + '</li>').join('') + '</ul></section>',
  '<section aria-labelledby="connect"><h2 id="connect">Connect</h2><p>' + profile.links.map(link => '<a href="' + esc(link.url) + '">' + esc(link.label) + '</a>').join(' &middot; ') + '</p></section>',
  '</main><script>',
  'const preference=matchMedia("(prefers-reduced-motion: reduce)");',
  'const button=document.querySelector("#motion-toggle");const portrait=document.querySelector("picture");',
  'const sources=[...portrait.querySelectorAll("source")];const image=portrait.querySelector("img");',
  'const originals=sources.map(source=>source.srcset);let manualStatic=false;',
  'function updateMotion(){const still=preference.matches||manualStatic;sources.forEach((source,index)=>source.srcset=still?originals[index].split("#")[0]+"#still":originals[index]);image.src=still?"light.svg#still":"light.svg";button.setAttribute("aria-pressed",String(still));button.disabled=preference.matches;const label=preference.matches?"Reduced motion enabled":still?"Animate profile":"Show static profile";button.setAttribute("aria-label",label);button.title=label;button.querySelector("img").src=still?"assets/play.svg":"assets/pause.svg";}',
  'button.addEventListener("click",()=>{manualStatic=!manualStatic;updateMotion()});preference.addEventListener("change",updateMotion);updateMotion();',
  '</script></body></html>\n',
].join('\n');

for (const theme of Object.keys(palettes)) {
  for (const mobile of [false, true]) {
    const name = theme + (mobile ? '-mobile' : '') + '.svg';
    fs.writeFileSync(path.join(root, name), svg(theme, mobile));
    console.log('Built ' + name);
  }
}
fs.writeFileSync(path.join(root, 'README.md'), readme);
fs.writeFileSync(path.join(root, 'preview.html'), preview);
console.log('Built README.md and preview.html from profile-content.json');
