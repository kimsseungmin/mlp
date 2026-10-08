async function sendMessageEvent(event) {
  try {
    await chrome.runtime.sendMessage({ type: event.type, event });
    console.log("Interaction recorded successfully:", event.type);
  } catch (error) {
    console.error("Failed to record interaction:", event.type, error);
  }

  return Promise.resolve();
}

(async function loadInstructionAndWebsite() {
  try {
    const { currentInstruction } = await chrome.storage.local.get([
      "currentInstruction",
    ]);
    document.getElementById("dynamic-instruction").textContent =
      currentInstruction || "No instruction found.";
  } catch (error) {
    console.error("Error retrieving instruction:", error);
    document.getElementById("dynamic-instruction").textContent =
      "No instruction found :().";
  }


})();

const SEND_NOTE_EVENT = "sendNote";
const SEND_FINAL_ANSWER_EVENT = "sendFinalAnswer";
const SEND_QUESTION_AND_ANSWER_EVENT = "sendQuestionAndAnswer";
const TAKE_SCREENSHOT_EVENT = "takeScreenshot";
const COMPLETE_STEP_EVENT = "completeStep";

/**
 * @typedef UserMessageEvent
 * @type {SEND_NOTE_EVENT | SEND_FINAL_ANSWER_EVENT | SEND_QUESTION_AND_ANSWER_EVENT | TAKE_SCREENSHOT_EVENT | COMPLETE_STEP_EVENT}
 *
 * @typedef {object} NoteEvent
 * @property {SEND_NOTE_EVENT} type
 * @property {string} note
 *
 * @typedef FinalAnswerEvent
 * @property {SEND_FINAL_ANSWER_EVENT} type
 * @property {string} answer
 *
 * @typedef QuestionAndAnswerEvent
 * @property {SEND_QUESTION_AND_ANSWER_EVENT} type
 * @property {string} question
 * @property {string} answer
 *
 * @typedef ScreenshotEvent
 * @property {TAKE_SCREENSHOT_EVENT} type
 * @property {string} note
 *
 * @typedef CompleteStepEvent
 * @property {COMPLETE_STEP_EVENT} type
 * @property {string} note
 * @property {string} title
 */

/**
 *
 * @type {Record<UserMessageEvent, string>} eventType
 */
const eventLabelMap = {
  [SEND_NOTE_EVENT]: "Note",
  [SEND_FINAL_ANSWER_EVENT]: "Final answer",
  [SEND_QUESTION_AND_ANSWER_EVENT]: "Question & answer",
  [TAKE_SCREENSHOT_EVENT]: "Screenshot",
  [COMPLETE_STEP_EVENT]: "Complete Step",
};

/**
 *
 * @param {NoteEvent | FinalAnswerEvent | QuestionAndAnswerEvent | ScreenshotEvent | CompleteStepEvent} event
 */
function createMessageRow(event) {
  const messageElement = document.createElement("li");

  const titleElement = document.createElement("strong");
  titleElement.innerHTML = eventLabelMap[event.type];
  messageElement.appendChild(titleElement);

  Object.entries(event)
    .filter(([key, _]) => key !== "type")
    .forEach(([key, value]) => {
      if (key === "axTree") return;
      if (key === "html") return;
      const containerElement = document.createElement("div");
      const valueElement = document.createElement("span");
      valueElement.innerHTML = `${key}: ${value}`;

      containerElement.appendChild(valueElement);
      messageElement.appendChild(containerElement);
    });

  document.getElementById("user-messages-list")?.appendChild(messageElement);
}

/**
 *
 * @param {NoteEvent | FinalAnswerEvent | QuestionAndAnswerEvent | ScreenshotEvent | CompleteStepEvent} event
 * @returns
 */
