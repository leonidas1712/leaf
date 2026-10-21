/* Render fenced Mermaid locally; SVG images cannot execute diagram links or scripts. */
'use strict';
let diagramNumber = 0;
async function renderDiagrams(sequence) {
 const blocks = [...$('document').querySelectorAll('pre > code.language-mermaid')];
 for (const code of blocks) {
  if (sequence !== state.render) return;
  const source = code.textContent;
  const panel = element('section', '', 'diagram-panel');
  const toolbar = element('div', '', 'diagram-toolbar');
  toolbar.append(element('span', 'MERMAID', 'diagram-label'));
  const stage = element('div', '', 'diagram-stage');
  const details = element('details', '', 'diagram-source');
  details.append(element('summary', 'Diagram source'));
  const pre = element('pre'); pre.append(element('code', source)); details.append(pre);
  panel.append(toolbar, stage, details); code.parentElement.replaceWith(panel);
  try {
   if (source.length > 50000) throw new Error('Diagram exceeds the 50,000-character limit.');
   mermaid.initialize({startOnLoad:false, securityLevel:'strict', suppressErrorRendering:true,
    theme:document.body.classList.contains('dark') ? 'dark' : 'neutral',
    fontFamily:'Arial, sans-serif', htmlLabels:false, flowchart:{htmlLabels:false, useMaxWidth:false},
    secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','htmlLabels','flowchart'],
    maxTextSize:50000, maxEdges:500});
   const {svg} = await mermaid.render('leaf-diagram-' + (++diagramNumber), source);
   if (sequence !== state.render) return;
   // The blob is displayed as an image, never inserted as executable document markup.
   const image = element('img', '', 'diagram-image');
   image.alt = 'Mermaid diagram';
   const url = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
   state.urls.push(url); image.src = url;
   const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
   const box = (parsed.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
   const naturalWidth = box.length === 4 && box[2] > 0 ? box[2] : 800;
   let width = Math.min(naturalWidth, Math.max(240, stage.clientWidth || panel.clientWidth - 32));
   const resize = () => { image.style.width = width + 'px'; };
   for (const [label, title, action] of [
    ['−','Zoom diagram out',() => {width = Math.max(120,width / 1.25);}],
    ['+','Zoom diagram in',() => {width = Math.min(8000,width * 1.25);}],
    ['Fit','Fit diagram to panel',() => {width = Math.min(naturalWidth,Math.max(120,stage.clientWidth - 32));}],
    ['100%','Show diagram at natural size',() => {width = naturalWidth;}]
   ]) { const button = element('button',label); button.title = title; button.setAttribute('aria-label',title); button.onclick = () => { action(); resize(); }; toolbar.append(button); }
   stage.append(image); resize();
  } catch (error) {
   if (sequence !== state.render) return;
   panel.classList.add('diagram-error');
   stage.append(element('p','This diagram could not be rendered. Its source is preserved below.'));
   stage.append(element('pre', String(error.message || error)));
   details.open = true;
  }
 }
}
