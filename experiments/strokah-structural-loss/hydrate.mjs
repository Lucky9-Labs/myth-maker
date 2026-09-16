import fs from "node:fs/promises";
import crypto from "node:crypto";
const source = process.argv[2];
if (!source)
  throw Error(
    "Pass the accepted strokah-stable-gait-v10.glb path. Source is read-only.",
  );
const buffer = await fs.readFile(source);
const hash = crypto.createHash("sha256").update(buffer).digest("hex");
if (hash !== "fae1894b712c42a80385a586802b0931c51ef372348aec450caec33bbfcc23fb")
  throw Error(`Wrong accepted source hash: ${hash}`);
const target = new URL("../../output/structural-loss/", import.meta.url);
await fs.mkdir(target, { recursive: true });
await fs.writeFile(new URL("model.glb", target), buffer);
console.log("Accepted source copied to output/structural-loss/model.glb");
