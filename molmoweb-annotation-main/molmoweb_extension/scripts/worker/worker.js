import debounce from "./debounce.js";
import waitUntil from "./waitUntil.js";

/**
 * @typedef RecordedInteractionEvent
 * @type {{ type: string; timestamp: number; [extraEventDataKey: string]: any, message?: string }}
 */

/**
 * @typedef RecordedInteractionEventWithExtraData
 * @type {{ event: RecordedInteractionEvent, screenshot?: string, html?: string, domSnapshot?: string, axTree: string }}
 */

/**
 * @typedef SendVideoEvent
 * @type {{ video: string | ArrayBuffer | null}}
 */

/**
 *
 * @param {number} tabId
 */
function injectEventCollectorScript(tabId) {
  chrome.scripting
    .executeScript({
      // allFrames so interactions inside embedded iframes (e.g. the 간편인증 /
      // KakaoTalk auth widget) are recorded too, not just the top frame.
      target: { tabId, allFrames: true },
      files: ["scripts/content/event-collector.js"],
      injectImmediately: true,
    })
    // May reject for still-loading / chrome:// tabs; a later load re-injects
    // (the content script's init guard makes re-injection a no-op).
    .catch(() => {});
}

// A recording session can span more than one browser window: e.g. a site that
// opens a login/payment page with window.open lands in a SEPARATE window whose
// id != recordingWindowId. We track every window that belongs to the session so
// the collector is injected there and screenshots capture whichever session
// window is focused.
async function getSessionWindowIds() {
  const { sessionWindowIds } =
    await chrome.storage.local.get("sessionWindowIds");
  return Array.isArray(sessionWindowIds) ? sessionWindowIds : [];
}

async function isSessionWindow(windowId) {
  return (await getSessionWindowIds()).includes(windowId);
}

async function addSessionWindow(windowId) {
  if (windowId == null) return;
  const ids = await getSessionWindowIds();
  if (!ids.includes(windowId)) {
    ids.push(windowId);
    await chrome.storage.local.set({ sessionWindowIds: ids });
  }
}

// Remember the last-focused session window so screenshots capture the popup the
// participant is actually looking at, not the window that happens to be behind.
async function windowFocusListener(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (await isSessionWindow(windowId)) {
    await chrome.storage.local.set({ focusedSessionWindowId: windowId });
  }
}

// Prune a session window when it closes (e.g. the popup is dismissed).
async function windowRemovedListener(windowId) {
  const ids = await getSessionWindowIds();
  if (ids.includes(windowId)) {
    await chrome.storage.local.set({
      sessionWindowIds: ids.filter((id) => id !== windowId),
    });
    const { focusedSessionWindowId, recordingWindowId } =
      await chrome.storage.local.get([
        "focusedSessionWindowId",
        "recordingWindowId",
      ]);
    if (focusedSessionWindowId === windowId) {
      await chrome.storage.local.set({
        focusedSessionWindowId: recordingWindowId,
      });
    }
  }
}

// Which window to screenshot: the focused session window if it still exists,
// else the main recording window.
async function getScreenshotWindowId() {
  const { focusedSessionWindowId, recordingWindowId } =
    await chrome.storage.local.get([
      "focusedSessionWindowId",
      "recordingWindowId",
    ]);
  const target = focusedSessionWindowId ?? recordingWindowId;
  if (target != null) {
    try {
      await chrome.windows.get(target);
      return target;
    } catch {
      return recordingWindowId;
    }
  }
  return recordingWindowId;
}

async function sendMessageToStartingTab(event) {
  const result = await chrome.storage.local.get(["startingTabId"]);
  const startingTabId = result.startingTabId;
  if (startingTabId) {
    return chrome.tabs.sendMessage(startingTabId, {
      data: event,
      type: "addEvent",
    });
  } else {
    console.error("startingTabId was not defined when an event was recorded");
  }
}

async function addRecordedEvent(event, tabId) {
  console.log("adding event");
  const result = await chrome.storage.local.get(["events"]);
  let events = result.events;
  if (!Array.isArray(events)) {
    events = [];
  }

  if (tabId) {
    event.event.tabId = tabId;
  }

  events.push(event);
  await chrome.storage.local.set({ events });

  try {
    await sendMessageToStartingTab(event);
  } catch (e) {
    console.error(
      "Something went wrong when sending an addEvent message to the starting tab",
      e,
    );
  }
}

// Detect when a tab's URL changes or the page reloads
async function tabUpdateListener(tabId, changeInfo, tab) {
  console.log("tabUpdateListener triggered");
  const { recordingWindowId, recordingTabGroupId } =
    await chrome.storage.local.get([
      "recordingWindowId",
      "recordingTabGroupId",
    ]);
  // Inject into any session window (main recording window OR a popup window
  // opened from it), so clicks/types inside popups are recorded too.
  if (!(await isSessionWindow(tab.windowId))) return;

  // Tab groups are per-window, so only group tabs in the main recording window.
  if (tab.windowId === recordingWindowId && changeInfo.status === "loading") {
    chrome.tabs.group({ groupId: recordingTabGroupId, tabIds: tab.id });
  }

  if (
    changeInfo.status === "loading" &&
    !tab.url?.includes("chrome://") &&
    !tab.pendingUrl?.includes("chrome://")
  ) {
    injectEventCollectorScript(tab.id);
  }
}

