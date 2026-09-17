import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
http
  .createServer((req, res) => {
    const p = path.resolve(
      root,
      "." +
        decodeURIComponent(
          new URL(req.url, "http://localhost").pathname === "/"
            ? "/experiments/strokah-pistol/preview.html"
            : new URL(req.url, "http://localhost").pathname,
        ),
    );
    if (!p.startsWith(root + "/")) return res.writeHead(403).end();
    fs.readFile(p, (e, b) => {
      if (e) return res.writeHead(404).end();
      res.setHeader(
        "Content-Type",
        {
          ".mjs": "text/javascript",
          ".js": "text/javascript",
          ".html": "text/html",
          ".json": "application/json",
        }[path.extname(p)] || "application/octet-stream",
      );
      res.end(b);
    });
  })
  .listen(4179, "127.0.0.1", () => console.log("http://127.0.0.1:4179"));
