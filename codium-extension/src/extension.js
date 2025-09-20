// extension.js — patched version
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
    // newThread is declared later, but we can call a minimal version for startup:
    currentThread = { id: Date.now().toString(36), history: [] };
    // persist via saveThread once saveThread exists below
  }

  // Register chat view provider instance
  const provider = new ChatViewProvider(context);

  // Ensure provider has threads array based on stored workspaceState
  provider.threads = Object.values(all || {});
  provider.getThreads = () => provider.threads || [];
  provider.getThreadById = (id) => (provider.threads || []).find(t => t.id === id);
  provider.currentThread = currentThread;

  function newThread() {
    const id = Date.now().toString(36);
    const t = { id, history: [], title: `Thread ${id.slice(-4)}` };
    // update provider state immediately
    provider.threads = provider.threads || [];
    provider.threads.unshift(t); // add to front
    provider.currentThread = t;
    currentThread = t;
    return t;
  }

  async function saveThread(t) {
    if (!globalContext) {
      return;
    }
    const allObj = globalContext.workspaceState.get(STORE_KEY, {});
    allObj[t.id] = t;
    await globalContext.workspaceState.update(STORE_KEY, allObj);
    await globalContext.workspaceState.update('ajai.currentThread', t.id);

    // keep provider in sync
    provider.threads = Object.values(allObj || {});
    provider.currentThread = t;
  }

  function pushToHistory(role, content) {
    if (!currentThread) {
      currentThread = newThread();
    }
    currentThread.history = currentThread.history || [];
    currentThread.history.push({ role, content, ts: Date.now() });
    if (currentThread.history.length > 50) {
      currentThread.history.shift();
    }
    // persist and update provider
    Promise.resolve(saveThread(currentThread)).catch(e => console.warn("saveThread failed", e));

    // Notify webview (if present)
    try {
      if (provider && provider.webviewView && provider.webviewView.webview) {
        provider.webviewView.webview.postMessage({
          type: 'historyUpdate',
          thread: currentThread
        });
      }
    } catch (e) {
      console.warn('Failed to post history update to webview', e);
    }
  }

  // Attach helpers to provider instance for resolveWebviewView to use via this.*
  provider.pushToHistory = pushToHistory;
  provider.newThread = newThread;
  provider.saveThread = saveThread;
  provider.streamChat = streamChat;
  provider.currentThread = currentThread;
  provider.postFileInfo = postFileInfo;

  // Command: open/focus chat
  context.subscriptions.push(
    vscode.commands.registerCommand("ajai.openChat", async () => {
      await vscode.commands.executeCommand("ajaiChatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ajai.newThread', () => {
      const t = newThread();
      // update persistent storage
      saveThread(t).catch(() => {});
      if (provider.webviewView) {
        provider.webviewView.webview.postMessage({ type: 'threadSet', id: provider.currentThread.id });
        // also send a threads list update
        provider.webviewView.webview.postMessage({
          type: 'threadCreated',
          thread: provider.currentThread,
          threads: provider.getThreads(),
          currentThread: provider.currentThread
        });
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
    // other instance fields may be attached later in activate()
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    const webview = webviewView.webview;

    // send initial state using this.* (instance) — provider variable is not available here
    webview.postMessage({
      type: 'init',
      threads: (typeof this.getThreads === 'function') ? this.getThreads() : (this.threads || []),
      currentThread: this.currentThread || null
    });

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
      // Ask
      if (msg.type === "ask") {
        if (typeof this.pushToHistory === 'function') {
          this.pushToHistory('user', msg.text);
        } else {
          console.warn('pushToHistory not available on provider instance');
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
        return;
      }

      // Apply fix into editor
      if (msg.type === "applyFix") {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.edit(editBuilder => {
            const sel = editor.selection;
            if (!sel.isEmpty) {
              editBuilder.replace(sel, msg.text);
            } else {
              editBuilder.insert(sel.active, msg.text);
            }
          });
        }
        return;
      }

      // New thread request from webview
      if (msg.type === 'newThread') {
        try {
          const thread = (typeof this.newThread === 'function') ? this.newThread() : (function fallbackNewThread(){
            return { id : String(Date.now()), title: 'New Thread', history: [] };
          })();

          if (typeof this.saveThread === 'function') {
            await this.saveThread(thread);
          }

          // ensure instance pointer is current
          this.currentThread = thread;

          const threads = (typeof this.getThreads === 'function') ? this.getThreads() : (this.threads || []);

          webview.postMessage({
            type: 'threadCreated',
            thread: this.currentThread,
            threads: threads,
            currentThread: this.currentThread,
          });
        } catch (err) {
          webview.postMessage({
            type: 'error',
            value: err.message || String(err)
          });
        }
        return;
      }

      // History snapshot request
      if (msg.type === 'history') {
        webview.postMessage({
          type: 'historyUpdate',
          thread: this.currentThread
        });
        return;
      }

      // Switch thread
      if (msg.type === 'switchThread') {
        const id = msg.id;
        let found = null;
        if (typeof this.getThreadById === 'function') {
          found = this.getThreadById(id);
        } else if (Array.isArray(this.threads)) {
          found = this.threads.find(t => t.id === id);
        }
        if (found) {
          this.currentThread = found;
          webview.postMessage({ type: 'historyUpdate', thread: this.currentThread });
        } else {
          webview.postMessage({ type: 'error', value: 'Thread not found: ' + id });
        }
        return;
      }

      // unknown message — ignore or log
      // console.log('unhandled webview message', msg);
    });
  }
}

// Stream from orchestrator (/chat)
function streamChat(port, body, onDelta) {
  return new Promise((resolve, reject) => {
    if (!body.provider) body.provider = body.model && body.model.startsWith && body.model.startsWith('glm') ? 'zai' : 'openrouter';
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