// Detect when the user switches to another tab
async function tabSwitchListener(activeInfo) {
  const { tabId, windowId } = activeInfo;
  console.log("tabSwitchListener triggered:", { tabId, windowId });

  // Ensure the tab is in the recording window
  const result = await chrome.storage.local.get(["recordingWindowId"]);
  const recordingWindowId = result.recordingWindowId;

  if (windowId === recordingWindowId) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        console.error("Error getting tab info:", chrome.runtime.lastError);
        return;
      }

      console.log("Switched to tab:", tab);

      addRecordedEvent({
        event: {
          type: "tab-switched",
          tabId: tabId,
          url: tab.url || "unknown",
          title: tab.title || "unknown",
          timestamp: Date.now(),
        },
      });

      if (
        !tab.url?.includes("chrome://") &&
        !tab.url?.includes("about:blank")
      ) {
        injectEventCollectorScript(tabId);
      }
    });
  } else {
    const result = await chrome.storage.local.get(["recordingWindowId"]);
    const recordingWindowId = result.recordingWindowId;
    console.warn("Activated tab is not in the recording window:", {
      windowId,
      recordingWindowId,
    });
  }
}

// Detect when a new tab is created
async function tabCreationListener(tab) {
  console.log("tabCreationListener triggered");

  const isExplicitUserAction =
    tab.pendingUrl === "chrome://newtab/" || // Explicit new tab (e.g., new tab button)
    (!tab.openerTabId && !tab.pendingUrl); // No opener, likely user-triggered

  addRecordedEvent({
    event: {
      type: "tab-created",
      tabId: tab.id,
      url: tab.url || "unknown",
      title: tab.title || "unknown",
      openedByAnotherTab: !isExplicitUserAction, // False if explicitly opened by the user
      timestamp: Date.now(),
    },
  });

  if (isExplicitUserAction) {
    console.log(`Tab ${tab.id} explicitly created by the user.`);
  } else {
    console.log(`Tab ${tab.id} created by a link or script.`);
  }

  // A tab opened from a session tab (window.open target=_blank / popup) may land
  // in a SEPARATE window. If its opener belongs to the session, enroll that
  // window so tabUpdateListener injects the collector and screenshots can follow
  // focus into it. Injection itself happens on the tab's load event.
  try {
    if (tab.openerTabId != null) {
      const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
      if (opener && (await isSessionWindow(opener.windowId))) {
        await addSessionWindow(tab.windowId);
      }
    }
  } catch (e) {
    console.error("tabCreationListener session-window check failed", e);
  }
}

/**
 * @param {chrome.windows.Window} window
 */
async function handleWindowBoundsChanged(window) {
  // NOTE: This also includes moving a window around. If we don't want this we'll need to compare top/left to previous values.
  const result = await chrome.storage.local.get(["recordingWindowId"]);
  const recordingWindowId = result.recordingWindowId;
  if (window != null && window.id === recordingWindowId) {
    handleRecordInteraction(
      {
        type: "resizeWindow",
        height: window.height,
        width: window.width,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        timestamp: Date.now(),
      },
      null,
      false,
    );
  }
}

const debouncedHandleWindowBoundsChanged = debounce(
  handleWindowBoundsChanged,
  200,
);

function streamifyEvents(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("["));
      let first = true;
      for (const event of events) {
        if (!first) {
          controller.enqueue(encoder.encode(","));
        }
        // Convert each event to JSON and encode it
        controller.enqueue(encoder.encode(JSON.stringify(event)));
        first = false;
      }
      controller.enqueue(encoder.encode("]"));
      controller.close();
    },
  });
}

async function compressEvents(events) {
  // Use the streaming approach instead of converting the entire array to a string first
  const eventStream = await streamifyEvents(events);
  const compressedStream = eventStream.pipeThrough(
    new CompressionStream("gzip"),
  );
  const response = new Response(compressedStream);
  return await response.blob();
}

/**
 * @param {Array<RecordedInteractionEvent | RecordedInteractionEventWithExtraData>} events
 * @param {string} uploadUrl
 * @param {string} sessionId
 */
async function uploadEvents(events, uploadUrl, sessionId) {
  const compressedEventsBlob = await compressEvents(events);

  const file = new File([compressedEventsBlob], sessionId + ".gz", {
    type: "application/gzip",
  });

  const formData = new FormData();
  formData.append("file", file);
  // Attach the schema-driven task metadata filled in the side panel, if any, so
  // the server can save it as task_metadata.json beside the trajectory.
  try {
    const { taskMetadata } = await chrome.storage.local.get("taskMetadata");
    if (taskMetadata && Object.keys(taskMetadata).length) {
      formData.append("task_metadata", JSON.stringify(taskMetadata));
    }
  } catch (e) {
    console.error("Failed to attach task metadata to upload:", e);
  }
  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Upload error ${response.status}: ${responseText}`);
  }

  return responseText;
}

/**
 * @param {string} sessionRecording
 * @param {string} uploadUrl
 * @param {string} sessionId
 */
async function uploadVideo(sessionRecording, uploadUrl, sessionId) {
  const videoResponse = await fetch(sessionRecording);
  const videoBlob = await videoResponse.blob();

  const formData = new FormData();

  formData.append(
    "file",
    new File([videoBlob], sessionId + ".webm", { type: "video/webm" }),
  );

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Upload error ${response.status}: ${responseText}`);
  }

  return responseText;
}

