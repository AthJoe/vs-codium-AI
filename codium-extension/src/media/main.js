const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const q = document.getElementById('q');
const sendBtn = document.getElementById('sendBtn');
const applyFix = document.getElementById('applyFix');
let last = '';

// --- Auto-grow textarea ---
function autosize(){
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 160) + 'px';
}
q.addEventListener('input', autosize);
setTimeout(autosize, 0);


// --- Enter to send; Shift+Enter newline ---
q.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    send();
  }
});

sendBtn.onclick = send;

function send(){
  const text = q.value;
  if (!text.trim()) return;
  last = '';
  appendUser(text);// preserve formatting
  const model = document.getElementById('modelSelect').value;
  vscode.postMessage({ type: 'ask', text, model }); // send as-is
  q.value = '';
  autosize();
}

// --- Rendering ---
function appendUser(text){
  const wrap = document.createElement('div');
  wrap.className = 'msg me';
  const label = document.createElement('div');
  label.className = 'speaker';
  label.textContent = 'You';
  const pre = document.createElement('pre');
  pre.className = 'usertext';
  pre.textContent = text;   // keeps newlines
  wrap.appendChild(label);
  wrap.appendChild(pre);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

function appendAI(text){
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  const label = document.createElement('div');
  label.className = 'speaker';
  label.textContent = 'AJ AI';
  wrap.appendChild(label);

  const blocks = parseBlocks(text);         // your existing robust parser
  blocks.forEach(b=>{
    if (b.type === 'code') {
      wrap.appendChild(createCodeCard(b.lang, b.content));
    } else if (b.content.trim()){
      const p = document.createElement('p');
      p.style.whiteSpace = 'pre-wrap';      // keep AI newlines too
      p.textContent = b.content.trim();
      wrap.appendChild(p);
    }
  });

  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// Put this ABOVE append()
function parseBlocks(raw) {
  const KNOWN = ["python","py","javascript","js","typescript","ts","tsx","jsx","json","html","css","bash","sh","zsh","powershell","ps1","sql","yaml","yml","xml","markdown","md","c","cpp","h","hpp","java","go","rust","rs","php","ruby","rb","kotlin","swift","r","lua","dart","scala","zig","perl","pl"];
  const PLAIN = new Set(["", "text", "plain", "plaintext"]);

  const text = String(raw).replace(/\r\n?/g, "\n");
  const blocks = [];
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf("```", i);
    if (start === -1) { if (i < text.length) blocks.push({ type:"text", content:text.slice(i) }); break; }
    if (start > i) blocks.push({ type:"text", content:text.slice(i, start) });

    let j = start + 3;
    let nl = text.indexOf("\n", j);
    if (nl === -1) nl = text.length;
    const header = text.slice(j, nl).trim();       // may be "python", "pythonfor i…", ""

    // peel language even if it's glued to first code token
    let lang = "", firstLine = "";
    if (header) {
      const lower = header.toLowerCase();
      const hit = KNOWN.find(k => lower.startsWith(k));  // <-- prefix match fixes "pythonfor…"
      if (hit) {
        lang = PLAIN.has(hit) ? "" : hit;
        firstLine = header.slice(hit.length).trimStart(); // rest becomes first code line
      } else {
        // not a known lang header → treat whole header as first code line
        firstLine = header;
      }
    }

    j = (nl < text.length) ? nl + 1 : nl;
    const end = text.indexOf("```", j);
    const body = (end === -1) ? text.slice(j) : text.slice(j, end);
    const code = (firstLine ? firstLine + "\n" : "") + body;

    blocks.push({ type:"code", lang, content: code });
    if (end === -1) break;
    i = end + 3;
  }
  return blocks;
}

function createCodeCard(lang, codeText) {
  const wrap = document.createElement('div'); wrap.className = 'codecard';

  const head = document.createElement('div'); head.className = 'codecard-head';
  const left = document.createElement('div'); left.className = 'dots';
  ['red','yellow','green'].forEach(c => { 
    const d=document.createElement('span'); d.className='dot '+c; left.appendChild(d); 
  });

  const langEl = document.createElement('span'); 
  langEl.className = 'lang'; 
  langEl.textContent = lang || '';

  const actions = document.createElement('div'); actions.className = 'cc-actions';
  const copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      copyBtn.textContent='Copied';
      setTimeout(()=>copyBtn.textContent='Copy',1200);
    } catch(e){}
  };
  actions.appendChild(copyBtn);

  head.appendChild(left); head.appendChild(langEl); head.appendChild(actions);

  const pre = document.createElement('pre'); 
  const code = document.createElement('code'); 
  code.textContent = codeText.trim(); 
  pre.appendChild(code);

  wrap.appendChild(head); wrap.appendChild(pre);
  return wrap;
}


function append(cls, text, speaker) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;

  if (speaker) {
    const label = document.createElement('div');
    label.className = 'speaker';
    label.textContent = speaker;
    d.appendChild(label);
  }

  const blocks = parseBlocks(text);
  blocks.forEach(b => {
    if (b.type === "code") {
      d.appendChild(createCodeCard(b.lang, b.content));
    } else if (b.content.trim()) {
      const p = document.createElement('p');
      p.textContent = b.content.trim();
      d.appendChild(p);
    }
  });

  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}


function extractCode(answer) {
  const blocks = parseBlocks(answer);
  for (let k = blocks.length - 1; k >= 0; k--) {
    if (blocks[k].type === "code") return blocks[k].content.trim();
  }
  return answer.trim();
}

sendBtn.onclick = () => {
  if (!q.value.trim()) return;
  last = '';
  appendUser(q.value);   // preserves formatting + adds "You" label
  vscode.postMessage({ type: 'ask', text: q.value });
  q.value = '';
  autosize();
};



// Replace previous append() usage:
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'delta') { last += m.value; }
  if (m.type === 'done')  {
    appendAI(last || '(no output)');
    applyFix.style.display = last.trim() ? 'block' : 'none';
  }
  if (m.type === 'error') {
    const err = document.createElement('div');
    err.className = 'msg ai';
    err.innerHTML = '<div class="speaker">AJ AI</div><p style="color:var(--vscode-errorForeground)">' + (m.value || m) + '</p>';
    log.appendChild(err);
  }
});

applyFix.onclick = () => {
  const code = extractCode(last);
  vscode.postMessage({ type: 'applyFix', text: code });
};
