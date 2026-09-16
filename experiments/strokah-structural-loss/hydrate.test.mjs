import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {verifyAsset} from './hydrate.mjs';
test('pinned release restores the actual rig and rejects corrupt bytes',async()=>{
 const release=JSON.parse(await fs.readFile(new URL('./asset-release.json',import.meta.url),'utf8'));
 const provenance=JSON.parse(await fs.readFile(new URL('./provenance.json',import.meta.url),'utf8'));
 assert.equal(release.sha256,provenance.sourceExportSha256);
 assert.ok(release.version_id&&release.archive_sha256&&release.member);
 const bytes=await fs.readFile(new URL('../../output/structural-loss/model.glb',import.meta.url));
 assert.equal(verifyAsset(bytes),bytes);
 const corrupt=Buffer.from(bytes);corrupt[0]^=1;
 assert.throws(()=>verifyAsset(corrupt),/Asset hash mismatch/);
});
