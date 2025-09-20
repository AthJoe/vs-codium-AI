document.addEventListener('DOMContentLoaded', ()=> {
  if (!window._ajai_vscode) {
    try {
      window._ajai_vscode = acquireVsCodeApi();
      console.log('[AJAI webview] acquired vscode API');
    } catch (e) {
      console.error('[AJAI webview] acquireVsCodeApi failed', e);
    }
  }
  const vscode = window._ajai_vscode;
  const log = document.getElementById('log');
  const q = document.getElementById('q');
  const sendBtn = document.getElementById('sendBtn');
  const applyFix = document.getElementById('applyFix');
  const currentFile = document.getElementById('currentFile');
  const threadHint = document.getElementById('threadHint');
  let last = '';

  // --- Thread add button (already existed) ---
  const addThreadbtn = document.getElementById('add-thread-btn');
  if (addThreadbtn) {
    addThreadbtn.addEventListener('click', () => {
      console.log('[AJAI webview] debug: + clicked. window._ajai_vscode=', !!window._ajai_vscode);
      try {
        // prefer the same API variable used in the rest of your file
        const api = window._ajai_vscode || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
        if (api) {
          console.log('[AJAI webview] debug: posting newThread message to extension');
          api.postMessage({ type: 'newThread' });
        } else {
          console.warn('[AJAI webview] debug: no vs code api available in this env');
        }
      } catch (e) {
        console.error('[AJAI webview] debug: failed to postMessage', e);
      }
    });
  } else {
    console.warn('[AJAI webview] debug: add-thread-btn element missing');
  }


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
      sendBtn.onclick();
    }
  });

  // --- Rendering helpers ---
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
    appendUser(q.value);                     // show user message

    const sel = document.getElementById('modelSelect');
    const provider = sel.options[sel.selectedIndex].dataset.provider || 
                  (sel.value.startsWith('glm') ? 'zai' : 'openrouter');
    vscode.postMessage({
      type     : 'ask',
      text     : q.value,
      model    : sel.value,                                      // e.g. "glm-4.5-flash"
      provider : provider,// "zai" or "openrouter"
      thread   : threadHint.textContent                          // current thread id/label
    });

    q.value = '';
    autosize();
  };



  // --- Thread UI helper functions ---
  function renderThreadsList(threads = [], currentThread = null) {
    const container = document.getElementById('threads');
    if (!container) return;

    container.innerHTML = '';
    threads.forEach(t => {
      const el = document.createElement('div');
      el.className = 'thread-item' + (currentThread && t.id === currentThread.id ? ' active' : '');
      el.textContent = t.title || `Thread ${t.id.substring(0,6)}`;
      el.dataset.id = t.id;
      el.addEventListener('click', () => {
        // tell extension to switch current thread
        vscode.postMessage({ type: 'switchThread', id: t.id });
      });
      container.appendChild(el);
    });
  }

  function updateThreadInUI(thread) {
    const currentId = thread?.id;
    const activeEl = document.querySelector('.thread-item.active');
    if (activeEl && activeEl.dataset.id === currentId) {
      const messages = document.getElementById('messages');
      if (messages) {
        messages.innerHTML = '';
        (thread.history || []).forEach(h => {
          const p = document.createElement('div');
          p.className = `message ${h.role}`;
          p.textContent = h.content;
          messages.appendChild(p);
        });
      }
    }

    const threadEl = document.querySelector(`.thread-item[data-id="${currentId}"]`);
    if (threadEl) {
      threadEl.title = (thread.history && thread.history.length) ? thread.history.slice(-1)[0].content : 'No messages';
    }
  }

  // Replace previous append() usage with an expanded message listener
  window.addEventListener('message', ev => {
    const m = ev.data;

    // existing types still handled
    if (m.type === 'fileInfo') {
      currentFile.textContent = m.name || '(no file)';
      return;
    }
    if (m.type === 'threadSet'){
      threadHint.textContent = m.id.slice(-4);
      log.innerHTML = '';
      return;
    }
    if (m.type === 'delta') { last += m.value; return; }
    if (m.type === 'done')  {
      appendAI(last || '(no output)');
      applyFix.style.display = last.trim() ? 'block' : 'none';
      last = '';
      return;
    }
    if (m.type === 'error') {
      const err = document.createElement('div');
      err.className = 'msg ai';
      err.innerHTML = '<div class="speaker">AJ AI</div><p style="color:var(--vscode-errorForeground)">' + (m.value || m) + '</p>';
      log.appendChild(err);
      // if add thread was disabled, re-enable on error
      if (addThreadbtn) addThreadbtn.disabled = false;
      return;
    }

    // NEW: handle thread-related messages coming from the extension
    switch (m.type) {
      case 'init':
        // initial payload: full state
        renderThreadsList(m.threads || [], m.currentThread || null);
        break;

      case 'threadCreated':
        // extension created thread and returned it
        renderThreadsList(m.threads || [], m.currentThread || null);
        if (addThreadbtn) addThreadbtn.disabled = false;
        break;

      case 'historyUpdate':
        // a thread's history changed (pushToHistory or save)
        // msg.thread contains latest thread
        if (m.thread) updateThreadInUI(m.thread);
        break;

      // other message types might still be useful to the app; fall back to console
      default:
        // console.log('unhandled message', m);
        break;
    }
  });

  applyFix.onclick = () => {
    const code = extractCode(last);
    vscode.postMessage({ type: 'applyFix', text: code });
  };

});