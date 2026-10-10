// Rewrites <time datetime="…" data-local> stamps from the server's UTC fallback into the
// viewer's own timezone: "Today, 3:42 PM", "Yesterday, 9:15 PM", "Thu, 2:20 PM", "Oct 3",
// "Sep 14, 2025". The full local date and time goes in the tooltip.
(function () {
  "use strict";

  var DAY_MS = 24 * 60 * 60 * 1000;

  function format(options, date) {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function shortLabel(date, now) {
    var days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
    var time = format({ hour: "numeric", minute: "2-digit" }, date);
    if (days === 0) return "Today, " + time;
    if (days === -1) return "Yesterday, " + time;
    if (days === 1) return "Tomorrow, " + time;
    if (Math.abs(days) < 7) return format({ weekday: "short" }, date) + ", " + time;
    if (date.getFullYear() === now.getFullYear()) {
      return format({ month: "short", day: "numeric" }, date);
    }
    return format({ month: "short", day: "numeric", year: "numeric" }, date);
  }

  function fullLabel(date) {
    return format(
      {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      },
      date,
    );
  }

  function render() {
    var now = new Date();
    var stamps = document.querySelectorAll("time[data-local][datetime]");
    for (var i = 0; i < stamps.length; i++) {
      var el = stamps[i];
      var date = new Date(el.getAttribute("datetime"));
      if (Number.isNaN(date.getTime())) continue;
      el.textContent = shortLabel(date, now);
      el.title = fullLabel(date);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
