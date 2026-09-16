import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const model = path.resolve(root, "../../output/structural-loss/model.glb");
const mime = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".glb": "model/gltf-binary",
};
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file =
      url.pathname === "/model.glb"
        ? model
        : path.resolve(
            root,
            "." +
              (url.pathname === "/"
                ? "/preview.html"
                : decodeURIComponent(url.pathname)),
          );
    if (file !== model && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (e, s) => {
      if (e || !s.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(0, "127.0.0.1", function () {
    console.log(`http://127.0.0.1:${this.address().port}`);
  });
