// Runs on the owner's digest page. Immediate submit feedback is important when
// Cloudflare/Google round trips take time. It never starts jobs itself and does not
// change form data, navigation, security checks or the server-side run lock.
export const RUN_START_SCRIPT = `(function () {
  "use strict";
  Array.prototype.forEach.call(document.querySelectorAll('form[action="/app/run"]'), function (form) {
    form.addEventListener("submit", function (event) {
      if (event.defaultPrevented || form.dataset.starting === "1") return;
      form.dataset.starting = "1";
      var button = event.submitter || form.querySelector('button[type="submit"]');
      if (button) {
        button.textContent = "Starting…";
        button.setAttribute("aria-busy", "true");
      }
      var note = document.createElement("span");
      note.setAttribute("role", "status");
      note.className = "note run-start-status";
      note.textContent = "Opening run progress…";
      form.appendChild(note);
    });
  });
})();`;

/** The only extra script admitted by CSP; a test verifies this matches the text above. */
export const RUN_START_SCRIPT_HASH = "sha256-I303uaCBZl++8/p1S/Dp4kuy8pIpOzhVe/VWz2Rg0CE=";
