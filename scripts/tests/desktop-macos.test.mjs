// Run after npm run build: 用 pnpm install 装好的 node_modules/electron/dist；
// 需要时可用 DSH_PET_ELECTRON=/path/to/Electron 覆盖。
// Uses an isolated mock host: no DSH credentials, conversations or user config are read/written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundledElectron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const executablePath = process.env.DSH_PET_ELECTRON || bundledElectron;

test(
  'macOS desktop: native geometry, HiDPI menu and click-through recovery',
  {
    skip: process.platform !== 'darwin' || !existsSync(executablePath),
    timeout: 30000,
  },
  async (t) => {
    const source = readFileSync(join(root, 'assets/config.jsonc'), 'utf8');
    const config = JSON.parse(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1'));
    config.pets = [
      {
        ...config.pets[0],
        size: 150,
        fixedEnabled: true,
        workStatusEnabled: false,
        position: { corner: 'top-left', marginX: 200, marginY: 0 },
      },
    ];
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path.endsWith('/config')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ main: config }));
      } else if (path.includes('/thumb/')) {
        const file = join(root, 'assets/webm', basename(path));
        if (!existsSync(file)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader('content-type', 'video/webm');
        createReadStream(file).pipe(res);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let app;
    try {
      const env = {
        ...process.env,
        DSH_PET_SMOKE: '0',
        DSH_PET_CONFIG_URL: `http://127.0.0.1:${server.address().port}/dsh-pet-7340/config`,
        DSH_PET_PETS: JSON.stringify([{ id: 'main', size: 150 }]),
        DSH_PET_SCALE: '1',
      };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({ executablePath, args: [join(root, 'runtime/electron-helper/main.js')], env });
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.__dshPetDebug?.configOk);
      await page.waitForFunction(() => document.visibilityState === 'visible');
      await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const original = win.setIgnoreMouseEvents.bind(win);
        win.testIgnoring = true;
        win.setIgnoreMouseEvents = (value, options) => {
          win.testIgnoring = value;
          original(value, options);
        };
        // Control the fallback cursor deterministically without moving the user's physical pointer.
        screen.getCursorScreenPoint = () => ({ x: -9999, y: -9999 });
      });

      await t.test('Retina uses native point coordinates, menu scale remains 1x, head reaches panel top', async () => {
        const actual = await app.evaluate(({ BrowserWindow, screen }) => ({
          bounds: BrowserWindow.getAllWindows()[0].getContentBounds(),
          zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
          focused: BrowserWindow.getAllWindows()[0].isFocused(),
          display: screen.getPrimaryDisplay().bounds,
          scale: screen.getPrimaryDisplay().scaleFactor,
        }));
        const hit = await page.locator('.pet-hit').boundingBox();
        t.diagnostic(JSON.stringify({ ...actual, hit }));
        assert.equal(actual.zoom, 1);
        assert.equal(actual.bounds.width, 300);
        assert.ok(Math.abs(actual.bounds.y + hit.y - actual.display.y) <= 1);
        assert.equal(actual.focused, false, 'starting the pet must not activate its window');
      });

      await t.test('throw ceiling and negative margin retain the physical top coordinate', async () => {
        const geometry = await page.evaluate(`(() => {
        const s = sprites[0];
        const head = s.hitRect.y;
        const ceiling = s.throwSpaceOf().bounds[0].minY + head + VIEW.y;
        s.pet.position.marginY = -20;
        s.position();
        const negative = s.pos.y + head + VIEW.y;
        s.pet.position.marginY = 0;
        s.position();
        return { ceiling, negative };
      })()`);
        assert.equal(geometry.ceiling, 0);
        assert.ok(Math.abs(geometry.negative + 20) <= 1);
      });

      await t.test(
        'right-click opens a narrow, tall menu in its own window beside the pet, draggable and closable',
        async () => {
          // Use a larger pet so the menu window has a body rect beside it.
          await page.evaluate(`(() => {
        config.pets[0].size = 462;
        config.pets[0].position.marginY = 100;
        sprites[0].dispose();
        sprites = [new PetSprite(config.pets[0])];
      })()`);
          // 等布局落定：紧接着 new 出来的 hit 还没量出 rect，菜单拿不到宠物身体位置
          await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          const menuPagePromise = app.waitForEvent('window');
          await page.evaluate(`(() => {
        const s = sprites[0], r = s.hit.getBoundingClientRect();
        s.onContextMenu(new MouseEvent('contextmenu', {clientX:r.x+r.width/2, clientY:r.y+r.height/2}));
      })()`);
          const menuPage = await menuPagePromise;
          await menuPage.waitForSelector('.dsh-pet-menu-panel');
          assert.equal(await page.evaluate('sprites[0].menuOpen'), true);

          const menuBounds = () =>
            app.evaluate(({ BrowserWindow }) => {
              const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('menu.html'));
              return win && !win.isDestroyed() ? win.getContentBounds() : null;
            });
          const initialBounds = await menuBounds();
          assert.ok(initialBounds, 'menu window must exist');
          assert.ok(initialBounds.width <= 360, `detached menu should be narrow, got ${initialBounds.width}`);

          const panel = await menuPage.evaluate(`(() => {
          const el = document.querySelector('.dsh-pet-menu-panel');
          const r = el.getBoundingClientRect();
          return { width: r.width, font: parseFloat(getComputedStyle(el).fontSize) };
        })()`);
          assert.ok(panel.width <= 320, `panel width should be narrow, got ${panel.width}`);
          assert.ok(panel.font <= 16, `menu font unexpectedly doubled: ${panel.font}`);
          assert.equal(await menuPage.evaluate('document.querySelectorAll(".dsh-pet-menu-column").length'), 0);

          // 动作/串门这类大分组默认收起，避免一次铺满整屏；点开后面板长高并出现滚动区
          const actionSection = `[...document.querySelectorAll('details.dsh-pet-menu-section')].find(
            (d) => (d.querySelector('summary')?.textContent || '').includes('动作'))`;
          assert.equal(
            await menuPage.evaluate(`(() => { const d = ${actionSection}; return !d || !d.open; })()`),
            true,
          );
          await menuPage.evaluate(
            `(() => { const d = ${actionSection}; if (d) d.querySelector('summary').click(); })()`,
          );
          await assertEventually(async () => {
            const after = await menuBounds();
            return !!after && after.height > initialBounds.height;
          });
          const bounds = await menuBounds();
          assert.ok(bounds.height > bounds.width, `expanded menu should be tall, got ${bounds.width}x${bounds.height}`);
          assert.equal(
            await menuPage.evaluate(`(() => { const d = ${actionSection}; return !!d && d.open; })()`),
            true,
          );

          // 和宠物身体不重叠（可以压住窗口的透明余量，但不能盖住宠物本体）
          const body = await page.evaluate(`(() => {
          const r = sprites[0].hit.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })()`);
          const petBounds = await app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
            return win ? win.getContentBounds() : null;
          });
          assert.ok(petBounds, 'pet window must exist');
          const bodyScreen = {
            x: petBounds.x + body.x,
            y: petBounds.y + body.y,
            w: body.w,
            h: body.h,
          };
          assert.ok(
            bounds.x >= bodyScreen.x + bodyScreen.w ||
              bounds.x + bounds.width <= bodyScreen.x ||
              bounds.y >= bodyScreen.y + bodyScreen.h ||
              bounds.y + bounds.height <= bodyScreen.y,
            `menu window must not cover the pet body: ${JSON.stringify({ bounds, bodyScreen })}`,
          );

          // 拖标题移动整个菜单窗口
          const before = bounds;
          await menuPage.evaluate(`(() => {
          const title = document.querySelector('.dsh-pet-menu-title');
          const r = title.getBoundingClientRect();
          const sx = Math.round(window.screenX + r.x + 10);
          const sy = Math.round(window.screenY + r.y + 5);
          title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r.x + 10, clientY: r.y + 5, screenX: sx, screenY: sy }));
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: r.x + 40, clientY: r.y + 25, screenX: sx + 30, screenY: sy + 20 }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, screenX: sx + 30, screenY: sy + 20 }));
        })()`);
          await assertEventually(async () => {
            const after = await menuBounds();
            return !!after && (after.x !== before.x || after.y !== before.y);
          });

          // Esc 收起：菜单窗口消失、宠物状态复位
          await menuPage.evaluate(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          );
          await assertEventually(async () => (await menuBounds()) === null);
          await assertEventually(async () => (await page.evaluate('sprites[0].menuOpen')) === false);
          assert.equal(await page.evaluate('sprites[0].inputBusy()'), false);
        },
      );

      await t.test('chat input stays usable while its surrounding transparent area passes through', async () => {
        await page.evaluate('sprites[0].showChatFromMenu()');
        await page.waitForSelector('.dsh-pet-chat');
        const bounds = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
          return win ? win.getContentBounds() : null;
        });
        const chat = await page.locator('.dsh-pet-chat').boundingBox();
        await app.evaluate(
          ({ screen }, p) => {
            screen.getCursorScreenPoint = () => p;
          },
          {
            x: bounds.x + chat.x + chat.width / 2,
            y: bounds.y + chat.y + chat.height / 2,
          },
        );
        await assertEventually(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
            return win ? !win.testIgnoring : false;
          }),
        );
        await page
          .locator('.dsh-pet-chat-input')
          .fill('测试输入：长文本增长后仍然可以点击聊天框，旁边的应用保持可点击。'.repeat(4));
        const expanded = await page.locator('.dsh-pet-chat').boundingBox();
        assert.ok(expanded.height > chat.height);
        await app.evaluate(
          ({ screen }, p) => {
            screen.getCursorScreenPoint = () => p;
          },
          {
            x: bounds.x + expanded.x + expanded.width / 2,
            y: bounds.y + expanded.y + expanded.height - 5,
          },
        );
        await assertEventually(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
            return win ? !win.testIgnoring : false;
          }),
        );
        await app.evaluate(
          ({ screen }, p) => {
            screen.getCursorScreenPoint = () => p;
          },
          {
            x: bounds.x + 2,
            y: bounds.y + bounds.height - 2,
          },
        );
        await assertEventually(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
            return win ? win.testIgnoring === true : false;
          }),
        );
        assert.equal(await page.evaluate('sprites[0].chatOpen'), true);
        // 宠物贴屏边时窗口会随余量收缩：面板要按新视口重新落位，右侧不能被窗口裁掉
        await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
          win?.setContentSize(260, 240);
        });
        await assertEventually(async () => {
          const box = await page.locator('.dsh-pet-chat').boundingBox();
          const width = await page.evaluate('innerWidth');
          return !!box && box.x >= 0 && box.x + box.width <= width + 0.5;
        });
        await page.evaluate('sprites[0].chatClose()');
        assert.equal(await page.evaluate('sprites[0].inputBusy()'), false);
      });

      await t.test('missing pointerup and switching apps release stuck dragging/menu input', async () => {
        await page.evaluate(`(() => {
        const s = sprites[0];
        s.dragState.active = true;
        s.syncInputBusy();
        s.setInteractive(true);
        s.onMouseMove(new MouseEvent('mousemove', { buttons: 0, clientX: 0, clientY: 0 }));
      })()`);
        assert.equal(await page.evaluate('sprites[0].dragState.active'), false);
        await page.evaluate(`(() => {
        const s = sprites[0];
        s.menuOpen = true;
        s.syncInputBusy();
        s.setInteractive(true);
        window.dispatchEvent(new Event('blur'));
      })()`);
        assert.equal(await page.evaluate('sprites[0].inputBusy()'), false);
        await assertEventually(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('menu.html'));
            return win ? win.testIgnoring === true : false;
          }),
        );
      });
    } finally {
      if (app) await app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

async function assertEventually(check) {
  for (let i = 0; i < 20; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('native window did not restore click-through');
}
