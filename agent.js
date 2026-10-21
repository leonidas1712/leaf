/* The local bridge applies explicit agent actions and acknowledges the resulting UI state. */
'use strict';
const bridgeToken = document.querySelector('meta[name="leaf-agent-token"]')?.content;
const readerSession = crypto.randomUUID();
let pollBusy = false;
let draggedTab = null;
let workspaceRevision = -1;
let bridgeInstance = null;
let lastSavedView = '';
let applyingWorkspace = false;
function snapshot() {
 return { revision: workspaceRevision, session: readerSession, title: document.title, rootPath: state.remoteRoot?.path || null,
  active: state.active, tabs: state.tabs.map(t => t.path), source: state.source,
  theme: document.body.classList.contains('dark') ? 'dark' : 'light', search: $('search').value,
  folders: [...$('tree').querySelectorAll('details')].map(d => ({path:d.dataset.path,expanded:d.open})),
  documents: [...state.entries.keys()].filter(p => readable.test(p)).slice(0,500),
  documentCount: [...state.entries.keys()].filter(p => readable.test(p)).length,
  headings: [...$('document').querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({id:h.id,text:h.textContent})),
  scroll: $('viewport').scrollTop, sidebarWidth: document.querySelector('.sidebar').getBoundingClientRect().width,
  status: $('status').textContent };
}
async function bridgeRequest(path, data) {
 const response = await fetch(path, {method:data === undefined ? 'GET' : 'POST', headers:{'X-Leaf-Token':bridgeToken,'Content-Type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data)});
 if (!response.ok) throw new Error((await response.json()).error || 'Local bridge request failed.');
 return response;
}
function remoteEntry(entry) {
 return {getFile:async () => { if (entry.error) throw new Error(entry.error); const response = await bridgeRequest('/api/file?id=' + encodeURIComponent(entry.id)); return new File([await response.blob()], entry.path.split('/').pop()); }};
}
function addRemoteEntries(entries) { for (const entry of entries) state.entries.set(entry.path, remoteEntry(entry)); }
function reorderTabs(paths) {
 if (!Array.isArray(paths) || paths.length !== state.tabs.length || new Set(paths).size !== paths.length || paths.some(p => !state.tabs.some(t => t.path === p))) throw new Error('Supply every open tab path exactly once.');
 state.tabs = paths.map(p => state.tabs.find(t => t.path === p)); drawTabs();
}
function tabPath(path) {
 if (state.tabs.some(t => t.path === path)) return path;
 const relative = state.remoteRoot && path?.startsWith(state.remoteRoot.path + '/') ? path.slice(state.remoteRoot.path.length + 1) : path;
 if (!state.tabs.some(t => t.path === relative)) throw new Error('Tab is not open. Use its exact path from state.');
 return relative;
}
async function refreshReader() {
 await bridgeRequest('/api/action',{action:'refresh'}); await pollAgent();
}
function workspaceView() {
 rememberScroll();
 return {folders:state.libraryFolders || [], files:state.savedFiles || [],
  tabs:state.tabs.filter(t => t.path.startsWith('/')).map(t => ({path:t.path,scroll:t.scroll || 0})),
  active:state.active?.startsWith('/') ? state.active : null,
  theme:document.body.classList.contains('dark') ? 'dark' : 'light', source:state.source,
  search:$('search').value, sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width,
  expanded:[...$('tree').querySelectorAll('details[open]')].map(d => d.dataset.path).filter(p => p.startsWith('/'))};
}
async function restoreWorkspace(payload) {
 applyingWorkspace = true;
 try {
  const saved = payload.workspace;
  clearLibrary(); state.entries.clear(); state.root = null;
  state.libraryFolders = saved.folders; state.savedFiles = saved.files;
  state.savedExpanded = new Set(saved.expanded);
  addRemoteEntries(payload.entries);
  state.tabs = saved.tabs.map(tab => ({...tab}));
  document.body.classList.toggle('dark',saved.theme === 'dark');
  state.source = saved.source; $('search').value = saved.search;
  document.querySelector('.sidebar').style.width = saved.sidebarWidth + 'px';
  $('folderName').textContent = 'WORKSPACE'; $('reconnect').hidden = true;
  drawTree(); drawTabs();
  if (saved.active) await openDocument(saved.active);
  else { $('document').replaceChildren(element('h1','Your reading workspace'),element('p','Open a file or folder, or ask your agent. Your tabs and folders are saved automatically.')); }
  drawRecents(saved);
  workspaceRevision = saved.revision;
  lastSavedView = JSON.stringify(workspaceView());
  if (payload.missing.length) status(`${payload.missing.length} saved paths unavailable · restore them and refresh`);
 } finally { applyingWorkspace = false; }
}
function drawRecents(saved) {
 const host = $('recentItems'); host.replaceChildren();
 for (const [kind, paths] of [['open-file',saved.recentFiles],['open-folder',saved.recentFolders]]) {
  for (const path of paths.slice(0,8)) {
   const button = element('button',(kind === 'open-folder' ? '▸ ' : '') + path.split('/').pop(),'file');
   button.title = path; button.onclick = () => bridgeRequest('/api/action',{action:kind,path}).then(() => pollAgent()).catch(error => status(error.message));
   host.append(button);
  }
 }
 if (!host.childElementCount) host.append(element('p','No recent paths yet.','hint'));
}

async function applyAction(command) {
 const path = command.path;
 switch(command.action) {
 case 'state': break;
 case 'open-folder':
  clearLibrary(); state.root = null; state.entries.clear(); state.remoteRoot = {path, id:command.rootId}; $('search').value = ''; addRemoteEntries(command.entries); $('folderName').textContent = path.split('/').pop(); drawTree(); status('Folder opened by your agent · ' + path); break;
 case 'open-file': {
  const key = state.remoteRoot && path.startsWith(state.remoteRoot.path + '/') ? path.slice(state.remoteRoot.path.length + 1) : path;
  state.entries.set(key, remoteEntry({id:command.fileId,path:key})); await openDocument(key); break;
 }
 case 'focus-tab': await openDocument(tabPath(path)); break;
 case 'close-tab': await closeTab(tabPath(path || state.active)); break;
 case 'reorder-tabs': reorderTabs(command.paths); break;
 case 'search': $('search').value = path || ''; drawTree(); break;
 case 'expand-folder': case 'collapse-folder': {
  const folders = [...$('tree').querySelectorAll('details')].filter(d => path === '*' || d.dataset.path.replace(/\/$/,'') === path?.replace(/\/$/,''));
  if (!folders.length) throw new Error('Folder is not visible in the current tree.');
  folders.forEach(d => { d.open = command.action === 'expand-folder'; }); break;
 }
 case 'theme':
  if (!['light','dark'].includes(path)) throw new Error('Theme must be light or dark.');
  document.body.classList.toggle('dark',path === 'dark'); preference('leaf-theme',path); if (state.active) await openDocument(state.active); break;
 case 'view':
  if (!['source','formatted'].includes(path)) throw new Error('View must be source or formatted.');
  state.source = path === 'source'; if(state.active) await openDocument(state.active); break;
 case 'heading': {
  const heading = [...$('document').querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => h.id === path || h.textContent === path);
  if (!heading) throw new Error('Heading not found. Use state to inspect headings.');
  heading.scrollIntoView({behavior:'instant'}); break;
 }
 case 'scroll': {
  const top = command.top === undefined ? $('viewport').scrollTop + Number(command.by) : Number(command.top);
  if (!Number.isFinite(top)) throw new Error('Supply a numeric top or by value.');
  $('viewport').scrollTo({top,behavior:'instant'}); break;
 }
 case 'refresh': await refreshReader(); break;
 case 'sidebar-width': {
  const width = Number(command.width);
  if (!Number.isFinite(width) || width < 180 || width > 600) throw new Error('Sidebar width must be 180–600 pixels.');
  document.querySelector('.sidebar').style.width = width + 'px'; break;
 }
 default: throw new Error('Unknown action: ' + command.action);
 }
 if (['open-file','focus-tab','view','refresh'].includes(command.action) && state.lastError) throw new Error(state.lastError);
 return snapshot();
}
async function pollAgent() {
 if (pollBusy || !bridgeToken || applyingWorkspace) return;
 pollBusy = true;
 try {
  const view = workspaceView(); const encoded = JSON.stringify(view);
  const request = {instance:bridgeInstance,session:readerSession,revision:workspaceRevision,state:snapshot()};
  if (workspaceRevision >= 0 && encoded !== lastSavedView) request.view = view;
  const response = await (await bridgeRequest('/api/sync',request)).json();
  bridgeInstance = response.instance;
  if (response.workspace) await restoreWorkspace(response);
  else {workspaceRevision = response.revision; lastSavedView = encoded;}
  for (const command of response.commands) {
   let error;
   try { await applyAction(command); } catch (failure) { error = failure.message; }
   await bridgeRequest('/api/ack',{session:readerSession,id:command.id,state:snapshot(),error});
  }
  $('agentStatus').textContent = 'Saved · Agent connected';
 } catch (error) { $('agentStatus').textContent = 'Disconnected · changes not saved'; }
 finally { pollBusy = false; }
}
function showPathDialog(action) {
 $('pathDialog').dataset.action = action;
 $('pathTitle').textContent = action === 'open-folder' ? 'Add a folder' : 'Open a document';
 $('pathValue').value = ''; $('pathError').textContent = ''; $('pathDialog').showModal(); $('pathValue').focus();
}

$('tabs').addEventListener('dragstart', event => { const tab = event.target.closest('[data-tab-path]'); if(tab) { draggedTab = tab.dataset.tabPath; event.dataTransfer.setData('text/plain',draggedTab); } });
$('tabs').addEventListener('dragover', event => event.preventDefault());
$('tabs').addEventListener('drop', event => { event.preventDefault(); const target = event.target.closest('[data-tab-path]')?.dataset.tabPath; if (!target || !draggedTab || target === draggedTab) return; const paths = state.tabs.map(t => t.path); const index = paths.indexOf(target); paths.splice(paths.indexOf(draggedTab),1); paths.splice(index,0,draggedTab); reorderTabs(paths); draggedTab = null; });
$('moveLeft').onclick = () => { const paths = state.tabs.map(t => t.path); const i = paths.indexOf(state.active); if(i > 0) { [paths[i-1],paths[i]] = [paths[i],paths[i-1]]; reorderTabs(paths); } };
$('moveRight').onclick = () => { const paths = state.tabs.map(t => t.path); const i = paths.indexOf(state.active); if(i >= 0 && i < paths.length-1) { [paths[i+1],paths[i]] = [paths[i],paths[i+1]]; reorderTabs(paths); } };
if (bridgeToken) {
 $('agentStatus').textContent = 'Restoring workspace…';
 $('recentList').hidden = false;
 $('folder').onclick = () => showPathDialog('open-folder');
 $('start').onclick = () => showPathDialog('open-folder');
 $('files').onclick = () => showPathDialog('open-file');
 $('pathCancel').onclick = () => $('pathDialog').close();
 $('pathForm').onsubmit = async event => {
  event.preventDefault();
  try { await bridgeRequest('/api/action',{action:$('pathDialog').dataset.action,path:$('pathValue').value}); $('pathDialog').close(); await pollAgent(); }
  catch(error) { $('pathError').textContent = error.message; }
 };
 document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAgent(); });
 window.addEventListener('pagehide', () => {
  if (workspaceRevision >= 0 && !applyingWorkspace && !pollBusy) fetch('/api/sync',{method:'POST',keepalive:true,headers:{'X-Leaf-Token':bridgeToken,'Content-Type':'application/json'},body:JSON.stringify({instance:bridgeInstance,session:readerSession,revision:workspaceRevision,view:workspaceView(),state:snapshot()})}).catch(() => {});
 });
 $('refresh').onclick = () => refreshReader().catch(error => status(error.message));
 setInterval(pollAgent, 750); pollAgent();
}
