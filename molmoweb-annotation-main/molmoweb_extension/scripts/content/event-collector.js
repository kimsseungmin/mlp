// Track timing locally in content script to block events immediately
let lastEventTime = 0;
let secondLastEventTime = 0;
const MIN_EVENT_GAP = 950;

// Debouncing for input and selection events
const INPUT_IDLE_MS = 500;
const SELECTION_IDLE_MS = 200;
let lastInputPayload = null;
let inputDebounceTimer = null;
let lastSelectionPayload = null;
let selectionDebounceTimer = null;

function shouldBlockEvent(eventTimestamp) {
  // Speed limiting disabled: it blocked rapid actions and showed a red
  // "performing actions too quickly" banner that polluted screenshots.
  return false;
}

function updateEventTiming(eventTimestamp) {
  secondLastEventTime = lastEventTime;
  lastEventTime = eventTimestamp;
}

async function processEvent(event, domEvent, takeScreenshot) {
  // Check timing for all events
  if (shouldBlockEvent(event.timestamp) && takeScreenshot) {
    if (domEvent && domEvent.preventDefault) {
      domEvent.preventDefault();
      domEvent.stopPropagation();
    }

    showSpeedWarning(
      "You are performing actions too quickly. Please slow down and try this action again.",
    );
    console.warn(
      `Event blocked: Only ${event.timestamp - secondLastEventTime}ms since two events ago (minimum: ${MIN_EVENT_GAP}ms)`,
    );
  }

  // Update timing for successful events
  updateEventTiming(event.timestamp);

  // Send to background script
  const documentAsHtml = null;
  try {
    await chrome.runtime.sendMessage({
      type: "recordInteraction",
      event,
      html: documentAsHtml,
      takeScreenshot: takeScreenshot,
    });
    console.log("Interaction recorded successfully:", event.type);
  } catch (error) {
    console.error("Failed to record interaction:", event.type, error);
  }
}

async function recordInteraction(event, domEvent, takeScreenshot = true) {
  console.log(event.type, event);

  if (event.type === "input") {
    // Debounce input events
    lastInputPayload = { event, domEvent };
    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
      processEvent(
        lastInputPayload.event,
        lastInputPayload.domEvent,
        takeScreenshot,
      );
      lastInputPayload = null;
      inputDebounceTimer = null;
    }, INPUT_IDLE_MS);
    return Promise.resolve();
  }

  if (event.type === "selection") {
    // Debounce selection events
    lastSelectionPayload = { event, domEvent };
    if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = setTimeout(() => {
      processEvent(
        lastSelectionPayload.event,
        lastSelectionPayload.domEvent,
        takeScreenshot,
      );
      lastSelectionPayload = null;
      selectionDebounceTimer = null;
    }, SELECTION_IDLE_MS);
    return Promise.resolve();
  }

  await processEvent(event, domEvent, takeScreenshot);
  return Promise.resolve();
}