/**
 *
 * @param {string | undefined} sessionRecording
 */
async function handleUpload(sessionRecording) {
  try {
    chrome.runtime.sendMessage({ type: "startUpload" });

    // This handles cases where the session ID and upload URL get wiped out. This lets us finish a session in case we don't have the right data available
    const result = await chrome.storage.local.get(["sessionId"]);
    const sessionId = result.sessionId;
    const sessionIdOrDefault = sessionId ?? crypto.randomUUID();
    const result2 = await chrome.storage.local.get(["uploadUrl"]);
    const uploadUrl = result2.uploadUrl;
    const uploadUrlOrDefault =
      uploadUrl ?? "http://127.0.0.1:5001/upload";

    const result3 = await chrome.storage.local.get(["events"]);
    const events = result3.events;
    const eventsUploadPromise = uploadEvents(
      events,
      uploadUrlOrDefault,
      sessionIdOrDefault,
    );

    if (sessionRecording) {
      uploadVideo(sessionRecording, uploadUrlOrDefault, sessionIdOrDefault);
    }

    const redirectLocation = await eventsUploadPromise;

    chrome.runtime.sendMessage({ type: "finishUpload" });

    chrome.runtime.sendMessage({ type: "finishSession", redirectLocation });
  } catch (e) {
    console.error("Something went wrong when uploading your session.", e);
    if (e instanceof Error) {
      chrome.runtime.sendMessage({
        type: "uploadFailed",
        detail: e.message,
        stack: e.stack,
        cause: e.cause,
      });
    } else {
      chrome.runtime.sendMessage({
        type: "uploadFailed",
        detail: JSON.stringify(e),
      });
    }

    throw e;
  }
}

async function handleSessionFinish() {
  try {
    // Stop recording and store the returned sessionRecording value in storage.
    const sessionRecordingResult = await chrome.runtime.sendMessage({
      type: "stop-recording",
      target: "offscreen",
    });
    await chrome.storage.local.set({
      sessionRecording: sessionRecordingResult,
    });

    // Retrieve events from storage.
    const eventsResult = await chrome.storage.local.get(["events"]);
    const events = eventsResult.events;
    console.log("Events on session finish:", events);

    // Wait until the last event is an 'unload' event.
    await waitUntil(() => events.at(-1)?.event.type === "unload", 3);

    // Retrieve the upload URL.
    const uploadResult = await chrome.storage.local.get(["uploadUrl"]);
    const uploadUrl = uploadResult.uploadUrl;
    console.log("Uploading files to", uploadUrl);

    // Retrieve sessionRecording from storage.
    const sessionResult = await chrome.storage.local.get(["sessionRecording"]);
    const sessionRecording = sessionResult.sessionRecording;
    await handleUpload(sessionRecording);

    // Notify content scripts.
    try {
      await sendMessageToStartingTab({ type: "finishSession" });
    } catch (e) {
      console.error("Error sending finishSession message to starting tab", e);
    }

    // Remove session-related keys.
    await chrome.storage.local.remove([
      "events",
      "sessionId",
      "startingTabId",
      "uploadUrl",
      "currentInstruction",
      "sessionRecording",
      "recordingWindowId",
      "recordingTabGroupId",
      "sessionWindowIds",
      "focusedSessionWindowId",
    ]);

    // Remove listeners.
    chrome.tabs.onUpdated.removeListener(tabUpdateListener);
    chrome.tabs.onCreated.removeListener(tabCreationListener);
    chrome.tabs.onActivated.removeListener(tabSwitchListener);
    chrome.windows.onBoundsChanged.removeListener(
      debouncedHandleWindowBoundsChanged,
    );
    chrome.windows.onFocusChanged.removeListener(windowFocusListener);
    chrome.windows.onRemoved.removeListener(windowRemovedListener);
  } catch (e) {
    console.error("Something went wrong when finishing the session.", e);
  }
}

/**
 * Resizes a base64 encoded image (data URL) to fit within 1280x720 while maintaining the aspect ratio.
 * This version is suitable for a worker.
 * @param {string} dataURL - The original base64 data URL.
 * @returns {Promise<string>} - A promise that resolves to the resized image as a base64 data URL.
 */
