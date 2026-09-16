async (page) => {
  await page.waitForFunction(() => !!window.review);
  await page.setViewportSize({ width: 1100, height: 720 });
  for (const [side, view, folder] of [
    ["L", "quarter", "left"],
    ["R", "rear", "right"],
  ]) {
    await page.evaluate(
      ({ side, view }) => {
        review.pause();
        review.controller.reset();
        document.getElementById("limb").value = `leg.${side}`;
        review.view(view);
      },
      { side, view },
    );
    for (let frame = 0; frame < 100; frame++) {
      await page.evaluate(
        ({ side, frame }) => {
          if ([0, 4, 8, 12, 16].includes(frame))
            review.controller.hit(`leg.${side}`, 30);
          if (frame === 65) review.controller.fire();
          review.step(3);
        },
        { side, frame },
      );
      await page.screenshot({
        path: `output/structural-loss/frames-${folder}/${String(frame).padStart(3, "0")}.png`,
      });
    }
  }
  await page.evaluate(() => {
    review.controller.reset();
    review.view("quarter");
  });
  for (let frame = 0; frame < 80; frame++) {
    await page.evaluate((frame) => {
      if (frame === 40) review.controller.reset();
      const n = frame % 40,
        side = frame < 40 ? "arm.L" : "arm.R";
      document.getElementById("limb").value = side;
      if ([0, 3, 6, 9, 12, 20, 22].includes(n)) review.controller.hit(side, 30);
      if (n === 26) review.controller.fire();
      review.step(3);
    }, frame);
    await page.screenshot({
      path: `output/structural-loss/frames-arms/${String(frame).padStart(3, "0")}.png`,
    });
  }
}
