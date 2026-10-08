// Large drawing window: show the captured screenshot and let the user either
// drag a box (click / double_click bbox) or draw a start->end arrow (drag).
(async () => {
  const { drawScreenshot, drawAction } = await chrome.storage.local.get([
    "drawScreenshot",
    "drawAction",
  ]);
  const action =
    drawAction === "double_click" || drawAction === "drag" ? drawAction : "click";
  const isDrag = action === "drag";
  const img = document.getElementById("shot");
  const wrap = document.getElementById("wrap");
  const status = document.getElementById("status");
  if (!drawScreenshot) {
    status.textContent = "스크린샷을 불러오지 못했어요.";
    return;
  }
  img.src = drawScreenshot;
  const title = document.getElementById("draw-title");
  if (title)
    title.textContent = isDrag
      ? "드래그 (시작점 → 끝점)"
      : action === "double_click"
        ? "더블클릭 영역 그리기"
        : "클릭 영역 그리기";

  let bbox = null; // normalized {left, top, width, height} for click/double_click
  let dragPts = null; // {start:{x,y}, end:{x,y}} normalized for drag
  let drawing = false;
  let startX = 0;
  let startY = 0;
  let boxEl = null;
  let svgEl = null;
  let lineEl = null;

  function clearShapes() {
    if (boxEl) { boxEl.remove(); boxEl = null; }
    if (svgEl) { svgEl.remove(); svgEl = null; lineEl = null; }
  }

  img.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const r = img.getBoundingClientRect();
    drawing = true;
    startX = event.clientX - r.left;
    startY = event.clientY - r.top;
    clearShapes();
    if (isDrag) {
      const NS = "http://www.w3.org/2000/svg";
      svgEl = document.createElementNS(NS, "svg");
      Object.assign(svgEl.style, {
        position: "absolute",
        left: "0",
        top: "0",
        pointerEvents: "none",
        overflow: "visible",
      });
      svgEl.setAttribute("width", r.width);
      svgEl.setAttribute("height", r.height);
      svgEl.innerHTML =
        '<defs><marker id="ah" markerWidth="12" markerHeight="12" refX="9" refY="3.5" orient="auto">' +
        '<path d="M0,0 L9,3.5 L0,7 Z" fill="red"/></marker></defs>';
      lineEl = document.createElementNS(NS, "line");
      lineEl.setAttribute("stroke", "red");
      lineEl.setAttribute("stroke-width", "3");
      lineEl.setAttribute("marker-end", "url(#ah)");
      lineEl.setAttribute("x1", startX);
      lineEl.setAttribute("y1", startY);
      lineEl.setAttribute("x2", startX);
      lineEl.setAttribute("y2", startY);
      svgEl.appendChild(lineEl);
      wrap.appendChild(svgEl);
    } else {
      boxEl = document.createElement("div");
      Object.assign(boxEl.style, {
        position: "absolute",
        border: "2px solid red",
        background: "rgba(255,0,0,0.12)",
        pointerEvents: "none",
        left: startX + "px",
        top: startY + "px",
        width: "0px",
        height: "0px",
      });
      wrap.appendChild(boxEl);
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (!drawing) return;
    const r = img.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - r.left, 0), r.width);
    const y = Math.min(Math.max(event.clientY - r.top, 0), r.height);
    if (isDrag) {
      lineEl.setAttribute("x2", x);
      lineEl.setAttribute("y2", y);
    } else {
      boxEl.style.left = Math.min(startX, x) + "px";
      boxEl.style.top = Math.min(startY, y) + "px";
      boxEl.style.width = Math.abs(x - startX) + "px";
      boxEl.style.height = Math.abs(y - startY) + "px";
    }
  });

  window.addEventListener("mouseup", (event) => {
    if (!drawing) return;
    drawing = false;
    const r = img.getBoundingClientRect();
    if (isDrag) {
      const ex = Math.min(Math.max(event.clientX - r.left, 0), r.width);
      const ey = Math.min(Math.max(event.clientY - r.top, 0), r.height);
      dragPts = {
        start: { x: startX / r.width, y: startY / r.height },
        end: { x: ex / r.width, y: ey / r.height },
      };
      status.textContent = "드래그 선택됨 — '저장'을 누르세요";
    } else {
      bbox = {
        left: parseFloat(boxEl.style.left) / r.width,
        top: parseFloat(boxEl.style.top) / r.height,
        width: parseFloat(boxEl.style.width) / r.width,
        height: parseFloat(boxEl.style.height) / r.height,
      };
      status.textContent = "영역 선택됨 — '저장'을 누르세요";
    }
  });

  document.getElementById("save").addEventListener("click", async () => {
    if (isDrag) {
      if (!dragPts) {
        status.textContent = "먼저 시작점에서 끝점으로 드래그하세요.";
        return;
      }
      const dx = Math.abs(dragPts.end.x - dragPts.start.x);
      const dy = Math.abs(dragPts.end.y - dragPts.start.y);
      if (dx < 0.005 && dy < 0.005) {
        status.textContent = "드래그 거리가 너무 짧아요.";
        return;
      }
      await chrome.runtime.sendMessage({
        type: "recordDrawnBbox",
        screenshot: drawScreenshot,
        action: "drag",
        start_pct: dragPts.start,
        end_pct: dragPts.end,
        note: "manual drag",
        timestamp: Date.now(),
      });
      window.close();
      return;
    }
    if (!bbox || bbox.width < 0.005 || bbox.height < 0.005) {
      status.textContent = "먼저 영역을 드래그하세요.";
      return;
    }
    await chrome.runtime.sendMessage({
      type: "recordDrawnBbox",
      screenshot: drawScreenshot,
      bbox_pct: bbox,
      action,
      note: action === "double_click" ? "manual double_click bbox" : "manual bbox",
      timestamp: Date.now(),
    });
    window.close();
  });

  document.getElementById("cancel").addEventListener("click", () => window.close());
})();