function resizeImage(dataURL) {
  return fetch(dataURL)
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob))
    .then((imageBitmap) => {
      const originalWidth = imageBitmap.width;
      const originalHeight = imageBitmap.height;
      // Compute scale factor
      const scaleFactor = Math.min(
        1280 / originalWidth,
        1280 / originalHeight,
        1,
      );
      const newWidth = originalWidth * scaleFactor;
      const newHeight = originalHeight * scaleFactor;

      // Create an OffscreenCanvas
      const canvas = new OffscreenCanvas(newWidth, newHeight);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imageBitmap, 0, 0, newWidth, newHeight);

      // Convert canvas to a Blob
      return canvas.convertToBlob({ type: "image/png" });
    })
    .then((blob) => {
      // Convert the Blob to a base64 data URL using FileReader
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    });
}

async function recordWithScreenshot(payload) {
  const { event, html, takeScreenshot, tabId } = payload;
  const out = { event, html, screenshot: null };

  if (takeScreenshot) {
    try {
      const { recordingWindowId } =
        await chrome.storage.local.get("recordingWindowId");
      if (recordingWindowId != null) {
        // Send start loading message to side panel
        try {
          await chrome.runtime.sendMessage({
            type: "startScreenshotCapture",
          });
        } catch (e) {
          console.error(
            "Failed to send screenshot start message to side panel:",
            e,
          );
        }

        const shot = await maybeTakeScreenshot(await getScreenshotWindowId());
        if (shot) {
          out.screenshot = shot;
          // Remember a type action's frame so a following Enter can reuse it as
          // its hotkey("Enter") observation (see handleRecordInteraction).
          if (event?.action === "type") {
            await chrome.storage.local.set({ lastTypeScreenshot: shot });
          }
          // Send screenshot to side panel
          try {
            await chrome.runtime.sendMessage({
              type: "updateScreenshot",
              screenshot: shot,
            });
          } catch (e) {
            console.error("Failed to send screenshot to side panel:", e);
          }
        }
      }
    } catch (err) {
      console.error(
        "error capturing screenshot, falling back to raw event",
        err,
      );
    }
  } else {
    out.screenshot = null;
  }
  addRecordedEvent(out, tabId);
}

// Event types that should carry a screenshot. All other interaction events
// (click, keypress, input, load, sendNote, resizeWindow, ...) are recorded
// without one. "completeStep" = the participant checks off a step;
// "takeScreenshot" = an explicit manual capture command.
// Auto-captured event types: only scroll (and, separately, the page that loads
// after an Enter keypress). "takeScreenshot" is the manual capture button.
// Everything else is captured manually by the participant.
const SCREENSHOT_EVENT_TYPES = new Set([
  "click",
  "input", // a settled "type" action (debounced when typing pauses)
  "scroll",
  "takeScreenshot",
  "sendFinalAnswer",
]);

// Set when Enter is pressed so the page that loads as a result (e.g. a search
// results page) gets its own screenshot — giving a search two frames: the
// typed query (via completeStep) and the results page.
let captureNextLoad = false;
// The latest click/typed value are persisted to chrome.storage.local (not
// module memory) so they survive MV3 service-worker restarts between the
// action and a later manual capture.