function recordUserMessage(event) {
  sendMessageEvent(event).then((_) => {
    createMessageRow(event);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Add Enter key event listeners for all textareas
  function addEnterKeyListener(formId, textareaSelector) {
    const form = document.getElementById(formId);
    const textarea = form?.querySelector(textareaSelector);

    if (textarea) {
      textarea.addEventListener("keydown", (event) => {
        // Submit on Enter, but allow Shift+Enter for new lines
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          form.dispatchEvent(
            new Event("submit", { cancelable: true, bubbles: true }),
          );
        }
      });
    }
  }

  // Add Enter key listeners to all forms
  addEnterKeyListener("note-form", 'textarea[name="note"]');
  addEnterKeyListener("final-answer-form", 'textarea[name="answer"]');
  addEnterKeyListener("question-answer-form", 'textarea[name="question"]');
  addEnterKeyListener("question-answer-form", 'textarea[name="answer"]');

  // Schema-driven task metadata form (saved to chrome.storage; uploaded with
  // the session and persisted as task_metadata.json server-side).
  initTaskMetadataForm();

  document
    .getElementById("question-answer-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);

      const questionAndAnswerEvent = {
        type: SEND_QUESTION_AND_ANSWER_EVENT,
        question: formData.get("question"),
        answer: formData.get("answer"),
        timestamp: Date.now(),
      };

      recordUserMessage(questionAndAnswerEvent);
      event.target?.reset();
    });

  document.getElementById("note-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);

    const noteEvent = {
      type: SEND_NOTE_EVENT,
      note: formData.get("note"),
      timestamp: Date.now(),
    };

    recordUserMessage(noteEvent);
    event.target?.reset();
  });

  document
    .getElementById("final-answer-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);

      const finalAnswerEvent = {
        type: SEND_FINAL_ANSWER_EVENT,
        answer: formData.get("answer"),
        timestamp: Date.now(),
      };

      recordUserMessage(finalAnswerEvent);
      event.target?.reset();
      document
        .getElementById("final-answer-form-loading-indicator")
        ?.removeAttribute("data-hidden");
    });

  document
    .getElementById("retry-upload-button")
    ?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "retryUpload" });
    });

  // Manual "click": capture the screen and open a large window to draw the bbox.
  document.getElementById("manual-click-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openDrawWindow", action: "click" });
  });

  // Manual "double_click": same draw flow, recorded as a double_click action.
  document
    .getElementById("manual-doubleclick-btn")
    ?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "openDrawWindow",
        action: "double_click",
      });
    });

  // Manual "drag": draw a start->end arrow on the captured screen.
  document.getElementById("manual-drag-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openDrawWindow", action: "drag" });
  });

  // Image capture: paste / upload / drop an image (e.g. an OS screenshot of a
  // native dropdown or file dialog that captureVisibleTab can't see), then draw
  // a click/drag on it. The image becomes the step's screenshot.
  let pastedImage = null;
  const imgPreview = document.getElementById("img-preview");
  const imgClickBtn = document.getElementById("img-click-btn");
  const imgDragBtn = document.getElementById("img-drag-btn");
  const imgDrop = document.getElementById("img-drop");

  function setPastedImage(dataUrl) {
    pastedImage = dataUrl;
    if (imgPreview) {
      imgPreview.src = dataUrl;
      imgPreview.style.display = "block";
    }
    if (imgClickBtn) imgClickBtn.disabled = false;
    if (imgDragBtn) imgDragBtn.disabled = false;
  }
  function readImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setPastedImage(reader.result);
    reader.readAsDataURL(file);
  }

  // Paste anywhere in the side panel (ignore non-image pastes so text paste in
  // the type/hotkey fields still works normally).
  window.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          readImageFile(blob);
        }
        break;
      }
    }
  });

  document
    .getElementById("img-file")
    ?.addEventListener("change", (e) => readImageFile(e.target.files?.[0]));

  if (imgDrop) {
    imgDrop.addEventListener("dragover", (e) => {
      e.preventDefault();
      imgDrop.style.background = "#eef2ff";
    });
    imgDrop.addEventListener("dragleave", () => {
      imgDrop.style.background = "";
    });
    imgDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      imgDrop.style.background = "";
      readImageFile(e.dataTransfer?.files?.[0]);
    });
  }

  const sendImageDraw = (action) => {
    if (!pastedImage) return;
    chrome.runtime.sendMessage({
      type: "openDrawWindowWithImage",
      image: pastedImage,
      action,
    });
  };
  imgClickBtn?.addEventListener("click", () => sendImageDraw("click"));
  imgDragBtn?.addEventListener("click", () => sendImageDraw("drag"));

  // Manual "clear": clear a text field. Click the field first so the action
  // inherits that click's coords, recorded as clear(x,y) with the current frame.
  document.getElementById("manual-clear-btn")?.addEventListener("click", () => {
    showScreenshotLoading();
    recordUserMessage({
      type: TAKE_SCREENSHOT_EVENT,
      action: "clear",
      note: "manual clear",
      timestamp: Date.now(),
    });
  });

  // Manual "type": record a type action with the value the user entered.
  document.getElementById("manual-type-btn")?.addEventListener("click", () => {
    const input = document.getElementById("manual-type-value");
    const value = input ? input.value : "";
    showScreenshotLoading();
    recordUserMessage({
      type: TAKE_SCREENSHOT_EVENT,
      action: "type",
      value,
      note: "manual type",
      timestamp: Date.now(),
    });
    if (input) input.value = "";
  });

  // Manual "hotkey": record a keyboard shortcut like ctrl+c (keys split on "+").
  // Enter typed in a text field is auto-recorded as hotkey("Enter") right after
  // the type action; use this button for other combos or edge cases.
  document.getElementById("manual-hotkey-btn")?.addEventListener("click", () => {
    const input = document.getElementById("manual-hotkey-value");
    const keys = (input ? input.value : "")
      .split("+")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keys.length === 0) return;
    showScreenshotLoading();
    recordUserMessage({
      type: TAKE_SCREENSHOT_EVENT,
      action: "hotkey",
      keys,
      note: "manual hotkey",
      timestamp: Date.now(),
    });
    if (input) input.value = "";
  });

  // Manual "wait": record a wait/noop action (e.g. waiting for a page to load).
  document.getElementById("manual-wait-btn")?.addEventListener("click", () => {
    showScreenshotLoading();
    recordUserMessage({
      type: TAKE_SCREENSHOT_EVENT,
      action: "wait",
      note: "wait",
      timestamp: Date.now(),
    });
  });

  // Manual "go_back" / "go_forward": record a browser back/forward navigation.
  // Automatic detection is unreliable, so the annotator captures the current
  // screen (the observation) here, then presses the browser back/forward button.
  const recordNav = (action) => {
    showScreenshotLoading();
    recordUserMessage({
      type: TAKE_SCREENSHOT_EVENT,
      action,
      note: action,
      timestamp: Date.now(),
    });
  };
  document
    .getElementById("manual-goback-btn")
    ?.addEventListener("click", () => recordNav("go_back"));
  document
    .getElementById("manual-goforward-btn")
    ?.addEventListener("click", () => recordNav("go_forward"));

});

