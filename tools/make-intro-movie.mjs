// 紹介ムービーの収録（タイトルのぷるぷる → 7面の戦い。テロップなし）。
// ゲーム本体には手を加えず、ムービー専用のコピー（/tmp/movie-index.html）で撮る：文字を太く、小さな水滴を減らす。
// 時間を仮想化して 1 フレームずつ進め、撮った画像を ffmpeg で mp4 にする。
// ボスに勝った（ゲームクリアになった）テイクだけを採用する。負けたら撮り直し。
//   使い方: node tools/make-intro-movie.mjs   → /tmp/boss-title/ と /tmp/boss-take-N/ に画像、成功したら intro.mp4 を作る
import { chromium } from '/home/naga3/src/etc/slime-lab/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'child_process';
import fs from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
// ムービー専用のコピー：タイトルの文字を太らせ、小さな水滴（中立の水）を減らして画面をすっきりさせる
const SRC = fs.readFileSync(ROOT + 'index.html', 'utf8');
const MOVIE = SRC
  .replace('const NEUT_DENSITY = 2;', 'const NEUT_DENSITY = 1;')
  .replace('  g.fillText(h1.textContent, cx, cy);', "  g.lineJoin = 'round'; g.strokeStyle = '#000'; g.lineWidth = size * 0.04; g.strokeText(h1.textContent, cx, cy);\n  g.fillText(h1.textContent, cx, cy);");
if (MOVIE === SRC || !MOVIE.includes('size * 0.04')) throw new Error('ムービー用コピーの書き換えに失敗');
fs.writeFileSync('/tmp/movie-index.html', MOVIE);
const URL_GAME = 'file:///tmp/movie-index.html';
const MAX_ATTEMPTS = Number(process.env.ATTEMPTS || 6);
const MAX_FRAMES = Number(process.env.MAX_FRAMES || 1500);   // 1 テイクの上限（30fps で 50 秒）
const TITLE_FRAMES = 150;                                    // タイトル（ぷるぷる）の長さ。30fps で 5 秒
const STAGE = 7;                                             // 見せる面（敵がほどよく大きく、撃ち合いも見せられる）
const MIN_FRAMES = 300;                                      // 勝つのが早すぎるテイクは撮り直し（30fps で 10 秒以上は見せる）
const FADE = 0.5;                                            // 場面のつなぎ（秒）
const TAIL = 0;                                              // 勝った直後（クリア表示が出る前）で切る                                             // クリア後に映し続けるフレーム数

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const INIT = () => {
  // 時間の仮想化：rAF は手動で進め、setTimeout は仮想時間で発火させる
  window.__cb = null; window.__now = 0; window.__timers = []; let id = 0;
  window.requestAnimationFrame = cb => { window.__cb = cb; return 1; };
  window.setTimeout = (fn, ms) => { window.__timers.push({ id: ++id, t: window.__now + (ms || 0), fn }); return id; };
  window.clearTimeout = i => { window.__timers = window.__timers.filter(x => x.id !== i); };
  window.__tick = () => {
    window.__now += 1000 / 30;
    const due = window.__timers.filter(x => x.t <= window.__now);
    window.__timers = window.__timers.filter(x => x.t > window.__now);
    due.forEach(x => x.fn());
    const cb = window.__cb; window.__cb = null;
    if (cb) cb(window.__base + window.__now);
    return window.__arena.over;
  };
  window.__bot = () => {
    const a = window.__arena, r = a.mainRoot[1];
    if (r < 0) return null;
    const mm = a.BM[r], cx = a.BX[r] / mm, cy = a.BY[r] / mm;
    let best = -1, bs = 0, thr = -1, td = 1e9, cpu = -1, cd = 1e9;
    for (let k = 0; k < a.n; k++) {
      const m = a.BM[k];
      if (!(m > 0) || a.OWN[k] === 1) continue;
      const x = a.BX[k] / m, y = a.BY[k] / m, d = Math.hypot(x - cx, y - cy);
      if (a.OWN[k] === 2 && d < cd) { cpu = k; cd = d; }
      if (a.OWN[k] === 2 && m > mm * 1.15) { if (d < 380 && d < td) { thr = k; td = d; } }
      else if (m < mm * .85) { const s = Math.sqrt(m) / (d + 60) * (a.OWN[k] === 2 ? 3 : 1); if (s > bs) { bs = s; best = k; } }
    }
    let tx = cx, ty = cy, shoot = null;
    if (thr >= 0) {
      const x = a.BX[thr] / a.BM[thr], y = a.BY[thr] / a.BM[thr];
      const l = Math.hypot(cx - x, cy - y) || 1;
      tx = Math.min(1240, Math.max(40, cx + (cx - x) / l * 260)); ty = Math.min(680, Math.max(40, cy + (cy - y) / l * 260));
      if (td < 330 && mm >= 40) shoot = [x - cx, y - cy];
    } else if (best >= 0) {
      tx = a.BX[best] / a.BM[best]; ty = a.BY[best] / a.BM[best];
      if (cpu >= 0 && cd < 360 && mm >= 50) shoot = [a.BX[cpu] / a.BM[cpu] - cx, a.BY[cpu] / a.BM[cpu] - cy];
    }
    return { tx, ty, shoot };
  };
};

