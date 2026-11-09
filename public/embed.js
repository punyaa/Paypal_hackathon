/*
 * ProofPay embed: turns any element with data-proofpay into a
 * "Propose a protected milestone" button. Two lines on any job board:
 *
 *   <script src="https://YOUR-PROOFPAY-HOST/embed.js" defer></script>
 *   <button data-proofpay data-title="Landing page" data-amount="1200"
 *           data-currency="SGD" data-client="Kopi & Crumbs"
 *           data-description="Menu with prices, contact form, mobile friendly"></button>
 *
 * Clicking opens ProofPay with the job pre-filled. The freelancer confirms the
 * criteria and sends the client a protected PayPal link.
 */
(function () {
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : location.origin;

  var css =
    ".proofpay-btn{display:inline-flex;align-items:center;gap:8px;font:600 14px/1.2 system-ui,sans-serif;" +
    "padding:9px 14px;border-radius:8px;border:1px solid #16203a;background:#16203a;color:#fff;cursor:pointer;text-decoration:none}" +
    ".proofpay-btn:hover{background:#24304f}" +
    ".proofpay-btn:focus-visible{outline:2px solid #2f6fed;outline-offset:2px}" +
    ".proofpay-mark{width:16px;height:16px;border-radius:4px;background:repeating-linear-gradient(135deg,#5b4bc4 0 2px,#8a7de6 2px 5px)}" +
    ".proofpay-note{display:block;font:12px/1.3 system-ui,sans-serif;color:#6d7690;margin-top:6px}";

  function init() {
    if (!document.getElementById("proofpay-embed-css")) {
      var style = document.createElement("style");
      style.id = "proofpay-embed-css";
      style.textContent = css;
      document.head.appendChild(style);
    }
    var nodes = document.querySelectorAll("[data-proofpay]:not([data-proofpay-ready])");
    Array.prototype.forEach.call(nodes, function (el) {
      el.setAttribute("data-proofpay-ready", "1");
      el.classList.add("proofpay-btn");
      if (!el.textContent.trim()) {
        el.innerHTML = '<span class="proofpay-mark" aria-hidden="true"></span>Propose a protected milestone';
      }
      el.addEventListener("click", function (e) {
        e.preventDefault();
        var d = el.dataset;
        var params = new URLSearchParams();
        ["title", "amount", "currency", "client", "description"].forEach(function (k) {
          if (d[k]) params.set(k, d[k]);
        });
        params.set("source", d.source || location.hostname || "embed");
        window.open(origin + "/new?" + params.toString(), "_blank", "noopener");
      });
      if (el.hasAttribute("data-proofpay-note")) {
        var note = document.createElement("span");
        note.className = "proofpay-note";
        note.textContent = "Client's payment held by PayPal until the work passes. No platform fee.";
        el.insertAdjacentElement("afterend", note);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.ProofPay = { init: init };
})();