async function handleRecordInteraction(
  event,
  html = null,
  takeScreenshot = true,
  tabId = null,
) {
  const type = event?.type;

  // Enter submits a search/form; arm a capture for the resulting page load.
  if (type === "keypress" && (event?.key === "Enter" || event?.key === "NumpadEnter")) {
    captureNextLoad = true;
    // If Enter is pressed inside a text field, record it as its own
    // hotkey("Enter") step, so a search becomes two actions: type + hotkey.
    // Reuse the preceding type action's screenshot so this frame isn't raced by
    // the page navigation Enter triggers; fall back to a fresh capture if none
    // is stored (e.g. Enter with no recent typing).
    if (event.element === "INPUT" || event.element === "TEXTAREA") {
      const { lastTypeScreenshot } = await chrome.storage.local.get(
        "lastTypeScreenshot",
      );
      const hk = {
        type: "keypress",
        action: "hotkey",
        keys: ["Enter"],
        note: "enter after type",
        viewport_width: event.viewport_width,
        viewport_height: event.viewport_height,
        url: event.url,
        page_title: event.page_title,
        timestamp: event.timestamp || Date.now(),
      };
      if (lastTypeScreenshot) {
        await addRecordedEvent(
          { event: hk, html: null, screenshot: lastTypeScreenshot },
          tabId,
        );
        await chrome.storage.local.remove("lastTypeScreenshot");
      } else {
        await recordWithScreenshot({
          event: hk,
          html: null,
          takeScreenshot: true,
          tabId,
        });
      }
      return; // replaces the (screenshot-less) raw Enter keypress step
    }
  }

  // Persist the latest click / typed text so a later capture (the Enter->results
  // page, or a manual capture) can be tagged with what the user just did.
  if (type === "click") {
    // A click changes the context, so a type screenshot stored before it is no
    // longer the right frame to reuse for a later Enter->hotkey step.
    await chrome.storage.local.remove("lastTypeScreenshot");
    await chrome.storage.local.set({
      lastClick: {
        x: event.x,
        y: event.y,
        viewport_width: event.viewport_width,
        viewport_height: event.viewport_height,
        bbox: event.bbox,
        element: event.element,
        id: event.id,
        text: event.text,
        ariaLabel: event.ariaLabel,
        role: event.role,
        href: event.href,
      },
    });
  }
  if (
    (type === "input" || type === "keypress") &&
    event.value !== undefined &&
    event.value !== "unknown"
  ) {
    await chrome.storage.local.set({ lastTypedValue: event.value });
  }

  // A settled input is a "type" action.
  if (type === "input") {
    event.action = "type";
  }

  // The final answer is a molmoweb finished(answer="...") action.
  if (type === "sendFinalAnswer") {
    event.action = "finished";
  }

  // Single choke point: capture a screenshot only for allowlisted event types,
  // plus the page that loads right after an Enter keypress (search results).
  takeScreenshot = SCREENSHOT_EVENT_TYPES.has(type);

  // Classify navigations (molmoweb-style actions):
  //  - direct address-bar / bookmark (no referrer) -> goto
  //  - link click to ANOTHER site (external_link, e.g. naver -> nate) -> goto
  //  - browser back/forward -> go_back (recorded via manual button instead)
  // Same-site link clicks (internal_link) are NOT captured as a step: that page
  // is already the pre-click observation of the next action, so it would just be
  // a redundant frame.
  const isGoto =
    type === "load" &&
    (event.navigationMethod === "direct_navigation" ||
      event.navigationMethod === "external_link");
  const isBack =
    type === "load" && event.navigationMethod === "browser_back_forward";
  const isEnterResult =
    type === "load" && captureNextLoad && !isGoto && !isBack;

  if (isGoto) {
    takeScreenshot = true;
    event.action = "goto"; // shown as the step type in the trajectory
    captureNextLoad = false;
  }
  if (isBack) {
    // Automatic back/forward detection is unreliable (content-script injection
    // races the load event, and the browser can't tell back from forward), so
    // go_back / go_forward are recorded via the manual side-panel buttons
    // instead. Here we only clear any armed Enter-result capture so this load
    // isn't mislabeled as a search-results page.
    captureNextLoad = false;
  }
  if (isEnterResult) {
    takeScreenshot = true;
    captureNextLoad = false;
  }

  // Tag the relevant captures with the preceding click / typed text:
  //  - manual "click"/"type" captures inherit those values directly, and
  //  - the Enter->results page records which box was clicked + what was typed.
  const wantsContext =
    (type === "takeScreenshot" &&
      (event.action === "click" ||
        event.action === "clear" ||
        event.action === "type")) ||
    isEnterResult;
  if (wantsContext) {
    const { lastClick, lastTypedValue } = await chrome.storage.local.get([
      "lastClick",
      "lastTypedValue",
    ]);
    if (
      type === "takeScreenshot" &&
      (event.action === "click" || event.action === "clear")
    ) {
      // clear(x,y) inherits the field the user just clicked; consume the click
      // so a later manual capture can't reuse a stale bbox.
      if (lastClick) {
        Object.assign(event, lastClick);
        await chrome.storage.local.remove("lastClick");
      }
    } else if (type === "takeScreenshot" && event.action === "type") {
      // Keep a value the user typed in the side panel; otherwise fall back to
      // the last auto-recorded typed value.
      if (
        (event.value === undefined || event.value === "") &&
        lastTypedValue != null
      ) {
        event.value = lastTypedValue;
        await chrome.storage.local.remove("lastTypedValue");
      }
    } else if (isEnterResult) {
      if (lastClick) event.clicked = lastClick;
      if (lastTypedValue != null) event.typed_value = lastTypedValue;
    }
  }

  await recordWithScreenshot({ event, html, takeScreenshot, tabId });
}

/**
 *
 * @param {string} sessionIdToStart
 * @param {string} instruction
 * @param {string} uploadUrlToStart
 * @param {number} tabId
 */
