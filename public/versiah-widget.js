(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var targetSelector = script.getAttribute("data-target");
  var target;
  try { target = targetSelector ? document.querySelector(targetSelector) : null; } catch {}

  if (!target) {
    target = document.createElement("div");
    script.parentNode.insertBefore(target, script);
  }

  var urlFromData = script.getAttribute("data-url");
  var destination;
  try { destination = new URL(urlFromData || "/", script.src); } catch { return; }
  if (!/^https?:$/.test(destination.protocol)) return;
  destination.searchParams.set("source", "featured");
  var openUrl = destination.href;

  var root = target.attachShadow ? (target.shadowRoot || target.attachShadow({ mode: "open" })) : target;

  root.innerHTML = [
    "<style>",
    ":host{display:block}",
    ".card{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:22px 24px;border:1px solid rgba(201,168,76,.28);border-radius:16px;background:linear-gradient(135deg,#17130c,#0d0a05);color:#f5edd6;font-family:Arial,sans-serif;box-shadow:0 18px 45px rgba(0,0,0,.2)}",
    ".card:before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 88% 0%,rgba(201,168,76,.12),transparent 35%);pointer-events:none}",
    ".copy{position:relative;min-width:0}.eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#c9a84c;margin-bottom:7px;font-weight:700}.title{font-size:22px;line-height:1.15;font-family:Georgia,serif;margin:0 0 7px}.text{margin:0;max-width:650px;color:#dfd0aa;font-size:13px;line-height:1.55}",
    ".button{position:relative;flex:0 0 auto;border:1px solid #c9a84c;border-radius:999px;padding:12px 17px;background:linear-gradient(135deg,#8f6c17,#c9a84c);color:#0d0a05;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;white-space:nowrap;transition:transform .2s ease,box-shadow .2s ease}.button:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(201,168,76,.2)}",
    "@media(max-width:620px){.card{flex-direction:column;align-items:flex-start;padding:20px}.button{box-sizing:border-box;width:100%;text-align:center}}",
    "</style>",
    '<article class="card" aria-label="The Pulpit">',
    '<div class="copy"><div class="eyebrow">The Pulpit · Built by Timzee</div><h2 class="title">Scripture for study, teaching and everyday life.</h2><p class="text">Prepare sermons, read and study the Bible, explore Pulpitpedia, and bring your questions to Versiah.</p></div>',
    '<a class="button" href="' + String(openUrl).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + '" target="_blank" rel="noopener noreferrer">Explore The Pulpit</a>',
    "</article>"
  ].join("");
})();