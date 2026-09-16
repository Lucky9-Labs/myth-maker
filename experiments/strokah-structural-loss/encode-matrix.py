"""Encode real runtime renders; retain exact per-case frame counts and hashes."""
from pathlib import Path
import subprocess,json,hashlib
from PIL import Image,ImageDraw
root=Path(__file__).resolve().parents[2]/'output/structural-loss/weak-final'
counts={}
for mask in range(1,16):
    frames=sorted((root/f'frames-{mask}').glob('*.png'))
    if len(frames)!=100: raise RuntimeError(f'Mask {mask}: expected 100 frames, got {len(frames)}')
    output=root/f'loss-{mask:02d}.gif'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-framerate','20','-i',str(root/f'frames-{mask}/%03d.png'),'-filter_complex','[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=3','-y',str(output)],check=True)
    counts[mask]={'frames':len(frames),'distinct':len({hashlib.sha256(p.read_bytes()).hexdigest() for p in frames}),'seconds':5,'fps':20,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(output),'-vf','select=eq(n\\,15)+eq(n\\,52)+eq(n\\,76)+eq(n\\,95),scale=400:-1,tile=2x2','-frames:v','1','-y',str(root/f'decoded-{mask:02d}.png')],check=True)
(root/'frame-counts.json').write_text(json.dumps(counts,indent=2)+'\n')
for phase in ['reach','effort','recover']:
    out=Image.new('RGB',(1500,5*230),(20,30,36));draw=ImageDraw.Draw(out)
    for i in range(15):
        mask=i+1;im=Image.open(root/f'key-{mask}-{phase}-side.png');im.thumbnail((490,205));x=(i%3)*500;y=(i//3)*230;out.paste(im,(x,y+25));draw.text((x+8,y+5),f'{mask}: lost '+','.join(n for j,n in enumerate(['AL','AR','LL','LR']) if mask&(1<<j)),fill='white')
    out.save(root/f'overview-{phase}.png')