async function handleSessionStart(
  sessionIdToStart,
  instruction,
  task_steps,
  uploadUrlToStart,
  tabId,
) {
  const result = await chrome.storage.local.get(["sessionId"]);
  const sessionId = result.sessionId;
  console.log("sessionId:", sessionId);
  if (sessionId != null) {
    console.error("session already started");
  }

  console.log("start session", sessionIdToStart);
  console.log("instruction received", instruction);
  console.log("task_steps received", task_steps);
  console.log("upload URL", uploadUrlToStart);
  console.log("starting tab id", tabId);

  // Store the session-related values in chrome.storage.local.
  await chrome.storage.local.set({ ["events"]: [] });
  await chrome.storage.local.set({ ["sessionId"]: sessionIdToStart });
  await chrome.storage.local.set({ ["startingTabId"]: tabId });
  await chrome.storage.local.set({ ["uploadUrl"]: uploadUrlToStart });
  await chrome.storage.local.set({ ["currentInstruction"]: instruction });
  await chrome.storage.local.set({ ["currentTaskSteps"]: task_steps });
  // Clear any click/typed value left over from a PREVIOUS session, so the new
  // session's first captured page isn't tagged with a stale search term or
  // click (e.g. an old "정부24" typed_value leaking onto the starting page).
  await chrome.storage.local.remove(["lastClick", "lastTypedValue"]);

  const test = await chrome.storage.local.get(["startingTabId"]);
  console.log("Stored startingTabId:", test.startingTabId);

  // New window with default new tab (blank); participant navigates from the task instruction.
  const newWindow = await chrome.windows.create({
    focused: true,
    incognito: true,
  });
  await chrome.storage.local.set({
    ["recordingWindowId"]: newWindow?.id,
    sessionWindowIds: [newWindow?.id],
    focusedSessionWindowId: newWindow?.id,
  });

  // Get all tabs in the new window and group them; store the group ID.
  const tabs = await chrome.tabs.query({ windowId: newWindow.id });
  const group = await chrome.tabs.group({
    createProperties: { windowId: newWindow.id },
    tabIds: tabs.map((tab) => tab.id),
  });
  await chrome.storage.local.set({ ["recordingTabGroupId"]: group });

  // Update the tab group appearance.
  chrome.tabGroups.update(group, { color: "red", title: "Task recording" });

  chrome.tabs.onUpdated.addListener(tabUpdateListener);
  chrome.tabs.onCreated.addListener(tabCreationListener);
  chrome.tabs.onActivated.addListener(tabSwitchListener);
  chrome.windows.onBoundsChanged.addListener(
    debouncedHandleWindowBoundsChanged,
  );
  chrome.windows.onFocusChanged.addListener(windowFocusListener);
  chrome.windows.onRemoved.addListener(windowRemovedListener);

  // Capture the first page the participant navigates to as the first frame.
  // The blank incognito new tab fires no load event, so this is the first real
  // site (e.g. Google) — which is what we want as step 1, not the blank tab.
  captureNextLoad = true;
}

