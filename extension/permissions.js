// Chrome cannot show permission prompts in the popup, so we ask once in this tab.
const $ = (id) => document.getElementById(id);

async function ask() {
  $("error").textContent = "";
  let got = 0;
  for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      s.getTracks().forEach((t) => t.stop());
      got = constraints.audio && constraints.video ? 2 : 1;
      break;
    } catch (e) {
      $("error").textContent = e.name === "NotAllowedError"
        ? "Access is blocked. Click the camera icon in the address bar, allow access, then click Ask again."
        : e.message;
    }
  }
  if (got) {
    $("title").textContent = "Done";
    $("text").textContent = got === 2 ? "Kino can use your camera and microphone. This tab closes now." : "Kino got access to one device. This tab closes now.";
    $("ask").hidden = true;
    $("error").textContent = "";
    setTimeout(() => window.close(), 1500);
  }
}

$("ask").onclick = ask;
ask();
