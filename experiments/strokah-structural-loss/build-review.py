"""Validate the captured availability matrix and build its offline review gallery."""
from pathlib import Path
import json, hashlib
root=Path(__file__).resolve().parents[2]/'output/structural-loss/weak-final'
notes=[
'Leg purchase is shallow; weapon stays forward while the torso rests. Severed free arm settles outside the body.',
'Free palm reaches and pulls; both legs trail without a coordinated walking cycle. Weapon leaves with its arm.',
'Leg-only effort keeps the front hull down. Side views overlap debris; the opposite view resolves the two surviving legs.',
'Primary example: a detached articulated leg tumbles away; the other leg trails during the free-hand pull.',
'Only the right leg supplies a short shove while the weapon arm remains available. No alternating gait.',
'Free hand pulls with one passive trailing leg. Lost rifle and left leg move independently.',
'Right-leg-only shove is deliberately small. Chassis stays grounded; opposite view separates the survivor from debris.',
'Mirrored single-leg loss retains the slow hand pull and dragging left leg.',
'Left-leg shove is visibly shallow and followed by a full stop. Weapon remains in its original grip.',
'Free hand and left leg remain. Hand reach is smooth after removal of dropped-rifle target blending.',
'Left-leg-only shove advances the grounded torso. Nearby detached leg is clearer from the opposite angle.',
'With both legs gone, the free arm pulls while the weapon arm stays mostly passive; no balanced crawl.',
'Weapon-arm-only case lowers the held rifle to brace, then smoothly recovers aiming. Firing is blocked during brace.',
'Free-arm-only case reaches, pulls a small distance, and retracts slowly. Detached limbs no longer drive any actor joints.',
'No limbs: the chassis settles and has exactly zero self-propulsion. Articulated debris continues independently.'
]
counts=json.loads((root/'frame-counts.json').read_text())
rows=[json.loads(s) for s in (root/'matrix-audit.log').read_text().splitlines() if s.startswith('{')]
assert len(rows)==15
(root/'matrix-audit.json').write_text(json.dumps(rows,indent=2)+'\n')
cases=[]
for mask in range(1,16):
 t=json.loads((root/f'telemetry-{mask}.json').read_text());s=t['samples'];a=rows[mask-1];c=counts[str(mask)]
 assert t['identity']['worktree']=='8a6b' and len(s)==100 and c['frames']==100 and c['distinct']>30
 assert all(x['debris']==mask.bit_count() and x['armed']==(not bool(mask&2)) for x in s)
 assert all(x['force']==0 or (x['contactValid'] and not(mask & (1<<['arm.L','arm.R','leg.L','leg.R'].index(x['actor'])))) for x in s)
 assert a['invalidPlant']==0 and a['maxJointGap']<.01 and a['maxJointStep']<.35
 assert (a['distance']>0 and s[-1]['z']>.01) if mask<15 else (a['distance']==0 and all(x['force']==0 and x['z']==0 for x in s))
 assert hashlib.sha256((root/f'loss-{mask:02}.gif').read_bytes()).hexdigest()==c['sha256']
 names=['Left arm','Weapon arm','Left leg','Right leg'];lost=', '.join(n for i,n in enumerate(names) if mask&(1<<i))
 cases.append(dict(mask=mask,lost=lost,note=notes[mask-1],distance=round(a['distance']*100,2),peak=round(a['maxSpeed']*100,2),**c))
(root/'review-data.json').write_text(json.dumps(cases,indent=2)+'\n')
head='''# Damaged locomotion review

All 15 non-empty limb-loss combinations were captured from the actual model in the local Three.js 0.180.0 / Cannon 0.20.0 runtime (worktree 8a6b). Each five-second GIF contains 100 real rendered samples; decoded GIF frames and reach/effort/recovery poses were inspected. Side and opposite views reveal occluded survivors. Measurements below cover eleven simulated seconds; the GIF shows the first five seconds. These are candidate judgments, not user artistic acceptance.

The review led to fixes for free-hand target snapping, leg-solver branch jumps, abrupt weapon-brace recovery, ragdoll joint separation, and inward debris throws. The final motion has long rests, shallow efforts, ground contact and intermittent travel. No limb combination produces a balanced walking crawl.

Limitations: flat floor only; planar chassis dynamics, authored contact intent and approximate rigid-link collision boxes. Debris does not collide with the animated owner hull, so occasional overlap remains. Slope force is tested, not visually demonstrated as terrain traversal. No Unity integration or gameplay release.

[Interactive offline gallery](gallery.html) · [Intact baseline](baseline-intact.png) · [Numeric audit](matrix-audit.json)

| Lost limbs | 11s travel | Review |
|---|---:|---|
'''
for c in cases:head+=f"| [{c['lost']}](loss-{c['mask']:02}.gif) | {c['distance']} cm | {c['note']} |\n"
(root/'review-matrix.md').write_text(head)
html='''<!doctype html><meta charset="utf-8"><title>Strokah — damaged locomotion review</title><style>body{background:#142028;color:#e8eff0;font:16px system-ui;max-width:1080px;margin:32px auto;padding:0 24px}h1{font-size:28px}p{line-height:1.5;color:#c5d4d9}select,button{font:inherit;background:#293e49;color:white;border:1px solid #56717d;border-radius:6px;padding:10px;margin:5px}#motion{width:100%;max-width:800px}#keys{display:flex;flex-wrap:wrap}#keys img{width:32%;min-width:250px}a{color:#91d8e9}.stat{font-family:monospace}</style><h1>Strokah / damaged locomotion</h1><p>A grounded chassis, short efforts, long rests. Actual rig and articulated severed limbs. Local preview candidate; flat floor.</p><label>Lost limbs <select id="case"></select></label><button id="replay">Replay</button><p id="note"></p><p class="stat" id="stats"></p><img id="motion" alt="Five second runtime capture"><p>Reach / effort / recovery <select id="angle"><option>side</option><option>opposite</option></select></p><div id="keys"></div><p><a href="review-matrix.md">Full review</a> · <a href="baseline-intact.png">Intact baseline</a> · <a href="matrix-audit.json">11-second audit</a></p><p>Debris collides with the floor and other debris, but not its former animated hull. No Unity port or arbitrary-terrain claim.</p><script>const cases=DATA;const pick=document.getElementById('case');cases.forEach(c=>pick.add(new Option(c.mask+' — '+c.lost,c.mask)));pick.value=4;function show(){const c=cases[+pick.value-1];document.getElementById('note').textContent=c.note;document.getElementById('stats').textContent=`11s travel ${c.distance} cm · peak ${c.peak} cm/s · ${c.frames} frames / ${c.seconds}s`;document.getElementById('motion').src=`loss-${String(c.mask).padStart(2,'0')}.gif`;document.getElementById('keys').replaceChildren(...['reach','effort','recover'].map(p=>{const i=new Image();i.src=`key-${c.mask}-${p}-${document.getElementById('angle').value}.png`;i.alt=p;return i;}));}pick.onchange=show;document.getElementById('angle').onchange=show;document.getElementById('replay').onclick=()=>{const i=document.getElementById('motion');const s=i.src;i.src='';requestAnimationFrame(()=>i.src=s);};show();</script>'''.replace('DATA',json.dumps(cases))
(root/'gallery.html').write_text(html)
print('SHOWME_MATRIX_VERIFIED: 15 combinations, 1500 frames, contact and ownership gates passed')