// when the user clicks the icon for the extension
chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }

  const existingContexts = await chrome.runtime.getContexts({});
  let recording = false;

  const offscreenDocument = existingContexts.find(
    (c) => c.contextType === "OFFSCREEN_DOCUMENT",
  );
  // If an offscreen document is not already open, create one.
  if (!offscreenDocument) {
    try {
      // Create an offscreen document.
      await chrome.offscreen.createDocument({
        url: "scripts/offscreen/offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Recording from chrome.tabCapture API",
      });
    } catch (error) {
      console.error("Failed to create offscreen document:", error);
    }
  } else {
    recording = offscreenDocument.documentUrl.endsWith("#recording");
  }

  // don't record if we are already recording
  if (recording) {
    return;
  }
  // Get a MediaStream for the active tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  // Send the stream ID to the offscreen document to start recording.
  chrome.runtime.sendMessage({
    type: "start-recording",
    target: "offscreen",
    data: streamId,
  });
});

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  switch (message.type) {
    case "recordInteraction": {
      // Capture at pointerdown time, so a click's screenshot is the screen the
      // user actually clicked on (two clicks on the same popup => same screen).
      await handleRecordInteraction(
        message.event,
        message.html,
        message.takeScreenshot,
        sender.tab.id,
      );
      break;
    }

    case "reinjectFrames": {
      // A new iframe appeared in a recording-window tab (e.g. a popup panel).
      // Re-inject into all frames so the collector runs inside it too. The
      // content script's hasEventCollectorInitialized guard makes this a no-op
      // for frames that already have it.
      if (sender.tab && (await isSessionWindow(sender.tab.windowId))) {
        injectEventCollectorScript(sender.tab.id);
      }
      break;
    }

    case "captureClickBox": {
      // Single-key ("1") manual click capture from a session page. Fired via a
      // page keydown so focus never leaves the popup/overlay being captured.
      if (sender.tab && (await isSessionWindow(sender.tab.windowId))) {
        await captureAndOpenDrawWindow();
      }
      break;
    }


    case "sendNote": {
      await handleRecordInteraction(
        message.event,
        message.html,
        true,
        sender.tab?.id,
      );
      break;
    }

    case "sendQuestionAndAnswer": {
      await handleRecordInteraction(
        message.event,
        message.html,
        true,
        sender.tab.id,
      );
      break;
    }

    case "sendFinalAnswer": {
      console.log("Received sendFinalAnswer:", message);
      await handleRecordInteraction(
        message.event,
        message.html,
        true,
        sender.tab?.id,
      );

      const result = await chrome.storage.local.get(["sessionRecording"]);
      const sessionRecording = result.sessionRecording;
      await handleSessionFinish();
      break;
    }

    case "takeScreenshot": {
      console.log("Received takeScreenshot:", message);
      await handleRecordInteraction(
        message.event,
        message.html,
        true,
        sender.tab?.id,
      );
      break;
    }

    case "startSession": {
      await handleSessionStart(
        message.sessionId,
        message.instruction,
        message.task_steps,
        message.uploadUrl,
        sender.tab.id,
      );
      await chrome.storage.local.set({
        ["currentInstruction"]: message.instruction,
      });
      await chrome.storage.local.set({
        ["currentTaskSteps"]: message.task_steps,
      });
      console.log(message);
      console.log(message.task_steps);
      break;
    }

    case "getInstruction": {
      const result = await chrome.storage.local.get(["currentInstruction"]);
      const currentInstruction = result.currentInstruction;
      sendResponse({ instruction: currentInstruction });
      return true;
    }

    case "getWebsite": {
      sendResponse({ website: "" });
      return true;
    }

    case "retryUpload": {
      const result3 = await chrome.storage.local.get(["sessionRecording"]);
      const sessionRecording = result3.sessionRecording;
      await handleUpload(sessionRecording);
    }

    case "recordDrawnBbox": {
      // The user dragged a box on the shown screenshot. Convert the normalized
      // fractions to viewport pixels + viewport size (same format as auto
      // clicks), so it can be normalized downstream (e.g. x / viewport * 1000).
      const p = message.bbox_pct || {};
      let vw, vh;
      // Prefer the viewport captured at screenshot time (correct even when the
      // shot was of a popup window that has since closed). Fall back to the
      // recording window's active tab.
      const { drawViewport, drawFromImage } = await chrome.storage.local.get([
        "drawViewport",
        "drawFromImage",
      ]);
      if (drawViewport?.vw && drawViewport?.vh) {
        vw = drawViewport.vw;
        vh = drawViewport.vh;
      } else if (drawFromImage) {
        // Pasted/uploaded image: no page viewport. Keep only the normalized
        // bbox_pct / start_pct / end_pct (the renderer draws those on the image).
      } else {
        try {
          const { recordingWindowId } =
            await chrome.storage.local.get("recordingWindowId");
          const [tab] = await chrome.tabs.query({
            active: true,
            windowId: recordingWindowId,
          });
          if (tab) {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => [window.innerWidth, window.innerHeight],
            });
            [vw, vh] = res.result;
          }
        } catch (e) {
          console.error("Failed to read viewport for drawn bbox:", e);
        }
      }

      let ev;
      if (message.action === "drag") {
        // A drag: start_pct -> end_pct (normalized). Convert to viewport pixels.
        const s = message.start_pct || {};
        const e = message.end_pct || {};
        ev = {
          type: "takeScreenshot",
          action: "drag",
          note: message.note || "manual drag",
          start_pct: s,
          end_pct: e,
          timestamp: message.timestamp || Date.now(),
        };
        if (vw && vh && s.x != null && e.x != null) {
          ev.viewport_width = vw;
          ev.viewport_height = vh;
          ev.x = s.x * vw; // drag start
          ev.y = s.y * vh;
          ev.x2 = e.x * vw; // drag end
          ev.y2 = e.y * vh;
        }
      } else {
        ev = {
          type: "takeScreenshot",
          action: message.action === "double_click" ? "double_click" : "click",
          note: message.note || "manual bbox",
          bbox_pct: p, // kept as a fallback
          timestamp: message.timestamp || Date.now(),
        };
        if (vw && vh && p.width != null) {
          ev.viewport_width = vw;
          ev.viewport_height = vh;
          ev.bbox = {
            x: p.left * vw,
            y: p.top * vh,
            width: p.width * vw,
            height: p.height * vh,
          };
          ev.x = (p.left + p.width / 2) * vw; // click point = box center
          ev.y = (p.top + p.height / 2) * vh;
        }
      }

      await addRecordedEvent(
        { event: ev, html: null, screenshot: message.screenshot },
        sender.tab?.id,
      );
      break;
    }

    case "openDrawWindowWithImage": {
      // Annotate a pasted/uploaded image (OS dropdowns, file dialogs, ...).
      await openDrawWindowWithImage(message.image, message.action);
      break;
    }

    case "openDrawWindow": {
      // Button path. NOTE: clicking the side-panel button blurs the recording
      // window, which dismisses focus-sensitive overlays/popups BEFORE the
      // screenshot is taken. For those, use the keyboard shortcut instead
      // (chrome.commands "capture_click_box") — it captures without stealing
      // focus so the popup stays open in the frozen screenshot.
      await captureAndOpenDrawWindow(message.action);
      break;
    }

    case "captureForDraw": {
      // Capture the current recording-window screen and show it in the side
      // panel so the user can draw a bbox on it. No event recorded here.
      const { recordingWindowId } =
        await chrome.storage.local.get("recordingWindowId");
      if (recordingWindowId != null) {
        const shot = await maybeTakeScreenshot(recordingWindowId);
        if (shot) {
          try {
            await chrome.runtime.sendMessage({
              type: "updateScreenshot",
              screenshot: shot,
            });
          } catch (e) {
            console.error("Failed to send screenshot for draw:", e);
          }
        }
      }
      break;
    }

    case "completeStep": {
      console.log("Received completeStep", message);
      console.log("Sender tab info:", sender.tab);

      // Get the active tab in the recording window instead of sender tab
      try {
        const { recordingWindowId } =
          await chrome.storage.local.get("recordingWindowId");
        if (recordingWindowId) {
          const tabs = await chrome.tabs.query({
            active: true,
            windowId: recordingWindowId,
          });
          const activeTab = tabs[0];
          console.log("Active tab in recording window:", activeTab);
          await handleRecordInteraction(
            message.event,
            message.html,
            true,
            activeTab?.id,
          );
        } else {
          console.log(
            "No recording window ID found, falling back to sender tab",
          );
          await handleRecordInteraction(
            message.event,
            message.html,
            true,
            sender.tab?.id,
          );
        }
      } catch (error) {
        console.error("Error getting active tab:", error);
        await handleRecordInteraction(
          message.event,
          message.html,
          true,
          sender.tab?.id,
        );
      }
      break;
    }

    case "completeTask": {
      console.log("Received completeTask:", message);
      await handleRecordInteraction(
        message.event,
        message.html,
        true,
        sender.tab?.id,
      );
      break;
    }

    default:
      console.warn("Unknown message type:", message.type);
  }
});