/**
 *
 * @param {string} redirectUrl
 */
function handleSessionFinish(redirectUrl) {
  document
    .getElementById("instructions-and-answers")
    ?.setAttribute("data-hidden", "true");

  const redirectElement = document.getElementById("redirect-location");
  const sessionInstructions = document.getElementById(
    "session-finished-instructions",
  );

  if (redirectUrl && redirectUrl.trim() !== "") {
    redirectElement.setAttribute("href", redirectUrl);
    redirectElement.textContent = redirectUrl;
    sessionInstructions.innerHTML = `<p>Thank you for recording your session. Please go to <a href="${redirectUrl}" target="_blank">this link</a> to ensure your contribution has been recorded.</p>`;
  } else {
    redirectElement.removeAttribute("href");
    redirectElement.textContent = "";
    sessionInstructions.innerHTML = `<p>Thank you for recording your session. Your session has been completed successfully.</p>`;
  }

  sessionInstructions?.removeAttribute("data-hidden");
}

function handleUploadFailed(event) {
  document
    .getElementById("instructions-and-answers")
    ?.setAttribute("data-hidden", "true");
  document
    .getElementById("final-answer-form-loading-indicator")
    ?.setAttribute("data-hidden", "true");
  document
    .getElementById("upload-failed-instructions")
    ?.setAttribute("data-hidden", "false");
  const uploadFailedDetailsElement = document.getElementById(
    "upload-failed-details",
  );

  if (!uploadFailedDetailsElement) {
    return;
  }

  uploadFailedDetailsElement.innerHTML = Object.entries(event).reduce(
    (acc, [key, value]) => {
      if (key === "type") {
        return acc;
      }

      return acc + `<strong>${key}</strong>: <code>${value}</code><br><br>`;
    },
    "",
  );
}

function handleStartLoading() {
  document
    .getElementById("upload-failed-instructions")
    ?.setAttribute("data-hidden", "true");
  document
    .querySelectorAll('.action-form button[type="submit"]')
    .forEach((element) => {
      element.setAttribute("disabled", "true");
    });

  document
    .getElementById("final-answer-form-loading-indicator")
    ?.removeAttribute("data-hidden");
}

