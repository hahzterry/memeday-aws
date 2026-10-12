// Stand-in for @/lib/db in test/buffer-motd.test.js, so importing the cron
// route needs no AWS credentials or DynamoDB table. The test sets the meme to
// return on globalThis.__bufferMotd and can read back how often it was asked.
const state = (globalThis.__bufferMotd ??= { meme: null, calls: 0 });

export async function getMemeOfDay() {
  state.calls += 1;
  return state.meme;
}