function addListeners() {
  window.isScrolling = false;
  window.scrollStartPos = { x: window.scrollX, y: window.scrollY };
  window.scrollStartTime = Date.now();
  window.cursorPos = { x: undefined, y: undefined };

  // variables to track drag and drop using
  // heuristic: mouse down + movement + mouse up
  let mouseDownCoords = null;
  let mouseDownTime = null;
  let mouseDownTarget = null;

  function getBoundingBox(target) {
    if (target instanceof HTMLElement) {
      return target.getBoundingClientRect();
    }
    return undefined;
  }

  // Nearest *semantic* control (sized to the control itself). Intentionally
  // narrow — [tabindex]/[onclick]/cursor:pointer are excluded because they match
  // big wrapper <div>s (e.g. a whole header nav) and overshoot the real target.
  const INTERACTIVE_SELECTOR =
    'a[href], button, input, select, textarea, summary, label, ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="menuitemradio"], [role="tab"], [role="checkbox"], [role="radio"], ' +
    '[role="option"], [role="switch"]';

  // bbox of the clicked control: the nearest semantic control, else the exact
  // element clicked. If the matched control is huge (a big wrapper) fall back to
  // the exact element so the box stays tight around what was clicked.
  function getClickableBox(target) {
    if (!(target instanceof Element)) return undefined;
    const el = target.closest(INTERACTIVE_SELECTOR) || target;
    const rect = el.getBoundingClientRect();
    const vp = (window.innerWidth || 1) * (window.innerHeight || 1);
    // If the chosen element covers more than half the viewport it isn't a
    // meaningful click target: clicking empty space resolves to <html>/<body>,
    // or an interactive wrapper is huge. Prefer the actual target; if that's
    // still oversized, return {} so no bogus giant box is drawn (the click
    // point x,y is recorded separately and still shows).
    if ((rect.width * rect.height) / vp > 0.5) {
      if (el !== target) {
        const tr = target.getBoundingClientRect();
        if ((tr.width * tr.height) / vp <= 0.5) return tr;
      }
      return {};
    }
    return rect;
  }

  // Record the starting scroll position when scrolling begins
  window.addEventListener(
    "scroll",
    (event) => {
      // avoid auto-scrolls from clicks
      if (pointerdown_captured === true) {
        return;
      }
      if (!isScrolling) {
        isScrolling = true;
        const target = event.target === document ? window : event.target;
        scrollStartPos = {
          x: target === window ? window.scrollX : target.scrollLeft,
          y: target === window ? window.scrollY : target.scrollTop,
        };
        scrollStartTime = Date.now();
      }

      // Cancel drag detection if user starts scrolling
      if (mouseDownCoords) {
        mouseDownCoords = null;
        mouseDownTime = null;
        mouseDownTarget = null;
      }
    },
    { capture: true },
  );

  // Get cursor position
  window.addEventListener("mousemove", (event) => {
    cursorPos = { x: event.clientX, y: event.clientY };
  });

  // Use the scrollend event to detect when scrolling stops
  window.addEventListener(
    "scrollend",
    (event) => {
      const target = event.target === document ? window : event.target;
      scrollEndPos = {
        x: target === window ? window.scrollX : target.scrollLeft,
        y: target === window ? window.scrollY : target.scrollTop,
      };
      const scrollEndTime = Date.now();

      const deltaX = scrollEndPos.x - scrollStartPos.x;
      const deltaY = scrollEndPos.y - scrollStartPos.y;
      const duration = scrollEndTime - scrollStartTime;
      const directionX = deltaX > 0 ? "right" : deltaX < 0 ? "left" : "none";
      const directionY = deltaY > 0 ? "down" : deltaY < 0 ? "up" : "none";
      // Ignore negligible scrolls (e.g. a 0.5px shift from layout reflow while a
      // page is still loading) — those aren't real scroll actions.
      const MIN_SCROLL_PX = 8;
      if (Math.abs(deltaX) < MIN_SCROLL_PX && Math.abs(deltaY) < MIN_SCROLL_PX) {
        isScrolling = false;
        return;
      }
      recordInteraction({
        type: "scroll",
        deltaX: deltaX,
        deltaY: deltaY,
        directionX: directionX,
        directionY: directionY,
        cursorX: cursorPos.x,
        cursorY: cursorPos.y,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        duration: duration,
        url: window.location.href,
        page_title: document.title,
        timestamp: scrollEndTime,
        bbox: getBoundingBox(event.target) ?? {},
        isElementScroll: target !== window,
      }).catch(console.error);

      isScrolling = false;
    },
    { capture: true },
  );

  let pointerdown_captured = false;

  ["pointerdown", "pointerup"].forEach((eventType) => {
    window.addEventListener(
      eventType,
      (event) => {
        // Record a left click on pointerdown so its screenshot shows the
        // pre-action state. A right click is recorded on pointerup as its own
        // action; its pointerdown is ignored so it is not mislabeled as click.
        if (pointerdown_captured === true) {
          console.log("pointerdown_captured === true in click event listener");
          return;
        }

        if (eventType === "pointerdown") {
          if (event.button !== 0) {
            console.log(`Skipping ${eventType} with button ${event.button}`);
            return;
          } else if (event.clientX === 0 && event.clientY === 0) {
            console.log(`Skipping ${eventType} at (0,0)`);
            return;
          }

          pointerdown_captured = true;
          setTimeout(() => (pointerdown_captured = false), 300);
        } else if (event.button !== 2) {
          // Left click was already recorded on pointerdown. Ignore its
          // pointerup (including long presses) and unsupported middle clicks.
          return;
        }

        // Clicks inside a sub-frame (iframe, e.g. an ad SafeFrame or the Google
        // apps popup) report x/y and viewport RELATIVE TO THAT FRAME, but the
        // screenshot is the whole tab. We can't map the frame's box onto the
        // tab, so an auto bbox would paint a bogus full-screen box. Omit it for
        // sub-frames (isSubframe flags this); use manual 📸 click for precise
        // grounding inside iframes.
        const inSubframe = window.top !== window.self;
        const event_data = {
          type: "click",
          action: event.button === 2 ? "right_click" : "click",
          x: event.clientX,
          y: event.clientY,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          isSubframe: inSubframe,
          element: event.target?.tagName || "unknown",
          id: event.target?.id || "unknown",
          class: event.target?.className || "unknown",
          src: event.target?.src || "unknown",
          href: event.target?.href || "unknown",
          ariaLabel: event.target?.getAttribute("aria-label") || "unknown",
          role: event.target?.getAttribute("role") || "unknown",
          text: event.target?.innerText || "unknown",
          url: window.location.href,
          page_title: document.title,
          button: event.button,
          timestamp: Date.now(),
          bbox: inSubframe ? {} : getClickableBox(event.target) ?? {},
          originalEventType: eventType,
        };
        recordInteraction(event_data, event).catch(console.error);
      },
      { capture: true },
    );
  });

  document.addEventListener(
    "mousedown",
    (event) => {
      if (event.clientX === 0 && event.clientY === 0) {
        return;
      }
      // Only handle left-clicks
      if (event.button !== 0) return;

      mouseDownCoords = { x: event.clientX, y: event.clientY };
      mouseDownTime = Date.now();
      mouseDownTarget = event.target;

      let target = event.target;
      // Traverse up to find anchor if needed
      while (target && target.tagName !== "A") {
        target = target.parentElement;
      }
      if (target && target.tagName === "A") {
        const href = target.getAttribute("href");
        const targetAttr = target.getAttribute("target");
        if (targetAttr === "_blank" && href) {
          // Record the click event immediately
          recordInteraction(
            {
              type: "click",
              x: event.clientX,
              y: event.clientY,
              // Same viewport fields as the pointerdown click path, so the
              // trajectory viewer can position the bbox overlay (without these
              // the box can't be drawn as a percentage of the screenshot).
              viewport_width: window.innerWidth,
              viewport_height: window.innerHeight,
              element: target.tagName,
              id: target.id || "unknown",
              class: target.className || "unknown",
              src: target.src || "unknown",
              href: href,
              ariaLabel: target.getAttribute("aria-label") || "unknown",
              role: target.getAttribute("role") || "unknown",
              text: target.innerText || "unknown",
              url: window.location.href,
              page_title: document.title,
              button: event.button,
              timestamp: Date.now(),
              bbox: target.getBoundingClientRect(),
              openedNewTab: true,
            },
            event,
            false,
          ).catch(console.error);
        }
      }
    },
    { capture: true },
  );

  // Capture non-character-typing keys
  const specialKeys = [
    "Enter",
    "NumpadEnter",
    "Tab",
    "ArrowDown",
    "ArrowUp",
    "ArrowLeft",
    "ArrowRight",
    "Escape",
  ];
  window.addEventListener(
    "keydown",
    (event) => {
      if (!specialKeys.includes(event.key)) return;

      const interaction = {
        type: "keypress",
        key: event.key,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        element: event.target?.tagName || "unknown",
        id: event.target?.id || "unknown",
        class: event.target?.className || "unknown",
        url: window.location.href,
        page_title: document.title,
        ariaLabel: event.target?.getAttribute("aria-label") || "unknown",
        role: event.target?.getAttribute("role") || "unknown",
        value: event.target?.value || "unknown",
        timestamp: Date.now(),
        bbox: getBoundingBox(event.target) ?? {},
      };
      recordInteraction(interaction, event).catch(console.error);
    },
    { capture: true },
  );

  // Manual click capture via a function key. Handling it here in the page means
  // it never steals focus — so a popup/overlay that closes on blur stays open in
  // the captured screenshot. F1 doesn't type a character, so it works even while
  // an input/textarea is focused (no need to skip editable fields). Set
  // CAPTURE_CLICK_REQUIRE_CTRL to true to require Ctrl+F1 instead of bare F1.
  const CAPTURE_CLICK_KEY = "F1";
  const CAPTURE_CLICK_REQUIRE_CTRL = false;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== CAPTURE_CLICK_KEY) return;
      if (event.metaKey || event.altKey) return;
      if (CAPTURE_CLICK_REQUIRE_CTRL && !event.ctrlKey) return;
      if (!CAPTURE_CLICK_REQUIRE_CTRL && event.ctrlKey) return;
      event.preventDefault(); // suppress the browser's F1 help
      event.stopPropagation();
      chrome.runtime.sendMessage({ type: "captureClickBox" }).catch(() => {});
    },
    { capture: true },
  );

  document.addEventListener(
    "input",
    async (event) => {
      // Check if the event target is an input or textarea
      if (pointerdown_captured === true) {
        return;
      }
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        const interaction = {
          type: "input",
          value: event.target.value,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          element: event.target.tagName,
          id: event.target.id || "unknown",
          class: event.target.className || "unknown",
          url: window.location.href,
          page_title: document.title,
          timestamp: Date.now(),
          bbox: event.target.getBoundingClientRect(),
        };

        try {
          await recordInteraction(interaction).catch(console.error);
          console.log("Input change recorded:", interaction.value);
        } catch (error) {
          console.error("Error recording input change:", error);
        }
      }
    },
    { capture: true },
  );

  document.addEventListener("copy", async (event) => {
    const selectedText = document.getSelection().toString();

    await recordInteraction({
      type: "copy",
      text: selectedText,
      url: window.location.href,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      timestamp: Date.now(),
    }).catch(console.error);

    console.log("Copied text:", selectedText);
  });

  document.addEventListener("paste", async (event) => {
    const pastedData = event.clipboardData.getData("text/plain");

    await recordInteraction({
      type: "paste",
      text: pastedData,
      url: window.location.href,
      page_title: document.title,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      timestamp: Date.now(),
    }).catch(console.error);

    console.log("Pasted data:", pastedData);
  });

  document.addEventListener("selectionchange", async () => {
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString() : "";
    const isSelectAll = selectedText === document.body.innerText;

    if (selectedText) {
      console.log("Selection changed:", { selectedText, isSelectAll });

      // Get the range and bounding rect of the selection
      let startCoordinates = null;
      let endCoordinates = null;

      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0); // Get the first range
        const rect = range.getBoundingClientRect(); // Get bounding box of the range

        startCoordinates = { x: rect.left, y: rect.top }; // Top-left of the selection
        endCoordinates = { x: rect.right, y: rect.bottom }; // Bottom-right of the selection
      }

      try {
        await recordInteraction({
          type: "selection",
          text: selectedText,
          isSelectAll: isSelectAll,
          url: window.location.href,
          page_title: document.title,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          startCoordinates: startCoordinates,
          endCoordinates: endCoordinates,
          timestamp: Date.now(),
        });
        console.log("Selection recorded:", {
          selectedText,
          startCoordinates,
          endCoordinates,
        });
      } catch (error) {
        console.error("Failed to record selection:", error);
      }
    }
  });

  const getNavigationMethod = () => {
    // Get navigation entry (modern API)
    const navEntry = performance.getEntriesByType("navigation")[0];
    const navigationType = navEntry ? navEntry.type : "unknown";

    // Get referrer
    const referrer = document.referrer || "";

    // Determine navigation method
    let method = "unknown";

    if (navigationType === "reload") {
      method = "page_refresh";
    } else if (navigationType === "back_forward") {
      method = "browser_back_forward";
    } else if (navigationType === "navigate") {
      if (!referrer) {
        // No referrer = direct navigation
        method = "direct_navigation"; // URL bar, bookmark, external app
      } else {
        // Has referrer = came from another page
        const referrerDomain = new URL(referrer).hostname;
        const currentDomain = window.location.hostname;

        if (referrerDomain === currentDomain) {
          method = "internal_link"; // Link click within same site
        } else {
          method = "external_link"; // Link click from different site
        }
      }
    }

    return {
      method: method,
      type: navigationType,
      referrer: referrer,
    };
  };

  let loadDebounceTimer;
  window.addEventListener(
    "load",
    (event) => {
      // The content script runs in ALL frames (allFrames), so this "load" also
      // fires inside ad/embed iframes (e.g. googlesyndication SafeFrame). Those
      // sub-frame loads have no referrer and get misclassified as a "goto",
      // producing a bogus goto step whose URL is the ad iframe while the
      // screenshot is the top page. Only the top document is a real navigation.
      if (window.top !== window.self) return;

      const navigationInfo = getNavigationMethod();
      // set timeout to 300ms
      clearTimeout(loadDebounceTimer);
      loadDebounceTimer = setTimeout(() => {
        recordInteraction({
          type: "load",
          url: window.location.href,
          page_title: document.title,
          timestamp: Date.now(),
          bbox: {},
          navigationMethod: navigationInfo.method,
          navigationType: navigationInfo.type,
          referrer: navigationInfo.referrer,
        }).catch(console.error);
      }, 300);
    },
    { capture: true },
  );

  // Trigger finalization on page unload
  window.addEventListener(
    "unload",
    async (event) => {
      await recordInteraction(
        {
          type: "unload",
          url: window.location.href,
          page_title: document.title,
          timestamp: Date.now(),
          bbox: {},
        },
        null,
        false,
      ).catch(console.error);
    },
    { capture: true },
  );

  // Dynamically-created iframes (e.g. the Google apps popup served from
  // ogs.google.com, ad SafeFrames) appear AFTER the initial allFrames injection,
  // so no collector runs inside them and their clicks/scrolls go unrecorded.
  // Watch the top document for newly added iframes and ask the worker to
  // re-inject into all frames (idempotent via hasEventCollectorInitialized), so
  // the new frame gets listeners too.
  if (window.top === window.self) {
    let reinjectTimer = null;
    const requestReinject = () => {
      if (reinjectTimer) return;
      reinjectTimer = setTimeout(() => {
        reinjectTimer = null;
        try {
          chrome.runtime.sendMessage({ type: "reinjectFrames" });
        } catch (e) {
          /* worker may be asleep; next mutation will retry */
        }
      }, 400);
    };
    const iframeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (
            node.tagName === "IFRAME" ||
            (node.querySelector && node.querySelector("iframe"))
          ) {
            requestReinject();
            return;
          }
        }
      }
    });
    iframeObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