function handleFinishLoading() {
  document
    .querySelectorAll('.action-form button[type="submit"]')
    .forEach((element) => {
      element.removeAttribute("disabled");
    });
  document
    .getElementById("final-answer-form-loading-indicator")
    ?.setAttribute("data-hidden", "true");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "finishSession":
      console.log("finishing session");
      handleSessionFinish(message.redirectLocation);
      break;

    case "startUpload":
      handleStartLoading();
      break;

    case "finishUpload":
      handleFinishLoading();
      break;

    case "uploadFailed":
      handleUploadFailed(message);
      break;

    case "updateScreenshot":
      updateScreenshotDisplay(message.screenshot);
      incrementScreenshotCount();
      break;

    case "startScreenshotCapture":
      showScreenshotLoading();
      break;
  }
});

// Running count of screenshots captured this session, shown as a small badge.
let screenshotCount = 0;
function incrementScreenshotCount() {
  screenshotCount += 1;
  const badge = document.getElementById("screenshot-count");
  if (badge) badge.textContent = String(screenshotCount);
}

/**
 * Updates the screenshot display in the side panel
 * @param {string} screenshotDataUrl - The screenshot as a data URL
 */
function updateScreenshotDisplay(screenshotDataUrl) {
  const screenshotImg = document.getElementById("latest-screenshot");
  const noScreenshotMessage = document.getElementById("no-screenshot-message");
  const loadingSpinner = document.getElementById("screenshot-loading-spinner");

  if (screenshotImg && noScreenshotMessage && loadingSpinner) {
    // Hide loading spinner
    loadingSpinner.style.display = "none";

    screenshotImg.src = screenshotDataUrl;
    screenshotImg.style.display = "block";
    noScreenshotMessage.style.display = "none";

    // Remember it so a dragged bbox is recorded against THIS exact image.
    latestScreenshotDataUrl = screenshotDataUrl;
    const hint = document.getElementById("draw-bbox-hint");
    if (hint) hint.style.display = "block";
  }
}

// The screenshot currently shown (for drag-to-draw bbox grounding).
let latestScreenshotDataUrl = null;

// Drag a rectangle on the shown screenshot to record a click with that exact
// image + a normalized bbox (for cases auto-capture can't ground, e.g. iframes).
function setupBboxDraw() {
  const img = document.getElementById("latest-screenshot");
  const wrap = document.getElementById("screenshot-draw-wrap");
  if (!img || !wrap) return;

  let drawing = false;
  let startX = 0;
  let startY = 0;
  let boxEl = null;

  img.addEventListener("mousedown", (event) => {
    if (img.style.display === "none" || !latestScreenshotDataUrl) return;
    event.preventDefault();
    const r = img.getBoundingClientRect();
    drawing = true;
    startX = event.clientX - r.left;
    startY = event.clientY - r.top;
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
  });

  window.addEventListener("mousemove", (event) => {
    if (!drawing) return;
    const r = img.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - r.left, 0), r.width);
    const y = Math.min(Math.max(event.clientY - r.top, 0), r.height);
    boxEl.style.left = Math.min(startX, x) + "px";
    boxEl.style.top = Math.min(startY, y) + "px";
    boxEl.style.width = Math.abs(x - startX) + "px";
    boxEl.style.height = Math.abs(y - startY) + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!drawing) return;
    drawing = false;
    const r = img.getBoundingClientRect();
    const left = parseFloat(boxEl.style.left) / r.width;
    const top = parseFloat(boxEl.style.top) / r.height;
    const width = parseFloat(boxEl.style.width) / r.width;
    const height = parseFloat(boxEl.style.height) / r.height;
    boxEl.remove();
    boxEl = null;
    if (width < 0.005 || height < 0.005 || !latestScreenshotDataUrl) return; // ignore tiny

    chrome.runtime.sendMessage({
      type: "recordDrawnBbox",
      screenshot: latestScreenshotDataUrl,
      bbox_pct: { left, top, width, height },
      note: "manual bbox",
      timestamp: Date.now(),
    });
    createMessageRow({
      type: TAKE_SCREENSHOT_EVENT,
      action: "click (drawn bbox)",
    });
  });
}

