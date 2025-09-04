const fs = require('fs');
const path = require('path');
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
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("ajaiChatView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

class ChatViewProvider {
  constructor(context) {
    this.context = context;
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