// Handle messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "showSpeedWarning") {
    showSpeedWarning(message.message);
  }
});

function showSpeedWarning(warningText) {
  // Remove any existing warning
  const existingWarning = document.getElementById("__webolmoSpeedWarning");
  if (existingWarning) {
    existingWarning.remove();
  }

  // Create warning overlay
  const warning = document.createElement("div");
  warning.id = "__webolmoSpeedWarning";
  warning.textContent = warningText;
  Object.assign(warning.style, {
    position: "fixed",
    top: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    backgroundColor: "#ff4444",
    color: "white",
    padding: "15px 25px",
    borderRadius: "8px",
    fontFamily: "Arial, sans-serif",
    fontSize: "16px",
    fontWeight: "bold",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    pointerEvents: "none",
    animation: "webolmoFadeIn 0.3s ease-in",
  });

  // Add fade in animation
  const style = document.createElement("style");
  style.textContent = `
        @keyframes webolmoFadeIn {
            from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
            to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
    `;
  document.head.appendChild(style);

  document.documentElement.appendChild(warning);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (warning && warning.parentNode) {
      warning.style.animation = "webolmoFadeIn 0.3s ease-out reverse";
      setTimeout(() => warning.remove(), 300);
    }
  }, 3000);
}

// Initialize listeners if not already done
if (!window.hasEventCollectorInitialized) {
  addListeners();
  window.hasEventCollectorInitialized = true;
}
