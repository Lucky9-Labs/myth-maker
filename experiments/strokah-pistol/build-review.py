from pathlib import Path
import subprocess,json,hashlib
from PIL import Image,ImageDraw,ImageFont
out=Path('output/pistol/review');report=[]
for side in ['right','left']:
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-framerate','20','-i',str(out/side/'%03d.png'),'-filter_complex','[0:v]scale=880:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=sierra2_4a','-loop','0',str(out/f'{side}.gif')],check=True)
 gif=Image.open(out/f'{side}.gif');frames=[];duration=0;hashes=set()
 for i in range(gif.n_frames):
  gif.seek(i);duration+=gif.info.get('duration',0);frame=gif.convert('RGB');hashes.add(hashlib.sha256(frame.tobytes()).hexdigest());
  if i in [0,10,18,28,40,58,76,90]:frames.append(frame.copy())
 report.append(dict(hand=side,frames=gif.n_frames,durationSeconds=duration/1000,distinctDecodedFrames=len(hashes)))
 sheet=Image.new('RGB',(4*440,2*304),'#16232b')
 for i,frame in enumerate(frames):sheet.paste(frame.resize((440,304)),((i%4)*440,(i//4)*304))
 sheet.save(out/f'{side}-decoded.jpg',quality=92)
labels=['recoil','recovery','grasp','extracted','reseated','returned'];sheet=Image.new('RGB',(6*330,2*320),'#16232b');draw=ImageDraw.Draw(sheet)
for row,side in enumerate(['R','L']):
 for col,label in enumerate(labels):
  im=Image.open(out/'keyframes'/f'{side}-{label}-action.png').convert('RGB').crop((250,40,1075,740));im.thumbnail((330,280));x=col*330;y=row*320;sheet.paste(im,(x+(330-im.width)//2,y+30));draw.text((x+12,y+9),f'{side} / {label.upper()}',fill='#e8edf0')
sheet.save(out/'fire-reload-comparison.jpg',quality=93)
# Matching cameras: one row per hand, side inspection plus locomotion and crawl.
states=['neutral','ready','walk','sprint','aim','crawl'];sheet=Image.new('RGB',(6*330,2*300),'#16232b');draw=ImageDraw.Draw(sheet)
for row,side in enumerate(['R','L']):
 for col,state in enumerate(states):
  im=Image.open(out/'keyframes'/f'{side}-{state}.png').convert('RGB').crop((250,0,1100,760));im.thumbnail((330,265));x=col*330;y=row*300;sheet.paste(im,(x+(330-im.width)//2,y+30));draw.text((x+12,y+9),f'{side} / {state.upper()}',fill='#e8edf0')
sheet.save(out/'state-matrix.jpg',quality=93)
(out/'gif-readback.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
