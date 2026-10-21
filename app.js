/* Leaf reads only files explicitly selected by the user. Renderers never execute document code. */
'use strict';
const $ = id => document.getElementById(id);
const state = { entries: new Map(), tabs: [], active: null, root: null, saved: null, source: false, urls: [], render: 0 };
const readable = /\.(md|markdown|txt|json|ya?ml|csv|log)$/i;
const ignored = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'vendor']);
function status(message) { $('status').textContent = message; }
function element(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
function preference(key, value) { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch {} }
if (preference('leaf-theme') === 'dark') document.body.classList.add('dark');
$('theme').onclick = () => { document.body.classList.toggle('dark'); preference('leaf-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); if (state.active) openDocument(state.active); };
async function database() { return new Promise((resolve, reject) => { const request = indexedDB.open('leaf-library', 1); request.onupgradeneeded = () => request.result.createObjectStore('settings'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function saveFolder(handle) { try { const db = await database(); const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put(handle, 'folder'); tx.oncomplete = () => db.close(); } catch { /* Reading still works when browser storage is unavailable. */ } }
async function restoreFolder() { try { const db = await database(); const request = db.transaction('settings').objectStore('settings').get('folder'); request.onsuccess = () => { state.saved = request.result; $('reconnect').hidden = !state.saved; db.close(); }; } catch {} }
async function scan(handle, prefix = '', result = new Map()) { for await (const [name, entry] of handle.entries()) { if (name.startsWith('.') || ignored.has(name)) continue; const path = prefix + name; if (entry.kind === 'directory') await scan(entry, path + '/', result); else result.set(path, entry); } return result; }
function releaseImages() { state.urls.forEach(URL.revokeObjectURL); state.urls = []; }
function clearLibrary() { state.remoteRoot = null; state.lastError = null; state.render++; releaseImages(); state.tabs = []; state.active = null; state.source = false; $('document').replaceChildren(element('h1', 'Choose a document'), element('p', 'Your folder is ready. Select a file in the sidebar.')); $('outline').replaceChildren(); $('breadcrumb').textContent = 'YOUR LIBRARY'; $('source').disabled = true; drawTabs(); }
async function loadFolder(handle) { status('Reading folder…'); const entries = await scan(handle); clearLibrary(); state.entries = entries; state.root = handle; $('folderName').textContent = handle.name; drawTree(); status(`${[...entries.keys()].filter(p => readable.test(p)).length} documents · ${handle.name}`); state.saved = handle; $('reconnect').hidden = true; await saveFolder(handle); }
async function chooseFolder() { if (!window.showDirectoryPicker) { $('folderInput').click(); return; } try { const handle = await window.showDirectoryPicker({ mode: 'read' }); await loadFolder(handle); } catch (error) { if (error.name !== 'AbortError') { status('Folder picker unavailable. Use the folder selection dialog.'); $('folderInput').click(); } } }
$('folder').onclick = chooseFolder; $('start').onclick = chooseFolder;
$('reconnect').onclick = async () => { try { if (await state.saved.requestPermission({ mode: 'read' }) === 'granted') await loadFolder(state.saved); else status('Folder access was not granted. Choose a folder to continue.'); } catch { status('Folder no longer available. Choose it again.'); } };
$('files').onclick = () => $('fileInput').click();
$('folderInput').onchange = event => { const files = [...event.target.files]; if (!files.length) return; clearLibrary(); state.root = null; state.entries = new Map(files.map(file => [file.webkitRelativePath.split('/').slice(1).join('/'), file])); $('folderName').textContent = files[0].webkitRelativePath.split('/')[0]; drawTree(); status('Folder loaded · choose it again to see changed files'); event.target.value = ''; };
$('fileInput').onchange = async event => { const files = [...event.target.files]; for (const file of files) state.entries.set(file.name, file); drawTree(); if (files.length) await openDocument(files[0].name); event.target.value = ''; };
$('search').oninput = drawTree;
function drawTree() {
 const query = $('search').value.toLowerCase();
 const paths = [...state.entries.keys()].filter(path => readable.test(path) && path.toLowerCase().includes(query)).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
 const expanded = state.savedExpanded || new Set([...$('tree').querySelectorAll('details[open]')].map(node => node.dataset.path));
 state.savedExpanded = null;
 $('tree').replaceChildren();
 const roots = state.libraryFolders || [];
 const assigned = new Set();
 function fileButton(path, parent) {
  const button = element('button', path.split('/').pop(), 'file' + (path === state.active ? ' active' : ''));
  button.title = path; button.onclick = () => openDocument(path); parent.append(button);
 }
 function folderNode(name, path, parent) {
  const details = element('details'); details.dataset.path = path; details.open = !!query || expanded.has(path);
  details.append(element('summary', name)); parent.append(details); return details;
 }
 for (const root of roots) {
  const group = folderNode(root.split('/').pop() || root, root, $('tree')); group.title = root;
  const nodes = new Map([[root,group]]);
  for (const path of paths.filter(p => p.startsWith(root + '/'))) {
   assigned.add(path); let parent = group; let prefix = root;
   for (const part of path.slice(root.length+1).split('/').slice(0,-1)) {
    prefix += '/' + part; if (!nodes.has(prefix)) nodes.set(prefix,folderNode(part,prefix,parent)); parent = nodes.get(prefix);
   }
   fileButton(path,parent);
  }
 }
 // Loose documents remain first-class items; opening a file never adopts its entire parent folder.
 for (const path of paths.filter(p => !assigned.has(p))) fileButton(path,$('tree'));
 if (!paths.length && !roots.length) $('tree').append(element('p', 'No matching documents.', 'hint'));
}

function rememberScroll() { const tab = state.tabs.find(t => t.path === state.active); if (tab) tab.scroll = $('viewport').scrollTop; }
function drawTabs() { $('tabs').replaceChildren(); for (const tab of state.tabs) { const wrap = element('div', '', 'tab' + (tab.path === state.active ? ' selected' : '')); wrap.draggable = true; wrap.dataset.tabPath = tab.path; const button = element('button', tab.path.split('/').pop()); button.role = 'tab'; button.setAttribute('aria-selected', String(tab.path === state.active)); button.title = tab.path; button.onclick = () => openDocument(tab.path); const close = element('button', '×', 'close'); close.setAttribute('aria-label', `Close ${tab.path}`); close.onclick = () => closeTab(tab.path); wrap.append(button, close); $('tabs').append(wrap); } }
async function closeTab(path) { const index = state.tabs.findIndex(t => t.path === path); if (index < 0) return; state.tabs.splice(index,1); if (state.active === path) { if (state.tabs.length) await openDocument(state.tabs[Math.min(index,state.tabs.length-1)].path); else { const root = state.remoteRoot; clearLibrary(); state.remoteRoot = root; drawTree(); } } else drawTabs(); }
async function readFile(path) { const entry = state.entries.get(path); if (!entry) throw new Error('File is not in the selected folder.'); const file = entry.getFile ? await entry.getFile() : entry; if (file.size > 10 * 1024 * 1024) throw new Error('This file exceeds the 10 MB reading limit.'); return file; }
function resolvePath(path, base) { const pieces = base.split('/').slice(0,-1); for (const part of decodeURIComponent(path).split('/')) { if (part === '..') { if (!pieces.length) return null; pieces.pop(); } else if (part && part !== '.') pieces.push(part); } return pieces.join('/'); }
const renderers = [
 { matches: path => /\.(md|markdown)$/i.test(path), render: text => DOMPurify.sanitize(marked.parse(text, {gfm:true}), {USE_PROFILES:{html:true}, FORBID_TAGS:['style','form','input','video','audio'], FORBID_ATTR:['style','srcset','id','name']}) },
 { matches: () => true, render: text => { const pre = element('pre'); pre.append(element('code', text)); return pre; } }
];
async function openDocument(path) {
 state.lastError = null;
 rememberScroll(); state.active = path; let tab = state.tabs.find(t => t.path === path); if (!tab) { tab = {path,scroll:0}; state.tabs.push(tab); } const sequence = ++state.render;
 drawTabs(); drawTree(); $('breadcrumb').textContent = path; $('source').disabled = false; $('source').textContent = state.source ? 'Formatted' : 'Source'; status('Opening document…');
 try { const file = await readFile(path); const text = await file.text(); if (sequence !== state.render) return; releaseImages(); const renderer = state.source ? renderers[1] : renderers.find(r => r.matches(path)); const output = renderer.render(text); if (typeof output === 'string') $('document').innerHTML = output; else $('document').replaceChildren(output);
 $('outline').replaceChildren(); const headings = [...$('document').querySelectorAll('h1,h2,h3,h4,h5,h6')]; const slugs = new Map(); if (headings.length) $('outline').append(element('b','ON THIS PAGE'));
 for (const heading of headings) { const slug = heading.textContent.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-'); const count = slugs.get(slug) || 0; slugs.set(slug,count+1); heading.id = slug + (count ? `-${count}` : ''); if (/H[123]/.test(heading.tagName)) { const link = element('a',heading.textContent); link.href = '#' + heading.id; link.onclick = event => {event.preventDefault(); heading.scrollIntoView({behavior:'smooth'});}; $('outline').append(link); } }
 for (const img of $('document').querySelectorAll('img')) { const source = img.getAttribute('src') || ''; img.removeAttribute('src'); try { const imagePath = !/^(?:[a-z]+:|\/)/i.test(source) && resolvePath(source.split('#')[0],path); if (!imagePath || !/\.(png|jpe?g|gif|webp|avif)$/i.test(imagePath)) { img.alt = img.alt || 'External image (not loaded)'; continue; } const imageFile = await readFile(imagePath); if (sequence !== state.render) return; const url = URL.createObjectURL(imageFile); state.urls.push(url); img.src = url; } catch { img.alt = img.alt || 'Image unavailable in selected folder'; } }
 for (const link of $('document').querySelectorAll('a')) { const href = link.getAttribute('href') || ''; link.onclick = event => { event.preventDefault(); if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return; } if (href.startsWith('#')) { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); return; } if (/^(?:[a-z]+:|\/)/i.test(href)) { status('This link type is not supported.'); return; } try { const [relative,hash] = href.split('#'); const target = resolvePath(relative,path); if (state.entries.has(target) && readable.test(target)) openDocument(target).then(() => { if(hash) document.getElementById(decodeURIComponent(hash))?.scrollIntoView(); }); else status('Choose the containing folder to follow this document link.'); } catch { status('This document link could not be opened.'); } }; }
 if (!state.source) await renderDiagrams(sequence);
 if (sequence !== state.render) return;
 $('viewport').scrollTo({top:tab.scroll,behavior:'instant'}); status(`${text.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words · ${Math.max(1,Math.ceil(text.trim().split(/\s+/).length/220))} min read · ${state.source ? 'Source' : 'Read only'}`);
 } catch (error) { if (sequence !== state.render) return; state.lastError = error.message; $('document').replaceChildren(element('h1','Could not open this file'),element('p',error.message)); $('outline').replaceChildren(); status('Choose the file again or refresh the folder.'); }
}
$('source').onclick = () => { state.source = !state.source; if(state.active) openDocument(state.active); };
$('print').onclick = () => window.print();
$('refresh').onclick = async () => { try { if(state.root) { status('Refreshing folder…'); state.entries = await scan(state.root); drawTree(); } if(state.active) await openDocument(state.active); else status(state.root ? 'Folder refreshed' : 'Choose the folder again to refresh its files.'); } catch { status('Could not refresh. Choose the folder again.'); } };
$('demo').onclick = () => { const text = '# A quieter place for your ideas\n\nWelcome to **Leaf**, your local document reader. Open a folder, pick a document, and make yourself at home.\n\n> Good tools give your thoughts a little more room.\n\n## Everything in its place\n\nKeep a guide in one tab and your notes in another. The sidebar follows your folder structure.\n\n- **Folders** keep your library familiar.\n- **Tabs** keep useful documents close.\n- **An outline** helps you find your way.\n\n## A few things to try\n\n| Feature | Where to find it |\n| --- | --- |\n| Filter documents | Search in the sidebar |\n| Dark theme | Circle in the upper right |\n| Raw Markdown | Source button |\n| Save as PDF | Print button |\n\n## Code, without the clutter\n\n```javascript\nconst ideas = ["read", "think", "create"];\nideas.forEach(idea => console.log(idea));\n```\n\n## Your files stay yours\n\nLeaf reads the files you select. It does not upload or modify them. Images from your selected folder can appear inline; remote images stay unloaded.\n'; state.entries.set('Welcome.md', new File([text + '\n[Open the reading list](Examples/Reading-list.md)\n'], 'Welcome.md')); state.entries.set('Examples/Reading-list.md', new File(['# Reading list\n\nKeep a few useful documents close.\n\n## Try tabs\n\nSwitch back to Welcome.md using its tab.\n\n[Back to welcome](../Welcome.md)\n'], 'Reading-list.md')); drawTree(); openDocument('Welcome.md'); };
restoreFolder();