async function openPage() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.addInitScript(INIT);
  await page.goto(URL_GAME);
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__base = performance.now() + 1000; });
  // ボタンは映さない（題名と一行の説明だけ）。操作説明・HUD も出さない
  await page.addStyleTag({ content: '*{transition:none!important}#hud,#help,#ui,#lab,#ttlBtns,#cnt,#goal,#stage,#intro{display:none!important}' });
  return { ctx, page };
}
const shotAt = (page, dir, f) => page.screenshot({ path: `${dir}/${String(f).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 92 });

// タイトル：しばらくぷるぷる揺らし、カーソルで文字をなぞって崩し、元に戻るところまで
async function titleScene() {
  const dir = '/tmp/boss-title';
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const { ctx, page } = await openPage();
  // マウスの速さは実時間で計算されるため、撮影の待ち時間で遅く見えてしまう。粒への影響（ptr）を、仮想時間の速さで直接与える
  const setPtr = (x, y, vx, vy, on) => page.evaluate(([x, y, vx, vy, on]) => { ptr.x = x; ptr.y = y; ptr.vx = vx; ptr.vy = vy; ptr.on = on; ptr.r = 60; }, [x, y, vx, vy, on]);
  const path = u => [250 + u * 780, 250 + Math.sin(u * 14) * 55];   // 文字の上を左から右へ、波打ちながらなぞる
  for (let f = 0; f < TITLE_FRAMES; f++) {
    if (f >= 30 && f < 80) {
      const u = (f - 30) / 50, du = 1 / 50, [x, y] = path(u), [x2, y2] = path(u + du);
      await setPtr(x, y, (x2 - x) * 30, (y2 - y) * 30, true);
    } else await setPtr(0, 0, 0, 0, false);
    await page.evaluate(() => window.__tick());
    await shotAt(page, dir, f);
  }
  await ctx.close();
  return dir;
}

async function take(n) {
  const dir = `/tmp/boss-take-${n}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { ctx, page } = await openPage();
  await page.evaluate(s => { __arena.startStage(s); }, STAGE);
  await page.mouse.move(640, 360);

  let f = 0, won = false, tail = 0;
  for (; f < MAX_FRAMES; f++) {
    if (!won) {
      const r = await page.evaluate(() => window.__bot());
      if (r) {
        await page.mouse.move(r.tx, r.ty);
        if (r.shoot) await page.evaluate(([dx, dy]) => window.__arena.shoot(1, dx, dy), r.shoot);
      }
    }
    const over = await page.evaluate(() => window.__tick());
    if (over === 2) { await ctx.close(); return { n, dir, result: 'lose', frames: f }; }
    if (over === 1) { won = true; break; }   // 勝った瞬間。クリア表示は映さない
    await shotAt(page, dir, f);
  }
  await ctx.close();
  return { n, dir, result: won && f >= MIN_FRAMES ? 'win' : won ? 'short' : 'timeout', frames: f };
}

const titleDir = await titleScene();
console.log('title done', TITLE_FRAMES, 'frames');
let chosen = process.env.REUSE_TAKE ? { dir: process.env.REUSE_TAKE, result: 'win', frames: 0 } : null;   // REUSE_TAKE=/tmp/boss-take-4 で、勝てたテイクを使い回す
for (let n = 1; n <= MAX_ATTEMPTS && !chosen; n++) {
  const r = await take(n);
  console.log('take', r.n, r.result, r.frames + 1, 'frames');
  if (r.result === 'win') chosen = r;
}
await b.close();
if (!chosen) { console.log('勝てたテイクがありませんでした'); process.exit(1); }
// 2 つの場面を mp4 にして、xfade でつなぎ、最後を暗転させる
const clips = [titleDir, chosen.dir];
const lens = clips.map(d => fs.readdirSync(d).filter(f => f.endsWith('.jpg')).length / 30);
clips.forEach((d, i) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', `${d}/%05d.jpg`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', `/tmp/clip-${i}.mp4`]));
const total = lens[0] + lens[1] - FADE;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', '/tmp/clip-0.mp4', '-i', '/tmp/clip-1.mp4',
  '-filter_complex', `[0][1]xfade=transition=fade:duration=${FADE}:offset=${lens[0] - FADE}[v1];[v1]fade=t=out:st=${total - 0.8}:d=0.8[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', ROOT + 'intro.mp4']);
console.log('intro.mp4 を作りました:', chosen.dir, lens.map(x => x.toFixed(1)).join('+'), '秒');
