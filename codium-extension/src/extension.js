const fs = require('fs');
const path = require('path');
const vscode = require("vscode");
const http = require("http");

let currentEditor = vscode.window.activeTextEditor;

function activeFileInfo() {
  if (!currentEditor) return null;
  return {
    name: path.basename(currentEditor.document.fileName),
    text: currentEditor.document.getText()
  };
}

function postFileInfo(webview) {
  const info = activeFileInfo();
  if (info) webview.postMessage({ type: "fileInfo", ...info });
}

function activate(context) {
  // Set globalContext for save/load
  const STORE_KEY = 'ajai.threads';
  let globalContext = context;
  let currentThread = null;

  const storedId = context.workspaceState.get('ajai.currentThread');
  const all = context.workspaceState.get(STORE_KEY, {});
  if (storedId && all && all[storedId]) {
    currentThread = all[storedId];
  } else {
    currentThread = newThread();
    saveThread(currentThread);
  }

  // Command: open/focus chat
  context.subscriptions.push(
    vscode.commands.registerCommand("ajai.openChat", async () => {
      await vscode.commands.executeCommand("ajaiChatView.focus");
    })
  );

  // Register chat view
  const provider = new ChatViewProvider(context);

  function newThread() {
    const id = Date.now().toString(36);
    return { id, history: [] };
  }

  function saveThread(t) {
    if (!globalContext) {
      return;
    }
    const all = globalContext.workspaceState.get(STORE_KEY, {});
    all[t.id] = t;
    globalContext.workspaceState.update(STORE_KEY, all);
    globalContext.workspaceState.update('ajai.currentThread', t.id);
  }

  function pushToHistory(role, content) {
    if (!currentThread) {
      currentThread = newThread();
    }
    currentThread.history = currentThread.history || [];
    currentThread.history.push({ role, content });
    if (currentThread.history.length > 50) {
      currentThread.history.shift();
    }
    saveThread(currentThread);
  }
  provider.pushToHistory = pushToHistory;
  provider.newThread = newThread;
  provider.saveThread = saveThread;
  provider.streamChat = streamChat;
  provider.currentThread = currentThread;
  provider.postFileInfo = postFileInfo;

  context.subscriptions.push(
    vscode.commands.registerCommand('ajai.newThread', () => {
      currentThread = newThread();
      if (provider.webviewView) {
        provider.webviewView.webview.postMessage({ type: 'threadSet', id: currentThread.id });
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("ajaiChatView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(ed => {
      currentEditor = ed;
      if (provider.webviewView) postFileInfo(provider.webviewView.webview);
    })
  );
}


class ChatViewProvider {
  constructor(context) {
    this.context = context;
    this.webviewView = null;
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'src', 'media')]
    };

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'media', 'main.js')
    );

    let html = fs.readFileSync(
      path.join(this.context.extensionPath, 'src', 'media', 'webview.html'),
      'utf8'
    );

    // replace the plain src with a webview-safe URI
    html = html.replace('src="main.js"', `src="${scriptUri}"`);
    webview.html = html;
    postFileInfo(webview);

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ask") {
        if (typeof this.pushToHistory === 'function') {
          this.pushToHistory('user', msg.text);
        }else {
          console.warn('pushToHistory not available');
        }
        let answer = "";
        const port = vscode.workspace.getConfiguration().get("ajai.port") || 27121;
        const fileCtx = activeFileInfo();
        webview.postMessage({ type: "status", value: "Thinking…" });
        try {
          await streamChat(port, {
            message: msg.text,
            provider: msg.provider,
            model: msg.model,
            threadId: this.currentThread?.id,
            history: this.currentThread?.history,
            fileName: fileCtx?.name,
            fileContent: fileCtx?.text
          }, (delta) => {
            answer += delta;
            webview.postMessage({ type: "delta", value: delta });
          });
          if (typeof this.pushToHistory === 'function') {
            this.pushToHistory('assistant', answer);
          }
          webview.postMessage({ type: "done" });
        } catch (e) {
          webview.postMessage({ type: "error", value: e.message || String(e) });
        }
      }

      if (msg.type === "applyFix") {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.edit(editBuilder => {
            // Replace current selection with AI output
            const sel = editor.selection;
            if (!sel.isEmpty) {
              editBuilder.replace(sel, msg.text);
            } else {
              editBuilder.insert(sel.active, msg.text);
            }
          });
        }
      }
    });
  }
}

// Stream from orchestrator (/chat)
function streamChat(port, body, onDelta) {
  return new Promise((resolve, reject) => {
    if (!body.provider) body.provider = body.model.startsWith('glm') ? 'zai' : 'openrouter';
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      { host: "127.0.0.1", port, path: "/chat", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode}`));
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
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}


// Simple HTML UI
function getHtml(context) {
  const htmlPath = path.join(context.extensionPath, 'src', 'media', 'webview.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  const baseUri = vscode.Uri.joinPath(context.extensionUri, 'src', 'media');
  html = html.replace(
    /(<script\s+src=")(.+?)(">)/g,
    (m, pre, src, post) =>
      `${pre}${vscode.Uri.joinPath(baseUri, src)}${post}`
  );

  return html;
}


function deactivate(){}
module.exports = { activate, deactivate };
