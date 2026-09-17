async (page) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.reload();
  await page.waitForFunction(() => !!window.review);
  for (const side of ["R", "L"]) {
    await page.evaluate((side) => {
      review.pause();
      review.sequence(0, side);
      review.view("action");
      review.render();
    }, side);
    for (let frame = 0; frame < 96; frame++) {
      await page.evaluate(
        ({ frame, side }) => {
          review.sequence(frame / 20, side);
          review.render();
        },
        { frame, side },
      );
      await page.screenshot({
        path: `output/pistol/review/${side === "R" ? "right" : "left"}/${String(frame).padStart(3, "0")}.png`,
      });
    }
    for (const [state, t, label] of [
      ["fire", 0.045, "recoil"],
      ["fire", 0.5, "recovery"],
      ["reload", 0.52, "grasp"],
      ["reload", 1.2, "extracted"],
      ["reload", 1.85, "reseated"],
      ["reload", 2.399, "returned"],
    ])
      for (const view of ["action", "side"]) {
        await page.evaluate(
          ({ side, state, t, view }) => {
            review.sample(t, state, side);
            review.view(view);
            review.render();
          },
          { side, state, t, view },
        );
        await page.screenshot({
          path: `output/pistol/review/keyframes/${side}-${label}-${view}.png`,
        });
      }
    for (const state of [
      "neutral",
      "ready",
      "walk",
      "sprint",
      "aim",
      "crawl",
      "rifle",
    ]) {
      await page.evaluate(
        ({ side, state }) => {
          review.sample(0.5, state, side);
          review.view("front");
          review.render();
        },
        { side, state },
      );
      await page.screenshot({
        path: `output/pistol/review/keyframes/${side}-${state}.png`,
      });
    }
    await page.evaluate((side) => {
      review.sample(0.5, "aim", side);
      review.view("close");
      review.render();
    }, side);
    await page.screenshot({
      path: `output/pistol/review/keyframes/${side}-grip.png`,
    });
  }
  await page.evaluate(() => {
    review.sample(0, "ready", "R");
    review.view("front");
    review.render();
  });
};
