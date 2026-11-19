// Keeps ?next=/path through the email sign-in. Same-site paths only.
const next = new URLSearchParams(location.search).get("next") || "";
document.getElementById("next").value = /^\/(?![\/\\])/.test(next) ? next : "/library";
