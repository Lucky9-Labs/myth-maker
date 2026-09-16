async (page) => {
  await page.waitForFunction(()=>!!window.review);
  await page.setViewportSize({width:1100,height:720});
  await page.evaluate(()=>review.pause());
  const begin=await page.evaluate(()=>Number(new URL(location.href).searchParams.get('begin')||1));
  for(let mask=begin;mask<Math.min(16,begin+3);mask++){
    await page.locator('#combination').selectOption(String(mask));
    await page.evaluate(()=>{review.view('quarter');review.render();});
    const samples=[];
    for(let frame=0;frame<100;frame++){
      samples.push(await page.evaluate(()=>review.step(3)));
      await page.screenshot({path:`output/structural-loss/weak-final/frames-${mask}/${String(frame).padStart(3,'0')}.png`,clip:{x:300,y:100,width:800,height:540}});
    }
    const downloadPromise=page.waitForEvent('download');
    await page.evaluate(({mask,samples})=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({mask,identity:review.identity,samples})],{type:'application/json'}));a.download=`telemetry-${mask}.json`;a.click();},{mask,samples});
    await (await downloadPromise).saveAs(`output/structural-loss/weak-final/telemetry-${mask}.json`);
    for(const [name,frame]of [['reach',195],['effort',232],['recover',280]]){
      await page.locator('#combination').selectOption(String(mask));
      await page.evaluate(frame=>review.step(frame),frame);
      for(const angle of ['side','opposite']){
        await page.evaluate(angle=>{review.view(angle);review.render();},angle);
        await page.screenshot({path:`output/structural-loss/weak-final/key-${mask}-${name}-${angle}.png`,clip:{x:300,y:100,width:800,height:540}});
      }
    }
  }
}