document.addEventListener("DOMContentLoaded", setupBboxDraw);

/**
 * Shows the screenshot loading spinner
 */
function showScreenshotLoading() {
  const screenshotImg = document.getElementById("latest-screenshot");
  const noScreenshotMessage = document.getElementById("no-screenshot-message");
  const loadingSpinner = document.getElementById("screenshot-loading-spinner");

  if (screenshotImg && noScreenshotMessage && loadingSpinner) {
    // Hide existing content and show spinner
    screenshotImg.style.display = "none";
    noScreenshotMessage.style.display = "none";
    loadingSpinner.style.display = "flex";
  }
}

/**
 * Extracts data items from ARIA attributes (browsergym format)
 * @param {string} ariaValue - The ARIA attribute value
 * @returns {Array} - Array containing extracted data and new value
 */
function extractDataItemsFromAria(ariaValue) {
  const dataPattern = /browsergym_id:(\w+)/;
  const match = ariaValue.match(dataPattern);
  if (match) {
    const browsergymId = match[1];
    const newValue = ariaValue.replace(dataPattern, "").trim();
    return [[browsergymId], newValue];
  }
  return [[], ariaValue];
}

/**
 * Simple test function to verify debugger API works
 * @param {number} tabId - The tab ID to test
 * @returns {Promise<boolean>} - Whether debugger attachment works
 */
async function testDebuggerAccess(tabId) {
  return new Promise((resolve) => {
    console.log("Testing debugger access for tabId:", tabId);

    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        console.error("Debugger attach test FAILED:", chrome.runtime.lastError);
        // Check for specific Chrome URL error
        if (
          chrome.runtime.lastError.message &&
          chrome.runtime.lastError.message.includes("chrome://")
        ) {
          console.warn("Cannot attach debugger to Chrome internal page");
        }
        resolve(false);
        return;
      }

      console.log("Debugger attach test SUCCESSFUL");
      chrome.debugger.detach({ tabId }, () => {
        console.log("Debugger detached after test");
        resolve(true);
      });
    });
  });
}

/**
 * Extracts the AXTree of all frames using Chrome DevTools Protocol
 * @param {number} tabId - The tab ID to extract AXTree from
 * @returns {Promise<Object>} - Dictionary of AXTrees indexed by frame IDs
 */
