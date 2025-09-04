const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const q = document.getElementById('q');
const sendBtn = document.getElementById('sendBtn');
const applyFix = document.getElementById('applyFix');
let last = '';

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

  // Speaker label
  if (speaker) {
    const label = document.createElement('strong');
    label.textContent = speaker + ":";
    label.style.display = "block";
    label.style.marginBottom = "4px";
    d.appendChild(label);
  }

  // Break into blocks (text vs code)
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
  append('me', "You: " + q.value);
  vscode.postMessage({ type: 'ask', text: q.value });
  q.value = '';
};

window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'delta') { last += m.value; }
  if (m.type === 'done') {
    append('ai', last || '(no output)');
    applyFix.style.display = last.trim() ? 'block' : 'none';
  }
  if (m.type === 'error') { append('err', m.value); }
});

applyFix.onclick = () => {
  const code = extractCode(last);
  vscode.postMessage({ type: 'applyFix', text: code });
};
