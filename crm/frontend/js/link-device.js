/**
 * link-device.js — the phone side of "Scan to log in" (D58).
 * The computer's login page shows a QR code that opens link-device.html#<id>.<secret>; here the
 * signed-in phone sees which computer asks and allows it (or not). Without a code in the
 * address, the camera scans one (BarcodeDetector, where the browser has it); otherwise the
 * phone's own camera app opens the link.
 */
(function linkDevice() {
  if (!isAuthenticated()) return; // app.js keeps the code and sends the phone to log in first
  const $ = (id) => document.getElementById(id);
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const CODE_PATTERN = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{20,100})$/;
  const ICONS = { ok: "fa-circle-check", no: "fa-circle-xmark", warn: "fa-triangle-exclamation" };
  let code = null;
  let stream = null;
  let scanning = false;

  const show = (step) => ["scanStep", "askStep", "doneStep"].forEach((id) => {
    $(id).hidden = id !== step;
  });

  // A scanned link (…/link-device.html#<id>.<secret>) or the address' own hash.
  function codeFrom(text) {
    const match = CODE_PATTERN.exec(String(text || "").split("#").pop().trim());
    return match ? { id: match[1], secret: match[2] } : null;
  }

  function finish(kind, title, text) {
    stopCamera();
    $("doneIcon").className = `link-icon is-${kind}`;
    $("doneIcon").innerHTML = `<i class="fa-solid ${ICONS[kind]}"></i>`;
    $("doneTitle").textContent = title;
    $("doneText").textContent = text;
    show("doneStep");
  }
  const unusable = (error) => finish("warn", "This code can't be used", apiErrorMessage(error, "Show a new code on the computer and scan it again."));

  async function ask(found) {
    code = found;
    stopCamera();
    try {
      const request = await crmApi(`/auth/qr/${code.id}/peek`, json({ secret: code.secret }));
      $("askComputer").textContent = request.computer;
      const email = getCurrentUser()?.email;
      $("askAccount").textContent = email ? `It will be logged in as ${email}.` : "";
      show("askStep");
      $("allowBtn").focus();
    } catch (error) {
      unusable(error);
    }
  }

  async function decide(allow) {
    $("allowBtn").disabled = true;
    $("denyBtn").disabled = true;
    try {
      const result = await crmApi(`/auth/qr/${code.id}/approve`, json({ secret: code.secret, allow }));
      if (allow) finish("ok", "Done", `${result.computer} is logging in now. You can put the phone away.`);
      else finish("no", "Not allowed", "The computer was not logged in.");
    } catch (error) {
      unusable(error);
    } finally {
      $("allowBtn").disabled = false;
      $("denyBtn").disabled = false;
    }
  }

  // --- the in-page scanner ------------------------------------------------------------------
  function stopCamera() {
    scanning = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    $("cameraBox").hidden = true;
    $("startCameraBtn").hidden = false;
  }

  async function startCamera() {
    const cameraApp = "Open your phone's camera app and point it at the code on the computer. It opens this page.";
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
      $("scanHint").textContent = `This browser can't scan here. ${cameraApp}`;
      return;
    }
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes("qr_code")) throw new Error("QR codes are not supported");
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      const video = $("cameraVideo");
      video.srcObject = stream;
      await video.play();
      $("cameraBox").hidden = false;
      $("startCameraBtn").hidden = true;
      $("scanHint").textContent = "Point the camera at the code on the computer.";
      scanning = true;
      const look = async () => {
        if (!scanning) return;
        try {
          const found = (await detector.detect(video)).map((barcode) => codeFrom(barcode.rawValue)).find(Boolean);
          if (found) return ask(found);
        } catch {
          /* a frame that could not be read */
        }
        return setTimeout(look, 250);
      };
      look();
    } catch (error) {
      stopCamera();
      $("scanHint").textContent = error?.name === "NotAllowedError"
        ? `The camera is blocked for this site. Allow it in the browser, or: ${cameraApp}`
        : `The camera could not start. ${cameraApp}`;
    }
  }

  function scanScreen() {
    code = null;
    $("scanHint").textContent = "";
    show("scanStep");
  }

  $("startCameraBtn").addEventListener("click", startCamera);
  $("allowBtn").addEventListener("click", () => decide(true));
  $("denyBtn").addEventListener("click", () => decide(false));
  $("scanAgainBtn").addEventListener("click", scanScreen);
  window.addEventListener("pagehide", stopCamera);

  // The code came in the address (the phone's camera app, or back from logging in): take it
  // out of the address bar and history right away.
  const hash = window.location.hash.slice(1);
  sessionStorage.removeItem("crm_pending_link");
  if (hash) window.history.replaceState(null, document.title, window.location.pathname);
  const fromAddress = codeFrom(hash);
  if (fromAddress) ask(fromAddress);
  else if (hash) unusable();
  else scanScreen();
})();
