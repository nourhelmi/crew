// A deliberately small, bounded prose renderer. All source HTML stays literal.
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LIMIT = 100_000;
export function prettyOutput(text) {
  const source = String(text ?? '');
  text = source.slice(0, LIMIT);
  try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Incomplete JSON and other output remain literal. */ }
  return text.slice(0,LIMIT)+(source.length>LIMIT || text.length>LIMIT?'\n[Output shortened for display]':'');
}
function inline(text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|!?\[[^\[\]\n]+\]\([^\s()[\]]+\))/g;
  let result = '', from = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(from, match.index));
    const token = match[0];
    if (token.startsWith('`')) result += `<code>${escapeHtml(token.slice(1,-1))}</code>`;
    else if (token.startsWith('**')) result += `<strong>${escapeHtml(token.slice(2,-2))}</strong>`;
    else if (token.startsWith('*')) result += `<em>${escapeHtml(token.slice(1,-1))}</em>`;
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      let safe = false;
      if (parts) {
        try { safe = /^https?:$/.test(new URL(parts[2]).protocol); } catch { /* Paths and unknown schemes remain literal. */ }
      }
      result += safe ? `<a href="${escapeHtml(parts[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(parts[1])}</a>` : escapeHtml(token);
    }
    from = match.index + token.length;
  }
  return result + escapeHtml(text.slice(from));
}
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').slice(0,20).map(s=>s.trim());
export function renderProse(value) {
  const original = String(value ?? '');
  const lines = original.slice(0,LIMIT).replace(/\r\n?/g,'\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)([^`]*)$/.exec(line);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(`<div class="cw-code-block">${fence[2].trim() ? `<div class="cw-code-language">${escapeHtml(fence[2].trim())}</div>` : ''}<pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const level=Math.min(heading[1].length+1,6); blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { blocks.push('<hr>'); i++; continue; }
    if (i+1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])) {
      const header=cells(line); const rows=[]; i+=2;
      while(i<lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(`<div class="cw-table-wrap"><table><thead><tr>${header.map(c=>`<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${header.map((_,j)=>`<td>${inline(r[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const list = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
    if (list) {
      const ordered=!!list[2], items=[]; const start=ordered ? ` start="${Math.min(Number(list[2]),999999)}"` : ''; let next;
      while(i<lines.length && (next=/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[i])) && !!next[2]===ordered) { items.push(`<li>${inline(next[3])}</li>`); i++; }
      const tag=ordered?'ol':'ul'; blocks.push(`<${tag}${start}>${items.join('')}</${tag}>`); continue;
    }
    const paragraph=[line]; i++;
    while(i<lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|```|~~~|[-+*]\s|\d+\.\s)/.test(lines[i]) && !(i+1<lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i+1]))) paragraph.push(lines[i++]);
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  if(original.length>LIMIT) blocks.push('<p class="cw-source-note">Text shortened for display.</p>');
  return blocks.join('');
}
