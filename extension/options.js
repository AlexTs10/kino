import { api, getSettings, openWeb, openLogin } from "./shared.js";

const $ = (id) => document.getElementById(id);
const s = await getSettings();

for (const id of ["quality", "camPosition", "camSize"]) $(id).value = s[id];
for (const id of ["mirror", "noiseSuppression", "camInVideo", "clickHighlights"]) $(id).checked = s[id];

// Recording options save at once.
for (const id of ["quality", "camPosition", "camSize"]) $(id).onchange = () => chrome.storage.local.set({ [id]: $(id).value });
for (const id of ["mirror", "noiseSuppression", "camInVideo", "clickHighlights"]) $(id).onchange = () => chrome.storage.local.set({ [id]: $(id).checked });

$("shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

// Account: signed in = the website's session cookie works.
try {
  const me = await api("/me");
  $("status").textContent = `Signed in as ${me.email}`;
  $("account").textContent = "Open my videos";
  $("account").onclick = () => openWeb("/library");
} catch {
  $("status").textContent = "You are not signed in.";
  $("account").textContent = "Sign in";
  $("account").onclick = () => openLogin();
}
$("account").hidden = false;