// Chrome caps captureVisibleTab at ~2 calls/sec per window
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). We DON'T pre-pace every capture
// (that adds latency to every click/type/scroll) — instead we let the call run
// immediately and only back off + retry when Chrome actually throws the
// rate-limit error (e.g. a fast burst like opening an overlay then clicking
// inside it). Normal captures stay instant.
async function maybeTakeScreenshot(windowId) {
  let dataUrl = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 50,
      });
      break;
    } catch (err) {
      // Rate-limited: wait for the 1s window to clear, then retry.
      if (attempt < 2 && /MAX_CAPTURE/.test(String(err && err.message))) {
        await new Promise((r) => setTimeout(r, 550));
        continue;
      }
      throw err;
    }
  }
  if (!dataUrl) return null;

  dataUrl = await resizeImage(dataUrl);
  return dataUrl;
}

// Capture the focused session window (recording window OR a popup opened from
// it), then open the large draw window so the user can drag a precise bbox on
// the frozen screenshot. Screenshot happens first, so any overlay/popup that
// closes when the draw window opens is still present in the captured image.
async function captureAndOpenDrawWindow(action = "click") {
  const { recordingWindowId } =
    await chrome.storage.local.get("recordingWindowId");
  if (recordingWindowId == null) return;
  const winId = await getScreenshotWindowId();
  const shot = await maybeTakeScreenshot(winId);
  if (!shot) return;
  const drawAction =
    action === "double_click" || action === "drag" ? action : "click";
  // Record the CAPTURED window's viewport now — recordDrawnBbox needs it to
  // scale the drawn box, and by the time the user submits, the popup may be
  // closed and focus back on the recording window (wrong viewport).
  let drawViewport = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
    if (tab) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => [window.innerWidth, window.innerHeight],
      });
      if (res?.result) drawViewport = { vw: res.result[0], vh: res.result[1] };
    }
  } catch (e) {
    console.error("Failed to read viewport for draw capture:", e);
  }
  await chrome.storage.local.set({
    drawScreenshot: shot,
    drawViewport,
    drawAction,
    drawFromImage: false,
  });
  await chrome.windows.create({
    url: chrome.runtime.getURL("draw.html"),
    type: "popup",
    width: 1200,
    height: 900,
  });
}

// Open the draw window on a user-supplied image (pasted or uploaded) instead of
// a tab screenshot. Used to annotate OS-drawn UI that captureVisibleTab can't
// see (native <select> dropdowns, file dialogs, ...). No viewport is known, so
// only the normalized bbox_pct / start_pct / end_pct are stored (which is what
// the trajectory renderer draws on the image anyway).
async function openDrawWindowWithImage(image, action) {
  if (!image) return;
  const drawAction =
    action === "double_click" || action === "drag" ? action : "click";
  await chrome.storage.local.set({
    drawScreenshot: image,
    drawViewport: null,
    drawAction,
    drawFromImage: true,
  });
  await chrome.windows.create({
    url: chrome.runtime.getURL("draw.html"),
    type: "popup",
    width: 1200,
    height: 900,
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  console.log("Command received:", command);

  if (command === "capture_click_box") {
    // Keyboard-triggered manual click capture. Unlike the side-panel button,
    // pressing a shortcut does NOT blur the recording/popup window, so a
    // focus-sensitive overlay or popup stays open in the captured screenshot.
    try {
      await captureAndOpenDrawWindow();
    } catch (error) {
      console.error("Error in capture_click_box command:", error);
    }
  } else if (command === "take_screenshot") {
    console.log("Processing screenshot command...");

    try {
      // Get the active tab
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      console.log("📋 Active tab:", activeTab);

      if (activeTab) {
        // Create a screenshot event similar to what the side panel does
        const screenshotEvent = {
          type: "takeScreenshot",
          note: "screenshot",
          timestamp: Date.now(),
        };

        console.log("Calling handleRecordInteraction...");
        // Handle the screenshot recording
        await handleRecordInteraction(
          screenshotEvent,
          null,
          true,
          activeTab.id,
        );
        console.log("Screenshot taken via keyboard shortcut");
      } else {
        console.error("No active tab found for screenshot command");
      }
    } catch (error) {
      console.error("Error in screenshot command:", error);
    }
  } else {
    console.log("Unknown command:", command);
  }
});
