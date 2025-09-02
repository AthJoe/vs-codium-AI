const vscode = require("vscode");
const http = require("http");

function activate(context) {
  // Command: open/focus chat
  context.subscriptions.push(
    vscode.commands.registerCommand("ajai.openChat", async () => {
      await vscode.commands.executeCommand("ajaiChatView.focus");
    })
  );

  // Register chat view
  const provider = new ChatViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("ajaiChatView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

class ChatViewProvider {
  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    const webview = webviewView.webview;
    webview.options = { enableScripts: true };
    webview.html = getHtml();

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ask") {
        const port = vscode.workspace.getConfiguration().get("ajai.port") || 27121;
        webview.postMessage({ type: "status", value: "Thinking…" });
        try {
          await streamChat(port, { message: msg.text }, (delta) => {
            webview.postMessage({ type: "delta", value: delta });
          });
          webview.postMessage({ type: "done" });
        } catch (e) {
          webview.postMessage({ type: "error", value: e.message || String(e) });
        }
      }
      if (msg.type === "insert") {
        const editor = vscode.window.activeTextEditor;
        if (editor) editor.edit(ed => ed.insert(editor.selection.active, msg.text));
      }
    });
  }
}

// Stream from orchestrator (/chat)
function streamChat(port, body, onDelta) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");

    const req = http.request(
      { host: "127.0.0.1", port, path: "/chat", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim(); buf = buf.slice(idx+1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              if (j.type === "delta" && typeof j.data === "string") onDelta(j.data);
              if (j.type === "error") return reject(new Error(j.data?.message || "error"));
            } catch {}
          }
        });
        res.on("end", resolve);
      }
    );
    req.on("error", reject); req.write(data); req.end();
  });
}

// Simple HTML UI
function getHtml() {
  return /* html */`
  <style>
    body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground); }
    #wrap { display:flex; flex-direction:column; height:100%; gap:6px; }
    #log { flex:1; overflow:auto; border:1px solid var(--vscode-editorWidget-border); padding:6px; }
    #input { display:flex; gap:6px; align-items: center; }
    textarea { flex:1; height:60px; }
    button { padding:4px 8px; }
    .sys { opacity:0.7; }
    .err { color: var(--vscode-errorForeground); }
    pre { white-space: pre-wrap; margin:0; }

    /* add a simple spinner */
    #busy { display:none; }
    #busy.show { display:inline-block; animation: spin 1s linear infinite; }
    @keyframes spin { from {transform: rotate(0)} to {transform: rotate(360deg)} }
  </style>
  <div id="wrap">
    <div id="log"></div>
    <div id="input">
      <textarea id="q" placeholder="Ask…"></textarea>
      <button id="ask">Send</button>
      <span id="busy">⏳</span>
      <button id="insert">Insert</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const q = document.getElementById('q');
    const busy = document.getElementById('busy');
    let last = '';
    function append(cls, text){
      const d=document.createElement('div'); d.className=cls;
      const pre=document.createElement('pre'); pre.textContent=text; d.appendChild(pre);
      log.appendChild(d); log.scrollTop = log.scrollHeight;
    }
    document.getElementById('ask').onclick = () => {
      last = ''; append('sys','You: ' + q.value);
      busy.classList.add('show');                 // show spinner
      vscode.postMessage({ type:'ask', text: q.value });
    };
    document.getElementById('insert').onclick = () => {
      if (last) vscode.postMessage({ type:'insert', text: last });
    };
    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'delta') { last += m.value; }
      if (m.type === 'done')  { busy.classList.remove('show'); append('', last || '(no output)'); }
      if (m.type === 'error') { busy.classList.remove('show'); append('err', m.value); }
      if (m.type === 'status') append('sys', m.value);
    });
  </script>`;
}


function deactivate(){}
module.exports = { activate, deactivate };
