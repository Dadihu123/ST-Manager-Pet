/**
 * 阶段 0 冒烟插件前端：只做一件事——注册一个 `ambient` surface 并放一个纯色方块。
 *
 * 目的是在写任何宠物逻辑之前，用真实浏览器核对宿主容器契约（§2.1）：
 * 注册即挂载 / 不推挤内容区 / 框选不命中 / 正常 Tab 序 / 禁用即消失 /
 * `pointer-events: auto` 取回后能点 / 移动端不挂载。
 *
 * 方块自己把容器里的关键事实暴露到 `window.__petSmoke`，
 * 供 CDP 驱动脚本读取，不必依赖截图判断。
 */

export async function activate(api) {
  const report = {
    registeredKey: null,
    mountCount: 0,
    containerBox: null,
    clicks: 0,
    disposed: false,
  };
  globalThis.__petSmoke = report;
  // 把 api 暴露给 CDP 驱动脚本：验收用例 ⑦ 需要用**插件侧公开的** api
  // 开一个 modal surface 来触发 is-host-occluded（PluginHost 不在 window 上，
  // 是 ESM 具名导出，外部拿不到）。
  globalThis.__petSmokeApi = api;

  const key = api.surfaces.register("smoke", {
    type: "ambient",
    mount(container) {
      report.mountCount += 1;

      const box = document.createElement("div");
      // 宿主的 ambient shell 只带 `data-plugin`，**不带** `plugin-<id>` 类
      // （那是 `api.createRoot()` 才加的，而 createRoot 挂在 plugin-host-root 上，
      // 不是挂进 ambient 容器）。所以插件自己的根元素要**两个都写**，
      // 样式才有稳定的作用域根（见 docs/HOST_FEEDBACK.md）。
      box.className = "pet-smoke-box plugin-stm-pet-smoke";
      box.dataset.plugin = "stm-pet-smoke";
      box.textContent = "smoke";
      // 取回 pointer-events：容器整体是 none，不取回就点不动（§8 陷阱 1）
      box.addEventListener("click", () => {
        report.clicks += 1;
        // eslint-disable-next-line no-console
        console.log("[pet-smoke] box clicked", report.clicks);
      });
      container.appendChild(box);

      // 记录容器与方块的几何，供 CDP 断言「不推挤内容区」
      const measure = () => {
        const content = document.querySelector(".content-area");
        const boxRect = box.getBoundingClientRect();
        report.containerBox = {
          containerPosition: getComputedStyle(container).position,
          containerPointerEvents: getComputedStyle(container).pointerEvents,
          boxPointerEvents: getComputedStyle(box).pointerEvents,
          box: { x: boxRect.x, y: boxRect.y, w: boxRect.width, h: boxRect.height },
          contentArea: content
            ? { w: content.getBoundingClientRect().width, left: content.getBoundingClientRect().left }
            : null,
          shellClasses: container.parentElement ? container.parentElement.className : "",
          shellMarqueeIgnore: container.parentElement
            ? container.parentElement.getAttribute("data-marquee-ignore")
            : null,
          shellDataset: container.parentElement
            ? Object.assign({}, container.parentElement.dataset)
            : null,
          bodyHasScrim: document.body.classList.contains("has-fullscreen-scrim"),
        };
      };
      requestAnimationFrame(measure);
      window.addEventListener("resize", measure);
      report.measure = measure;

      return () => {
        report.disposed = true;
        window.removeEventListener("resize", measure);
      };
    },
  });

  report.registeredKey = key;
  // 宿主 `register()` 在桌面与移动端都返回 key（移动端只是不挂载，见 HOST_FEEDBACK）
  return () => {
    report.disposed = true;
  };
}

export function deactivate() {}
