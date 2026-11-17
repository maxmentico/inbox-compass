// The one script the app runs (the owner decided this on 2026-10-24): it makes the done switches save
// in place, without a reload, and the copy icon on To action copy the text the server rendered. The CSP allows exactly this text by its sha256 hash, so editing it
// without updating SWITCH_SCRIPT_HASH stops it from running (and fails test/web.test.ts).
//
// Progressive enhancement: without it, a switch is a plain submit button and the page reloads at the
// item, and the copy icon is a link to the same text as text/plain. The script reads only attributes,
// markup and a textarea's value the server rendered, writes text with textContent only, and never
// renders email content (it copies the server's text as it is).

export const SWITCH_SCRIPT = `(function () {
  "use strict";
  // The copy icon: puts the message together from the server's per-item text (escaped textareas, never
  // shown) for the switches as they are now, and copies it, synchronously inside the click. If the
  // clipboard isn't there or refuses, it shows that text selected, to copy by hand.
  /* assemble:start */
  function assemble(head, tops, isDone) {
    var entries = [];
    tops.forEach(function (top) {
      var open = top.earlier.filter(function (e) { return !isDone(e.key); });
      if (!isDone(top.key)) entries.push(top.block + (open.length ? "\\n   Earlier in this conversation:\\n" + open.map(function (e) { return e.nested; }).join("\\n") : ""));
      else open.forEach(function (e) { entries.push(e.alone); });
    });
    var n = entries.length;
    var text = head.replace("{n}", String(n)).replace("{s}", n === 1 ? "" : "s");
    entries.forEach(function (e, i) { text += "\\n\\n" + (i + 1) + ". " + e; });
    return { text: text + "\\n", count: n };
  }
  /* assemble:end */
  var copy = document.querySelector("a.copy[data-copy]");
  var copyText = document.getElementById("copy-text");
  var copyMsg = document.getElementById("copy-msg");
  var copyParts = document.getElementById("copy-parts");
  if (copy && copyText && copyParts) {
    var all = function (root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
    var value = function (root, sel) { var t = root.querySelector(sel); return t ? t.value : ""; };
    var tell = function (text) {
      if (!copyMsg) return;
      copyMsg.textContent = "";
      setTimeout(function () { copyMsg.textContent = text; }, 50);
    };
    var byHand = function (count) {
      var ok = false;
      copyText.classList.remove("vh");
      copyText.removeAttribute("aria-hidden");
      copyText.focus();
      copyText.select();
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      tell(ok ? "Copied " + count + (count === 1 ? " item" : " items") : "Couldn't copy \\u2014 select the text instead");
    };
    copy.addEventListener("click", function (event) {
      event.preventDefault();
      // Each key's switch as it is now; a part without a switch keeps the state it was rendered with.
      var switched = {};
      all(document, "button.switch").forEach(function (sw) { switched[sw.value] = sw.getAttribute("aria-checked") === "true"; });
      var isDoneOf = function (el, key) { return Object.prototype.hasOwnProperty.call(switched, key) ? switched[key] : el.getAttribute("data-done") === "1"; };
      var states = {};
      var tops = all(copyParts, ":scope > div[data-top]").map(function (t) {
        var key = t.getAttribute("data-top");
        states[key] = isDoneOf(t, key);
        return {
          key: key,
          block: value(t, ":scope > textarea[data-block]"),
          earlier: all(t, ":scope > div[data-earlier]").map(function (e) {
            var k = e.getAttribute("data-earlier");
            states[k] = isDoneOf(e, k);
            return { key: k, nested: value(e, ":scope > textarea[data-nested]"), alone: value(e, ":scope > textarea[data-alone]") };
          }),
        };
      });
      var out = assemble(value(copyParts, ":scope > textarea[data-head]"), tops, function (k) { return states[k] === true; });
      copy.setAttribute("data-count", String(out.count));
      if (!out.count) { tell("Nothing in To action is open"); return; }
      copyText.value = out.text;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(out.text).then(function () { tell("Copied " + out.count + (out.count === 1 ? " item" : " items")); }, function () { byHand(out.count); });
      } else byHand(out.count);
    });
  }

  var form = document.querySelector("form.digest");
  if (!form || !window.fetch || !window.URLSearchParams) return;
  var ON = " (switching off marks it unread in Gmail)";
  var OFF = " (marks it read in Gmail)";
  var RETRY = "Couldn't save, try again";
  var STALE = "This page is out of date. Reload to see the latest run.";
  var SESSION = "Your session expired. Reload to sign in again.";
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
  var isOn = function (sw) { return sw.getAttribute("aria-checked") === "true"; };

  function setState(sw, done) {
    sw.setAttribute("aria-checked", done ? "true" : "false");
    sw.setAttribute("formaction", done ? "/app/undone" : "/app/done");
    var label = sw.getAttribute("aria-label") || "";
    var from = done ? OFF : ON;
    var to = done ? ON : OFF;
    if (label.slice(-from.length) === from) sw.setAttribute("aria-label", label.slice(0, -from.length) + to);
    var row = sw.closest("li.item");
    if (row) row.classList.toggle("is-done", done);
  }

  // A row still needs the owner while it, or an earlier message of its conversation, is switched off.
  function needsYou(row) {
    var open = false;
    each([row].concat(Array.prototype.slice.call(row.querySelectorAll(".thread-in li.item"))), function (r) {
      var sw = r.querySelector(":scope > .side > .switch");
      if (sw && !isOn(sw)) open = true;
    });
    return open;
  }

  // Section headers read "N" or "N · M done"; the all-done note shows only when nothing is left.
  function recount() {
    each(form.querySelectorAll(":scope > section, :scope > details"), function (sec) {
      var head = sec.querySelector(":scope > .sec-h");
      var list = sec.querySelector(":scope > ul.items");
      if (!head || !list) return;
      var rows = list.querySelectorAll(":scope > li.item");
      var left = 0;
      each(rows, function (r) { if (needsYou(r)) left++; });
      var done = rows.length - left;
      var counts = head.querySelectorAll(":scope > .n");
      if (!counts.length) return;
      counts[0].textContent = String(left);
      var doneCount = counts[1];
      if (done && !doneCount) {
        doneCount = document.createElement("span");
        doneCount.className = "n";
        counts[0].after(doneCount);
      }
      if (doneCount) {
        if (done) doneCount.textContent = "\\u00b7 " + done + " done";
        else doneCount.remove();
      }
      var calm = sec.querySelector(":scope > .calm");
      if (calm) calm.hidden = left > 0;
    });
  }

  // One line at the top of the row: an error, or the Gmail warning the page would show.
  function say(row, text, kind) {
    var body = row && row.querySelector(":scope > .body");
    if (!body) return;
    var line = body.querySelector(":scope > .sw-msg");
    if (!text) {
      if (line) line.remove();
      return;
    }
    if (!line) {
      line = document.createElement("p");
      line.className = "sw-msg";
      line.setAttribute("role", "status");
      body.insertBefore(line, body.firstChild);
    }
    line.className = "sw-msg " + kind;
    line.textContent = "";
    setTimeout(function () { line.textContent = text; }, 50);
  }

  form.addEventListener("click", function (event) {
    var sw = event.target instanceof Element ? event.target.closest("button.switch") : null;
    if (!sw || !form.contains(sw)) return;
    event.preventDefault();
    if (sw.getAttribute("aria-busy") === "true") return;
    var row = sw.closest("li.item");
    var was = isOn(sw);
    var action = sw.getAttribute("formaction");
    var fields = new URLSearchParams();
    fields.set("csrf", form.elements.namedItem("csrf").value);
    fields.set("run", form.elements.namedItem("run").value);
    fields.set("item", sw.value);
    setState(sw, !was);
    recount();
    sw.setAttribute("aria-busy", "true");
    fetch(action, { method: "POST", headers: { Accept: "application/json" }, body: fields, credentials: "same-origin" })
      .then(function (res) {
        // A server error can be retried. Anything else that isn't our JSON is the sign-in page (after the
        // redirect for an expired session) or an expired form: reloading is what helps.
        if (res.status >= 500) throw RETRY;
        var type = res.headers.get("Content-Type") || "";
        if (res.redirected || type.indexOf("application/json") !== 0) throw SESSION;
        return res.json().then(function (out) {
          // The page is older than the latest run, or its run is gone.
          if ((out && out.code === "stale") || res.status === 409 || res.status === 404) throw STALE;
          if (!res.ok || !out || out.ok !== true) throw RETRY;
          var failed = out.gmail === "failed" ? "Saved here, but Gmail couldn't be updated for " + String(out.mailbox || "this mailbox") + "." : "";
          say(row, failed, "warn");
        });
      })
      .catch(function (why) {
        setState(sw, was);
        recount();
        say(row, why === STALE || why === SESSION ? why : RETRY, "err");
      })
      .then(function () { sw.removeAttribute("aria-busy"); });
  });
})();`;

/** base64 sha256 of SWITCH_SCRIPT, for the CSP's script-src. Update it whenever the script changes. */
export const SWITCH_SCRIPT_HASH = "sha256-iRoDVLz8nHrClCzN93Gm/Kc5H7A8oPk1JFN2eGp50Xw=";