async function extractAllFrameAxtrees(tabId) {
  console.log("Starting AXTree extraction for tabId:", tabId);

  // First test if debugger access works
  const debuggerWorks = await testDebuggerAccess(tabId);
  if (!debuggerWorks) {
    throw new Error("Debugger access test failed");
  }

  return new Promise((resolve, reject) => {
    // Attach debugger to the tab
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        console.error("Failed to attach debugger:", chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
        return;
      }

      console.log("Debugger attached successfully");

      // Enable Accessibility domain
      chrome.debugger.sendCommand({ tabId }, "Accessibility.enable", {}, () => {
        if (chrome.runtime.lastError) {
          console.error(
            "Failed to enable Accessibility:",
            chrome.runtime.lastError,
          );
          chrome.debugger.detach({ tabId });
          reject(chrome.runtime.lastError);
          return;
        }

        console.log("Accessibility domain enabled");

        // Get frame tree
        chrome.debugger.sendCommand(
          { tabId },
          "Page.getFrameTree",
          {},
          (frameTreeResult) => {
            if (chrome.runtime.lastError) {
              console.error(
                "Failed to get frame tree:",
                chrome.runtime.lastError,
              );
              chrome.debugger.detach({ tabId });
              reject(chrome.runtime.lastError);
              return;
            }

            console.log("Frame tree retrieved:", frameTreeResult);

            // Extract all frame IDs (breadth-first search)
            const frameIds = [];
            const rootFrame = frameTreeResult.frameTree;
            const framesToProcess = [rootFrame];

            while (framesToProcess.length > 0) {
              const frame = framesToProcess.pop();
              framesToProcess.push(...(frame.childFrames || []));
              frameIds.push(frame.frame.id);
            }

            console.log("Found frame IDs:", frameIds);

            // Extract AXTree for each frame
            const frameAxtrees = {};
            let completedFrames = 0;

            if (frameIds.length === 0) {
              console.warn("No frames found");
              chrome.debugger.detach({ tabId });
              resolve({});
              return;
            }

            frameIds.forEach((frameId) => {
              chrome.debugger.sendCommand(
                { tabId },
                "Accessibility.getFullAXTree",
                { frameId },
                (axTreeResult) => {
                  if (chrome.runtime.lastError) {
                    console.error(
                      `Failed to get AXTree for frame ${frameId}:`,
                      chrome.runtime.lastError,
                    );
                  } else {
                    console.log(
                      `Got AXTree for frame ${frameId}, nodes:`,
                      axTreeResult?.nodes?.length || 0,
                    );
                    frameAxtrees[frameId] = axTreeResult;

                    if (axTreeResult && axTreeResult.nodes) {
                      axTreeResult.nodes.forEach((node) => {
                        let dataItems = [];

                        // Look for data in node's "roledescription" property
                        if (node.properties) {
                          for (let i = 0; i < node.properties.length; i++) {
                            const prop = node.properties[i];
                            if (
                              prop.name === "roledescription" &&
                              prop.value &&
                              prop.value.value
                            ) {
                              const [extractedData, newValue] =
                                extractDataItemsFromAria(prop.value.value);
                              dataItems = extractedData;
                              prop.value.value = newValue;
                              // Remove property if empty
                              if (newValue === "") {
                                node.properties.splice(i, 1);
                              }
                              break;
                            }
                          }
                        }

                        // Look for data in node's "description" (fallback)
                        if (node.description && node.description.value) {
                          const [extractedDataBis, newValue] =
                            extractDataItemsFromAria(node.description.value);
                          node.description.value = newValue;
                          if (newValue === "") {
                            delete node.description;
                          }
                          if (!dataItems.length) {
                            dataItems = extractedDataBis;
                          }
                        }

                        if (dataItems.length > 0) {
                          const [dataItemId] = dataItems;
                          node.browsergym_id = dataItemId;
                        }
                      });
                    }
                  }

                  completedFrames++;
                  console.log(
                    `Completed ${completedFrames}/${frameIds.length} frames`,
                  );

                  if (completedFrames === frameIds.length) {
                    // Detach debugger and return results
                    chrome.debugger.detach({ tabId }, () => {
                      console.log(
                        "AXTree extraction complete, returning:",
                        Object.keys(frameAxtrees),
                      );
                      resolve(frameAxtrees);
                    });
                  }
                },
              );
            });
          },
        );
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Task metadata form: a schema-driven form rendered in the side panel. Values
// are stored in chrome.storage.local under "taskMetadata"; the worker attaches
// them to the session upload, and the server writes task_metadata.json.
// The schema mirrors configs/task_schema.json (fetched live when the server
// origin is known, else this embedded fallback is used).
// ---------------------------------------------------------------------------
const DEFAULT_TASK_SCHEMA = {
  common_fields: [
    { key: "task_type", label: "작업 유형", type: "select", required: true, options: ["write", "mail", "search", "login"] },
    { key: "login_required", label: "로그인 필요", type: "boolean" },
    { key: "login_account", label: "로그인 계정", type: "select", options: ["카카오", "구글", "네이버", "사이트 자체 계정", "기타"], allow_other: true, other_value: "기타", other_placeholder: "계정 종류 직접 입력" },
    { key: "id", label: "ID", type: "input", placeholder: "로그인 ID" },
    { key: "pw", label: "PW", type: "input", placeholder: "비밀번호" },
    { key: "auth_code", label: "인증번호", type: "input", placeholder: "인증번호 (필요한 경우)" },
  ],
  task_schemas: {
    write: { fields: [
      { key: "title", label: "글 제목", type: "input", required: true, placeholder: "예: 첫 브런치 글" },
      { key: "body", label: "본문 내용", type: "textarea", required: true, multi: true, placeholder: "본문 내용" },
    ] },
    mail: { fields: [
      { key: "to", label: "받는 사람", type: "input", required: true, placeholder: "받는 사람 이메일/이름" },
      { key: "subject", label: "제목", type: "input", required: true },
      { key: "body", label: "본문 내용", type: "textarea", required: true, multi: true, placeholder: "본문 내용" },
      { key: "attach", label: "첨부 여부", type: "boolean" },
    ] },
    search: { fields: [
      { key: "query", label: "검색어", type: "input", required: true },
      { key: "filter", label: "필터 (기간·정렬·카테고리)", type: "input", required: false },
      { key: "count", label: "수집 개수", type: "select", options: [5, 10, 20] },
      { key: "output", label: "출력", type: "select", options: ["list", "summary", "open_item"] },
    ] },
    login: { fields: [] },
  },
};

async function initTaskMetadataForm() {
  const app = document.getElementById("meta-app");
  if (!app) return;

  // Prefer the server's schema (so edits to configs/task_schema.json show up),
  // fall back to the embedded copy when the server origin isn't known/reachable.
  let S = DEFAULT_TASK_SCHEMA;
  try {
    const { uploadUrl } = await chrome.storage.local.get("uploadUrl");
    if (uploadUrl) {
      const origin = new URL(uploadUrl).origin;
      const res = await fetch(origin + "/task_schema");
      if (res.ok) {
        const fetched = await res.json();
        if (fetched && fetched.common_fields) S = fetched;
      }
    }
  } catch (e) {
    /* offline / no session yet — use embedded schema */
  }

  const stored = await chrome.storage.local.get("taskMetadata");
  const PRE = stored.taskMetadata || {};

  const el = (tag, attrs, children) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (children || []).forEach((c) => e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
  };
  const label = (t) => el("label", { style: "display:block;font-weight:600;margin:8px 0 3px;font-size:13px;" }, [t]);
  function fieldInput(f, value) {
    let inp;
    if (f.type === "textarea") { inp = el("textarea", { rows: "2", style: "width:100%;padding:5px;" }); if (f.placeholder) inp.placeholder = f.placeholder; if (value != null) inp.value = value; }
    else if (f.type === "select") {
      inp = el("select", { style: "width:100%;padding:5px;" });
      (f.options || []).forEach((o) => { const op = el("option", { value: String(o) }, [String(o)]); if (String(value) === String(o)) op.selected = true; inp.appendChild(op); });
    } else if (f.type === "boolean") { inp = el("input", { type: "checkbox" }); if (value) inp.checked = true; }
    else { inp = el("input", { type: "text", style: "width:100%;padding:5px;" }); if (f.placeholder) inp.placeholder = f.placeholder; if (value != null) inp.value = value; }
    inp.dataset.key = f.key; inp.dataset.ftype = f.type;
    return inp;
  }
  function multiRow(f, v) {
    const row = el("div", { style: "display:flex;gap:5px;margin-bottom:4px;" });
    const inp = fieldInput(f, v); inp.style.flex = "1"; inp.dataset.multikey = f.key;
    const rm = el("button", { type: "button", class: "button", style: "padding:2px 8px;" }, ["x"]);
    rm.onclick = () => row.remove();
    row.appendChild(inp); row.appendChild(rm); return row;
  }
  function fieldBlock(f, value) {
    const wrap = el("div", { style: "margin-bottom:6px;" });
    const lbl = (f.label || f.key) + (f.required ? " *" : "");
    if (f.type === "select" && f.allow_other) {
      wrap.appendChild(label(lbl));
      const opts = (f.options || []).map(String);
      const isCustom = value != null && value !== "" && !opts.includes(String(value));
      const sel = fieldInput(f, isCustom ? f.other_value : value);
      sel.dataset.allowother = "1"; sel.dataset.othervalue = f.other_value || "";
      const other = el("input", { type: "text", style: "width:100%;padding:5px;margin-top:4px;" });
      other.placeholder = f.other_placeholder || "직접 입력"; other.dataset.otherfor = f.key;
      if (isCustom) other.value = value;
      const sync = () => { other.style.display = sel.value === f.other_value ? "block" : "none"; };
      sel.addEventListener("change", sync);
      wrap.appendChild(sel); wrap.appendChild(other); sync();
      return wrap;
    }
    if (f.multi) {
      wrap.appendChild(label(lbl + " (+ 로 여러 개)"));
      const list = el("div", {}); const vals = Array.isArray(value) ? value : (value != null ? [value] : [""]);
      vals.forEach((v) => list.appendChild(multiRow(f, v)));
      wrap.appendChild(list);
      const add = el("button", { type: "button", class: "button", style: "margin-top:3px;padding:2px 10px;" }, ["+ " + f.key]);
      add.onclick = () => list.appendChild(multiRow(f, ""));
      wrap.appendChild(add);
    } else { wrap.appendChild(label(lbl)); wrap.appendChild(fieldInput(f, value)); }
    return wrap;
  }

  const commonBox = el("div", {});
  const typeFieldsBox = el("div", { style: "border-top:1px solid #e2e8f0;margin-top:8px;padding-top:5px;" });
  let taskTypeSel = null, completionSel = null;
  (S.common_fields || []).forEach((f) => {
    if (f.key === "completion_criteria") {
      const wrap = el("div", { style: "margin-bottom:6px;" }); wrap.appendChild(label((f.label || "completion_criteria") + " *"));
      completionSel = el("select", { style: "width:100%;padding:5px;" }); completionSel.dataset.key = "completion_criteria";
      wrap.appendChild(completionSel); commonBox.appendChild(wrap); return;
    }
    if (f.key === "task_type") {
      const wrap = el("div", { style: "margin-bottom:6px;" }); wrap.appendChild(label((f.label || "task_type") + " *"));
      taskTypeSel = fieldInput(f, PRE.task_type || (f.options || [])[0]); wrap.appendChild(taskTypeSel); commonBox.appendChild(wrap); return;
    }
    const pv = PRE[f.key] !== undefined ? PRE[f.key] : (f.type === "boolean" ? false : "");
    commonBox.appendChild(fieldBlock(f, pv));
  });

  function refresh() {
    const tt = taskTypeSel.value; const ts = (S.task_schemas || {})[tt] || { fields: [], completion_criteria: [] };
    const usePre = PRE.task_type === tt;
    typeFieldsBox.innerHTML = ""; typeFieldsBox.appendChild(label("[" + tt + "] 필드"));
    (ts.fields || []).forEach((f) => {
      const v = usePre && PRE[f.key] !== undefined ? PRE[f.key] : (f.multi ? [""] : (f.type === "boolean" ? false : ""));
      typeFieldsBox.appendChild(fieldBlock(f, v));
    });
    if (completionSel) {
      completionSel.innerHTML = "";
      (ts.completion_criteria || []).forEach((o) => { const op = el("option", { value: o }, [o]); if (usePre && PRE.completion_criteria === o) op.selected = true; completionSel.appendChild(op); });
    }
  }
  const readInput = (inp) => (inp.dataset.ftype === "boolean" ? inp.checked : inp.value);
  function collect() {
    const entry = {};
    commonBox.querySelectorAll("[data-key]").forEach((inp) => {
      let v = readInput(inp);
      if (inp.dataset.allowother && v === inp.dataset.othervalue) {
        const o = commonBox.querySelector('[data-otherfor="' + inp.dataset.key + '"]');
        if (o && o.value) v = o.value;
      }
      entry[inp.dataset.key] = v;
    });
    const tt = taskTypeSel.value; entry.task_type = tt; const ts = (S.task_schemas || {})[tt] || { fields: [] };
    (ts.fields || []).forEach((f) => {
      if (f.multi) { const rows = typeFieldsBox.querySelectorAll('[data-multikey="' + f.key + '"]'); entry[f.key] = Array.from(rows).map((r) => r.value).filter((v) => v !== ""); }
      else { const inp = typeFieldsBox.querySelector('[data-key="' + f.key + '"]'); if (inp) entry[f.key] = readInput(inp); }
    });
    return entry;
  }
  function validate(entry) {
    const miss = [];
    (S.common_fields || []).forEach((f) => { if (f.required && !entry[f.key]) miss.push(f.key); });
    const ts = (S.task_schemas || {})[entry.task_type] || { fields: [] };
    (ts.fields || []).forEach((f) => { if (f.required) { const v = entry[f.key]; if (f.multi ? !(v && v.length) : !v) miss.push(f.key); } });
    return miss;
  }

  commonBox.appendChild(typeFieldsBox);
  app.innerHTML = ""; app.appendChild(commonBox);
  taskTypeSel.onchange = refresh; refresh();

  const status = document.getElementById("meta-status");
  const saveBtn = document.getElementById("meta-save-btn");
  if (saveBtn) saveBtn.onclick = async () => {
    const entry = collect(); const miss = validate(entry);
    if (miss.length) { if (status) { status.textContent = "필수 누락: " + miss.join(", "); status.style.color = "red"; } return; }
    await chrome.storage.local.set({ taskMetadata: entry });
    if (status) { status.textContent = "저장됨 ✓ (세션 업로드 시 반영)"; status.style.color = "green"; }
  };
}
